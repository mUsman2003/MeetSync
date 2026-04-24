/**
 * MeetSync engagement v2 — encoded events + roster (aligned with example/meet-statistics Store.js)
 * Loaded in content script, popup, and background (importScripts).
 */
(function (global) {
  "use strict";

  var eventTypes = {
    join: "0",
    leave: "1",
    chat: "a",
    emoji: "9"
  };

  var eventMap = Object.keys(eventTypes).reduce(function (acc, k) {
    acc[eventTypes[k]] = k;
    return acc;
  }, {});

  function hash(str) {
    var len = (str || "").length;
    var h = 5381;
    for (var i = 0; i < len; i++) {
      h = (h * 33) ^ str.charCodeAt(i);
    }
    return (h >>> 0).toString(36);
  }

  function normalizeDisplayName(name) {
    if (!name) return "";
    var s = String(name).replace(/\u202F/g, " ").trim();
    if (s.toLowerCase() === "you") return s;
    var words = s.split(/\s+/g);
    return words
      .map(function (x) {
        return x.length ? x[0].toUpperCase() + x.slice(1) : "";
      })
      .join(" ");
  }

  /** Stable key for merging the same person across pid vs name-only rows. */
  function normalizeNameKey(name) {
    return String(name || "")
      .replace(/\u202F/g, " ")
      .replace(/\s+\([^)]+\)\s*$/g, "")
      .trim()
      .toLowerCase();
  }

  function metaKeyForMeeting(meetingId) {
    return "meetms_meta_" + meetingId;
  }

  /**
   * Returns true only if the extension context is still live.
   * chrome.runtime.id becomes undefined when the extension is reloaded/unloaded
   * while a content script is still running in a tab.
   */
  function isContextValid() {
    try {
      return typeof chrome !== "undefined" &&
             !!chrome.storage &&
             !!chrome.runtime &&
             !!chrome.runtime.id;
    } catch (_) {
      return false;
    }
  }

  /**
   * @returns {Promise<{ dataId: string, firstSeen: number } | null>}
   */
  async function ensureMeetingMeta(meetingId) {
    if (!meetingId || !isContextValid()) return null;
    var key = metaKeyForMeeting(meetingId);
    var result;
    try { result = await chrome.storage.local.get(key); }
    catch (_) { return null; }
    if (result[key]) return result[key];
    var meta = {
      dataId: hash(meetingId + "-" + Date.now().toString(36)),
      firstSeen: Date.now()
    };
    try {
      await chrome.storage.local.set(
        /** @type {Record<string, unknown>} */ ({ [key]: meta })
      );
    } catch (_) { return null; }
    return meta;
  }

  async function getMeetingMeta(meetingId) {
    if (!meetingId || !isContextValid()) return null;
    var key = metaKeyForMeeting(meetingId);
    try {
      var result = await chrome.storage.local.get(key);
      return result[key] || null;
    } catch (_) { return null; }
  }

  /**
   * @param {keyof typeof eventTypes} type
   * @param {number} absoluteTimeMs
   * @param {number} meetingFirstSeen
   * @param {string} [payload]
   */
  function encodeEvent(type, absoluteTimeMs, meetingFirstSeen, payload) {
    var code = eventTypes[type];
    if (!code) throw new Error("Unknown event type: " + type);
    var temp = Math.max(0, absoluteTimeMs - meetingFirstSeen);
    var base256 = String.fromCharCode(
      (temp >> 24) & 255,
      (temp >> 16) & 255,
      (temp >> 8) & 255,
      temp & 255
    );
    return code + base256 + (payload || "");
  }

  function decodeEvent(x) {
    if (!x || x.length < 5) return null;
    var t = x[0];
    var type = eventMap[t];
    if (!type) return null;
    var time =
      (x.charCodeAt(1) << 24) +
      (x.charCodeAt(2) << 16) +
      (x.charCodeAt(3) << 8) +
      x.charCodeAt(4);
    var out = { type: type, time: time };
    if (x.length > 5) out.data = x.slice(5);
    return out;
  }

  /**
   * @param {string[]} encodedList
   * @returns {Array<{ type: string, time: number, data?: string }>}
   */
  function decodeEventList(encodedList) {
    return (encodedList || [])
      .map(decodeEvent)
      .filter(Boolean);
  }

  /**
   * @param {ReturnType<decodeEventList>} events
   * @param {number} participantLastSeenOffset - lastSeen relative to meeting start (ms)
   * @param {number} nowOffset - now relative to meeting start (ms)
   */
  function aggregateParticipantEvents(events, participantLastSeenOffset, nowOffset) {
    var chatCount = 0;
    var emojiCount = 0;
    var attendanceMs = 0;
    var joinStack = [];
    var endCap = participantLastSeenOffset != null ? participantLastSeenOffset : nowOffset;
    var i;
    var ev;
    var jt;
    for (i = 0; i < events.length; i++) {
      ev = events[i];
      if (ev.type === "chat") chatCount++;
      else if (ev.type === "emoji") emojiCount++;
      else if (ev.type === "join") joinStack.push(ev.time);
      else if (ev.type === "leave" && joinStack.length) {
        jt = joinStack.pop();
        attendanceMs += Math.max(0, ev.time - jt);
      }
    }
    while (joinStack.length) {
      jt = joinStack.pop();
      attendanceMs += Math.max(0, endCap - jt);
    }
    return {
      chatCount: chatCount,
      emojiCount: emojiCount,
      attendanceMs: attendanceMs
    };
  }

  function participantDataIdFrom(name, avatar, meetParticipantId) {
    if (meetParticipantId) return hash("pid:" + meetParticipantId);
    var nk = normalizeNameKey(name);
    if (nk) return hash("n:" + nk);
    var a = (avatar || "").split("=")[0];
    return hash(normalizeDisplayName(name) + "-" + a);
  }

  function isPresentFromJoinLeave(events) {
    var stack = 0;
    var i;
    for (i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev.type === "join") stack++;
      else if (ev.type === "leave" && stack > 0) stack--;
    }
    return stack > 0;
  }

  /**
   * @param {string} dataId
   * @param {Array<{ name: string, avatar?: string, dataId: string, firstSeen: number, lastSeen: number, subname?: string[] }>} roster
   */
  async function saveParticipantRoster(dataId, roster) {
    if (!isContextValid()) return;
    var k = "P-" + dataId;
    try {
      await chrome.storage.local.set(
        /** @type {Record<string, unknown>} */ ({ [k]: roster })
      );
    } catch (_) {}
  }

  async function getParticipantRoster(dataId) {
    if (!isContextValid()) return [];
    var k = "P-" + dataId;
    try {
      var result = await chrome.storage.local.get(k);
      return result[k] || [];
    } catch (_) { return []; }
  }

  async function appendEncodedEvents(dataId, participantDataId, newEvents) {
    if (!newEvents || !newEvents.length || !isContextValid()) return;
    var fullId = "D-" + dataId + "-" + participantDataId;
    var result;
    try { result = await chrome.storage.local.get(fullId); }
    catch (_) { return; }
    var data = result[fullId] || [];
    var i;
    for (i = 0; i < newEvents.length; i++) {
      data.push(newEvents[i]);
    }
    try {
      await chrome.storage.local.set(
        /** @type {Record<string, unknown>} */ ({ [fullId]: data })
      );
    } catch (_) {}
  }

  /**
   * Upsert roster entry and append encoded events.
   */
  async function recordParticipantEvents(meetingId, name, avatarUrl, encodedStrings, meetParticipantId) {
    var meta = await ensureMeetingMeta(meetingId);
    if (!meta || !encodedStrings || !encodedStrings.length) return;
    var dataId = meta.dataId;
    var displayName = normalizeDisplayName(name);
    var avatar = (avatarUrl || "").split("=")[0];
    var participantDataId = participantDataIdFrom(displayName, avatar, meetParticipantId);
    var roster = await getParticipantRoster(dataId);
    var now = Date.now();
    var found = roster.find(function (p) {
      return p.dataId === participantDataId;
    });
    if (!found) {
      roster.push({
        name: displayName,
        avatar: avatar,
        subname: [],
        firstSeen: now - meta.firstSeen,
        lastSeen: now - meta.firstSeen,
        dataId: participantDataId
      });
    } else {
      found.lastSeen = now - meta.firstSeen;
      if (displayName && found.name !== displayName) found.name = displayName;
    }
    await saveParticipantRoster(dataId, roster);
    await appendEncodedEvents(dataId, participantDataId, encodedStrings);
  }

  /**
   * Load full engagement summary for popup/export.
   */
  async function loadEngagementSummary(meetingId) {
    var meta = await getMeetingMeta(meetingId);
    if (!meta) {
      return {
        meta: null,
        participants: [],
        totals: { reactionCount: 0, chatTelemetryCount: 0 }
      };
    }
    var dataId = meta.dataId;
    var roster = await getParticipantRoster(dataId);
    var nowOffset = Date.now() - meta.firstSeen;
    var totals = { reactionCount: 0, chatTelemetryCount: 0 };
    var participants = [];

    /** @type {Map<string, typeof roster>} */
    var groups = new Map();
    var i;
    for (i = 0; i < roster.length; i++) {
      var row = roster[i];
      var nk = normalizeNameKey(row.name);
      if (!nk) nk = "__id_" + row.dataId;
      if (!groups.has(nk)) groups.set(nk, []);
      groups.get(nk).push(row);
    }

    var keys = Array.from(groups.keys());
    for (i = 0; i < keys.length; i++) {
      var list = groups.get(keys[i]);
      var combinedEncoded = [];
      var j;
      var maxLastSeen = 0;
      var minFirstSeen = Infinity;
      var displayName = "";
      for (j = 0; j < list.length; j++) {
        var p = list[j];
        if ((p.name || "").length > displayName.length) displayName = p.name;
        if (p.lastSeen != null && p.lastSeen > maxLastSeen) maxLastSeen = p.lastSeen;
        if (p.firstSeen != null && p.firstSeen < minFirstSeen) minFirstSeen = p.firstSeen;
        var fullId = "D-" + dataId + "-" + p.dataId;
        var res;
        try { res = await chrome.storage.local.get(fullId); }
        catch (_) { res = {}; }
        var encoded = res[fullId] || [];
        var k;
        for (k = 0; k < encoded.length; k++) {
          combinedEncoded.push(encoded[k]);
        }
      }
      if (!displayName && list[0]) displayName = list[0].name;
      combinedEncoded.sort(function (a, b) {
        var da = decodeEvent(a);
        var db = decodeEvent(b);
        if (!da || !db) return 0;
        return da.time - db.time;
      });
      var events = decodeEventList(combinedEncoded);
      var agg = aggregateParticipantEvents(events, maxLastSeen, nowOffset);
      totals.reactionCount += agg.emojiCount;
      totals.chatTelemetryCount += agg.chatCount;
      participants.push({
        name: displayName,
        avatar: list[0] && list[0].avatar,
        dataId: list[0] && list[0].dataId,
        firstSeen: minFirstSeen === Infinity ? 0 : minFirstSeen,
        lastSeen: maxLastSeen,
        chatCount: agg.chatCount,
        reactionCount: agg.emojiCount,
        attendanceMs: agg.attendanceMs,
        isPresent: isPresentFromJoinLeave(events)
      });
    }

    participants.sort(function (a, b) {
      return normalizeNameKey(a.name).localeCompare(normalizeNameKey(b.name));
    });

    return {
      meta: meta,
      dataId: dataId,
      participants: participants,
      totals: totals
    };
  }

  /** Clear v2 keys for a meeting (used with clear session). */
  async function clearEngagementForMeeting(meetingId) {
    var meta = await getMeetingMeta(meetingId);
    try { await chrome.storage.local.remove(metaKeyForMeeting(meetingId)); } catch (_) {}
    if (!meta) return;
    var dataId = meta.dataId;
    var roster = await getParticipantRoster(dataId);
    var toRemove = ["P-" + dataId];
    var j;
    for (j = 0; j < roster.length; j++) {
      toRemove.push("D-" + dataId + "-" + roster[j].dataId);
    }
    try { await chrome.storage.local.remove(toRemove); } catch (_) {}
  }

  global.MeetSyncEngagement = {
    hash: hash,
    eventTypes: eventTypes,
    normalizeDisplayName: normalizeDisplayName,
    ensureMeetingMeta: ensureMeetingMeta,
    getMeetingMeta: getMeetingMeta,
    encodeEvent: encodeEvent,
    decodeEvent: decodeEvent,
    decodeEventList: decodeEventList,
    aggregateParticipantEvents: aggregateParticipantEvents,
    recordParticipantEvents: recordParticipantEvents,
    loadEngagementSummary: loadEngagementSummary,
    clearEngagementForMeeting: clearEngagementForMeeting,
    appendEncodedEvents: appendEncodedEvents,
    getParticipantRoster: getParticipantRoster,
    saveParticipantRoster: saveParticipantRoster,
    participantDataIdFrom: participantDataIdFrom,
    normalizeNameKey: normalizeNameKey
  };
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : globalThis);
