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
const exportJsonBtn     = document.getElementById("exportJsonBtn");
const exportCsvBtn      = document.getElementById("exportCsvBtn");
const clearBtn          = document.getElementById("clearBtn");
const scrollBtn         = document.getElementById("scrollBtn");
const tabAll            = document.getElementById("tabAll");
const tabTasks          = document.getElementById("tabTasks");
const tabAttendees      = document.getElementById("tabAttendees");
const tabEngagement     = document.getElementById("tabEngagement");
const tabAllCount       = document.getElementById("tabAllCount");
const tabTasksCount     = document.getElementById("tabTasksCount");
const statMessages      = document.getElementById("statMessages");
const statTasks         = document.getElementById("statTasks");
const statAttendees     = document.getElementById("statAttendees");
const statReactions     = document.getElementById("statReactions");
const engagementPanel   = document.getElementById("engagementPanel");
const engagementTableBody = document.getElementById("engagementTableBody");
const engagementTable   = document.getElementById("engagementTable");

// ─── State ────────────────────────────────────────────────────────────────
let activeMeetingId  = null;
let allEntries       = [];         // All stored entries for current meeting
let renderedIds      = new Set();  // IDs already rendered in the feed
let isUserScrolled   = false;
let port             = null;
let activeFilter     = "all";      // "all" | "tasks" | "attendees" | "engagement"
let participants     = new Map();  // name -> { joinedAt, leftAt, isPresent }
/** @type {Array<Record<string, unknown>>} */
let engagementRows   = [];
let engagementTotals   = { reactionCount: 0, chatTelemetryCount: 0 };
let engagementSortKey = "chatCount";
let engagementSortDir = -1; // -1 desc, 1 asc
let sessionStartTime = null;
let durationTimer    = null;

// ─── Utility Helpers ──────────────────────────────────────────────────────

function getInitials(name) {
  if (!name || name === "Unknown" || name === "System") return "•";
  if (name === "You" || name === "__ME__") return "ME";
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

function getAvatarColor(name) {
  const colors = ["#4f8ef7","#3ecf8e","#f7c948","#f0605a","#a78bfa",
                  "#38bdf8","#fb923c","#34d399","#f472b6"];
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
  const taskCount = allEntries.filter(e => e.isTask).length;
  const attCount  = participants.size;
  const reactTot  = engagementTotals.reactionCount != null
    ? engagementTotals.reactionCount
    : engagementRows.reduce((a, r) => a + (r.reactionCount || 0), 0);

  statMessages.textContent  = msgCount;
  statTasks.textContent     = taskCount;
  statAttendees.textContent = attCount;
  statReactions.textContent = String(reactTot);
  tabAllCount.textContent   = allEntries.length;
  tabTasksCount.textContent = taskCount;
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
    
    // Normalize name: "User Name (Meeting host)" -> "User Name"
    const rawName = entry.participantName;
    const cleanNameStr = rawName.replace(/\s+\([^)]+\)\s*$/g, "").trim();
    
    // Extra validation: skip UI artifacts and timestamps
    if (cleanNameStr.toLowerCase().includes("more_vert")) return;
    if (/\d+ (?:sec|min|hour|day)s? (?:ago|left)/i.test(cleanNameStr)) return;
    
    if (!participants.has(cleanNameStr)) {
      participants.set(cleanNameStr, { joinedAt: null, leftAt: null, isPresent: false });
    }
    const p = participants.get(cleanNameStr);
    if (entry.isJoin) { p.joinedAt = p.joinedAt || entry.timestamp; p.isPresent = true; }
    if (entry.isLeave) { p.leftAt = entry.timestamp; p.isPresent = false; }
  });
}

function renderAttendees() {
  // Clear previous attendee cards (keep heading)
  const heading = attendeesPanel.querySelector(".attendees-heading");
  attendeesPanel.innerHTML = "";
  if (heading) attendeesPanel.appendChild(heading);

  if (participants.size === 0) {
    attendeesPanel.innerHTML += `
      <div class="empty-state">
        <div class="empty-icon">👥</div>
        <div class="empty-title">No attendees tracked yet</div>
        <div class="empty-sub">Join/leave events will appear here as participants enter the meeting.</div>
      </div>`;
    return;
  }

  // Sort: present first, then alphabetical
  const sorted = Array.from(participants.entries())
    .sort(([,a],[,b]) => (b.isPresent - a.isPresent) || 0);

  sorted.forEach(([name, data]) => {
    const card = document.createElement("div");
    card.className = `attendee-card ${data.isPresent ? "present" : "left"}`;
    
    // Check if this attendee is "You"
    const isMe = name.toLowerCase() === "you" || name.includes("(You)");
    const displayName = isMe ? "Me (Host)" : name;
    
    const initials = getInitials(name);
    const color    = getAvatarColor(name);
    const eng = findEngagementRow(name);
    const engLine = eng
      ? `<div class="attendee-metrics">
          <span>Msgs: ${eng.chatCount != null ? eng.chatCount : "—"}</span>
          <span>React: ${eng.reactionCount != null ? eng.reactionCount : "—"}</span>
          <span>Presence: ${eng.attendanceMs != null ? formatDuration(eng.attendanceMs) : "—"}</span>
        </div>`
      : "";

    card.innerHTML = `
      <div class="attendee-avatar" style="background:${color}">${escapeHtml(initials)}</div>
      <div class="attendee-info">
        <div class="attendee-name">${escapeHtml(displayName)}</div>
        <div class="attendee-meta">
          ${data.joinedAt ? `Joined ${escapeHtml(data.joinedAt)}` : ""}
          ${data.leftAt   ? ` &middot; Left ${escapeHtml(data.leftAt)}` : ""}
        </div>
        ${engLine}
      </div>
      <div class="attendee-status ${data.isPresent ? "status-present" : "status-left"}">
        ${eng && typeof eng.isPresent === "boolean" ? (eng.isPresent ? "Present" : "Left") : (data.isPresent ? "Present" : "Left")}
      </div>`;
    attendeesPanel.appendChild(card);
  });
}

// ─── Entry Rendering ──────────────────────────────────────────────────────

function renderEntry(entry) {
  if (renderedIds.has(entry.id)) return;
  renderedIds.add(entry.id);

  if (activeFilter === "tasks" && !entry.isTask) return;

  const isEvent  = entry.type === "event";
  const isTask   = !isEvent && !!entry.isTask;
  const div      = document.createElement("div");
  div.className  = `entry ${entry.type}${isTask ? " task" : ""}`;
  div.dataset.id = entry.id;

  const avatarBg   = isEvent ? "" : `background:${getAvatarColor(entry.sender)}`;
  const avatarText = isEvent ? "📢" : getInitials(entry.sender);
  const taskBadge  = isTask  ? `<span class="task-badge">⚡ Action</span>` : "";

  const isMe = entry.sender === "You" || entry.sender === "__ME__";
  const displayName = isMe ? "Me (Host)" : entry.sender;

  div.innerHTML = `
    <div class="entry-avatar" style="${avatarBg}">${avatarText}</div>
    <div class="entry-body">
      <div class="entry-meta">
        <span class="entry-sender">${escapeHtml(displayName)}</span>
        ${taskBadge}
        <span class="entry-time">${escapeHtml(entry.timestamp)}</span>
      </div>
      <div class="entry-message">${escapeHtml(entry.message)}</div>
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
    activeFilter !== "attendees" && activeFilter !== "engagement";
  feedPanel.style.display = showFeed ? "block" : "none";
  attendeesPanel.style.display = activeFilter === "attendees" ? "block" : "none";
  if (engagementPanel) {
    engagementPanel.style.display = activeFilter === "engagement" ? "block" : "none";
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

  // Rebuild feed for current filter
  feed.innerHTML = "";
  renderedIds.clear();

  const toShow = activeFilter === "tasks"
    ? allEntries.filter(e => e.isTask)
    : allEntries;

  if (toShow.length === 0) {
    emptyState.style.display = "flex";
    if (activeFilter === "tasks") {
      emptyTitle.textContent = "No action items detected";
      emptySub.textContent   = "Messages with task keywords or @mentions will be flagged here.";
    } else {
      emptyTitle.textContent = "No messages yet";
      emptySub.textContent   = "Open the chat panel in Google Meet and messages will appear here automatically.";
    }
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
      const isMe = entry.sender === "You" || entry.sender === "__ME__";
      const displayName = isMe ? "Me (Host)" : entry.sender;

      div.innerHTML = `
        <div class="entry-avatar" style="${avatarBg}">${avatarText}</div>
        <div class="entry-body">
          <div class="entry-meta">
            <span class="entry-sender">${escapeHtml(displayName)}</span>
            ${taskBadge}
            <span class="entry-time">${escapeHtml(entry.timestamp)}</span>
          </div>
          <div class="entry-message">${escapeHtml(entry.message)}</div>
        </div>`;
      feed.appendChild(div);
    });
  }

  updateStats();
  scrollToBottom();
}

function setActiveTab(filter) {
  activeFilter = filter;
  [tabAll, tabTasks, tabAttendees, tabEngagement].forEach(t => t.classList.remove("active"));
  if (filter === "all") tabAll.classList.add("active");
  else if (filter === "tasks") tabTasks.classList.add("active");
  else if (filter === "attendees") tabAttendees.classList.add("active");
  else tabEngagement.classList.add("active");
  applyFilter();
}

tabAll.addEventListener("click",       () => setActiveTab("all"));
tabTasks.addEventListener("click",     () => setActiveTab("tasks"));
tabAttendees.addEventListener("click", () => setActiveTab("attendees"));
tabEngagement.addEventListener("click", () => setActiveTab("engagement"));

function renderEngagement() {
  if (!engagementTableBody) return;
  engagementTableBody.innerHTML = "";
  const rows = [...engagementRows];
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
    tr.innerHTML = `<td colspan="5" style="text-align:center;padding:16px;color:var(--text-muted)">No engagement data yet. Open the People panel or chat in Meet.</td>`;
    engagementTableBody.appendChild(tr);
    return;
  }

  rows.forEach((r) => {
    const tr = document.createElement("tr");
    const pres = formatDuration(r.attendanceMs || 0);
    const st = r.isPresent ? "Present" : "Left";
    tr.innerHTML = `
      <td class="eng-name">${escapeHtml(r.name || "")}</td>
      <td>${r.chatCount != null ? r.chatCount : 0}</td>
      <td>${r.reactionCount != null ? r.reactionCount : 0}</td>
      <td>${r.attendanceMs != null ? pres : "—"}</td>
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
    engagementRows = s.participants || [];
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

  buildParticipantsFromEntries(allEntries);
  await loadEngagementData();
  clearFeed();
  applyFilter();
}

// ─── Background Connection ────────────────────────────────────────────────

function connectBackground() {
  port = chrome.runtime.connect({ name: "meetsync-popup" });

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "NEW_ENTRY":
        if (!msg.entry || !msg.entry.id) break;
        allEntries.push(msg.entry);
        // Update participant map if it's a join/leave event
        if (msg.entry.type === "event" && msg.entry.participantName) {
          buildParticipantsFromEntries(allEntries);
          if (activeFilter === "attendees") renderAttendees();
        }
        if (msg.entry.type === "chat") void loadEngagementData();
        if (activeFilter !== "attendees" && activeFilter !== "engagement") {
          renderEntries([msg.entry]);
        }
        updateStats();
        break;

      case "CHAT_PANEL_STATE":
        setChatPanelWarning(msg.open);
        break;

      case "SESSION_STARTED":
        updateMeetingDisplay(msg.meetingId);
        allEntries = [];
        participants.clear();
        engagementRows = [];
        engagementTotals = { reactionCount: 0, chatTelemetryCount: 0 };
        clearFeed();
        if (msg.startTime) { sessionStartTime = msg.startTime; startDurationTimer(); }
        void loadEngagementData();
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
    participants:     Array.from(participants.entries()).map(([name, d]) => ({
      name: cleanDisplayName(name), joinedAt: d.joinedAt, leftAt: d.leftAt, isPresent: d.isPresent
    })),
    actionItems: allEntries.filter(e => e.isTask).map(e => ({
      sender: cleanDisplayName(e.sender), message: e.message, timestamp: e.timestamp
    })),
    knownLimitations: [
      "Only chat messages are captured — verbal decisions not shared in chat are not logged.",
      "Task detection is heuristic/keyword-based, not LLM-based; subtle tasks may be missed.",
      "Join/leave events rely on Google Meet's notification system being active.",
      "Chat panel must remain open during the meeting for full capture."
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
  if (!activeMeetingId || !allEntries.length) { setStatus("warning", "No data to export."); return; }
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
    JSON.stringify({ ...summary, engagementV2, entries: allEntries }, null, 2),
    `meetsync_${activeMeetingId}_${timestamp}.json`,
    "application/json"
  );
  flashBtn(exportJsonBtn, "✓ Done!");
}

async function exportCSV() {
  if (!activeMeetingId || !allEntries.length) { setStatus("warning", "No data to export."); return; }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const header    = "Type,Timestamp,Sender,Message,IsActionItem,CapturedAt\r\n";
  const rows      = allEntries.map(e => {
    const msg    = `"${(e.message    || "").replace(/"/g,'""')}"`;
    // Clean up sender name
    let s = e.sender || "Participant";
    if (s === "Unknown") s = "Participant";
    s = s.replace(/\s+\([^)]+\)\s*$/g, "").trim();
    const sender = `"${s.replace(/"/g,'""')}"`;

    const capAt  = `"${(e.capturedAt || "").replace(/"/g,'""')}"`;
    return `${e.type},"${e.timestamp}",${sender},${msg},${e.isTask ? "TRUE" : "FALSE"},${capAt}`;
  });
  let csv = header + rows.join("\r\n");
  if (typeof MeetSyncEngagement !== "undefined") {
    try {
      const eng = await MeetSyncEngagement.loadEngagementSummary(activeMeetingId);
      csv += "\r\n\r\nENGAGEMENT_SUMMARY\r\n";
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
  await chrome.storage.local.remove(`meet_${activeMeetingId}`);
  if (typeof MeetSyncEngagement !== "undefined") {
    await MeetSyncEngagement.clearEngagementForMeeting(activeMeetingId);
  }
  allEntries = []; participants.clear();
  engagementRows = [];
  engagementTotals = { reactionCount: 0, chatTelemetryCount: 0 };
  clearFeed(); updateStats();
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
exportJsonBtn.addEventListener("click", exportJSON);
exportCsvBtn.addEventListener("click", exportCSV);
clearBtn.addEventListener("click", clearSession);

// ─── Init ─────────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !activeMeetingId) return;
  const keys = Object.keys(changes);
  const metaKey = "meetms_meta_" + activeMeetingId;
  const hit = keys.some(
    (k) => k === metaKey || k.startsWith("P-") || k.startsWith("D-")
  );
  if (hit) void loadEngagementData();
});

connectBackground();
void loadCurrentSession();