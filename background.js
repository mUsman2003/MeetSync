// background.js — MeetSync Service Worker
// Maintains session state across the extension lifetime

'use strict';

const DEFAULT_STATE = {
  isTracking: false,
  meetingStart: null,
  meetingTitle: null,
  participants: [],
  chats: []
};

let sessionState = { ...DEFAULT_STATE };

// ─── Persist helpers ──────────────────────────────────────────────────────────
function saveState() {
  chrome.storage.session.set({ meetsyncState: sessionState });
}

// ─── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case 'STATE_UPDATE':
      // Merge incoming data from content.js
      sessionState = { ...sessionState, ...msg.data };
      saveState();
      sendResponse({ ok: true });
      break;

    case 'SESSION_ENDED':
      sessionState.isTracking = false;
      saveState();
      sendResponse({ ok: true });
      break;

    case 'GET_STATE':
      sendResponse(sessionState);
      break;

    case 'CLEAR_STATE':
      sessionState = { ...DEFAULT_STATE };
      saveState();
      sendResponse({ ok: true });
      break;

    default:
      sendResponse({ ok: false, error: 'unknown message type' });
  }

  return true; // Keep message channel open for async responses
});

// ─── Init on install ──────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.set({ meetsyncState: sessionState });
  console.log('[MeetSync] Extension installed / updated.');
});
