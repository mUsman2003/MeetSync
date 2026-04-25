/**
 * MeetSync - popup.js
 * Popup UI controller: reads from chrome.storage.local, renders
 * the live feed, handles tab navigation, participant tracking,
 * session duration, and export actions.
 */
"use strict";

// ─── DOM Refs ─────────────────────────────────────────────────────────────
const feedWrapper       = document.getElementById("feedWrapper");
const feedPanel         = document.getElementById("feedPanel");
const feed              = document.getElementById("feed");
const emptyState        = document.getElementById("emptyState");
const emptyTitle        = document.getElementById("emptyTitle");
const emptySub          = document.getElementById("emptySub");
const attendeesPanel    = document.getElementById("attendeesPanel");
const statusDot         = document.getElementById("statusDot");
const statusText        = document.getElementById("statusText");
const durationChip      = document.getElementById("durationChip");
const meetingIdEl       = document.getElementById("meetingId");
const warningBanner     = document.getElementById("warningBanner");
const limitationsBanner = document.getElementById("limitationsBanner");
const dismissLimitations= document.getElementById("dismissLimitations");
const syncBtn           = document.getElementById("syncBtn");
const setupGuideBtn     = document.getElementById("setupGuideBtn");
const setupModal        = document.getElementById("setupModal");
const closeSetupModal   = document.getElementById("closeSetupModal");
const gotItBtn          = document.getElementById("gotItBtn");
const exportJsonBtn     = document.getElementById("exportJsonBtn");
const exportCsvBtn      = document.getElementById("exportCsvBtn");
const clearBtn          = document.getElementById("clearBtn");
const scrollBtn         = document.getElementById("scrollBtn");
const tabAll            = document.getElementById("tabAll");
const tabTranscription  = document.getElementById("tabTranscription");
const tabAttendees      = document.getElementById("tabAttendees");
const tabEngagement     = document.getElementById("tabEngagement");
const tabAllCount       = document.getElementById("tabAllCount");
const tabTranscriptionCount = document.getElementById("tabTranscriptionCount");
const statMessages      = document.getElementById("statMessages");
const statCaptions      = document.getElementById("statCaptions");
const statAttendees     = document.getElementById("statAttendees");
const statReactions     = document.getElementById("statReactions");
const engagementPanel   = document.getElementById("engagementPanel");
const engagementTableBody = document.getElementById("engagementTableBody");
const engagementTable   = document.getElementById("engagementTable");
const transcriptionPanel  = document.getElementById("transcriptionPanel");
const transcriptionFeed   = document.getElementById("transcriptionFeed");
const transcriptionEmpty  = document.getElementById("transcriptionEmpty");
const ccHint              = document.getElementById("ccHint");
const dismissCcHint       = document.getElementById("dismissCcHint");

// ─── State ────────────────────────────────────────────────────────────────
let activeMeetingId  = null;
let allEntries       = [];         // All stored entries for current meeting
let renderedIds      = new Set();  // IDs already rendered in the feed
let isUserScrolled   = false;
let port             = null;
let activeFilter     = "all";      // "all" | "transcription" | "attendees" | "engagement"
let participants     = new Map();  // name -> { joinedAt, leftAt, isPresent }
/** @type {Array<Record<string, unknown>>} */
let engagementRows   = [];
let engagementTotals   = { reactionCount: 0, chatTelemetryCount: 0 };
let engagementSortKey = "chatCount";
let engagementSortDir = -1; // -1 desc, 1 asc
let engagementMeta    = null; // meta from engagementStore (firstSeen timestamp)
let sessionStartTime = null;
let durationTimer    = null;
let captionEntries   = [];         // All caption entries for current meeting
let captionRenderedIds = new Set(); // IDs already rendered in transcription feed
let captionsActive   = false;      // Whether CC is detected on in the Meet tab
let localUserName    = null;       // Resolved host name (from content.js via storage)

// ─── Utility Helpers ──────────────────────────────────────────────────────

function getInitials(name) {
  if (!name || name === "Unknown" || name === "System") return "•";
  if (name === "You" || name === "__ME__") return "ME";
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

// Resolve __ME__ / Unknown / You to the real host name if known
function resolveHostName(name) {
  if (name === "__ME__" || name === "Unknown" || name === "You" || name === "you") {
    return localUserName || "Host (You)";
  }
  return name;
}

// Clean message text at render time — strips keepPin/Pin noise from old stored entries
function cleanDisplayText(text) {
  if (!text) return text;
  let c = text.replace(/[\u200B\u200C\u200D\uFEFF]/g, "").trim(); // strip zero-width chars

  // Pass 1: space-separated noise at end
  c = c.replace(/\s*(?:keep\s*Pin\s*message|Pin\s*message|Unpin\s*message|More\s*options|Remove\s*reaction|Copy\s*link|Reply|Keep|Edit|Delete|Report)\s*$/i, "").trim();

  // Pass 2: concatenated noise (no space before "keep")
  c = c.replace(/(?:keep\s*Pin\s*message|keepPinmessage|keepPin|Pinmessage)\s*$/i, "").trim();

  // Pass 3: backslash variant ("ahmed\keepPin message")
  c = c.replace(/\\?\s*keep\s*Pin\s*message\s*$/i, "").trim();

  // Pass 4: catch anything ending with just "Pin message" or "keepPin"
  c = c.replace(/\s*Pin\s+message\s*$/i, "").trim();

  return c || text; // fallback to original if fully stripped
}

function getAvatarColor(name) {
  const colors = ["#4361EE","#10B981","#F59E0B","#EF4444","#8B5CF6",
                  "#06B6D4","#F97316","#22C55E","#EC4899"];
  let h = 0;
  for (let i = 0; i < (name || "").length; i++) h = (h * 31 + name.charCodeAt(i)) % colors.length;
  return colors[Math.abs(h) % colors.length];
}

function escapeHtml(str) {
  return (str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function isAtBottom() {
  return feedWrapper.scrollHeight - feedWrapper.scrollTop - feedWrapper.clientHeight < 40;
}

function scrollToBottom() {
  feedWrapper.scrollTo({ top: feedWrapper.scrollHeight, behavior: "smooth" });
}

function formatDuration(ms) {
  if (!ms || ms < 0) return "0:00";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
  return `${m}:${String(sec).padStart(2,"0")}`;
}

/**
 * Parse a locale time string (e.g. "8:33:07 PM" or "20:33:07") into epoch ms for today.
 * Returns null on failure.
 */
function parseTimeToMs(timeStr) {
  if (!timeStr) return null;
  const clean = timeStr.replace(/\u202F/g, " ").trim();
  // Try 12-hour format: "8:33:07 PM" or "8:33 PM"
  const m12 = clean.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (m12) {
    let h = parseInt(m12[1], 10);
    const min = parseInt(m12[2], 10);
    const sec = m12[3] ? parseInt(m12[3], 10) : 0;
    const ampm = m12[4].toUpperCase();
    if (ampm === "PM" && h < 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    const d = new Date(); d.setHours(h, min, sec, 0);
    return d.getTime();
  }
  // Try 24-hour: "20:33:07" or "20:33"
  const m24 = clean.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m24) {
    const h = parseInt(m24[1], 10);
    const min = parseInt(m24[2], 10);
    const sec = m24[3] ? parseInt(m24[3], 10) : 0;
    const d = new Date(); d.setHours(h, min, sec, 0);
    return d.getTime();
  }
  return null;
}

function normalizeNameKey(name) {
  if (!name) return "";
  return String(name)
    .replace(/\s+\([^)]+\)\s*$/g, "")
    .trim()
    .toLowerCase();
}

function findEngagementRow(name) {
  const key = normalizeNameKey(name);
  const row = engagementRows.find((r) => normalizeNameKey(r.name) === key);
  return row || null;
}

// ─── Stats ────────────────────────────────────────────────────────────────

function updateStats() {
  const msgCount  = allEntries.filter(e => e.type === "chat").length;
  const capCount  = captionEntries.length;
  const attCount  = participants.size;
  const reactTot  = engagementTotals.reactionCount != null
    ? engagementTotals.reactionCount
    : engagementRows.reduce((a, r) => a + (r.reactionCount || 0), 0);

  statMessages.textContent  = msgCount;
  statCaptions.textContent  = capCount;
  statAttendees.textContent = attCount;
  statReactions.textContent = String(reactTot);
  tabAllCount.textContent   = msgCount; // Only chat messages count in All tab
  tabTranscriptionCount.textContent = capCount;
}

// ─── Duration Timer ───────────────────────────────────────────────────────

function startDurationTimer() {
  if (durationTimer) clearInterval(durationTimer);
  if (!sessionStartTime) { durationChip.textContent = "--:--"; return; }
  const tick = () => { durationChip.textContent = formatDuration(Date.now() - sessionStartTime); };
  tick();
  durationTimer = setInterval(tick, 1000);
}

// ─── Participant Tracking ──────────────────────────────────────────────────

function buildParticipantsFromEntries(entries) {
  participants.clear();
  entries.forEach(entry => {
    if (entry.type !== "event" || !entry.participantName) return;
    
    const rawName = entry.participantName;
    const cleanNameStr = rawName.replace(/\s+\([^)]+\)\s*$/g, "").trim();
    
    if (cleanNameStr.toLowerCase().includes("more_vert")) return;
    if (/\d+ (?:sec|min|hour|day)s? (?:ago|left)/i.test(cleanNameStr)) return;
    
    let targetKey = cleanNameStr;
    const lowerClean = cleanNameStr.toLowerCase();
    for (const key of participants.keys()) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === lowerClean || lowerKey.startsWith(lowerClean) || lowerClean.startsWith(lowerKey)) {
        if (cleanNameStr.length > key.length) {
          const data = participants.get(key);
          participants.delete(key);
          participants.set(cleanNameStr, data);
          targetKey = cleanNameStr;
        } else {
          targetKey = key;
        }
        break;
      }
    }

    if (!participants.has(targetKey)) {
      participants.set(targetKey, { sessions: [], isPresent: false });
    }
    const p = participants.get(targetKey);
    
    if (entry.isJoin) {
      const lastSession = p.sessions.length > 0 ? p.sessions[p.sessions.length - 1] : null;
      // Only push a new session if they don't have an open one
      if (!lastSession || lastSession.leftAt) {
        p.sessions.push({ joinedAt: entry.timestamp, leftAt: null });
      }
      p.isPresent = true;
    }
    
    if (entry.isLeave) {
      const lastSession = p.sessions.length > 0 ? p.sessions[p.sessions.length - 1] : null;
      if (lastSession && !lastSession.leftAt) {
        // Normal case: close the currently open session
        lastSession.leftAt = entry.timestamp;
      } else if (!lastSession) {
        // Edge case: They left before we ever saw them join
        p.sessions.push({ joinedAt: null, leftAt: entry.timestamp });
      }
      p.isPresent = false;
    }
  });
}

function renderAttendees() {
  const heading = attendeesPanel.querySelector(".attendees-heading");
  attendeesPanel.innerHTML = "";
  if (heading) attendeesPanel.appendChild(heading);

  if (participants.size === 0 && engagementRows.length > 0) {
    engagementRows.forEach(row => {
      const rawName = row.displayName || row.name || "Unknown";
      const joinedMs = engagementMeta && engagementMeta.firstSeen != null && row.firstSeen != null
        ? engagementMeta.firstSeen + row.firstSeen : null;
      const leftMs = engagementMeta && engagementMeta.firstSeen != null && row.lastSeen != null && !row.isPresent
        ? engagementMeta.firstSeen + row.lastSeen : null;
      const sessions = [];
      if (joinedMs || leftMs) {
        sessions.push({
          joinedAt: joinedMs ? new Date(joinedMs).toLocaleTimeString() : null,
          leftAt:   leftMs   ? new Date(leftMs).toLocaleTimeString() : null
        });
      }
      participants.set(rawName, { sessions, isPresent: !!row.isPresent });
    });
  }

  if (participants.size === 0) {
    attendeesPanel.innerHTML += `
      <div class="empty-state">
        <div class="empty-icon">👥</div>
        <div class="empty-title">No attendees tracked yet</div>
        <div class="empty-sub">Join/leave events will appear here as participants enter the meeting.</div>
      </div>`;
    return;
  }

  const sorted = Array.from(participants.entries())
    .sort(([,a],[,b]) => (b.isPresent - a.isPresent) || 0);

  sorted.forEach(([name, data]) => {
    const card = document.createElement("div");
    card.className = `attendee-card ${data.isPresent ? "present" : "left"}`;
    
    const isMe = name.toLowerCase() === "you" || name.includes("(You)") || name === "__ME__";
    const displayName = isMe ? (localUserName || "Host (You)") : resolveHostName(name);
    
    const initials = getInitials(name);
    const color    = getAvatarColor(name);
    const eng = findEngagementRow(name);

    // Build the session log HTML
    const sessions = data.sessions || [];
    let sessionLogHtml = "";
    let totalActiveMs = 0;
    let firstJoinTime = null;
    let lastEventTime = null;

    sessions.forEach((s, idx) => {
      const joinStr = s.joinedAt || "—";
      const leftStr = s.leftAt || (data.isPresent ? "Present" : "—");
      sessionLogHtml += `<div class="session-row">
        <span class="session-label">Session ${idx + 1}:</span>
        <span>Joined ${escapeHtml(joinStr)}</span>
        <span>→ ${s.leftAt ? "Left " + escapeHtml(leftStr) : escapeHtml(leftStr)}</span>
      </div>`;

      if (s.joinedAt && !firstJoinTime) firstJoinTime = s.joinedAt;
      if (s.leftAt) lastEventTime = s.leftAt;
      if (!s.leftAt && data.isPresent) lastEventTime = new Date().toLocaleTimeString();

      if (s.joinedAt && (s.leftAt || data.isPresent)) {
        const jt = parseTimeToMs(s.joinedAt);
        const lt = s.leftAt ? parseTimeToMs(s.leftAt) : Date.now();
        if (jt && lt && lt > jt) totalActiveMs += (lt - jt);
      }
    });

    // Count captions (speaking activity) for this participant
    const nameLower = name.toLowerCase();
    const displayNameLower = displayName.toLowerCase();
    const captionsSpoken = captionEntries.filter(c => {
      const sp = (c.speaker || "").toLowerCase();
      return sp && (sp === nameLower || sp === displayNameLower ||
        sp.includes(nameLower) || nameLower.includes(sp));
    });
    const captionCount = captionsSpoken.length;

    // Use caption timestamps to extend activity tracking
    if (captionsSpoken.length > 0) {
      const firstCaptionTs = captionsSpoken[0].timestamp;
      const lastCaptionTs = captionsSpoken[captionsSpoken.length - 1].timestamp;
      if (!firstJoinTime) firstJoinTime = firstCaptionTs;
      const lastCaptionMs = parseTimeToMs(lastCaptionTs);
      const lastEvMs = lastEventTime ? parseTimeToMs(lastEventTime) : 0;
      if (lastCaptionMs && lastCaptionMs > lastEvMs) lastEventTime = lastCaptionTs;
    }

    let totalMeetingMs = 0;
    if (firstJoinTime) {
      const firstMs = parseTimeToMs(firstJoinTime);
      const lastMs = lastEventTime ? parseTimeToMs(lastEventTime) : Date.now();
      if (firstMs && lastMs && lastMs > firstMs) totalMeetingMs = lastMs - firstMs;
    }

    if (totalActiveMs === 0 && eng && eng.attendanceMs) totalActiveMs = eng.attendanceMs;

    const engLine = eng
      ? `<div class="attendee-metrics">
          <span>Msgs: ${eng.chatCount != null ? eng.chatCount : "—"}</span>
          <span>React: ${eng.reactionCount != null ? eng.reactionCount : "—"}</span>
          <span>Spoke: ${captionCount}</span>
        </div>`
      : (captionCount > 0 ? `<div class="attendee-metrics"><span>Spoke: ${captionCount}</span></div>` : "");

    const timeLine = `<div class="attendee-metrics">
      <span>Active: ${totalActiveMs > 0 ? formatDuration(totalActiveMs) : "—"}</span>
      <span>Total: ${totalMeetingMs > 0 ? formatDuration(totalMeetingMs) : "—"}</span>
      <span>Sessions: ${sessions.length || 1}</span>
    </div>`;

    card.innerHTML = `
      <div class="attendee-avatar" style="background:${color}">${escapeHtml(initials)}</div>
      <div class="attendee-info">
        <div class="attendee-name">${escapeHtml(displayName)}</div>
        ${sessionLogHtml}
        ${engLine}
        ${timeLine}
      </div>
      <div class="attendee-status ${data.isPresent ? "status-present" : "status-left"}">
        ${data.isPresent ? "Present" : "Left"}
      </div>`;
    attendeesPanel.appendChild(card);
  });
}

// ─── Entry Rendering ──────────────────────────────────────────────────────

function renderEntry(entry) {
  if (renderedIds.has(entry.id)) return;
  // Skip system join/leave events from the All tab — they belong in Attendees
  if (entry.type === "event" && activeFilter === "all") return;
  renderedIds.add(entry.id);

  const isEvent  = entry.type === "event";
  const isTask   = !isEvent && !!entry.isTask;
  const div      = document.createElement("div");
  div.className  = `entry ${entry.type}${isTask ? " task" : ""}`;
  div.dataset.id = entry.id;

  const avatarBg   = isEvent ? "" : `background:${getAvatarColor(entry.sender)}`;
  const avatarText = isEvent ? "📢" : getInitials(entry.sender);
  const taskBadge  = isTask  ? `<span class="task-badge">⚡ Action</span>` : "";

  const displayName = resolveHostName(entry.sender || "Unknown");

  div.innerHTML = `
    <div class="entry-avatar" style="${avatarBg}">${avatarText}</div>
    <div class="entry-body">
      <div class="entry-meta">
        <span class="entry-sender">${escapeHtml(displayName)}</span>
        ${taskBadge}
        <span class="entry-time">${escapeHtml(entry.timestamp)}</span>
      </div>
      <div class="entry-message">${escapeHtml(cleanDisplayText(entry.message))}</div>
    </div>`;

  feed.appendChild(div);
}

function renderEntries(entries) {
  const wasAtBottom = isAtBottom();
  entries.forEach(renderEntry);

  const hasItems = renderedIds.size > 0 || (activeFilter === "tasks" && allEntries.some(e => e.isTask));
  emptyState.style.display = feed.children.length > 0 ? "none" : "flex";

  updateStats();

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
  emptyState.style.display = "flex";
  emptyTitle.textContent = "No messages yet";
  emptySub.textContent   = "Open the chat panel in Google Meet and messages will appear here automatically.";
  updateStats();
}

// ─── Tab / Filter Logic ───────────────────────────────────────────────────

function applyFilter() {
  // Toggle panels
  const showFeed =
    activeFilter !== "attendees" && activeFilter !== "engagement" && activeFilter !== "transcription";
  feedPanel.style.display = showFeed ? "block" : "none";
  attendeesPanel.style.display = activeFilter === "attendees" ? "block" : "none";
  if (engagementPanel) {
    engagementPanel.style.display = activeFilter === "engagement" ? "block" : "none";
  }
  if (transcriptionPanel) {
    transcriptionPanel.style.display = activeFilter === "transcription" ? "block" : "none";
  }

  if (activeFilter === "attendees") {
    scrollBtn.classList.remove("visible");
    renderAttendees();
    return;
  }

  if (activeFilter === "engagement") {
    scrollBtn.classList.remove("visible");
    renderEngagement();
    return;
  }

  if (activeFilter === "transcription") {
    scrollBtn.classList.remove("visible");
    renderTranscription();
    return;
  }

  // Rebuild feed for current filter
  feed.innerHTML = "";
  renderedIds.clear();

  const toShow = allEntries.filter(e => e.type !== "event"); // Only chat in All tab

  if (toShow.length === 0) {
    emptyState.style.display = "flex";
    emptyTitle.textContent = "No messages yet";
    emptySub.textContent   = "Open the chat panel in Google Meet and messages will appear here automatically.";
  } else {
    emptyState.style.display = "none";
    toShow.forEach(entry => {
      renderedIds.add(entry.id);
      const isEvent = entry.type === "event";
      const isTask  = !isEvent && !!entry.isTask;
      const div     = document.createElement("div");
      div.className = `entry ${entry.type}${isTask ? " task" : ""}`;
      div.dataset.id = entry.id;
      const avatarBg   = isEvent ? "" : `background:${getAvatarColor(entry.sender)}`;
      const avatarText = isEvent ? "📢" : getInitials(entry.sender);
      const taskBadge  = isTask  ? `<span class="task-badge">⚡ Action</span>` : "";
      const displayName = resolveHostName(entry.sender || "Unknown");

      div.innerHTML = `
        <div class="entry-avatar" style="${avatarBg}">${avatarText}</div>
        <div class="entry-body">
          <div class="entry-meta">
            <span class="entry-sender">${escapeHtml(displayName)}</span>
            ${taskBadge}
            <span class="entry-time">${escapeHtml(entry.timestamp)}</span>
          </div>
          <div class="entry-message">${escapeHtml(cleanDisplayText(entry.message))}</div>
        </div>`;
      feed.appendChild(div);
    });
  }

  updateStats();
  scrollToBottom();
}

function setActiveTab(filter) {
  activeFilter = filter;
  [tabAll, tabTranscription, tabAttendees, tabEngagement].forEach(t => t.classList.remove("active"));
  if (filter === "all") tabAll.classList.add("active");
  else if (filter === "transcription") tabTranscription.classList.add("active");
  else if (filter === "attendees") tabAttendees.classList.add("active");
  else tabEngagement.classList.add("active");
  applyFilter();
}

tabAll.addEventListener("click",            () => setActiveTab("all"));
tabTranscription.addEventListener("click", () => setActiveTab("transcription"));
tabAttendees.addEventListener("click",     () => setActiveTab("attendees"));
tabEngagement.addEventListener("click",    () => setActiveTab("engagement"));

// ── Transcription Rendering ─────────────────────────────────────────────

function renderTranscription() {
  if (!transcriptionFeed) return;
  transcriptionFeed.innerHTML = "";
  captionRenderedIds.clear();

  if (captionEntries.length === 0) {
    transcriptionEmpty.style.display = "flex";
  } else {
    transcriptionEmpty.style.display = "none";
    captionEntries.forEach(entry => {
      renderCaptionEntry(entry);
    });
  }
  // Scroll to bottom of transcription
  feedWrapper.scrollTo({ top: feedWrapper.scrollHeight, behavior: "smooth" });
}

function renderCaptionEntry(entry) {
  if (captionRenderedIds.has(entry.id)) return;
  captionRenderedIds.add(entry.id);

  const div = document.createElement("div");
  div.className = "caption-entry";
  div.dataset.id = entry.id;

  const speaker = entry.speaker ? resolveHostName(entry.speaker) : "Speaker";
  const color = getAvatarColor(speaker);
  const initials = getInitials(speaker);

  div.innerHTML = `
    <div class="caption-speaker-avatar" style="background:${color}">${escapeHtml(initials)}</div>
    <div class="caption-body">
      <div class="caption-meta">
        <span class="caption-speaker-name">${escapeHtml(speaker)}</span>
        <span class="caption-time">${escapeHtml(entry.timestamp)}</span>
      </div>
      <div class="caption-text">${escapeHtml(entry.text)}</div>
    </div>`;

  transcriptionFeed.appendChild(div);
}

function renderEngagement() {
  if (!engagementTableBody) return;
  engagementTableBody.innerHTML = "";

  // Merge rows that are all the same host identity (__ME__, Unknown, You, host name)
  const hostAliases = new Set(["__me__", "unknown", "you"]);
  if (localUserName) hostAliases.add(localUserName.toLowerCase());
  const mergedMap = new Map();

  // Pre-calculate accurate presence from the attendees map (based on toast events)
  const truePresenceMap = new Map();
  participants.forEach((data, name) => {
    truePresenceMap.set(name.toLowerCase(), data.isPresent);
  });

  engagementRows.forEach(r => {
    const rawName = r.name || "";
    const lower = rawName.toLowerCase();
    const isHostAlias = hostAliases.has(lower);
    const mergeKey = isHostAlias ? "__HOST__" : lower;

    // Use toast events if available, otherwise fallback to engagement tracker.
    // The host is always assumed to be present.
    let truePresence = r.isPresent;
    if (isHostAlias) {
      truePresence = true;
    } else {
      const matchKey = Array.from(truePresenceMap.keys()).find(k => 
        k === lower || 
        k === resolveHostName(rawName).toLowerCase() ||
        lower.startsWith(k) || 
        k.startsWith(lower)
      );
      if (matchKey) truePresence = truePresenceMap.get(matchKey);
    }

    if (!mergedMap.has(mergeKey)) {
      mergedMap.set(mergeKey, { ...r, name: isHostAlias ? (localUserName || "Host (You)") : rawName, isPresent: truePresence });
    } else {
      const existing = mergedMap.get(mergeKey);
      existing.chatCount = (existing.chatCount || 0) + (r.chatCount || 0);
      existing.reactionCount = (existing.reactionCount || 0) + (r.reactionCount || 0);
      existing.attendanceMs = Math.max(existing.attendanceMs || 0, r.attendanceMs || 0);
      if (truePresence) existing.isPresent = true;
      if (r.firstSeen != null && (existing.firstSeen == null || r.firstSeen < existing.firstSeen)) {
        existing.firstSeen = r.firstSeen;
      }
    }
  });

  const rows = [...mergedMap.values()];
  const key = engagementSortKey;
  const dir = engagementSortDir;
  rows.sort((a, b) => {
    let va = a[key];
    let vb = b[key];
    if (key === "name") {
      va = String(va || "");
      vb = String(vb || "");
      return dir * va.localeCompare(vb);
    }
    if (key === "isPresent") {
      va = va ? 1 : 0;
      vb = vb ? 1 : 0;
    } else {
      va = Number(va) || 0;
      vb = Number(vb) || 0;
    }
    return dir * (vb - va);
  });

  if (rows.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6" style="text-align:center;padding:16px;color:var(--text-muted)">No engagement data yet. Open the People panel or chat in Meet.</td>`;
    engagementTableBody.appendChild(tr);
    return;
  }

  rows.forEach((r) => {
    const tr = document.createElement("tr");
    let joinedStr = "\u2014";
    if (engagementMeta && engagementMeta.firstSeen != null && r.firstSeen != null) {
      const joinedAt = new Date(engagementMeta.firstSeen + r.firstSeen);
      joinedStr = joinedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    // Active minutes (round to 1 decimal)
    let activeMins = "—";
    if (r.attendanceMs != null && r.attendanceMs > 0) {
      const m = r.attendanceMs / 60000;
      activeMins = m >= 1 ? `${Math.round(m)} min` : `${Math.round(r.attendanceMs / 1000)} sec`;
    } else if (r.isPresent) {
      activeMins = "active";
    }
    const st = r.isPresent ? "✅ Present" : "Left";
    const displayName = resolveHostName(r.name || "");
    tr.innerHTML = `
      <td class="eng-name">${escapeHtml(displayName)}</td>
      <td>${r.chatCount != null ? r.chatCount : 0}</td>
      <td>${r.reactionCount != null ? r.reactionCount : 0}</td>
      <td>${joinedStr}</td>
      <td>${activeMins}</td>
      <td>${st}</td>`;
    engagementTableBody.appendChild(tr);
  });
}

if (engagementTable) {
  engagementTable.addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]");
    if (!th) return;
    const k = th.getAttribute("data-sort");
    if (engagementSortKey === k) engagementSortDir *= -1;
    else {
      engagementSortKey = k;
      engagementSortDir = k === "name" ? 1 : -1;
    }
    renderEngagement();
  });
}

async function loadEngagementData() {
  engagementRows = [];
  engagementTotals = { reactionCount: 0, chatTelemetryCount: 0 };
  if (!activeMeetingId || typeof MeetSyncEngagement === "undefined") {
    updateStats();
    return;
  }
  try {
    const s = await MeetSyncEngagement.loadEngagementSummary(activeMeetingId);
    engagementRows   = s.participants || [];
    engagementMeta   = s.meta || null;
    engagementTotals = s.totals || engagementTotals;
  } catch (_) {
    /* ignore */
  }
  updateStats();
  if (activeFilter === "engagement") renderEngagement();
  if (activeFilter === "attendees") renderAttendees();
}

// ─── Status UI ────────────────────────────────────────────────────────────

function setStatus(state, text) {
  statusDot.className  = "status-dot " + state;
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
    if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
    durationChip.textContent = "--:--";
  }
}

function setChatPanelWarning(open) {
  if (open) warningBanner.classList.remove("visible");
  else if (activeMeetingId) warningBanner.classList.add("visible");
}

// ─── Data Loading ─────────────────────────────────────────────────────────

async function loadCurrentSession() {
  const storage = await chrome.storage.local.get([
    "activeMeetingId", "chatPanelOpen", "lastUpdated", "sessionStartTime"
  ]);
  const meetingId = storage.activeMeetingId;
  updateMeetingDisplay(meetingId);
  setChatPanelWarning(storage.chatPanelOpen !== false);

  if (storage.sessionStartTime) {
    sessionStartTime = storage.sessionStartTime;
    startDurationTimer();
  }

  if (!meetingId) {
    engagementRows = [];
    engagementTotals = { reactionCount: 0, chatTelemetryCount: 0 };
    updateStats();
    return;
  }

  const key    = `meet_${meetingId}`;
  const result = await chrome.storage.local.get(key);
  allEntries   = result[key] || [];

  // Load captions
  const capKey = `captions_${meetingId}`;
  const capResult = await chrome.storage.local.get(capKey);
  captionEntries = capResult[capKey] || [];
  captionRenderedIds.clear();

  // Load the local host name so we can resolve __ME__/Unknown/You
  const nameResult = await chrome.storage.local.get("localUserName");
  if (nameResult.localUserName) localUserName = nameResult.localUserName;

  buildParticipantsFromEntries(allEntries);
  await loadEngagementData();
  clearFeed();
  applyFilter();

  // Bug fix 1: If we're joining a live meeting mid-way, trigger a content
  // script re-scan so any already-rendered chat is captured immediately.
  if (meetingId) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && tab.url.startsWith("https://meet.google.com/")) {
        await chrome.tabs.sendMessage(tab.id, { type: "MANUAL_SCAN" }).catch(() => {});
        // Re-load storage after the scan so newly captured entries appear
        setTimeout(async () => {
          const r2 = await chrome.storage.local.get(key);
          const fresh = r2[key] || [];
          if (fresh.length > allEntries.length) {
            allEntries = fresh;
            buildParticipantsFromEntries(allEntries);
            clearFeed();
            applyFilter();
          }
        }, 2500);
      }
    } catch (_) {}
  }
}

// ─── Background Connection ────────────────────────────────────────────────

function connectBackground() {
  port = chrome.runtime.connect({ name: "meetsync-popup" });

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "NEW_ENTRY":
        if (!msg.entry || !msg.entry.id) break;
        // Feed and count updates are handled exclusively by storage.onChanged
        // (which fires reliably even when the service worker is idle).
        // Here we only handle side effects that need to happen immediately:
        if (msg.entry.type === "event" && msg.entry.participantName) {
          // Attendee join/leave — rebuild participant map
          // (storage.onChanged will add the entry to allEntries first;
          //  we use a tiny delay so allEntries is already updated)
          setTimeout(() => {
            buildParticipantsFromEntries(allEntries);
            if (activeFilter === "attendees") renderAttendees();
          }, 150);
        }
        if (msg.entry.type === "chat") void loadEngagementData();
        break;

      case "CHAT_PANEL_STATE":
        setChatPanelWarning(msg.open);
        break;

      case "SESSION_STARTED":
        updateMeetingDisplay(msg.meetingId);
        allEntries = [];
        captionEntries = [];
        captionRenderedIds.clear();
        participants.clear();
        engagementRows = [];
        engagementTotals = { reactionCount: 0, chatTelemetryCount: 0 };
        clearFeed();
        if (msg.startTime) { sessionStartTime = msg.startTime; startDurationTimer(); }
        void loadEngagementData();
        break;

      case "NEW_CAPTION":
        if (!msg.entry || !msg.entry.id) break;
        captionEntries.push(msg.entry);
        if (activeFilter === "transcription") {
          const wasBottom = isAtBottom();
          renderCaptionEntry(msg.entry);
          transcriptionEmpty.style.display = "none";
          if (wasBottom || !isUserScrolled) {
            feedWrapper.scrollTo({ top: feedWrapper.scrollHeight, behavior: "smooth" });
          }
        }
        updateStats();
        break;

      case "CAPTION_STATE":
        captionsActive = !!msg.enabled;
        if (captionsActive && ccHint) {
          ccHint.classList.add("hidden");
        }
        break;
    }
  });

  port.onDisconnect.addListener(() => setTimeout(connectBackground, 1000));
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

// ─── Limitations Banner ───────────────────────────────────────────────────

if (!sessionStorage.getItem("limDismissed")) limitationsBanner.classList.add("visible");
dismissLimitations.addEventListener("click", () => {
  limitationsBanner.classList.remove("visible");
  sessionStorage.setItem("limDismissed", "1");
});

if (dismissCcHint) {
  dismissCcHint.addEventListener("click", () => {
    if (ccHint) ccHint.classList.add("hidden");
  });
}

// ─── Exports ─────────────────────────────────────────────────────────────

function buildSummary() {
  const durationMs = sessionStartTime ? Date.now() - sessionStartTime : null;
  
  // Helper to make "Unknown" or placeholders readable
  const cleanDisplayName = (name) => {
    if (!name || name === "Unknown") return "Participant";
    if (name === "You" || name === "__ME__") return "Me (Host)";
    // Strip trailing roles/icons from Meet names
    return name.replace(/\s+\([^)]+\)\s*$/g, "").trim();
  };

  return {
    meetingId:        activeMeetingId,
    exportedAt:       new Date().toISOString(),
    sessionDuration:  durationMs ? formatDuration(durationMs) : "unknown",
    totalEntries:     allEntries.length,
    chatMessageCount: allEntries.filter(e => e.type === "chat").length,
    actionItemCount:  allEntries.filter(e => e.isTask).length,
    eventCount:       allEntries.filter(e => e.type === "event").length,
    participantCount: participants.size,
    participants:     Array.from(participants.entries()).map(([name, d]) => {
      const sessions = (d.sessions || []).map(s => ({
        joinedAt: s.joinedAt || null, leftAt: s.leftAt || null
      }));
      return {
        name: cleanDisplayName(name),
        sessions,
        isPresent: d.isPresent
      };
    }),
    actionItems: allEntries.filter(e => e.isTask).map(e => ({
      sender: cleanDisplayName(e.sender), message: e.message, timestamp: e.timestamp
    })),
    captionCount: captionEntries.length,
    captions: captionEntries.map(c => ({
      speaker: cleanDisplayName(c.speaker), text: c.text, timestamp: c.timestamp
    })),
    knownLimitations: [
      "Only chat messages are captured — verbal decisions not shared in chat are not logged.",
      "Task detection is heuristic/keyword-based, not LLM-based; subtle tasks may be missed.",
      "Join/leave events rely on Google Meet's notification system being active.",
      "Chat panel must remain open during the meeting for full capture.",
      "Captions require CC to be enabled in Google Meet; caption text depends on DOM structure."
    ]
  };
}

function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

async function exportJSON() {
  if (!activeMeetingId || (!allEntries.length && !captionEntries.length)) { setStatus("warning", "No data to export."); return; }
  const summary   = buildSummary();
  let engagementV2 = null;
  if (typeof MeetSyncEngagement !== "undefined") {
    try {
      engagementV2 = await MeetSyncEngagement.loadEngagementSummary(activeMeetingId);
    } catch (_) {
      engagementV2 = null;
    }
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  downloadBlob(
    JSON.stringify({ ...summary, engagementV2, entries: allEntries, captionEntries }, null, 2),
    `meetsync_${activeMeetingId}_${timestamp}.json`,
    "application/json"
  );
  flashBtn(exportJsonBtn, "✓ Done!");
}

async function exportCSV() {
  if (!activeMeetingId || (!allEntries.length && !captionEntries.length)) { setStatus("warning", "No data to export."); return; }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  // Chat messages section
  let csv = "CHAT MESSAGES\r\n";
  csv += "Type,Timestamp,Sender,Message,IsActionItem,CapturedAt\r\n";
  const chatOnly = allEntries.filter(e => e.type === "chat");
  chatOnly.forEach(e => {
    const msg    = `"${cleanDisplayText(e.message || "").replace(/"/g,'""')}"`;
    let s = resolveHostName(e.sender || "Participant");
    s = s.replace(/\s+\([^)]+\)\s*$/g, "").trim();
    const sender = `"${s.replace(/"/g,'""')}"`;
    const capAt  = `"${(e.capturedAt || "").replace(/"/g,'""')}"`;
    csv += `${e.type},"${e.timestamp}",${sender},${msg},${e.isTask ? "TRUE" : "FALSE"},${capAt}\r\n`;
  });

  // Transcript/Captions section
  if (captionEntries.length > 0) {
    csv += "\r\nTRANSCRIPT\r\n";
    csv += "Timestamp,Speaker,CaptionText\r\n";
    captionEntries.forEach(c => {
      const speaker = resolveHostName(c.speaker || "Speaker");
      const text = `"${(c.text || "").replace(/"/g, '""')}"`;
      csv += `"${c.timestamp}","${speaker.replace(/"/g, '""')}",${text}\r\n`;
    });
  }

  // Attendees section
  if (participants.size > 0) {
    csv += "\r\nATTENDEES\r\n";
    csv += "Name,Status,Sessions,TotalActiveMins\r\n";
    participants.forEach((data, name) => {
      const displayName = resolveHostName(name);
      const sessions = data.sessions || [];
      let totalActiveMs = 0;
      sessions.forEach(s => {
        if (s.joinedAt && (s.leftAt || data.isPresent)) {
          const jt = parseTimeToMs(s.joinedAt);
          const lt = s.leftAt ? parseTimeToMs(s.leftAt) : Date.now();
          if (jt && lt && lt > jt) totalActiveMs += (lt - jt);
        }
      });
      const sessionsStr = sessions.map((s, i) => `Session ${i+1}: ${s.joinedAt || "?"}-${s.leftAt || "Present"}`).join("; ");
      csv += `"${displayName.replace(/"/g, '""')}",${data.isPresent ? "Present" : "Left"},"${sessionsStr}",${(totalActiveMs / 60000).toFixed(1)}\r\n`;
    });
  }

  // Engagement section
  if (typeof MeetSyncEngagement !== "undefined") {
    try {
      const eng = await MeetSyncEngagement.loadEngagementSummary(activeMeetingId);
      csv += "\r\nENGAGEMENT_SUMMARY\r\n";
      csv += "Name,ChatCount,ReactionCount,AttendanceMs,IsPresent\r\n";
      (eng.participants || []).forEach((p) => {
        const name = `"${(p.name || "").replace(/"/g, '""')}"`;
        csv += `${name},${p.chatCount != null ? p.chatCount : 0},${p.reactionCount != null ? p.reactionCount : 0},${p.attendanceMs != null ? p.attendanceMs : ""},${p.isPresent ? "TRUE" : "FALSE"}\r\n`;
      });
    } catch (_) { /* ignore */ }
  }
  downloadBlob(
    csv,
    `meetsync_${activeMeetingId}_${timestamp}.csv`,
    "text/csv;charset=utf-8;"
  );
  flashBtn(exportCsvBtn, "✓ Done!");
}

async function clearSession() {
  if (!activeMeetingId) return;
  if (!confirm(`Clear all data for meeting ${activeMeetingId}?`)) return;
  await chrome.storage.local.remove([`meet_${activeMeetingId}`, `captions_${activeMeetingId}`]);
  if (typeof MeetSyncEngagement !== "undefined") {
    await MeetSyncEngagement.clearEngagementForMeeting(activeMeetingId);
  }
  allEntries = []; participants.clear();
  captionEntries = []; captionRenderedIds.clear();
  engagementRows = [];
  engagementTotals = { reactionCount: 0, chatTelemetryCount: 0 };
  clearFeed(); updateStats();
  if (transcriptionFeed) transcriptionFeed.innerHTML = "";
  if (transcriptionEmpty) transcriptionEmpty.style.display = "flex";
  setStatus("active", "Session cleared.");
}

function flashBtn(btn, text) {
  const orig = btn.textContent;
  btn.textContent = text; btn.classList.add("success");
  setTimeout(() => { btn.textContent = orig; btn.classList.remove("success"); }, 2000);
}

// ─── Sync Button ──────────────────────────────────────────────────────────

async function manualSync() {
  syncBtn.textContent = "⏳"; syncBtn.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.startsWith("https://meet.google.com/"))
      await chrome.tabs.sendMessage(tab.id, { type: "MANUAL_SCAN" });
  } catch (_) {}
  await loadCurrentSession();
  syncBtn.textContent = "🔄"; syncBtn.disabled = false;
}

syncBtn.addEventListener("click", manualSync);
setupGuideBtn.addEventListener("click", () => setupModal.classList.add("visible"));
closeSetupModal.addEventListener("click", () => setupModal.classList.remove("visible"));
gotItBtn.addEventListener("click", () => setupModal.classList.remove("visible"));
setupModal.addEventListener("click", (e) => {
  if (e.target === setupModal) setupModal.classList.remove("visible");
});
exportJsonBtn.addEventListener("click", exportJSON);
exportCsvBtn.addEventListener("click", exportCSV);
clearBtn.addEventListener("click", clearSession);

// ─── Init ─────────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const keys = Object.keys(changes);

  // If the active meeting changes, fully reload for the new session.
  if (keys.includes("activeMeetingId")) {
    const newId = changes.activeMeetingId.newValue;
    if (newId !== activeMeetingId) {
      void loadCurrentSession();
      return;
    }
  }

  if (!activeMeetingId) return;

  // ── Primary feed/count update path ────────────────────────────────────────
  // storage.onChanged is the SINGLE source that adds entries to allEntries
  // and updates the feed. This fires reliably in the side-panel context even
  // when the service worker is idle, making it more reliable than port messages.
  const meetKey = `meet_${activeMeetingId}`;
  if (keys.includes(meetKey)) {
    const allStorageEntries = changes[meetKey].newValue || [];
    // Build a set of IDs already tracked to prevent any double-add
    const existingIds = new Set(allEntries.map(e => e.id));
    const addedEntries = allStorageEntries.filter(e => !existingIds.has(e.id));
    if (addedEntries.length > 0) {
      addedEntries.forEach(e => allEntries.push(e));
      // Render new entries in the All tab (not engagement/attendees/transcription)
      if (activeFilter !== "attendees" && activeFilter !== "engagement" && activeFilter !== "transcription") {
        renderEntries(addedEntries);
      }
      // If any are join/leave events, update attendee panel too
      if (addedEntries.some(e => e.type === "event")) {
        buildParticipantsFromEntries(allEntries);
        if (activeFilter === "attendees") renderAttendees();
      }
      updateStats();
    }
  }

  // Reload engagement data when engagement keys change
  const metaKey = "meetms_meta_" + activeMeetingId;
  const hit = keys.some(
    (k) => k === metaKey || k.startsWith("P-") || k.startsWith("D-")
  );
  if (hit) void loadEngagementData();
});

connectBackground();
void loadCurrentSession();