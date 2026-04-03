/**
 * MeetSync - background.js
 * Service Worker: Handles persistent state management, relays
 * messages between content scripts and the popup.
 */

"use strict";

importScripts("engagementStore.js");

// ─── Extension Lifecycle ──────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    console.log("[MeetSync] Extension installed.");
    // Set default storage state
    chrome.storage.local.set({
      activeMeetingId: null,
      chatPanelOpen: false,
      lastUpdated: null
    });
  }
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!tab.url || !tab.url.includes("meet.google.com")) return;
  if (info.status !== "complete") return;
  if (!chrome.sidePanel || !chrome.sidePanel.setOptions) return;
  chrome.sidePanel.setOptions({
    tabId,
    path: "popup.html",
    enabled: true
  }).catch(() => {});
});

// ─── Message Relay ─────────────────────────────────────────────────────────

/**
 * Relays messages from content.js to the popup (if open).
 * The service worker acts as the reliable intermediary since
 * content.js cannot directly message the popup.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "NEW_ENTRY":
    case "CHAT_PANEL_STATE":
    case "SESSION_STARTED":
      // Forward to any open popup connections
      forwardToPopup(message);
      break;

    case "CLEAR_SESSION":
      clearSession(message.meetingId).then(() => sendResponse({ ok: true }));
      return true; // async

    case "GET_ALL_SESSIONS":
      getAllSessions().then(sessions => sendResponse({ sessions }));
      return true; // async

    case "EXPORT_SESSION":
      exportSession(message.meetingId, message.format)
        .then(result => sendResponse(result));
      return true; // async
  }
});

// ─── Popup Connection ─────────────────────────────────────────────────────

let popupPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "meetsync-popup") {
    popupPort = port;
    port.onDisconnect.addListener(() => {
      popupPort = null;
    });
  }
});

function forwardToPopup(message) {
  if (popupPort) {
    try {
      popupPort.postMessage(message);
    } catch (e) {
      // Popup was closed
      popupPort = null;
    }
  }
}

// ─── Session Management ───────────────────────────────────────────────────

async function clearSession(meetingId) {
  if (!meetingId) return;
  const key = `meet_${meetingId}`;
  await chrome.storage.local.remove(key);
  if (typeof MeetSyncEngagement !== "undefined") {
    await MeetSyncEngagement.clearEngagementForMeeting(meetingId);
  }
  console.log(`[MeetSync] Cleared session: ${meetingId}`);
}

async function getAllSessions() {
  const all = await chrome.storage.local.get(null);
  const sessions = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith("meet_") && Array.isArray(value)) {
      const meetingId = key.replace("meet_", "");
      sessions.push({
        meetingId,
        entryCount: value.length,
        entries: value
      });
    }
  }
  return sessions;
}

// ─── Export Helpers ───────────────────────────────────────────────────────

async function exportSession(meetingId, format = "json") {
  const key = `meet_${meetingId}`;
  const result = await chrome.storage.local.get(key);
  const entries = result[key] || [];

  if (entries.length === 0) {
    return { ok: false, error: "No data found for this session." };
  }

  let engagementV2 = null;
  if (typeof MeetSyncEngagement !== "undefined") {
    try {
      engagementV2 = await MeetSyncEngagement.loadEngagementSummary(meetingId);
    } catch (e) {
      engagementV2 = null;
    }
  }

  let content, mimeType, filename;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  if (format === "json") {
    content = JSON.stringify(
      {
        meetingId,
        exportedAt: new Date().toISOString(),
        totalEntries: entries.length,
        engagementV2,
        entries
      },
      null,
      2
    );
    mimeType = "application/json";
    filename = `meetsync_${meetingId}_${timestamp}.json`;
  } else if (format === "csv") {
    const header = "Type,Timestamp,Sender,Message,CapturedAt\n";
    const rows = entries.map(e => {
      const escapedMsg = `"${(e.message || "").replace(/"/g, '""')}"`;
      const escapedSender = `"${(e.sender || "").replace(/"/g, '""')}"`;
      return `${e.type},${e.timestamp},${escapedSender},${escapedMsg},${e.capturedAt}`;
    });
    let csv = header + rows.join("\n");
    if (engagementV2 && engagementV2.participants && engagementV2.participants.length) {
      csv += "\n\nENGAGEMENT_SUMMARY\n";
      csv += "Name,ChatCount,ReactionCount,AttendanceMs,IsPresent\n";
      engagementV2.participants.forEach((p) => {
        const name = `"${(p.name || "").replace(/"/g, '""')}"`;
        csv += `${name},${p.chatCount != null ? p.chatCount : 0},${p.reactionCount != null ? p.reactionCount : 0},${p.attendanceMs != null ? p.attendanceMs : ""},${p.isPresent ? "TRUE" : "FALSE"}\n`;
      });
    }
    content = csv;
    mimeType = "text/csv";
    filename = `meetsync_${meetingId}_${timestamp}.csv`;
  } else {
    return { ok: false, error: "Unknown format." };
  }

  // Create a data URL and trigger download
  const dataUrl = `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;

  return new Promise((resolve) => {
    chrome.downloads.download(
      { url: dataUrl, filename, saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve({ ok: true, downloadId, filename });
        }
      }
    );
  });
}

// ─── Tab Tracking ─────────────────────────────────────────────────────────

/**
 * Inject the content script when a Meet tab is navigated to.
 * (Handles cases where the extension was installed mid-session.)
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === "complete" &&
    tab.url &&
    tab.url.startsWith("https://meet.google.com/")
  ) {
    chrome.scripting.executeScript({
      target: { tabId },
      files: ["engagementStore.js", "content.js"]
    }).catch(() => {
      // Script may already be injected — safe to ignore
    });
  }
});