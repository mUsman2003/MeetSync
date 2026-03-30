/**
 * MeetSync - popup.js
 * Popup UI controller: reads from chrome.storage.local, renders
 * the real-time feed, and handles export actions.
 */

"use strict";

// ─── DOM Refs ─────────────────────────────────────────────────────────────
const feedWrapper = document.getElementById("feedWrapper");
const feed        = document.getElementById("feed");
const emptyState  = document.getElementById("emptyState");
const statusDot   = document.getElementById("statusDot");
const statusText  = document.getElementById("statusText");
const countBadge  = document.getElementById("countBadge");
const meetingIdEl = document.getElementById("meetingId");
const warningBanner = document.getElementById("warningBanner");
const syncBtn     = document.getElementById("syncBtn");
const exportJsonBtn = document.getElementById("exportJsonBtn");
const exportCsvBtn  = document.getElementById("exportCsvBtn");
const clearBtn    = document.getElementById("clearBtn");
const scrollBtn   = document.getElementById("scrollBtn");

// ─── State ────────────────────────────────────────────────────────────────
let activeMeetingId = null;
let renderedIds = new Set();   // IDs already rendered in the feed
let isUserScrolled = false;    // Whether user has scrolled up (pause auto-scroll)
let port = null;               // Long-lived connection to background

// ─── Helpers ──────────────────────────────────────────────────────────────

function getInitials(name) {
  if (!name || name === "Unknown" || name === "System") return "•";
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

function getAvatarColor(name) {
  // Consistent color per sender name
  const colors = ["#4f8ef7", "#3ecf8e", "#f7c948", "#f0605a", "#a78bfa",
                  "#38bdf8", "#fb923c", "#34d399", "#f472b6"];
  let hash = 0;
  for (let i = 0; i < (name || "").length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) % colors.length;
  }
  return colors[Math.abs(hash) % colors.length];
}

function escapeHtml(str) {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isAtBottom() {
  return feedWrapper.scrollHeight - feedWrapper.scrollTop - feedWrapper.clientHeight < 40;
}

function scrollToBottom() {
  feedWrapper.scrollTo({ top: feedWrapper.scrollHeight, behavior: "smooth" });
}

// ─── Rendering ────────────────────────────────────────────────────────────

function renderEntry(entry) {
  if (renderedIds.has(entry.id)) return;
  renderedIds.add(entry.id);

  const isEvent = entry.type === "event";
  const div = document.createElement("div");
  div.className = `entry ${entry.type}`;
  div.dataset.id = entry.id;

  const avatarColor = isEvent ? "#a78bfa" : getAvatarColor(entry.sender);
  const avatarText  = isEvent ? "📢" : getInitials(entry.sender);

  div.innerHTML = `
    <div class="entry-avatar" style="${isEvent ? "" : `background:${avatarColor}`}">${avatarText}</div>
    <div class="entry-body">
      <div class="entry-meta">
        <span class="entry-sender">${escapeHtml(entry.sender)}</span>
        <span class="entry-time">${escapeHtml(entry.timestamp)}</span>
      </div>
      <div class="entry-message">${escapeHtml(entry.message)}</div>
    </div>
  `;

  feed.appendChild(div);
}

function renderEntries(entries) {
  const wasAtBottom = isAtBottom();

  entries.forEach(renderEntry);

  // Update empty state
  if (renderedIds.size > 0) {
    emptyState.style.display = "none";
  }

  // Update count badge
  countBadge.textContent = renderedIds.size;

  // Auto-scroll if user was at bottom
  if (wasAtBottom || !isUserScrolled) {
    scrollToBottom();
    scrollBtn.classList.remove("visible");
  } else {
    scrollBtn.classList.add("visible");
  }
}

function clearFeed() {
  feed.innerHTML = "";
  renderedIds.clear();
  countBadge.textContent = "0";
  emptyState.style.display = "flex";
}

// ─── Status UI ────────────────────────────────────────────────────────────

function setStatus(state, text) {
  statusDot.className = "status-dot " + state;
  statusText.textContent = text;
}

function updateMeetingDisplay(meetingId) {
  activeMeetingId = meetingId;
  if (meetingId) {
    meetingIdEl.textContent = `Meeting: ${meetingId}`;
    setStatus("active", "Syncing in real-time");
  } else {
    meetingIdEl.textContent = "No active meeting";
    setStatus("", "Not in a Google Meet");
  }
}

function setChatPanelWarning(open) {
  if (open) {
    warningBanner.classList.remove("visible");
  } else if (activeMeetingId) {
    warningBanner.classList.add("visible");
  }
}

// ─── Data Loading ─────────────────────────────────────────────────────────

async function loadCurrentSession() {
  const storage = await chrome.storage.local.get([
    "activeMeetingId",
    "chatPanelOpen",
    "lastUpdated"
  ]);

  const meetingId = storage.activeMeetingId;
  updateMeetingDisplay(meetingId);
  setChatPanelWarning(storage.chatPanelOpen !== false);

  if (!meetingId) return;

  const key = `meet_${meetingId}`;
  const result = await chrome.storage.local.get(key);
  const entries = result[key] || [];

  clearFeed();
  renderEntries(entries);
}

// ─── Background Connection ────────────────────────────────────────────────

function connectBackground() {
  port = chrome.runtime.connect({ name: "meetsync-popup" });

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "NEW_ENTRY":
        if (msg.entry && msg.entry.id) {
          renderEntries([msg.entry]);
        }
        break;

      case "CHAT_PANEL_STATE":
        setChatPanelWarning(msg.open);
        break;

      case "SESSION_STARTED":
        updateMeetingDisplay(msg.meetingId);
        clearFeed();
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    // Reconnect if background wakes up
    setTimeout(connectBackground, 1000);
  });
}

// ─── Scroll Tracking ─────────────────────────────────────────────────────

feedWrapper.addEventListener("scroll", () => {
  if (isAtBottom()) {
    isUserScrolled = false;
    scrollBtn.classList.remove("visible");
  } else {
    isUserScrolled = true;
  }
});

scrollBtn.addEventListener("click", () => {
  isUserScrolled = false;
  scrollToBottom();
  scrollBtn.classList.remove("visible");
});

// ─── Export Functions ─────────────────────────────────────────────────────

async function getEntries() {
  if (!activeMeetingId) return [];
  const key = `meet_${activeMeetingId}`;
  const result = await chrome.storage.local.get(key);
  return result[key] || [];
}

function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportJSON() {
  const entries = await getEntries();
  if (!entries.length) {
    setStatus("warning", "No data to export.");
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const data = {
    meetingId: activeMeetingId,
    exportedAt: new Date().toISOString(),
    totalEntries: entries.length,
    entries
  };

  downloadBlob(
    JSON.stringify(data, null, 2),
    `meetsync_${activeMeetingId}_${timestamp}.json`,
    "application/json"
  );

  flashBtn(exportJsonBtn, "✓ Done!");
}

async function exportCSV() {
  const entries = await getEntries();
  if (!entries.length) {
    setStatus("warning", "No data to export.");
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const header = "Type,Timestamp,Sender,Message,CapturedAt\r\n";
  const rows = entries.map(e => {
    const msg = `"${(e.message || "").replace(/"/g, '""')}"`;
    const sender = `"${(e.sender || "").replace(/"/g, '""')}"`;
    const capAt = `"${(e.capturedAt || "").replace(/"/g, '""')}"`;
    return `${e.type},"${e.timestamp}",${sender},${msg},${capAt}`;
  });

  downloadBlob(
    header + rows.join("\r\n"),
    `meetsync_${activeMeetingId}_${timestamp}.csv`,
    "text/csv;charset=utf-8;"
  );

  flashBtn(exportCsvBtn, "✓ Done!");
}

async function clearSession() {
  if (!activeMeetingId) return;
  if (!confirm(`Clear all data for meeting ${activeMeetingId}?`)) return;

  const key = `meet_${activeMeetingId}`;
  await chrome.storage.local.remove(key);
  clearFeed();
  setStatus("active", "Session cleared.");
}

function flashBtn(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  btn.classList.add("success");
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove("success");
  }, 2000);
}

// ─── Sync Button ──────────────────────────────────────────────────────────

async function manualSync() {
  syncBtn.textContent = "⏳";
  syncBtn.disabled = true;

  // Ask content.js to do a fresh scan
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.startsWith("https://meet.google.com/")) {
      await chrome.tabs.sendMessage(tab.id, { type: "MANUAL_SCAN" });
    }
  } catch (e) { /* content script may not be running */ }

  await loadCurrentSession();

  syncBtn.textContent = "🔄";
  syncBtn.disabled = false;
}

// ─── Event Listeners ──────────────────────────────────────────────────────

syncBtn.addEventListener("click", manualSync);
exportJsonBtn.addEventListener("click", exportJSON);
exportCsvBtn.addEventListener("click", exportCSV);
clearBtn.addEventListener("click", clearSession);

// ─── Init ─────────────────────────────────────────────────────────────────

connectBackground();
loadCurrentSession();