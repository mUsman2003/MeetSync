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
  // forceForeground removed: Google Meet's strict CSP prevents inline script injection 
  // and will fatally terminate the extension script even if wrapped in a try/catch.

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
    
    // Use console.log without the err object to prevent Chrome from 
    // flagging this as a critical extension error in the dashboard.
    console.log("[MeetSync] Extension context invalidated (expected after extension reload). Please refresh the Meet tab.");

    try { if (debounceTimer) clearTimeout(debounceTimer); } catch (_) { }
    debounceTimer = null;

    try { if (observer) observer.disconnect(); } catch (_) { }
    try { if (systemObserver) systemObserver.disconnect(); } catch (_) { }
    try { if (urlWatcher) urlWatcher.disconnect(); } catch (_) { }
    detachReactionObserver();
    detachCaptionObserver();
    engNameToParticipantId = new Map();

    observer = null;
    systemObserver = null;
    urlWatcher = null;
  }

  function safeSendMessage(msg) {
    if (!extensionContextValid || !isExtensionApiAvailable()) return;
    try {
      chrome.runtime.sendMessage(msg).catch((err) => {
        if (isContextInvalidatedError(err)) invalidateExtensionContext(err);
      });
    } catch (err) {
      if (isContextInvalidatedError(err)) invalidateExtensionContext(err);
    }
  }

  /**
   * Generates a stable unique ID for a message entry.
   */
  function normalizeForId(value) {
    return (value || "")
      .replace(/\u202F/g, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, "") // Strip all punctuation, keeping letters and numbers across all languages
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
    // Normalize local user to a stable constant for ID generation.
    // "Unknown" is treated as local because Meet sometimes fails to resolve
    // the host's name, causing the same message to be saved twice.
    const senderN = normalizeForId(sender);
    const isLocal = (
      senderN === "you" ||
      senderN === "unknown" ||
      senderN === "__me__" ||
      senderN === "host(you)" ||
      senderN === "host (you)" ||
      (localUserName && senderN === normalizeForId(localUserName))
    );
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
    // Include a minute-level bucket so the same name can be recorded
    // joining/leaving across different minutes without being deduped.
    const minuteBucket = Math.floor(Date.now() / 60000);
    return `event_${hashString(`${minuteBucket}|${timeN}|${textN}`)}`;
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
      "keepPin message",
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

  /**
   * Extract ONLY the actual message text from a chat line element (.ptNLrf),
   * completely excluding action button overlays (Keep, Pin, Reply, etc.).
   * Meet renders these as sibling/child elements inside the same container.
   */
  function getCleanMessageText(lineEl) {
    if (!lineEl) return "";

    // Strategy 1: Get the first span with a dir attribute (ltr, rtl, auto) which is usually the message text
    const dirSpan = lineEl.querySelector('span[dir="ltr"], span[dir="rtl"], span[dir="auto"]');
    if (dirSpan) {
      return (dirSpan.textContent || "").replace(/\u202F/g, " ").trim();
    }

    // Strategy 2: Get the first <span> child that contains text (skip button spans)
    const spans = lineEl.querySelectorAll("span");
    for (const span of spans) {
      // Skip spans inside button/action containers. Use [data-tooltip] as a reliable indicator
      // for Meet's action buttons, regardless of localization language.
      if (span.closest('button, [role="button"], [data-tooltip], [aria-label*="pin" i], [aria-label*="keep" i], [aria-label*="reply" i]')) continue;
      const t = (span.textContent || "").replace(/\u202F/g, " ").trim();
      if (t && t.length > 0) return t;
    }

    // Strategy 3: Walk child nodes, skipping action button containers
    let text = "";
    for (const child of lineEl.childNodes) {
      if (child.nodeType === 3) { // TEXT_NODE
        text += child.textContent;
      } else if (child.nodeType === 1) {
        // Skip known action button containers
        const tag = child.tagName?.toLowerCase();
        if (tag === "button" || child.getAttribute("role") === "button" || child.hasAttribute("data-tooltip")) continue;
        const ariaLabel = (child.getAttribute("aria-label") || "").toLowerCase();
        if (ariaLabel && (ariaLabel.includes("pin") || ariaLabel.includes("keep") || ariaLabel.includes("reply"))) continue;
        
        // Only get text from first meaningful child
        if (!text) text = (child.textContent || "");
      }
    }
    text = text.replace(/\u202F/g, " ").trim();
    if (text) return text;

    // Final fallback: innerText
    return (lineEl.innerText || lineEl.textContent || "").replace(/\u202F/g, " ").trim();
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
    // Meet concatenates button labels directly onto message text, e.g.:
    //   "hi" → "hikeepPin message" or "hello keepPin message"
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
      "remove reaction",
      "keepPin message",
      "Pin message"
    ];
    const tailRe = new RegExp(`(?:\\s*(?:${tailNoise.map(t => t.replace(/ /g, "\\s+")).join("|")}))+\\s*$`, "i");
    cleaned = cleaned.replace(tailRe, "").trim();

    // Aggressive final pass: strip concatenated noise that has NO space separator.
    // E.g. "hikeepPin message" → "hi", "stillkeepPin message" → "still"
    cleaned = cleaned.replace(/(?:keepPin\s*message|keep\s*Pin\s*message|Pin\s*message|Unpin\s*message|More\s*options|Remove\s*reaction|Copy\s*link)\s*$/i, "").trim();
    // Handle backslash-prefixed: "ahmed\keepPin message"
    cleaned = cleaned.replace(/\\?(?:keepPin\s*message|Pin\s*message)\s*$/i, "").trim();
    // Also handle the fully squashed "keepPinmessage" variant
    cleaned = cleaned.replace(/(?:keepPinmessage|keepPin|Pinmessage)\s*$/i, "").trim();

    // If after stripping everything is empty, drop it
    if (!cleaned || cleaned.length < 1) return "";

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

    // Selector 1: data-self-name attribute (most reliable 2026)
    const selfNameEl = document.querySelector("[data-self-name]");
    if (selfNameEl) {
      const t = (selfNameEl.getAttribute("data-self-name") || "").trim();
      if (t) { localUserName = t; persistLocalUserName(t); return t; }
    }

    // Selector 2: Google Account aria-label button
    const accountEl = document.querySelector('[aria-label^="Google Account:" i], button[aria-label^="Google Account:" i]');
    const label = accountEl ? (accountEl.getAttribute("aria-label") || "") : "";
    const m = label.match(/Google Account:\s*([^,(]+?)(?:\s*[,(]|$)/i);
    if (m && m[1]) {
      localUserName = m[1].trim();
      persistLocalUserName(localUserName);
      return localUserName;
    }

    // Selector 3: Name in header element
    const headerName = document.querySelector(".dwSJ2e, .R6S7W");
    if (headerName && headerName.textContent) {
      const t = headerName.textContent.trim();
      if (t && t.toLowerCase() !== "you") {
        localUserName = t;
        persistLocalUserName(t);
        return t;
      }
    }

    // Selector 4: Participant tile that has "(You)" or "(Meeting host)" label
    const tiles = document.querySelectorAll("[data-participant-id]");
    for (const tile of tiles) {
      const label = tile.textContent || "";
      if (/(\(You\)|\(Meeting host\))/i.test(label)) {
        // Extract name before the parenthetical
        const namePart = label.split(/\s*\(/)[0].replace(/\u202F/g, " ").trim();
        if (namePart && namePart.length >= 2 && namePart.toLowerCase() !== "you") {
          localUserName = namePart;
          persistLocalUserName(namePart);
          return namePart;
        }
      }
    }

    return null;
  }

  function persistLocalUserName(name) {
    if (!name || !extensionContextValid) return;
    try { chrome.storage.local.set({ localUserName: name }).catch(() => {}); } catch(err) {}
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

      // ── Synchronous dedup guard (BEFORE any await) ─────────────────────────
      // Two scans can fire within milliseconds of each other. If we check
      // seenIds after an await, both calls pass the check before either
      // completes the async storage write — causing duplicates.
      // By guarding synchronously here, the second concurrent call is rejected
      // immediately without waiting for storage at all.
      if (seenIds.has(entry.id)) return;
      seenIds.add(entry.id); // claim the ID now, synchronously

      const key = `meet_${currentMeetingId}`;
      const result = await chrome.storage.local.get([key, "activeMeetingId"]);
      const existing = result[key] || [];

      // Storage-level dedup (handles the case where the extension restarted
      // and seenIds was cleared but the entry already exists in storage)
      if (existing.some(e => e.id === entry.id)) return;

      existing.push(entry);
      await chrome.storage.local.set({
        [key]: existing,
        activeMeetingId: currentMeetingId,
        lastUpdated: Date.now()
      });

      // Notify popup if open
      safeSendMessage({ type: "NEW_ENTRY", entry });

      if (entry.type === "chat" && typeof MeetSyncEngagement !== "undefined") {
        recordChatEngagement(entry).catch(() => { });
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
      } catch (_) { }
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

  // ─── Body-level reaction fallback observer ────────────────────────────────
  // Watches the whole body for html-blob elements (unique to Meet emoji
  // reactions). Works regardless of Meet DOM restructuring, complementing
  // the fragile grid-path approach above.
  let bodyReactionObserver = null;
  function ensureBodyReactionObserver() {
    if (bodyReactionObserver) return;
    bodyReactionObserver = new MutationObserver((mutations) => {
      if (!extensionContextValid || !currentMeetingId || typeof MeetSyncEngagement === "undefined") return;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!node || !node.querySelector) continue;
          const blob = (node.tagName || "").toLowerCase() === "html-blob"
            ? node
            : node.querySelector && node.querySelector("html-blob");
          if (!blob) continue;
          const nameRaw = blob.nextElementSibling ? blob.nextElementSibling.textContent : "";
          const name = (nameRaw || "").trim().split(/\s+/)
            .map(x => x ? x[0].toUpperCase() + x.slice(1) : "").join(" ");
          const emoji = blob.querySelector("img") ? blob.querySelector("img").getAttribute("alt") : "";
          if (!name || !emoji) continue;
          void (async () => {
            const meta = await MeetSyncEngagement.ensureMeetingMeta(currentMeetingId);
            if (!meta) return;
            const nk = MeetSyncEngagement.normalizeNameKey(name);
            const meetPid = nk ? engNameToParticipantId.get(nk) : null;
            const enc = MeetSyncEngagement.encodeEvent("emoji", Date.now(), meta.firstSeen, emoji || "?");
            await MeetSyncEngagement.recordParticipantEvents(currentMeetingId, name, "", [enc], meetPid);
          })();
        }
      }
    });
    bodyReactionObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Caption / Live Transcription Extraction ─────────────────────────────

  let lastCapturedText = "";

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
        
        // Handle caption block removals to prevent dropping transcripts that disappear quickly
        if (mutation.removedNodes.length) {
          mutation.removedNodes.forEach((node) => {
            if (node.nodeType === 1 && node.classList && (node.classList.contains('nMcdL') || node.classList.contains('CNusmb') || node.classList.contains('iOzk7') || node.hasAttribute('jsname'))) {
              if (captionBuffer && captionBuffer !== lastCapturedText) {
                // The caption block was removed before the debounce timer fired. Force save now!
                saveCaptionEntry(captionBuffer, captionSpeaker);
                lastCapturedText = captionBuffer;
                captionBuffer = "";
                if (captionFlushTimer) clearTimeout(captionFlushTimer);
              }
            }
          });
        }

        // Also listen for direct text modifications (characterData)
        if (mutation.type === "characterData" && mutation.target) {
          const parent = mutation.target.parentElement;
          if (parent && (parent.classList?.contains('CNusmb') || parent.classList?.contains('ygicle') || parent.getAttribute('dir') === 'ltr')) {
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
        
        // FORCE FLUSH: If the new text is completely different from the current buffer, 
        // it means Meet started a new caption block (speaker continued, but UI refreshed).
        // If we don't save now, the previous text is overwritten and lost forever.
        const normLatest = normalizeForId(latestTextChunk);
        const normBuffer = normalizeForId(captionBuffer);
        
        if (normBuffer && !normLatest.includes(normBuffer) && !normBuffer.includes(normLatest)) {
          // Force save the old buffer immediately before overwriting it
          if (captionFlushTimer) clearTimeout(captionFlushTimer);
          captionFlushTimer = null;
          const prevBuffer = captionBuffer;
          captionBuffer = ""; // CRITICAL: reset BEFORE async save so the debounce timer never re-saves it
          lastCapturedText = prevBuffer;
          saveCaptionEntry(prevBuffer, captionSpeaker);
        }

        captionBuffer = latestTextChunk;

        // Extract speaker name from the caption block using multiple strategies.
        // Meet's caption DOM varies between versions; we try several approaches.
        let detectedSpeaker = "";
        try {
          // Strategy 1: Find caption blocks and match the one with our text
          const captionBlocks = document.querySelectorAll('.nMcdL, [jsname="tgaKEf"], .iOzk7, [class*="caption" i]');
          captionBlocks.forEach(block => {
            if (detectedSpeaker) return; // already found
            const textEl = block.querySelector('.CNusmb, .ygicle, [dir="ltr"], span[dir="ltr"]');
            if (textEl) {
              const blockText = (textEl.innerText || textEl.textContent || "").replace(/\u202F/g, " ").trim();
              if (blockText === latestTextChunk || blockText.includes(latestTextChunk) || latestTextChunk.includes(blockText)) {
                
                // Look within block, and its immediate parents up to 3 levels
                let currentScope = block;
                for (let i = 0; i < 3 && currentScope && !detectedSpeaker; i++) {
                  // Try known speaker label selectors
                  const speakerEl = currentScope.querySelector('.zs7s8d, .KcIKyf, .YTbUzc, .jxFHg, .poVWob, .mNHP2e, [data-sender-name], [class*="speaker" i], [class*="name" i]:not([class*="js"])');
                  if (speakerEl && speakerEl !== textEl) {
                    detectedSpeaker = (speakerEl.innerText || speakerEl.textContent || "").replace(/\u202F/g, " ").trim();
                  }
                  
                  // Fallback: Check for an image avatar which usually has the alt text as the user's name
                  if (!detectedSpeaker) {
                    const imgEl = currentScope.querySelector('img[src*="googleusercontent"], img');
                    if (imgEl && imgEl.alt) {
                      detectedSpeaker = imgEl.alt.trim();
                    }
                  }
                  currentScope = currentScope.parentElement;
                }
              }
            }
          });

          // Strategy 2: Use the caption container's full text to extract speaker
          // Caption blocks often render as: "Speaker Name\ncaption text"
          if (!detectedSpeaker) {
            captionBlocks.forEach(block => {
              if (detectedSpeaker) return;
              const fullText = (block.innerText || "").replace(/\u202F/g, " ").trim();
              if (fullText.includes(latestTextChunk)) {
                const lines = fullText.split("\n").map(l => l.trim()).filter(Boolean);
                if (lines.length >= 2 && lines[lines.length - 1].includes(latestTextChunk)) {
                  // First line is the speaker name
                  const candidateName = lines[0];
                  if (candidateName.length > 1 && candidateName.length < 50 && !/^\d/.test(candidateName)) {
                    detectedSpeaker = candidateName;
                  }
                }
              }
            });
          }

          // Strategy 3: aria-label on parent elements
          if (!detectedSpeaker) {
            const allCaptionTexts = document.querySelectorAll('.CNusmb, .ygicle, [dir="ltr"]');
            allCaptionTexts.forEach(el => {
              if (detectedSpeaker) return;
              const t = (el.innerText || el.textContent || "").replace(/\u202F/g, " ").trim();
              if (t === latestTextChunk) {
                let parent = el.parentElement;
                for (let i = 0; i < 5 && parent; i++) {
                  const aria = parent.getAttribute("aria-label") || "";
                  if (aria && aria.length > t.length) {
                    const name = aria.replace(t, "").replace(/[,.:]/g, "").trim();
                    if (name.length > 1 && name.length < 50) {
                      detectedSpeaker = name;
                      break;
                    }
                  }
                  parent = parent.parentElement;
                }
              }
            });
          }
        } catch (_) { }
        captionSpeaker = detectedSpeaker || captionSpeaker;

        if (captionFlushTimer) clearTimeout(captionFlushTimer);
        captionFlushTimer = setTimeout(() => {
          if (captionBuffer && captionBuffer !== lastCapturedText) {
            lastCapturedText = captionBuffer;
            saveCaptionEntry(captionBuffer, captionSpeaker);
          }
          captionBuffer = "";
        }, 4000); // Wait 4.0s after the last word is spoken before saving the line
      }

      // Notify popup that captions are active if we found one
      if (foundCaption && extensionContextValid) {
        safeSendMessage({ type: "CAPTION_STATE", enabled: true });
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
      try { captionObserver.disconnect(); } catch (_) { }
    }
    captionObserver = null;
    lastCapturedText = "";
  }

  /**
   * Saves a finalized caption entry to storage and notifies the popup.
   * Includes the speaker name when available.
   */
  async function saveCaptionEntry(text, speaker) {
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

    // Resolve speaker identity
    let resolvedSpeaker = (speaker || "").trim();
    if (!resolvedSpeaker || resolvedSpeaker.toLowerCase() === "you") {
      resolvedSpeaker = getLocalUserName() || "Host (You)";
    }

    const entry = {
      id: `cap_${h}_${Date.now()}`,
      type: "caption",
      timestamp: new Date().toLocaleTimeString(),
      speaker: resolvedSpeaker,
      text: text,
      capturedAt: new Date().toISOString()
    };

    try {
      const key = `captions_${currentMeetingId}`;
      const result = await chrome.storage.local.get(key);
      const existing = result[key] || [];
      existing.push(entry);
      await chrome.storage.local.set({ [key]: existing, lastUpdated: Date.now() });
      safeSendMessage({ type: "NEW_CAPTION", entry });
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
    // Strategy 1: Look for the chat textarea (most reliable panel indicator as of 2025)
    // When the chat panel is open, a textarea with aria-label "Send a message" is present.
    const chatTextarea = document.querySelector(
      'textarea[aria-label*="message" i], [contenteditable][aria-label*="message" i], [data-is-chat-input]'
    );
    // Strategy 2: Look for the Ss4fHf group container that holds message groups
    const hasMsgGroups = document.querySelector('.Ss4fHf');
    // Strategy 3: Legacy panel selector (may no longer work but kept as fallback)
    const legacyPanel = document.querySelector('[aria-label*="chat" i][role="complementary"]');

    const chatIsOpen = !!(chatTextarea || hasMsgGroups || legacyPanel);
    if (!chatIsOpen) return;

    // Primary: data-message-id bubbles (confirmed still present in 2025 Meet)
    const msgBubbles = Array.from(document.querySelectorAll('[data-message-id]'));
    if (msgBubbles.length > 0) {
      msgBubbles.forEach((bubble) => extractFromBubble(bubble));
      return;
    }

    // Fallback: scan Ss4fHf groups for any message-like children
    const groups = document.querySelectorAll('.Ss4fHf');
    if (groups.length > 0) {
      let idx = 0;
      groups.forEach(group => {
        group.querySelectorAll('[role="listitem"], [data-is-bot-message]').forEach(block => {
          extractFromBubble(block, idx++);
        });
      });
    }
  }

  function extractFromBubble(bubble, fallbackIdx = 0) {
    const messageId = bubble.getAttribute("data-message-id");
    
    // 1. Find Author
    let authorRaw = "";
    // Messages from others are grouped inside .Ss4fHf with a sender name header
    const parentGroup = bubble.closest('.Ss4fHf');
    if (parentGroup) {
      // Priority 1: data-sender-name attribute (confirmed stable in 2025 Meet DOM)
      const bySenderAttr = parentGroup.querySelector('[data-sender-name]');
      if (bySenderAttr) {
        authorRaw = (bySenderAttr.getAttribute('data-sender-name') || bySenderAttr.textContent || '')
          .replace(/\u202F/g, ' ').trim();
      }

      // Priority 2: known sender name classes (may still work on some Meet versions)
      if (!authorRaw) {
        const byClass = parentGroup.querySelector('.poVWob, .mNHP2e, .zg9pAb');
        if (byClass) authorRaw = (byClass.textContent || '').replace(/\u202F/g, ' ').trim();
      }

      // Priority 3: avatar img alt text (Meet sets alt to person's name)
      if (!authorRaw) {
        const avatarImg = parentGroup.querySelector('img[alt]');
        if (avatarImg) {
          const alt = (avatarImg.getAttribute('alt') || '').trim();
          if (alt && alt.length >= 2 && alt.length < 60 && !isNoise(alt)) authorRaw = alt;
        }
      }

      // Priority 4: aria-label on the group (e.g. "Ahmed 7:45 PM message text")
      if (!authorRaw) {
        const aria = (parentGroup.getAttribute('aria-label') || '').replace(/\u202F/g, ' ').trim();
        if (aria) {
          const timeIdx = aria.search(/\d{1,2}:\d{2}/);
          if (timeIdx > 0) authorRaw = aria.slice(0, timeIdx).trim();
        }
      }
    }
    
    // If no author found (self messages lack names and parent groups), use local user identity
    let author = !authorRaw ? (getLocalUserName() || "__ME__") : authorRaw;
    if (author.toLowerCase() === "you") author = getLocalUserName() || "__ME__";

    // 2. Find Time
    let timeRaw = "";
    const timeEl = parentGroup ? parentGroup.querySelector("time, [class*='time' i]") : null;
    if (timeEl) timeRaw = (timeEl.textContent || "").replace(/\u202F/g, " ").trim();
    
    const parsedTime = parseTime(timeRaw) || parseTime(bubble.textContent || "");
    const displayTime = parsedTime || new Date().toLocaleTimeString();
    const idTime = parsedTime || "";

    // 3. Extract Text
    let rawText = "";

    // Priority 1: jsname="dTKtvb" — confirmed message text container in 2025 Meet
    const byDtktvb = bubble.querySelector('[jsname="dTKtvb"]');
    if (byDtktvb) {
      rawText = (byDtktvb.textContent || '').replace(/\u202F/g, ' ').trim();
    }

    // Priority 2: data-message-text attribute
    if (!rawText) {
      const byAttr = bubble.querySelector('[data-message-text]');
      if (byAttr) rawText = (byAttr.textContent || '').replace(/\u202F/g, ' ').trim();
    }

    // Priority 3: old jsname (W297wb) — kept for older Meet versions
    if (!rawText) {
      const byOldJsname = bubble.querySelector('[jsname="W297wb"]');
      if (byOldJsname) rawText = (byOldJsname.textContent || '').replace(/\u202F/g, ' ').trim();
    }

    // Priority 4: span with dir attribute (ltr/rtl/auto)
    if (!rawText) {
      const dirSpan = bubble.querySelector('span[dir="ltr"], span[dir="rtl"], span[dir="auto"]');
      if (dirSpan) rawText = (dirSpan.textContent || '').replace(/\u202F/g, ' ').trim();
    }

    // Priority 5: getCleanMessageText helper (strips button overlays)
    if (!rawText) rawText = getCleanMessageText(bubble);

    // Priority 6: full textContent fallback
    if (!rawText) rawText = (bubble.textContent || '').replace(/\u202F/g, ' ').trim();

    const text = cleanMessageText(rawText, author);
    if (!text) return;

    // 4. Save Entry
    // The messageId is 100% unique per bubble provided by Google Meet.
    const uniqueKey = messageId 
      ? `${messageId}-0` 
      : makeChatId({ sender: author, time: idTime, text, msgIdx: fallbackIdx });

    saveEntry({
      id: uniqueKey,
      type: "chat",
      timestamp: displayTime,
      sender: author,
      message: text,
      isTask: detectIsTask(text),
      capturedAt: new Date().toISOString()
    });
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
    const text = (node.textContent || "").replace(/\u202F/g, " ").replace(/\s+/g, " ").trim();
    if (!text) return;

    const lower = text.toLowerCase();
    const isJoin = lower.includes(" joined") || lower.endsWith(" joined") || lower.includes("joined the meeting");
    const isLeave = lower.includes(" left") || lower.endsWith(" left") || lower.includes("left the meeting");

    if (!isJoin && !isLeave) return;

    // Ignore verbose self-state announcements that repeat frequently.
    if (lower.startsWith("you have joined the call")) return;

    // Avoid huge "state" announcements that can repeat (camera/mic status etc.)
    if (text.length > 120) return;

    const participantName = extractParticipantName(text);
    const action = isJoin ? "join" : "leave";

    // Dedup by normalized "participant:action" key with a 2-minute window.
    // Meet keeps re-rendering the same toast, so we only allow ONE event per
    // participant per action type within each 2-minute window.
    const dedupKey = `${(participantName || text).toLowerCase().replace(/\s+/g, "")}:${action}`;
    const now = Date.now();
    const lastSeen = recentSystemTexts.get(dedupKey) || 0;
    if (now - lastSeen < 120000) return; // 2-minute window per participant+action
    recentSystemTexts.set(dedupKey, now);

    const timeStr = new Date().toLocaleTimeString();
    const uniqueKey = `event_${hashString(`${dedupKey}|${Math.floor(now / 120000)}`)}`;

    if (seenIds.has(uniqueKey)) return;

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
        try {
          chrome.storage.local.set({ participantCount: count }).catch(err => {
            if (isContextInvalidatedError(err)) invalidateExtensionContext(err);
          });
        } catch(err) {
          if (isContextInvalidatedError(err)) invalidateExtensionContext(err);
        }
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
    // Also check for the Ss4fHf message group — present whenever chat panel is open
    const hasMsgGroup = !!document.querySelector('.Ss4fHf');

    const isOpen = !!(chatInput || chatList || hasMsgGroup);

    if (isOpen !== chatPanelOpen) {
      chatPanelOpen = isOpen;
      if (extensionContextValid) {
        try {
          chrome.storage.local.set({ chatPanelOpen: isOpen }).catch(err => {
            if (isContextInvalidatedError(err)) invalidateExtensionContext(err);
          });
        } catch(err) {
          if (isContextInvalidatedError(err)) invalidateExtensionContext(err);
        }
        safeSendMessage({
          type: "CHAT_PANEL_STATE",
          open: isOpen
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

      // ── Reset all per-meeting state so the previous meeting's data
      //    is never mixed into the new session.
      currentMeetingId = meetId;
      seenIds.clear();
      recentSystemTexts.clear();
      engPrevParticipants = new Map();
      engNameToParticipantId = new Map();
      localUserName = null; // re-detect for the new meeting
      detachReactionObserver();
      detachCaptionObserver();
      seenCaptionHashes.clear();
      recentCaptions.length = 0;
      captionBuffer = "";
      captionSpeaker = "";
      lastCapturedText = "";

      if (typeof MeetSyncEngagement !== "undefined") {
        MeetSyncEngagement.ensureMeetingMeta(meetId).catch(() => { });
      }

      sessionStartTime = Date.now();
      if (extensionContextValid) {
        try {
          await chrome.storage.local.set({
            activeMeetingId: meetId,
            chatPanelOpen: false,
            lastUpdated: Date.now(),
            sessionStartTime
          });
          // Notify popup immediately so it resets its view
          safeSendMessage({
            type: "SESSION_STARTED",
            meetingId: meetId,
            startTime: sessionStartTime
          });
        } catch (err) {
          if (isContextInvalidatedError(err)) invalidateExtensionContext(err);
        }
      }

      // Pre-load existing IDs so we don't re-log after a page refresh
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
      // Full re-scan: picks up all already-rendered chat when popup opens mid-meeting.
      refreshEngagementNameMap();
      detectChatPanelState();
      scanChatMessages();
      scanSystemEvents();
      scanActiveParticipants();
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
    ensureBodyReactionObserver(); // Start body-level reaction fallback immediately

    // Initial scan: captures messages already on screen when extension opens mid-meeting
    setTimeout(() => {
      if (!extensionContextValid) return;
      refreshEngagementNameMap();
      detectChatPanelState();
      scanChatMessages();
      scanSystemEvents();
      tryAttachCaptionObserver();
    }, 2000);

    // ── Periodic fallback poll (Bug 1 & 5) ────────────────────────────────
    // Runs every 5 seconds regardless of DOM mutations.
    // Ensures recording continues when the tab is in the background and
    // Meet may suppress mutation events, and catches messages missed on
    // mid-meeting extension open.
    setInterval(() => {
      if (!extensionContextValid || !currentMeetingId) return;
      refreshEngagementNameMap();
      detectChatPanelState();
      scanChatMessages();
      tryAttachCaptionObserver();
    }, 5000);

    // ── Participant & reaction periodic sync ───────────────────────────────
    // Re-syncs attendance DOM diff and re-attaches reaction observer
    // in case Meet changes its DOM structure.
    setInterval(() => {
      if (!extensionContextValid || !currentMeetingId) return;
      scanActiveParticipants();
      tryAttachReactionObserver();
    }, 10000);
  }

  // Wait for the page to be ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }

})();