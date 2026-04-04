// popup.js — MeetSync popup controller

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let state  = null;
let pollId = null;
let activeTab = 'participants';

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadState();
  renderAll();
  startPolling();

  $('tab-participants').addEventListener('click', () => setTab('participants'));
  $('tab-chats').addEventListener('click',        () => setTab('chats'));
  $('btn-download').addEventListener('click', downloadReport);
  $('btn-clear').addEventListener('click', clearSession);
});

window.addEventListener('unload', () => clearInterval(pollId));

// ─── Data loading ─────────────────────────────────────────────────────────────
async function loadState() {
  const res = await chrome.storage.session.get('meetsyncState').catch(() => ({}));
  state = res.meetsyncState || null;
}

async function sendToContent(msg) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.includes('meet.google.com')) return null;
    return await chrome.tabs.sendMessage(tab.id, msg).catch(() => null);
  } catch (_) { return null; }
}

// ─── Polling ──────────────────────────────────────────────────────────────────
function startPolling() {
  pollId = setInterval(async () => {
    await loadState();
    renderAll();
  }, 2000);
}

// ─── Tab switching ────────────────────────────────────────────────────────────
function setTab(name) {
  activeTab = name;
  ['participants', 'chats'].forEach(t => {
    $(`tab-${t}`).classList.toggle('active', t === name);
    $(`panel-${t}`).classList.toggle('active', t === name);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function initials(name) {
  return name.split(' ').slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('');
}

function fmtDuration(ms) {
  if (!ms || ms <= 0) return '—';
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}

// ─── Render functions ─────────────────────────────────────────────────────────
function renderAll() {
  renderStatus();
  renderStats();
  renderParticipants();
  renderChats();
  updateDownloadBtn();
}

function renderStatus() {
  const badge = $('status-badge');
  const dot   = $('status-dot');
  const text  = $('status-text');
  const title = $('meeting-title');

  const hasData     = state?.participants?.length > 0 || state?.chats?.length > 0;
  const isTracking  = state?.isTracking;

  if (isTracking) {
    badge.className = 'status-badge active';
    dot.className   = 'dot dot-active';
    text.textContent = 'Tracking Active';
  } else if (hasData) {
    badge.className = 'status-badge ended';
    dot.className   = 'dot dot-ended';
    text.textContent = 'Session Ended';
  } else {
    badge.className = 'status-badge standby';
    dot.className   = 'dot dot-standby';
    text.textContent = 'Standby';
  }

  title.textContent = state?.meetingTitle || 'Not in a Google Meet';
}

function renderStats() {
  const participants = state?.participants || [];
  const chats        = state?.chats        || [];
  const start        = state?.meetingStart;

  $('stat-participants').textContent = participants.length;
  $('stat-chats').textContent        = chats.length;

  if (start && state?.isTracking) {
    const elapsed = Date.now() - start;
    $('stat-duration').textContent = fmtDuration(elapsed);
  } else if (start && !state?.isTracking && state?.participants?.length > 0) {
    // Session ended — show final duration from last leave time
    const lastLeave = Math.max(...participants.map(p => p.leaveTime || start));
    $('stat-duration').textContent = fmtDuration(lastLeave - start);
  } else {
    $('stat-duration').textContent = '—';
  }
}

function renderParticipants() {
  const panel        = $('panel-participants');
  const participants = state?.participants || [];

  if (participants.length === 0) {
    panel.innerHTML = `<div class="empty"><div class="empty-icon">👥</div><span>Waiting for participants…</span></div>`;
    return;
  }

  // Sort: present first, then by join time
  const sorted = [...participants].sort((a, b) => {
    if (!a.leaveTime && b.leaveTime)  return -1;
    if (a.leaveTime  && !b.leaveTime) return 1;
    return a.joinTime - b.joinTime;
  });

  panel.innerHTML = sorted.map(p => `
    <div class="participant-row ${p.leaveTime ? 'left' : ''}">
      <div class="avatar">${esc(initials(p.name) || '?')}</div>
      <div class="p-info">
        <div class="p-name">${esc(p.name)}</div>
        <div class="p-times">
          <span class="time-chip chip-join">↓ ${fmtTime(p.joinTime)}</span>
          ${p.leaveTime
            ? `<span class="time-chip chip-leave">↑ ${fmtTime(p.leaveTime)}</span>`
            : `<span class="time-chip chip-present">● Present</span>`
          }
        </div>
      </div>
      <div class="p-duration">${fmtDuration(p.duration)}</div>
    </div>
  `).join('');
}

function renderChats() {
  const panel = $('panel-chats');
  const chats = state?.chats || [];

  if (chats.length === 0) {
    panel.innerHTML = `<div class="empty"><div class="empty-icon">💬</div><span>No chat messages yet</span></div>`;
    return;
  }

  panel.innerHTML = chats.map(c => `
    <div class="chat-row">
      <div class="chat-header">
        <span class="chat-sender">${esc(c.sender)}</span>
        <span class="chat-time">${esc(c.time)}</span>
      </div>
      <div class="chat-body">${esc(c.text)}</div>
    </div>
  `).join('');

  // Auto-scroll to latest if chat tab is active
  if (activeTab === 'chats') panel.scrollTop = panel.scrollHeight;
}

function updateDownloadBtn() {
  const hasData = (state?.participants?.length > 0) || (state?.chats?.length > 0);
  $('btn-download').disabled = !hasData;
}

// ─── Download Report ──────────────────────────────────────────────────────────
function downloadReport() {
  if (!state) return;
  const html = buildReportHTML(state);
  const blob  = new Blob([html], { type: 'text/html' });
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a');
  a.href      = url;

  const dateStr = new Date().toISOString().slice(0, 10);
  const title   = (state.meetingTitle || 'meeting').replace(/[^a-z0-9]/gi, '_').toLowerCase();
  a.download    = `meetsync_${title}_${dateStr}.html`;

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── HTML Report Generator ────────────────────────────────────────────────────
function buildReportHTML(s) {
  const participants = s.participants || [];
  const chats        = s.chats        || [];
  const start        = s.meetingStart;
  const title        = s.meetingTitle || 'Google Meet Session';
  const generated    = new Date().toLocaleString();

  // Duration
  const lastLeave  = participants.length
    ? Math.max(...participants.map(p => p.leaveTime || Date.now()))
    : Date.now();
  const totalMs    = start ? lastLeave - start : 0;
  const durationStr = fmtDuration(totalMs);
  const startStr    = start ? new Date(start).toLocaleString() : '—';

  const presentCount = participants.filter(p => !p.leaveTime).length;

  // Participant rows
  const pRows = participants.length === 0
    ? '<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:20px">No participants recorded</td></tr>'
    : [...participants]
        .sort((a, b) => a.joinTime - b.joinTime)
        .map(p => `
          <tr>
            <td>${esc(p.name)}</td>
            <td>${fmtTime(p.joinTime)}</td>
            <td>${p.leaveTime ? fmtTime(p.leaveTime) : '<span class="badge present">Still Present</span>'}</td>
            <td>${fmtDuration(p.duration)}</td>
          </tr>
        `).join('');

  // Chat rows
  const cRows = chats.length === 0
    ? '<tr><td colspan="3" style="text-align:center;color:#9ca3af;padding:20px">No chat messages recorded</td></tr>'
    : chats.map(c => `
        <tr>
          <td style="white-space:nowrap">${esc(c.time)}</td>
          <td><strong>${esc(c.sender)}</strong></td>
          <td>${esc(c.text)}</td>
        </tr>
      `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>MeetSync Report — ${esc(title)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', sans-serif;
    background: #0d0f14;
    color: #e8eaf0;
    padding: 0;
    min-height: 100vh;
  }
  /* Header */
  .report-header {
    background: linear-gradient(135deg, #13162b 0%, #1c0f3a 100%);
    padding: 36px 48px 32px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
  }
  .brand-row { display:flex; align-items:center; gap:12px; margin-bottom:20px; }
  .brand-icon {
    width:38px; height:38px; background:linear-gradient(135deg,#5b6cf8,#8b5cf6);
    border-radius:10px; display:flex; align-items:center; justify-content:center;
    font-size:18px;
  }
  .brand-name {
    font-size:22px; font-weight:700; letter-spacing:-0.5px;
    background:linear-gradient(90deg,#818cf8,#c084fc);
    -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text;
  }
  .meeting-name { font-size:28px; font-weight:700; margin-bottom:12px; color:#f1f5f9; }
  .meta-row { display:flex; gap:24px; flex-wrap:wrap; }
  .meta-item { font-size:13px; color:#6b7280; }
  .meta-item span { color:#94a3b8; font-weight:500; }
  /* Stats strip */
  .stats-strip {
    display:grid; grid-template-columns:repeat(4,1fr);
    border-bottom:1px solid rgba(255,255,255,0.07);
  }
  .stat-box {
    padding:20px 24px;
    border-right:1px solid rgba(255,255,255,0.07);
    background:#141720;
  }
  .stat-box:last-child { border-right:none; }
  .stat-num { font-size:30px; font-weight:700; color:#f1f5f9; line-height:1; }
  .stat-lbl { font-size:11px; color:#6b7280; text-transform:uppercase; letter-spacing:0.6px; margin-top:4px; }
  /* Sections */
  .section { padding:32px 48px; }
  .section + .section { border-top:1px solid rgba(255,255,255,0.07); }
  .section-title {
    font-size:16px; font-weight:700; margin-bottom:20px;
    display:flex; align-items:center; gap:8px; color:#c7d2fe;
  }
  /* Tables */
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th {
    background:#1a1e2b; text-align:left;
    padding:10px 14px; font-size:11px; font-weight:600;
    text-transform:uppercase; letter-spacing:0.5px; color:#6b7280;
    border-bottom:1px solid rgba(255,255,255,0.08);
  }
  td { padding:11px 14px; border-bottom:1px solid rgba(255,255,255,0.05); color:#d1d5db; vertical-align:top; }
  tr:hover td { background:rgba(255,255,255,0.02); }
  tr:last-child td { border-bottom:none; }
  .badge {
    display:inline-block; padding:2px 8px; border-radius:12px;
    font-size:11px; font-weight:600;
  }
  .badge.present { background:rgba(34,197,94,0.15); color:#4ade80; }
  /* Footer */
  .report-footer {
    padding:20px 48px; border-top:1px solid rgba(255,255,255,0.07);
    text-align:center; font-size:11px; color:#4b5563;
    background:#0d0f14;
  }
</style>
</head>
<body>

<div class="report-header">
  <div class="brand-row">
    <div class="brand-icon">⚡</div>
    <div class="brand-name">MeetSync</div>
  </div>
  <div class="meeting-name">${esc(title)}</div>
  <div class="meta-row">
    <div class="meta-item">Started: <span>${startStr}</span></div>
    <div class="meta-item">Duration: <span>${durationStr}</span></div>
    <div class="meta-item">Generated: <span>${generated}</span></div>
  </div>
</div>

<div class="stats-strip">
  <div class="stat-box">
    <div class="stat-num">${participants.length}</div>
    <div class="stat-lbl">Total Participants</div>
  </div>
  <div class="stat-box">
    <div class="stat-num">${presentCount}</div>
    <div class="stat-lbl">Still Present</div>
  </div>
  <div class="stat-box">
    <div class="stat-num">${chats.length}</div>
    <div class="stat-lbl">Chat Messages</div>
  </div>
  <div class="stat-box">
    <div class="stat-num">${durationStr}</div>
    <div class="stat-lbl">Total Duration</div>
  </div>
</div>

<div class="section">
  <div class="section-title">👥 Attendance Log</div>
  <table>
    <thead>
      <tr>
        <th>Participant</th>
        <th>Joined At</th>
        <th>Left At</th>
        <th>Duration</th>
      </tr>
    </thead>
    <tbody>${pRows}</tbody>
  </table>
</div>

<div class="section">
  <div class="section-title">💬 Chat Log</div>
  <table>
    <thead>
      <tr>
        <th style="width:100px">Time</th>
        <th style="width:160px">Sender</th>
        <th>Message</th>
      </tr>
    </thead>
    <tbody>${cRows}</tbody>
  </table>
</div>

<div class="report-footer">
  Generated by MeetSync — AI-powered Meeting Intelligence &nbsp;·&nbsp; ${generated}
</div>

</body>
</html>`;
}

// ─── Clear session ────────────────────────────────────────────────────────────
async function clearSession() {
  if (!confirm('Clear all session data? This cannot be undone.')) return;
  await chrome.runtime.sendMessage({ type: 'CLEAR_STATE' }).catch(() => {});
  state = null;
  renderAll();
}
