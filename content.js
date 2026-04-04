// content.js — MeetSync content script
// Injected into every meet.google.com tab. Tracks participants and chat.

(() => {
  'use strict';

  const log  = (...a) => console.log('[MeetSync]', ...a);
  const warn = (...a) => console.warn('[MeetSync]', ...a);

  // ════════════════════════════════════════════════════════════════
  // CONFIG — update selectors here if Google Meet changes its DOM
  // ════════════════════════════════════════════════════════════════
  const SEL = {
    // Any element that proves we are in an active call
    inCall: [
      '[data-participant-id]',
      '[aria-label*="Leave call" i]',
      '[aria-label*="End call" i]',
      '[jsname="CQylAd"]'
    ],

    // People / participants panel toggle button
    peopleBtn: [
      'button[aria-label*="people" i]',
      'button[aria-label*="participant" i]',
      'button[aria-label*="Show everyone" i]',
      '[jsname="A5il2e"]',
      '[data-tab-id="1"]'
    ],

    // Chat panel toggle button
    chatBtn: [
      'button[aria-label*="chat" i]',
      'button[aria-label*="Send a message" i]',
      '[jsname="r82FXAF"]',
      '[data-tab-id="2"]'
    ],

    // Video tile containers — data-participant-id is the most stable attrib
    tiles: ['[data-participant-id]'],

    // Name element inside each tile
    tileName: [
      '[data-self-name]',
      '.zWGUib',
      '.NWpY1',
      '[jsname="XdSTDd"]',
      '[jsname="BnGWJb"]'
    ],

    // Chat messages scrollable container
    chatContainer: [
      '[aria-label*="Chat messages" i]',
      '[aria-label*="Chat" i][role="region"]',
      '[aria-label*="message" i][role="list"]',
      '.z38b6',
      '[jsname="xySENc"]'
    ],

    // Individual chat message rows
    chatMsg: [
      '[data-message-id]',
      '[jsname*="msg"]',
      '.GDhqjd'
    ],

    // Sender name inside a message
    msgSender: [
      '.gMJiId',
      '[jsname*="author"]',
      '[data-sender-id]',
      'span.YTbUzc'
    ],

    // Message body text
    msgBody: [
      '.oIy2qc',
      '[jsname*="body"]',
      '[data-message-body]',
      '.GvcuGe',
      '.Ss4fHf'
    ]
  };

  // ════════════════════════════════════════════════════════════════
  // UTILITIES
  // ════════════════════════════════════════════════════════════════
  function qs(selList) {
    for (const s of selList) {
      try { const el = document.querySelector(s); if (el) return el; } catch (_) {}
    }
    return null;
  }

  function qsAll(selList) {
    for (const s of selList) {
      try {
        const els = document.querySelectorAll(s);
        if (els.length) return Array.from(els);
      } catch (_) {}
    }
    return [];
  }

  function qsIn(root, selList) {
    for (const s of selList) {
      try { const el = root.querySelector(s); if (el) return el; } catch (_) {}
    }
    return null;
  }

  const now  = () => Date.now();
  const fmtT = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtD = ms => {
    if (!ms) return '—';
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    return h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
  };

  // ════════════════════════════════════════════════════════════════
  // STATE
  // ════════════════════════════════════════════════════════════════
  const state = {
    running:      false,
    meetingStart: null,
    meetingTitle: null,
    participants: new Map(),   // id → { id, name, joinTime, leaveTime, duration }
    chats:        [],
    chatKeys:     new Set(),   // dedup
    obs:          { grid: null, chat: null },
    scanTick:     null
  };

  // ════════════════════════════════════════════════════════════════
  // PARTICIPANT TRACKING
  // ════════════════════════════════════════════════════════════════
  function tileId(tile) {
    return tile.getAttribute('data-participant-id') ||
           tile.getAttribute('data-requested-participant-id') ||
           null;
  }

  function tileName(tile) {
    // 1. Known name selectors inside tile
    const el = qsIn(tile, SEL.tileName);
    if (el && el.textContent.trim()) return el.textContent.trim();

    // 2. aria-label on the tile (e.g. "Jane Smith (unmuted)")
    const label = tile.getAttribute('aria-label') || '';
    if (label) {
      const clean = label.split(/[,(＆]/)[0].trim();
      if (clean && clean.length < 70) return clean;
    }

    // 3. Walk text nodes for short, human-readable text
    const walker = document.createTreeWalker(tile, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim();
      if (t.length > 0 && t.length < 60 && !/^\d+$/.test(t) &&
          !['Muted','Camera','Pin','Mic'].some(w => t.includes(w))) {
        return t;
      }
    }
    return null;
  }

  function addParticipant(id, name) {
    if (!id || !name || state.participants.has(id)) return false;
    
    // Ignore screen shares
    if (name.toLowerCase().includes('presentation') || name.toLowerCase().includes('companion')) return false;

    state.participants.set(id, { id, name, joinTime: now(), leaveTime: null, duration: null });
    log(`+ Joined: ${name}`);
    return true;
  }

  function markLeft(id) {
    const p = state.participants.get(id);
    if (!p || p.leaveTime !== null) return false;
    p.leaveTime = now();
    p.duration  = p.leaveTime - p.joinTime;
    log(`- Left: ${p.name} (${fmtD(p.duration)})`);
    return true;
  }

  function scanParticipants() {
    const tiles  = qsAll(SEL.tiles);
    const seenIds = new Set();

    for (const tile of tiles) {
      const id   = tileId(tile);
      const name = tileName(tile);
      if (id && name) { seenIds.add(id); addParticipant(id, name); }
    }

    // Anyone not in grid anymore → mark left
    for (const [id, p] of state.participants) {
      if (!seenIds.has(id) && p.leaveTime === null) markLeft(id);
    }

    sync();
  }

  // ════════════════════════════════════════════════════════════════
  // CHAT TRACKING
  // ════════════════════════════════════════════════════════════════
  let lastSender = 'Unknown';

  function addChat(sender, text, ts, key) {
    sender = (sender || '').trim();
    text   = (text   || '').trim();
    if (!sender || !text) return false;

    if (!key) key = `${sender}::${text.substring(0, 120)}`;
    if (state.chatKeys.has(key)) return false;

    state.chatKeys.add(key);
    state.chats.push({ sender, text, timestamp: ts, time: fmtT(ts) });
    log(`Chat | ${sender}: "${text.substring(0, 60)}"`);
    return true;
  }

  function scanAllChats() {
    const container = qs(SEL.chatContainer);
    if (!container) return;

    const msgBlocks = container.querySelectorAll('.GDhqjd, [data-message-id]');
    if (msgBlocks.length === 0) return;

    let chatIndex = 0;
    msgBlocks.forEach(block => {
      const senderEl = qsIn(block, ['.YTbUzc', '.ZsnNWb', '[data-sender-name]']);
      if (senderEl) {
        let sText = senderEl.getAttribute('data-sender-name') || senderEl.textContent;
        // Strip time like "3:04 PM"
        sText = sText.replace(/\d{1,2}:\d{2}\s*(AM|PM)?/i, '').trim();
        if (sText) lastSender = sText;
      }

      const bodies = block.querySelectorAll('.oIy2qc');
      bodies.forEach(bEl => {
        const b = bEl.textContent.trim();
        // Ignore hover buttons accidentally caught
        if (b && !['Pin message', 'keep', 'what'].includes(b) && !b.includes('Pin message')) {
           const id = block.getAttribute('data-message-id') || `idx_${chatIndex}`;
           const key = `${id}_${b.substring(0, 30)}`;
           addChat(lastSender, b, now(), key);
        }
        chatIndex++;
      });
    });
    sync();
  }

  function scanExistingChats() {
    scanAllChats();
  }

  // ════════════════════════════════════════════════════════════════
  // OBSERVERS
  // ════════════════════════════════════════════════════════════════
  function setupGridObserver() {
    state.obs.grid?.disconnect();
    state.obs.grid = new MutationObserver(() => scanParticipants());
    state.obs.grid.observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['data-participant-id']
    });
    log('Grid observer active');
  }

  function setupChatObserver() {
    const container = qs(SEL.chatContainer);
    if (!container) { setTimeout(setupChatObserver, 2500); return; }

    state.obs.chat?.disconnect();
    // Use debounced scanning of all chats instead of trying to patch nodes
    let timeout;
    state.obs.chat = new MutationObserver(() => {
      clearTimeout(timeout);
      timeout = setTimeout(scanAllChats, 250);
    });

    state.obs.chat.observe(container, { childList: true, subtree: true });
    log('Chat observer active');
  }

  // ════════════════════════════════════════════════════════════════
  // PANEL CONTROL
  // ════════════════════════════════════════════════════════════════
  function openPanel(selList, label) {
    const btn = qs(selList);
    if (!btn) { warn(`${label} button not found`); return; }
    const open = btn.getAttribute('aria-pressed') === 'true' ||
                 btn.getAttribute('aria-expanded') === 'true';
    if (!open) { btn.click(); log(`Opened ${label} panel`); }
    else        { log(`${label} panel already open`); }
  }

  // ════════════════════════════════════════════════════════════════
  // BACKGROUND SYNC
  // ════════════════════════════════════════════════════════════════
  function sync() {
    chrome.runtime.sendMessage({
      type: 'STATE_UPDATE',
      data: {
        isTracking:   state.running,
        meetingStart: state.meetingStart,
        meetingTitle: state.meetingTitle,
        participants: Array.from(state.participants.values()),
        chats:        state.chats
      }
    }).catch(() => {});
  }

  // ════════════════════════════════════════════════════════════════
  // MEETING TITLE
  // ════════════════════════════════════════════════════════════════
  function getMeetingTitle() {
    const title = document.title || '';
    if (title.includes('-')) return title.split('-')[0].trim();
    if (title && !title.toLowerCase().includes('meet')) return title;
    const code = window.location.pathname.replace(/\//g, '').split('?')[0];
    return code ? `Meet: ${code}` : 'Google Meet Session';
  }

  // ════════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════════════
  function start() {
    if (state.running) return;
    state.running      = true;
    state.meetingStart = now();
    state.meetingTitle = getMeetingTitle();
    log('=== Session started ===');

    // Open people panel → scan grid
    openPanel(SEL.peopleBtn, 'People');
    setupGridObserver();
    scanParticipants();

    // After 2s → open chat → scan existing → then watch
    setTimeout(() => {
      openPanel(SEL.chatBtn, 'Chat');
      setTimeout(() => {
        scanExistingChats();
        setupChatObserver();
      }, 2000);
    }, 2000);

    // Periodic fallback scan every 6s
    state.scanTick = setInterval(() => { scanParticipants(); }, 6000);

    sync();
  }

  function stop() {
    if (!state.running) return;
    state.running = false;
    for (const [id] of state.participants) markLeft(id);
    state.obs.grid?.disconnect();
    state.obs.chat?.disconnect();
    clearInterval(state.scanTick);
    sync();
    chrome.runtime.sendMessage({ type: 'SESSION_ENDED' }).catch(() => {});
    log('=== Session stopped ===');
  }

  // ════════════════════════════════════════════════════════════════
  // MESSAGE LISTENER (from popup)
  // ════════════════════════════════════════════════════════════════
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'START')  { start(); sendResponse({ ok: true }); }
    if (msg.type === 'STOP')   { stop();  sendResponse({ ok: true }); }
    if (msg.type === 'PING')   { sendResponse({ ok: true, isTracking: state.running }); }
    if (msg.type === 'RESCAN') { scanParticipants(); scanExistingChats(); sendResponse({ ok: true }); }
    return true;
  });

  // ════════════════════════════════════════════════════════════════
  // AUTO-START: wait for active call indicators
  // ════════════════════════════════════════════════════════════════
  function waitForCall() {
    const inCall = SEL.inCall.some(s => { try { return !!document.querySelector(s); } catch(_){return false;} });
    if (inCall) {
      log('Active call detected — starting in 3s');
      setTimeout(start, 3000);
    } else {
      setTimeout(waitForCall, 2000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForCall);
  } else {
    setTimeout(waitForCall, 1000);
  }

  log('Content script loaded:', window.location.href);
})();
