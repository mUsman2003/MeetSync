/**
 * MeetSync - content.js
 * The Extraction Engine: Observes Google Meet's DOM and extracts
 * chat messages and participant join/leave events in real-time.
 */

(function () {
    "use strict";
  
    // ─── Force Meet to render in background ───────────────────────────────────
    // Google Meet pauses DOM updates for captions and chat when the tab is hidden.
    // Inject a script into the MAIN DOM world to spoof visibilityState.
    function forceForeground() {
      const script = document.createElement("script");
      script.textContent = `
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
        Object.defineProperty(document, 'hidden', { get: () => false });
        window.addEventListener('visibilitychange', e => e.stopImmediatePropagation(), true);
        document.addEventListener('visibilitychange', e => e.stopImmediatePropagation(), true);
      `;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    }
    forceForeground();

    // ─── State ────────────────────────────────────────────────────────────────
    const seenIds = new Set();       // Deduplication set
    const recentSystemTexts = new Map(); // text -> lastSeenMs
    let debounceTimer = null;        // Scan debounce handle
    let currentMeetingId = null;     // Active meeting ID from URL
    let chatPanelOpen = false;       // Track chat panel state
    let observer = null;             // MutationObserver instance
    let systemObserver = null;       // Observer for system popups
    let localUserName = null;        // Cached display name for "You" / self messages
    let extensionContextValid = true;
    let urlWatcher = null;
    let sessionStartTime = null;     // Timestamp when current meeting started
  
    // ─── Caption / Live Transcription State ──────────────────────────────────
    let captionObserver = null;      // MutationObserver for captions
    let captionContainer = null;     // The DOM node holding live captions
    let captionBuffer = "";          // Accumulates the current caption line
    let captionSpeaker = "";         // Current speaker shown in captions
    let captionFlushTimer = null;    // Debounce timer for flushing finalized caption
    const recentCaptions = [];       // Sliding window for dedup (last N captions)
    const CAPTION_DEDUP_WINDOW = 20; // How many recent captions to keep for dedup
    const seenCaptionHashes = new Set(); // Hash-based dedup for stored captions
  
    // ─── Engagement v2 (DOM attendance + reactions + chat telemetry) ───────────
    /** @type {Map<string, { name: string, avatar: string }>} */
    let engPrevParticipants = new Map();
    /** Maps normalized name key → Meet `data-participant-id` so chat/reactions use same id as attendance. */
    let engNameToParticipantId = new Map();
    let engReactionsObserver = null;
    let engReactionsNode = null;
  
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

    function isContextInvalidatedError(err) {
      const msg = (err && err.message) ? String(err.message) : String(err || "");
      return /Extension context invalidated/i.test(msg);
    }

    function isExtensionApiAvailable() {
      return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;
    }

    function invalidateExtensionContext(err) {
      if (!extensionContextValid) return;
      extensionContextValid = false;
      console.warn("[MeetSync] Extension context invalidated. Refresh the Meet tab.", err);

      try { if (debounceTimer) clearTimeout(debounceTimer); } catch (_) {}
      debounceTimer = null;

      try { if (observer) observer.disconnect(); } catch (_) {}
      try { if (systemObserver) systemObserver.disconnect(); } catch (_) {}
      try { if (urlWatcher) urlWatcher.disconnect(); } catch (_) {}
      detachReactionObserver();
      detachCaptionObserver();
      engNameToParticipantId = new Map();

      observer = null;
      systemObserver = null;
      urlWatcher = null;
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
      // Normalize local user to a stable constant for ID generation
      const senderN = normalizeForId(sender);
      const isLocal = (senderN === "you" || (localUserName && senderN === normalizeForId(localUserName)));
      const senderKey = isLocal ? "__ME__" : senderN;
  
      const textN = normalizeForId(text);
      
      // EXCLUDING 'time' from the fingerprint for maximum stability.
      // In Meet, the text and sender plus the message index in the group 
      // is 99.9% unique. Including time often causes duplicates when 
      // "Just now" updates to a real time.
      const fingerprint = `${senderKey}|${textN}|${msgIdx ?? ""}`;
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
      "copy link", "report", "delete", "edit", "keepPin message"  
    ]);
  
    function isNoise(text) {
      const raw = (text || "").replace(/\u202F/g, " ").trim().toLowerCase();
      if (!raw) return true;
      if (UI_NOISE.has(raw)) return true;
  
      // Meet sometimes concatenates UI strings (e.g. "keepPin message").
      const squashed = raw.replace(/\s+/g, "").replace(/[^a-z]/g, "");
      const noiseTokens = [
        "keep",
        "keepPinmessage",
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

    // ─── Task Detection ───────────────────────────────────────────────────────

    /**
     * Keyword/pattern heuristics that flag a chat message as a likely action item.
     * Intentionally conservative — only strong signals, to minimise false positives.
     */
    const TASK_SIGNALS = [
      /\b(action\s+item|todo|to[-\s]do|follow[\s-]?up|next\s+steps?)\b/i,
      /\b(please|can\s+you|could\s+you|would\s+you|make\s+sure|ensure|don'?t\s+forget|remember\s+to)\b/i,
      /\bby\s+(eod|eow|cob|tomorrow|today|monday|tuesday|wednesday|thursday|friday|\d{1,2}[\/\-]\d{1,2})\b/i,
      /\b(will|shall|going\s+to)\b.{1,60}\b(by|before|today|tomorrow|eod|eow)\b/i,
      /\b(assigned?\s+to|task\s+for|responsible\s+for|owner[:\s])\b/i,
      /\b(needs?\s+to|has\s+to|have\s+to|must|should)\s+(do|fix|check|send|review|update|create|write|prepare|submit|implement|deploy|test|call|email|schedule|book)\b/i,
      /\b(task|deadline|complete|finish|due)\b/i,
      /@\w{2,}/,
    ];

    function detectIsTask(text) {
      if (!text || text.length < 8) return false;
      return TASK_SIGNALS.some(p => p.test(text));
    }

    /**
     * Extracts a participant name from a join/leave notification string.
     * e.g. "Jane Smith joined" → "Jane Smith"
     */
    function extractParticipantName(text) {
      // Improved regex to handle "X joined", "X has joined", "X has left the meeting", etc.
      const m = (text || "").match(/^(.+?)(?:\s+has)?\s+(?:joined|left)(?:\s+the meeting)?\b/i);
      return m ? m[1].trim() : null;
    }

    function getLocalUserName() {
      if (localUserName) return localUserName;
  
      // The most robust 2026 selector: data-self-name attribute
      const selfNameEl = document.querySelector("[data-self-name]");
      if (selfNameEl) {
        const t = (selfNameEl.getAttribute("data-self-name") || "").trim();
        if (t) {
          localUserName = t;
          return localUserName;
        }
      }

      // Fallback: aria-label of the account button
      const accountEl = document.querySelector('[aria-label^="Google Account:" i], button[aria-label^="Google Account:" i]');
      const label = accountEl ? (accountEl.getAttribute("aria-label") || "") : "";
      const m = label.match(/Google Account:\s*([^,(]+?)(?:\s*[,(]|$)/i);
      if (m && m[1]) {
        localUserName = m[1].trim();
        return localUserName;
      }
  
      // Fallback 2: Name in header
      const headerName = document.querySelector(".dwSJ2e, .R6S7W");
      if (headerName && headerName.textContent) {
        const t = headerName.textContent.trim();
        if (t && t.toLowerCase() !== "you") {
          localUserName = t;
          return localUserName;
        }
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

    function inferSenderFromContainerText(container, messageTextSamples = []) {
      const allText = (container.textContent || "").replace(/\u202F/g, " ");
      const msgSet = new Set(
        (messageTextSamples || [])
          .map(t => (t || "").replace(/\u202F/g, " ").trim())
          .filter(Boolean)
      );

      const lines = allText
        .split("\n")
        .map(l => l.trim())
        .filter(l => l && !isNoise(l) && !parseTime(l) && l.length < 60);

      // The first non-noise, non-time line is often the sender label.
      for (const line of lines) {
        if (msgSet.has(line)) continue;
        if (line.length < 2) continue;
        return line;
      }
      return "";
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
        if (!extensionContextValid || !isExtensionApiAvailable()) return;
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
        chrome.runtime.sendMessage({ type: "NEW_ENTRY", entry }).catch((err) => {
          if (isContextInvalidatedError(err)) invalidateExtensionContext(err);
        });

        if (entry.type === "chat" && typeof MeetSyncEngagement !== "undefined") {
          recordChatEngagement(entry).catch(() => {});
        }
      } catch (err) {
        if (isContextInvalidatedError(err)) {
          invalidateExtensionContext(err);
          return;
        }
        console.warn("[MeetSync] Storage error:", err);
      }
    }

    /**
     * Per-participant chat telemetry (encoded) alongside main feed entries.
     */
    async function recordChatEngagement(entry) {
      if (!currentMeetingId || !MeetSyncEngagement) return;
      const meta = await MeetSyncEngagement.ensureMeetingMeta(currentMeetingId);
      if (!meta) return;
      let name = entry.sender || "Unknown";
      if (name.toLowerCase() === "you" || name === "__ME__") {
        name = getLocalUserName() || name;
      }
      const nk = MeetSyncEngagement.normalizeNameKey(name);
      const meetPid = nk ? engNameToParticipantId.get(nk) : null;
      const payload = entry.message || "";
      const enc = MeetSyncEngagement.encodeEvent(
        "chat",
        Date.now(),
        meta.firstSeen,
        payload
      );
      await MeetSyncEngagement.recordParticipantEvents(
        currentMeetingId,
        name,
        "",
        [enc],
        meetPid
      );
    }

    /** Refresh name → Meet participant id map before chat scan so telemetry shares one row with attendance. */
    function refreshEngagementNameMap() {
      engNameToParticipantId.clear();
      if (typeof MeetSyncEngagement === "undefined") return;
      const snap = collectParticipantSnapshots();
      for (const [id, s] of snap) {
        const nk = MeetSyncEngagement.normalizeNameKey(s.name);
        if (nk) engNameToParticipantId.set(nk, id);
      }
    }

    /**
     * Collects participants from People side panel or video grid (data-participant-id).
     */
    function collectParticipantSnapshots() {
      /** @type {Map<string, { name: string, avatar: string }>} */
      const map = new Map();
      if (typeof MeetSyncEngagement === "undefined") return map;
      const panel = document.querySelector("div[data-panel-container-id=sidePanel1]");
      const contributorsList = panel && panel.querySelector("div[role='list']");
      if (contributorsList) {
        contributorsList.querySelectorAll("[data-participant-id]").forEach((node) => {
          const id = node.getAttribute("data-participant-id");
          if (!id) return;
          let name =
            node.querySelector("img")?.parentElement?.nextElementSibling?.firstElementChild?.firstElementChild
              ?.textContent || "";
          name = (name || "").replace(/\u202F/g, " ").trim();
          if (name.includes("(")) name = name.split("(")[0].trim();
          const avatar = node.querySelector("img")?.getAttribute("src") || "";
          if (name && name.length >= 2) {
            map.set(id, {
              name: MeetSyncEngagement.normalizeDisplayName(name),
              avatar
            });
          }
        });
      }
      if (map.size === 0) {
        const tile = document.querySelector("div[data-participant-id]:not([role])");
        const gridRoot = tile && tile.parentElement && tile.parentElement.parentElement;
        if (gridRoot) {
          const firstClass = gridRoot.firstElementChild && gridRoot.firstElementChild.classList[0];
          Array.from(gridRoot.children).forEach((node) => {
            if (firstClass && node.classList[0] !== firstClass) return;
            const inner = node.firstElementChild;
            const id = inner && inner.getAttribute("data-participant-id");
            if (!id) return;
            const nameEl = node.querySelector("div[jsslot] > div");
            let name = nameEl ? (nameEl.textContent || "").replace(/\u202F/g, " ").trim() : "";
            if (name.includes("(")) name = name.split("(")[0].trim();
            const avatar = node.querySelector("img")?.getAttribute("src") || "";
            if (name && name.length >= 2) {
              map.set(id, {
                name: MeetSyncEngagement.normalizeDisplayName(name),
                avatar
              });
            }
          });
        }
      }
      return map;
    }

    /**
     * DOM-based join/leave vs previous snapshot (reference: example/script/Meeting.js).
     */
    async function syncEngagementAttendance() {
      if (!extensionContextValid || !currentMeetingId || typeof MeetSyncEngagement === "undefined") {
        return;
      }
      const meta = await MeetSyncEngagement.ensureMeetingMeta(currentMeetingId);
      if (!meta) return;
      const current = collectParticipantSnapshots();
      if (current.size === 0) return;

      const now = Date.now();
      for (const [id, snap] of current) {
        if (!engPrevParticipants.has(id)) {
          const enc = MeetSyncEngagement.encodeEvent("join", now, meta.firstSeen, "");
          await MeetSyncEngagement.recordParticipantEvents(
            currentMeetingId,
            snap.name,
            snap.avatar,
            [enc],
            id
          );
        }
      }
      for (const [id, snap] of engPrevParticipants) {
        if (!current.has(id)) {
          const enc = MeetSyncEngagement.encodeEvent("leave", now, meta.firstSeen, "");
          await MeetSyncEngagement.recordParticipantEvents(
            currentMeetingId,
            snap.name,
            snap.avatar,
            [enc],
            id
          );
        }
      }
      engPrevParticipants = new Map(current);
    }

    function detachReactionObserver() {
      if (engReactionsObserver) {
        try {
          engReactionsObserver.disconnect();
        } catch (_) {}
      }
      engReactionsObserver = null;
      engReactionsNode = null;
    }

    /**
     * Emoji reactions in grid (reference Meeting._onReactionMutation).
     */
    function tryAttachReactionObserver() {
      if (!extensionContextValid || !currentMeetingId || typeof MeetSyncEngagement === "undefined") {
        return;
      }
      const gridNode = document.querySelector("div[data-participant-id]:not([role])")?.parentElement?.parentElement;
      if (!gridNode) {
        detachReactionObserver();
        return;
      }
      const last = gridNode.lastElementChild;
      const r1 = last && last.previousElementSibling;
      const r2 = r1 && r1.previousElementSibling;
      const r3 = r2 && r2.previousElementSibling;
      const reactionsNode =
        r3 &&
        r3.firstElementChild &&
        r3.firstElementChild.firstElementChild &&
        r3.firstElementChild.firstElementChild.firstElementChild;

      if (!reactionsNode || reactionsNode === engReactionsNode) return;

      detachReactionObserver();
      engReactionsNode = reactionsNode;
      engReactionsObserver = new MutationObserver((mutations) => {
        const ev = mutations.find((m) => m.addedNodes && m.addedNodes.length);
        if (!ev || !ev.addedNodes) return;
        const blob = ev.addedNodes[0] && ev.addedNodes[0].querySelector && ev.addedNodes[0].querySelector("html-blob");
        if (!blob) return;
        const nameRaw = blob.nextElementSibling && blob.nextElementSibling.textContent;
        const name = (nameRaw || "")
          .split(/\s+/g)
          .map((x) => (x ? x[0].toUpperCase() + x.slice(1) : ""))
          .join(" ");
        const emoji = blob.querySelector("img") && blob.querySelector("img").getAttribute("alt");
        if (!name || !emoji) return;
        void (async () => {
          const meta = await MeetSyncEngagement.ensureMeetingMeta(currentMeetingId);
          if (!meta) return;
          const nk = MeetSyncEngagement.normalizeNameKey(name);
          const meetPid = nk ? engNameToParticipantId.get(nk) : null;
          const enc = MeetSyncEngagement.encodeEvent(
            "emoji",
            Date.now(),
            meta.firstSeen,
            emoji || "?"
          );
          await MeetSyncEngagement.recordParticipantEvents(
            currentMeetingId,
            name,
            "",
            [enc],
            meetPid
          );
        })();
      });
      engReactionsObserver.observe(reactionsNode, { childList: true });
    }

    // ─── Caption / Live Transcription Extraction ─────────────────────────────

    let lastCapturedText = "";

    function isNoise(text) {
      if (!text || text.length < 2) return true;
      if (/arrow_downward|jump to bottom/i.test(text)) return true;
      return false;
    }

    /**
     * Start observing for captions.
     * We observe the entire document body for the insertion of new texts.
     * Meet frequently obfuscates classes; we target nodes with typical properties
     * (like specific class patterns or 'dir' attrs) and verify it's a caption.
     */
    function tryAttachCaptionObserver() {
      if (!extensionContextValid || !currentMeetingId) return;
      if (captionObserver) return; // Already observing

      captionObserver = new MutationObserver((mutations) => {
        if (!extensionContextValid || !currentMeetingId) return;

        let foundCaption = false;
        let latestTextChunk = "";

        mutations.forEach((mutation) => {
          if (mutation.addedNodes.length) {
            mutation.addedNodes.forEach((node) => {
              if (node.nodeType === 1 && node.classList) {
                // Meet uses specific wrappers for captions.
                // The user provided structure shows the text is inside `div.ygicle`.
                // We use a broad check for known caption classes or `dir="ltr"`.
                
                // Directly check if this is the text container itself:
                if (node.classList.contains('CNusmb') || 
                    node.classList.contains('ygicle') || 
                    node.getAttribute('dir') === 'ltr') {
                  
                  const newText = (node.innerText || node.textContent || "").replace(/\u202F/g, " ").trim();
                  
                  if (newText && !isNoise(newText)) {
                    latestTextChunk = newText;
                    foundCaption = true;
                  }
                } 
                // Alternatively, the node might be the outer block (`nMcdL`), so scan inside:
                else {
                  const textContainers = node.querySelectorAll('.CNusmb, .ygicle, [dir="ltr"]');
                  textContainers.forEach((tc) => {
                    const newText = (tc.innerText || tc.textContent || "").replace(/\u202F/g, " ").trim();
                    if (newText && !isNoise(newText)) {
                      latestTextChunk = newText;
                      foundCaption = true;
                    }
                  });
                }
              }
            });
          }
          // Also listen for direct text modifications (characterData)
          else if (mutation.type === "characterData" && mutation.target) {
             const parent = mutation.target.parentElement;
             if (parent && (parent.classList.contains('CNusmb') || parent.classList.contains('ygicle') || parent.getAttribute('dir') === 'ltr')) {
                 const newText = (parent.innerText || parent.textContent || "").replace(/\u202F/g, " ").trim();
                 if (newText && !isNoise(newText)) {
                   latestTextChunk = newText;
                   foundCaption = true;
                 }
             }
          }
        });

        // If we extracted a valid text chunk, buffer it and debounce the save.
        if (latestTextChunk && latestTextChunk !== lastCapturedText) {
          captionBuffer = latestTextChunk;
          
          if (captionFlushTimer) clearTimeout(captionFlushTimer);
          captionFlushTimer = setTimeout(() => {
             if (captionBuffer && captionBuffer !== lastCapturedText) {
                lastCapturedText = captionBuffer;
                saveCaptionEntry(captionBuffer);
             }
             captionBuffer = "";
          }, 1500); // Wait 1.5s after the last word is spoken before saving the line
        }

        // Notify popup that captions are active if we found one
        if (foundCaption && extensionContextValid) {
           chrome.runtime.sendMessage({ type: "CAPTION_STATE", enabled: true }).catch((err) => {
             if (isContextInvalidatedError(err)) invalidateExtensionContext(err);
           });
        }
      });


      // Observe the whole body since the caption container appears dynamically
      captionObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });

      console.log("[MeetSync] DOM observer initialized. Waiting for captions...");
    }

    /**
     * Stop observing captions.
     */
    function detachCaptionObserver() {
      if (captionObserver) {
        try { captionObserver.disconnect(); } catch (_) {}
      }
      captionObserver = null;
      lastCapturedText = "";
    }

    /**
     * Saves a finalized caption entry to storage and notifies the popup.
     * Only saves the TEXT — no speaker name as per user request.
     */
    async function saveCaptionEntry(text) {
      if (!extensionContextValid || !isExtensionApiAvailable() || !currentMeetingId) return;
      if (!text || text.length < 2) return;

      // Hash-based dedup
      const h = hashString(normalizeForId(text));
      if (seenCaptionHashes.has(h)) return;

      // Sliding window near-dedup
      const normText = normalizeForId(text);
      for (const rc of recentCaptions) {
        if (normalizeForId(rc.text) === normText) return;
      }

      seenCaptionHashes.add(h);
      recentCaptions.push({ text });
      if (recentCaptions.length > CAPTION_DEDUP_WINDOW) recentCaptions.shift();

      const entry = {
        id: `cap_${h}_${Date.now()}`,
        type: "caption",
        timestamp: new Date().toLocaleTimeString(),
        speaker: "",
        text: text,
        capturedAt: new Date().toISOString()
      };

      try {
        const key = `captions_${currentMeetingId}`;
        const result = await chrome.storage.local.get(key);
        const existing = result[key] || [];
        existing.push(entry);
        await chrome.storage.local.set({ [key]: existing, lastUpdated: Date.now() });
        chrome.runtime.sendMessage({ type: "NEW_CAPTION", entry }).catch((err) => {
          if (isContextInvalidatedError(err)) invalidateExtensionContext(err);
        });
      } catch (err) {
        if (isContextInvalidatedError(err)) { invalidateExtensionContext(err); return; }
        console.warn("[MeetSync] Caption storage error:", err);
      }
    }
  
    // ─── Chat Extraction ──────────────────────────────────────────────────────

  
    /**
     * Scans the chat panel and extracts all visible messages.
     * Handles grouped messages (multiple messages under one sender).
     */
    function scanChatMessages() {
      // Observed Meet DOM variant: each message group container is .Ss4fHf
      const ssContainers = document.querySelectorAll(".Ss4fHf");
      if (ssContainers.length > 0) {
        ssContainers.forEach((container, idx) => extractFromMessageContainer(container, idx));
        return;
      }
  
      // Prefer scanning within the chat panel/list to avoid matching unrelated listitems.
      const chatPanel = document.querySelector(
        '[aria-label*="chat" i][role="complementary"], [data-panel-type="chat"], [aria-label*="chat" i]'
      );

      let messageContainers = [];
      if (chatPanel) {
        const chatList =
          chatPanel.querySelector('[aria-label*="chat messages" i], [role="log"], [role="list"]') ||
          chatPanel;
        messageContainers = Array.from(
          chatList.querySelectorAll('[data-message-id], [role="listitem"], [data-sender-id]')
        );
      } else {
        // Fallback: global selectors (less reliable)
        messageContainers = Array.from(
          document.querySelectorAll('[data-message-id], [jsname="xySENc"] [data-sender-id], [role="listitem"]')
        );
      }
  
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
  
      // Observed Meet DOM variant (.Ss4fHf blocks)
      if (container.classList && container.classList.contains("Ss4fHf")) {
        // Try the primary selector, then additional variants Meet uses
        const authorEl = container.querySelector(".poVWob, .mNHP2e, [data-sender-name]");
        const timeEl   = container.querySelector(".MuzmKe, time, [class*='time' i]");
        let authorRaw  = authorEl ? (authorEl.textContent || "").replace(/\u202F/g, " ").trim() : "";
        const timeRaw  = timeEl  ? (timeEl.textContent  || "").replace(/\u202F/g, " ").trim() : "";

        // If author is still empty, try to find the name in aria-label of the container
        if (!authorRaw) {
          const aria = (container.getAttribute("aria-label") || "").replace(/\u202F/g, " ").trim();
          if (aria) {
            const timeIdx = aria.search(/\d{1,2}:\d{2}/);
            if (timeIdx > 0) authorRaw = aria.slice(0, timeIdx).trim();
          }
        }

        const author =
          !authorRaw
            ? (getLocalUserName() || "Unknown")  // Host's own messages often have no name label
            : authorRaw.toLowerCase() === "you"
              ? (getLocalUserName() || authorRaw)
              : authorRaw;

        const parsedTime = parseTime(timeRaw) || parseTime(container.textContent || "");
        const idTime = parsedTime || "";
        const displayTime = parsedTime || new Date().toLocaleTimeString();

        const lineEls = container.querySelectorAll('.ptNLrf, [jsname="W297wb"]');
        if (lineEls.length > 0) {
          Array.from(lineEls).forEach((lineEl, msgIdx) => {
            const rawText = lineEl.textContent || "";
            const text = cleanMessageText(rawText, author);
            if (!text) return;

            const uniqueKey = messageId
              ? `${messageId}-${msgIdx}`
              : makeChatId({ sender: author, time: idTime, text, msgIdx });

            saveEntry({
              id: uniqueKey,
              type: "chat",
              timestamp: displayTime,
              sender: author || "Unknown",
              message: text,
              isTask: detectIsTask(text),
              capturedAt: new Date().toISOString()
            });
          });
          return;
        }

        // Fallback: treat entire container as one message
        const text = cleanMessageText(container.textContent || "", author);
        if (!text) return;

        const uniqueKey = messageId
          ? `${messageId}-0`
          : makeChatId({ sender: author, time: idTime, text, msgIdx: 0 });

        saveEntry({
          id: uniqueKey,
          type: "chat",
          timestamp: displayTime,
          sender: author || "Unknown",
          message: text,
          isTask: detectIsTask(text),
          capturedAt: new Date().toISOString()
        });
        return;
      }

      // Find all text message nodes — individual message bubbles within a group
      // Meet groups multiple messages from the same sender under one header
      // Prefer stable selectors first.
      let textNodes = container.querySelectorAll('[data-message-text], [jsname="W297wb"], [jsname="r4nke"]');
      // Secondary fallback (some Meet builds don't use the attributes above).
      // Keep it narrower than the old broad selectors by excluding buttons/menus.
      if (textNodes.length === 0) {
        textNodes = container.querySelectorAll(
          'div[jsname="W297wb"] span, span[jsname="W297wb"], div[dir="auto"] span'
        );
      }
  
      const messageTextSamples = Array.from(textNodes)
        .map(n => (n.textContent || "").replace(/\u202F/g, " ").trim())
        .filter(Boolean);
      let senderName = pickBestSenderName(container, messageTextSamples) || "";
      if (!senderName) senderName = trySenderFromAria(container);
      if (!senderName) senderName = inferSenderFromContainerText(container, messageTextSamples);
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
            isTask: detectIsTask(text),
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
          isTask: detectIsTask(text),
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

      // Ignore verbose self-state announcements that repeat frequently.
      if (lower.startsWith("you have joined the call")) return;
  
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
  
      const participantName = extractParticipantName(text);
      const entry = {
        id: uniqueKey,
        type: "event",
        timestamp: timeStr,
        sender: "System",
        message: text,
        isJoin,
        isLeave,
        participantName,
        capturedAt: new Date().toISOString()
      };
  
      saveEntry(entry);
    }
  
    /**
     * Active Participant Scanner
     * Scrapes the "People" panel if open, and reads the participant count button.
     */
    function scanActiveParticipants() {
      // 1. Grab attendee count from the "Show everyone" button
      const countEl = document.querySelector(".p2hF1c, [aria-label*='Show everyone' i] [class*='count' i]");
      if (countEl) {
        const count = parseInt(countEl.textContent || "0");
        if (count > 0 && extensionContextValid) {
          chrome.storage.local.set({ participantCount: count }).catch(err => {
            if (isContextInvalidatedError(err)) invalidateExtensionContext(err);
          });
        }
      }

      // 2. Engagement v2: DOM-based join/leave + reaction observer (no spammy feed events)
      void syncEngagementAttendance();
      tryAttachReactionObserver();
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
        if (extensionContextValid) {
          chrome.storage.local.set({ chatPanelOpen: isOpen }).catch(err => {
            if (isContextInvalidatedError(err)) invalidateExtensionContext(err);
          });
          chrome.runtime.sendMessage({
            type: "CHAT_PANEL_STATE",
            open: isOpen
          }).catch(err => {
            if (isContextInvalidatedError(err)) invalidateExtensionContext(err);
          });
        }
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
        engPrevParticipants = new Map();
        engNameToParticipantId = new Map();
        detachReactionObserver();
        detachCaptionObserver();
        seenCaptionHashes.clear();
        recentCaptions.length = 0;
        captionBuffer = "";
        captionSpeaker = "";
        if (typeof MeetSyncEngagement !== "undefined") {
          MeetSyncEngagement.ensureMeetingMeta(meetId).catch(() => {});
        }
  
        // Store the new session info (do NOT clear old session data)
        sessionStartTime = Date.now();
        if (extensionContextValid) {
          try {
            await chrome.storage.local.set({
              activeMeetingId: meetId,
              chatPanelOpen: false,
              lastUpdated: Date.now(),
              sessionStartTime
            });
    
            chrome.runtime.sendMessage({
              type: "SESSION_STARTED",
              meetingId: meetId,
              startTime: sessionStartTime
            });
          } catch (err) {
            if (isContextInvalidatedError(err)) invalidateExtensionContext(err);
          }
        }
  
        // Reload existing IDs into the dedup set to prevent re-logging after page refresh
        const key = `meet_${meetId}`;
        if (extensionContextValid) {
          try {
            const result = await chrome.storage.local.get(key);
            const existing = result[key] || [];
            existing.forEach(entry => seenIds.add(entry.id));
            console.log(`[MeetSync] Restored ${seenIds.size} existing entries for dedup.`);
          } catch (err) {
            if (isContextInvalidatedError(err)) invalidateExtensionContext(err);
          }
        }
      }
    }
  
    // ─── Main Observer Setup ──────────────────────────────────────────────────
  
    /**
     * Debounced scan triggered on every DOM mutation.
     * The 500ms delay gives Meet time to fully render message blocks.
     */
    function scheduleScan() {
      if (!extensionContextValid) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (!extensionContextValid) return;
        refreshEngagementNameMap();
        detectChatPanelState();
        scanChatMessages();
        scanSystemEvents();
        scanActiveParticipants();
        tryAttachCaptionObserver();
      }, 500);
    }

    /**
     * Sets up the primary MutationObserver on document.body.
     * Watches for chat changes and system event toasts in one go.
     */
    function startObserver() {
      if (observer) observer.disconnect();
  
      observer = new MutationObserver((mutations) => {
        // Only act on mutations that add nodes to minimize overhead
        if (mutations.some(m => m.addedNodes.length > 0)) {
          scheduleScan();
        }
      });
  
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
  
      console.log("[MeetSync] Observer started.");
    }
  
    // ─── URL Change Watcher ───────────────────────────────────────────────────
  
    /**
     * Watches for URL changes (Meet navigates without full page reload).
     */
    let lastUrl = window.location.href;
    urlWatcher = new MutationObserver(() => {
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
          captionsActive: !!captionObserver,
          seenCount: seenIds.size,
          captionCount: seenCaptionHashes.size
        });
      }
      if (msg.type === "MANUAL_SCAN") {
        detectChatPanelState();
        scanChatMessages();
        scanSystemEvents();
        tryAttachCaptionObserver();
        sendResponse({ ok: true });
      }
    });
  
    // ─── Bootstrap ────────────────────────────────────────────────────────────
  
    async function bootstrap() {
      if (!isExtensionApiAvailable()) {
        invalidateExtensionContext(new Error("Extension API not available."));
        return;
      }
      await initSession();
      startObserver();
      // Initial scan after a short delay to let the page settle
      setTimeout(() => {
        if (!extensionContextValid) return;
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