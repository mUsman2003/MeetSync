/**
 * MeetSync - content.js
 * The Extraction Engine: Observes Google Meet's DOM and extracts
 * chat messages and participant join/leave events in real-time.
 */

(function () {
    "use strict";
  
    // ─── State ────────────────────────────────────────────────────────────────
    const seenIds = new Set();       // Deduplication set
    const recentSystemTexts = new Map(); // text -> lastSeenMs
    let debounceTimer = null;        // Scan debounce handle
    let currentMeetingId = null;     // Active meeting ID from URL
    let chatPanelOpen = false;       // Track chat panel state
    let observer = null;             // MutationObserver instance
    let systemObserver = null;       // Observer for system popups
    let localUserName = null;        // Cached display name for "You" / self messages
  
    // ─── Helpers ──────────────────────────────────────────────────────────────
  
    /**
     * Extracts the meeting ID from the current URL.
     * Meet URLs look like: https://meet.google.com/abc-defg-hij
     */
    function getMeetingId() {
      const match = window.location.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
      return match ? match[1] : null;
    }
  
    /**
     * Parses a time string from Google Meet, handling narrow no-break spaces (\u202F).
     * Returns the raw time string or null if not found.
     */
    function parseTime(rawText) {
      if (!rawText) return null;
      // Normalize narrow no-break spaces and regular spaces
      const normalized = rawText.replace(/\u202F/g, " ").trim();
      const match = normalized.match(/\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?/i);
      return match ? match[0].trim() : null;
    }
  
    /**
     * Generates a stable unique ID for a message entry.
     */
    function normalizeForId(value) {
      return (value || "")
        .replace(/\u202F/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    }
  
    function hashString(str) {
      // Small, deterministic, non-crypto hash (FNV-1a 32-bit)
      let hash = 0x811c9dc5;
      for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    }
  
    function makeChatId({ sender, time, text, msgIdx }) {
      const senderN = normalizeForId(sender);
      const timeN = normalizeForId(time); // may be empty if Meet doesn't expose it
      const textN = normalizeForId(text);
  
      // Include msgIdx (within grouped messages) to disambiguate repeats,
      // but avoid containerIdx which shifts as Meet re-renders.
      const fingerprint = `${senderN}|${timeN}|${textN}|${msgIdx ?? ""}`;
      return `chat_${hashString(fingerprint)}`;
    }
  
    function makeEventId({ time, text }) {
      const timeN = normalizeForId(time);
      const textN = normalizeForId(text);
      return `event_${hashString(`${timeN}|${textN}`)}`;
    }
  
    /**
     * Filters out Meet UI noise strings from text nodes.
     */
    const UI_NOISE = new Set([
      "keep", "pin message", "unpin message", "you",
      "react", "remove reaction", "more options", "reply",
      "copy link", "report", "delete", "edit"
    ]);
  
    function isNoise(text) {
      const raw = (text || "").replace(/\u202F/g, " ").trim().toLowerCase();
      if (!raw) return true;
      if (UI_NOISE.has(raw)) return true;
  
      // Meet sometimes concatenates UI strings (e.g. "keepPin message").
      const squashed = raw.replace(/\s+/g, "").replace(/[^a-z]/g, "");
      const noiseTokens = [
        "keep",
        "pinmessage",
        "unpinmessage",
        "moreoptions",
        "reply",
        "copylink",
        "report",
        "delete",
        "edit",
        "react",
        "removereaction"
      ];
  
      // Safe: only treat as noise if the whole string is made of noise tokens.
      // This avoids filtering legitimate messages that merely contain substrings
      // like "keep" (e.g., "keep going").
      const tokenUnion = noiseTokens.join("|");
      const noiseOnly = new RegExp(`^(?:${tokenUnion})+$`, "i");
      return noiseOnly.test(squashed);
    }

    function cleanMessageText(text, senderName) {
      const raw = (text || "").replace(/\u202F/g, " ").trim();
      if (!raw) return "";
      const senderN = (senderName || "").trim();
  
      const parts = raw
        .split(/\r?\n+/)
        .map(p => p.trim())
        .filter(Boolean)
        .filter(p => !isNoise(p))
        .filter(p => !parseTime(p))
        .filter(p => !senderN || p !== senderN);
  
      let cleaned = parts.join(" ").replace(/\s+/g, " ").trim();
  
      // Strip UI action junk that sometimes gets appended to the end of text
      // like: "usman keepPin message"
      const tailNoise = [
        "keep",
        "pin message",
        "unpin message",
        "more options",
        "reply",
        "copy link",
        "report",
        "delete",
        "edit",
        "react",
        "remove reaction"
      ];
      const tailRe = new RegExp(`(?:\\s*(?:${tailNoise.map(t => t.replace(/ /g, "\\\\s+")).join("|")}))+\\s*$`, "i");
      cleaned = cleaned.replace(tailRe, "").trim();
  
      // Also handle concatenated suffixes like "keepPin message"
      const squashed = cleaned.replace(/\s+/g, "");
      const squashedTailRe = new RegExp(`(?:keep|pinmessage|unpinmessage|moreoptions|reply|copylink|report|delete|edit|react|removereaction)+$`, "i");
      if (squashedTailRe.test(squashed)) {
        // If the entire string is just noise, drop it; otherwise keep original cleaned (best effort)
        const onlyNoise = new RegExp(`^(?:keep|pinmessage|unpinmessage|moreoptions|reply|copylink|report|delete|edit|react|removereaction)+$`, "i");
        if (onlyNoise.test(squashed)) return "";
      }
  
      return cleaned;
    }

    function getLocalUserName() {
      if (localUserName) return localUserName;
  
      // Common: profile/account button includes "Google Account: Name"
      const accountEl = document.querySelector(
        '[aria-label^="Google Account:" i], button[aria-label^="Google Account:" i], [aria-label*="Google Account:" i]'
      );
      const label = accountEl ? (accountEl.getAttribute("aria-label") || "") : "";
      const m = label.match(/Google Account:\s*([^,(]+?)(?:\s*[,(]|$)/i);
      if (m && m[1]) {
        localUserName = m[1].trim();
        return localUserName;
      }
  
      return null;
    }

    function trySenderFromAria(container) {
      const aria = (container.getAttribute("aria-label") || "").replace(/\u202F/g, " ").trim();
      if (!aria) return "";
  
      // Heuristic: "Name 7:45 PM Message" or similar.
      // Grab leading chunk before first time-like token.
      const timeIdx = aria.search(/\d{1,2}:\d{2}/);
      const head = (timeIdx > 0 ? aria.slice(0, timeIdx) : aria).trim();
      if (!head) return "";
  
      // Avoid UI noise / generic labels
      if (isNoise(head) || parseTime(head)) return "";
  
      // Reasonable name length
      if (head.length < 2 || head.length > 60) return "";
      return head;
    }

    function pickBestSenderName(container, excludeTexts = []) {
      // Prefer explicit sender name elements.
      const senderEl = container.querySelector(
        '[data-sender-name], [aria-label][class*="author" i], span[class*="sender" i]'
      );
      const senderText = senderEl ? (senderEl.textContent || "").trim() : "";
      if (senderText && !isNoise(senderText) && !parseTime(senderText)) return senderText;
  
      // Heuristic: pick the best candidate span text; prefer longer names over initials.
      const exclude = new Set(
        (excludeTexts || [])
          .map(t => (t || "").replace(/\u202F/g, " ").trim())
          .filter(Boolean)
      );
      const spans = Array.from(container.querySelectorAll("span"));
      const candidates = spans
        .map(s => (s.textContent || "").replace(/\u202F/g, " ").trim())
        .filter(t => t && !exclude.has(t) && !isNoise(t) && !parseTime(t) && t.length < 60);
  
      if (candidates.length === 0) return "";
  
      const long = candidates.filter(t => t.length > 3);
      const pool = long.length ? long : candidates;
      return pool.sort((a, b) => b.length - a.length)[0] || "";
    }
  
    /**
     * Saves a single entry to chrome.storage.local.
     * Appends to the existing array for the current meeting.
     */
    async function saveEntry(entry) {
      try {
        const key = `meet_${currentMeetingId}`;
        const result = await chrome.storage.local.get([key, "activeMeetingId"]);
        const existing = result[key] || [];
  
        // Double-check dedup before saving
        if (seenIds.has(entry.id)) return;
        seenIds.add(entry.id);
  
        existing.push(entry);
        await chrome.storage.local.set({
          [key]: existing,
          activeMeetingId: currentMeetingId,
          lastUpdated: Date.now()
        });
  
        // Notify popup if open
        chrome.runtime.sendMessage({ type: "NEW_ENTRY", entry }).catch(() => {});
      } catch (err) {
        console.warn("[MeetSync] Storage error:", err);
      }
    }
  
    // ─── Chat Extraction ──────────────────────────────────────────────────────
  
    /**
     * Scans the chat panel and extracts all visible messages.
     * Handles grouped messages (multiple messages under one sender).
     */
    function scanChatMessages() {
      // Primary chat container selector — targets the scrollable message list
      // Google Meet wraps messages in elements with data-message-id
      const messageContainers = document.querySelectorAll(
        '[data-message-id], [jsname="xySENc"] [data-sender-id]'
      );
  
      if (messageContainers.length === 0) {
        // Fallback: try to find the chat panel by its ARIA role
        scanChatFallback();
        return;
      }
  
      messageContainers.forEach((container, idx) => {
        extractFromMessageContainer(container, idx);
      });
    }
  
    /**
     * Fallback scanner that walks the chat panel's text nodes more broadly.
     */
    function scanChatFallback() {
      // Look for the chat side panel
      const chatPanel = document.querySelector(
        '[aria-label*="chat" i], [aria-label*="message" i], [data-panel-type="chat"]'
      );
      if (!chatPanel) return;
  
      // Find message blocks — each block typically has a sender and one or more messages
      const msgBlocks = chatPanel.querySelectorAll('[role="listitem"], [data-is-bot-message]');
      msgBlocks.forEach((block, idx) => extractFromMessageContainer(block, idx));
    }
  
    /**
     * Extracts message data from a single container element.
     */
    function extractFromMessageContainer(container, containerIdx) {
      // Attempt to read sender from data attribute first, then from DOM
      const senderId = container.getAttribute("data-sender-id") || "";
      const messageId = container.getAttribute("data-message-id") || "";
  
      // Find all text message nodes — individual message bubbles within a group
      // Meet groups multiple messages from the same sender under one header
      const textNodes = container.querySelectorAll(
        '[data-message-text], [jsname="r4nke"], [class*="message-text" i], [class*="messageText" i]'
      );
  
      const messageTextSamples = Array.from(textNodes)
        .map(n => (n.textContent || "").replace(/\u202F/g, " ").trim())
        .filter(Boolean);
      let senderName = pickBestSenderName(container, messageTextSamples) || "";
      if (!senderName) senderName = trySenderFromAria(container);
      if (senderName && senderName.toLowerCase() === "you") {
        senderName = getLocalUserName() || senderName;
      }
      if (!senderName) {
        // If we can't find the sender, prefer local user name for self messages.
        senderName = getLocalUserName() || "";
      }
  
      if (textNodes.length > 0) {
        textNodes.forEach((node, msgIdx) => {
          const rawText = node.textContent || "";
          const text = cleanMessageText(rawText, senderName);
          if (!text) return;
  
          // Find timestamp — usually in a sibling or parent time element
          let timeStr = null;
          const timeEl = container.querySelector("time, [aria-label*=':'], [class*='time' i]");
          if (timeEl) {
            timeStr = parseTime(timeEl.getAttribute("datetime") || timeEl.textContent);
          }
          if (!timeStr) {
            // Scan all text for a time pattern
            const allText = container.textContent || "";
            timeStr = parseTime(allText);
          }
  
          // Keep a stable time component for dedup IDs.
          // If Meet doesn't expose a timestamp, we leave it empty for ID stability
          // (display can still show a fallback time).
          const idTime = timeStr || "";
          const displayTime = timeStr || new Date().toLocaleTimeString();
  
          const uniqueKey = messageId
            ? `${messageId}-${msgIdx}`
            : makeChatId({
                sender: senderName,
                time: idTime,
                text,
                msgIdx
              });
  
          const entry = {
            id: uniqueKey,
            type: "chat",
            timestamp: displayTime,
            sender: senderName || "Unknown",
            message: text,
            capturedAt: new Date().toISOString()
          };
  
          saveEntry(entry);
        });
      } else {
        // Fallback: extract all meaningful text from the container
        const allText = (container.textContent || "").replace(/\u202F/g, " ");
        const lines = allText
          .split("\n")
          .map(l => l.trim())
          .filter(l => l && !isNoise(l) && l.length > 1);
  
        // Filter out time strings and build message text
        const parsedTime = parseTime(allText);
        const idTime = parsedTime || "";
        const displayTime = parsedTime || new Date().toLocaleTimeString();
        const msgLines = lines.filter(l => !parseTime(l) && !isNoise(l));
  
        if (msgLines.length === 0) return;
  
        const text = cleanMessageText(msgLines.join(" "), senderName);
        if (!text) return;
  
        const uniqueKey = makeChatId({
          sender: senderName,
          time: idTime,
          text,
          msgIdx: 0
        });
        const entry = {
          id: uniqueKey,
          type: "chat",
          timestamp: displayTime,
          sender: senderName || "Unknown",
          message: text,
          capturedAt: new Date().toISOString()
        };
  
        saveEntry(entry);
      }
    }
  
    // ─── System Event Extraction ──────────────────────────────────────────────
  
    /**
     * Scans for participant join/leave popup notifications.
     * These are ephemeral toast-style nodes that appear briefly.
     */
    function scanSystemEvents() {
      // Google Meet shows join/leave as small overlay notifications
      const selectors = [
        '[data-is-toast]',
        '[aria-live="polite"]',
        '[aria-live="assertive"]',
        '[role="alert"]',
        '[jsname="N5YgVb"]', // Known Meet participant toast jsname
        '[class*="notification" i]',
        '[class*="toast" i]'
      ];
  
      for (const selector of selectors) {
        const nodes = document.querySelectorAll(selector);
        nodes.forEach(node => extractSystemEvent(node));
      }
    }
  
    function extractSystemEvent(node) {
      const text = (node.textContent || "").replace(/\u202F/g, " ").trim();
      if (!text) return;
  
      const lower = text.toLowerCase();
      const isJoin = lower.includes(" joined") || lower.endsWith(" joined") || lower.includes("joined the meeting");
      const isLeave = lower.includes(" left") || lower.endsWith(" left") || lower.includes("left the meeting");
  
      if (!isJoin && !isLeave) return;
  
      // Avoid huge "state" announcements that can repeat (camera/mic status etc.)
      if (text.length > 120) return;
  
      // Debounce by message text (Meet often re-renders the same toast repeatedly)
      const now = Date.now();
      const lastSeen = recentSystemTexts.get(text) || 0;
      if (now - lastSeen < 30000) return; // 30s
      recentSystemTexts.set(text, now);
  
      const timeStr = new Date().toLocaleTimeString();
      const uniqueKey = makeEventId({ time: "", text });
  
      // Don't re-log the same event text within 5 seconds
      if (seenIds.has(uniqueKey)) return;
  
      const entry = {
        id: uniqueKey,
        type: "event",
        timestamp: timeStr,
        sender: "System",
        message: text,
        capturedAt: new Date().toISOString()
      };
  
      saveEntry(entry);
    }
  
    // ─── Chat Panel Detection ─────────────────────────────────────────────────
  
    /**
     * Detects whether the Google Meet chat side panel is currently open.
     * When closed, Meet destroys the chat DOM — we warn the user.
     */
    function detectChatPanelState() {
      // Look for the visible chat input (only present when panel is open)
      const chatInput = document.querySelector(
        'textarea[aria-label*="message" i], [contenteditable][aria-label*="message" i], [data-is-chat-input]'
      );
      const chatList = document.querySelector(
        '[aria-label*="chat messages" i], [role="list"][aria-label*="chat" i]'
      );
  
      const isOpen = !!(chatInput || chatList);
  
      if (isOpen !== chatPanelOpen) {
        chatPanelOpen = isOpen;
        chrome.storage.local.set({ chatPanelOpen: isOpen });
        chrome.runtime.sendMessage({
          type: "CHAT_PANEL_STATE",
          open: isOpen
        }).catch(() => {});
      }
  
      return isOpen;
    }
  
    // ─── Session Management ───────────────────────────────────────────────────
  
    /**
     * Initializes or resets the session when a new meeting is detected.
     */
    async function initSession() {
      const meetId = getMeetingId();
      if (!meetId) return;
  
      if (meetId !== currentMeetingId) {
        console.log(`[MeetSync] New meeting detected: ${meetId}`);
        currentMeetingId = meetId;
        seenIds.clear();
  
        // Store the new session info (do NOT clear old session data)
        await chrome.storage.local.set({
          activeMeetingId: meetId,
          chatPanelOpen: false,
          lastUpdated: Date.now()
        });
  
        chrome.runtime.sendMessage({
          type: "SESSION_STARTED",
          meetingId: meetId
        }).catch(() => {});
  
        // Reload existing IDs into the dedup set to prevent re-logging after page refresh
        const key = `meet_${meetId}`;
        const result = await chrome.storage.local.get(key);
        const existing = result[key] || [];
        existing.forEach(entry => seenIds.add(entry.id));
        console.log(`[MeetSync] Restored ${seenIds.size} existing entries for dedup.`);
      }
    }
  
    // ─── Main Observer Setup ──────────────────────────────────────────────────
  
    /**
     * Debounced scan triggered on every DOM mutation.
     * The 500ms delay gives Meet time to fully render message blocks.
     */
    function scheduleScan() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        detectChatPanelState();
        scanChatMessages();
        scanSystemEvents();
      }, 500);
    }
  
    /**
     * Sets up the primary MutationObserver on document.body.
     * Scoped to subtree changes only — avoids watching attribute noise.
     */
    function startObserver() {
      if (observer) observer.disconnect();
  
      observer = new MutationObserver((mutations) => {
        // Quick filter: only act on mutations that add nodes
        const hasAddedNodes = mutations.some(m => m.addedNodes.length > 0);
        if (hasAddedNodes) {
          scheduleScan();
        }
      });
  
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        // Intentionally NOT observing attributes or characterData
        // to minimize performance overhead
      });
  
      console.log("[MeetSync] Observer started.");
    }
  
    /**
     * Sets up a secondary observer specifically watching for system event toasts.
     * These appear at the top of the Meet UI and vanish quickly.
     */
    function startSystemObserver() {
      if (systemObserver) systemObserver.disconnect();
  
      systemObserver = new MutationObserver(() => {
        scanSystemEvents();
      });
  
      // Watch the entire body for the toast elements
      systemObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
    }
  
    // ─── URL Change Watcher ───────────────────────────────────────────────────
  
    /**
     * Watches for URL changes (Meet navigates without full page reload).
     */
    let lastUrl = window.location.href;
    const urlWatcher = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        initSession();
      }
    });
    urlWatcher.observe(document.body, { childList: true, subtree: true });
  
    // ─── Message Listener ─────────────────────────────────────────────────────
  
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === "GET_STATUS") {
        sendResponse({
          meetingId: currentMeetingId,
          chatPanelOpen,
          seenCount: seenIds.size
        });
      }
      if (msg.type === "MANUAL_SCAN") {
        detectChatPanelState();
        scanChatMessages();
        scanSystemEvents();
        sendResponse({ ok: true });
      }
    });
  
    // ─── Bootstrap ────────────────────────────────────────────────────────────
  
    async function bootstrap() {
      await initSession();
      startObserver();
      startSystemObserver();
      // Initial scan after a short delay to let the page settle
      setTimeout(() => {
        detectChatPanelState();
        scanChatMessages();
      }, 2000);
    }
  
    // Wait for the page to be ready
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", bootstrap);
    } else {
      bootstrap();
    }
  
  })();