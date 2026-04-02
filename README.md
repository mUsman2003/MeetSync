# MeetSync

> **An AI-powered Chrome Extension that captures Google Meet chat logs in real-time, detects action items, tracks participant attendance, and exports structured meeting intelligence.**

---

## Table of Contents

1. [What It Does](#what-it-does)
2. [Installation](#installation)
3. [Usage](#usage)
4. [How It Works](#how-it-works)
5. [Exported Data Format](#exported-data-format)
6. [Known Limitations](#known-limitations)
7. [Project Context](#project-context)

---

## What It Does

MeetSync runs silently in the background during any Google Meet session and:

| Feature | Description |
|---------|-------------|
| 📋 **Real-time chat capture** | Extracts all chat messages with sender names and timestamps as they appear |
| ⚡ **Action-item detection** | Flags messages containing task signals (deadlines, @mentions, obligation keywords) |
| 👥 **Participant tracking** | Logs join/leave events and builds an attendee list with timestamps |
| ⏱ **Session duration** | Tracks meeting duration from first detection |
| 📊 **Live popup dashboard** | Shows a live feed sorted by filter: All / Action Items / Attendees |
| ⬇ **Export** | Downloads structured JSON or CSV after the meeting |

---

## Installation

MeetSync is a Chrome Extension (Manifest V3). It is not published on the Chrome Web Store — load it in developer mode:

### Steps

1. **Clone or download** this repository to your local machine

2. **Open Chrome** and navigate to:
   ```
   chrome://extensions
   ```

3. **Enable Developer Mode** (toggle in the top-right corner)

4. Click **"Load unpacked"**

5. Select the **root folder** of this repository (the one containing `manifest.json`)

6. The MeetSync icon will appear in your Chrome toolbar

> **Tip:** Pin the extension by clicking the puzzle-piece icon → pin MeetSync.

---

## Usage

1. **Join a Google Meet** (`https://meet.google.com/...`)

2. **Open the chat panel** in Google Meet (the chat icon in the bottom toolbar)
   > ⚠️ The chat panel must remain open for MeetSync to capture messages

3. **Click the MeetSync icon** in your Chrome toolbar to open the popup

4. Use the **filter tabs** to switch views:
   - **📋 All** — full chronological feed of all messages and events
   - **⚡ Action Items** — only messages flagged as tasks or assignments
   - **👥 Attendees** — participant list with join/leave timestamps

5. After the meeting, click **⬇ JSON** or **⬇ CSV** to export the captured data

---

## How It Works

```
Google Meet DOM
      │
      ▼
content.js (MutationObserver)
  • Scans chat panel every 500ms on DOM changes
  • Extracts: sender, message, timestamp
  • Runs detectIsTask() heuristic on each message
  • Listens for join/leave toast notifications
      │
      ▼
chrome.storage.local
  • Persists all entries keyed by meeting ID (meet_<id>)
  • Sessions survive popup close/open cycles
      │
      ▼
background.js (Service Worker)
  • Relays NEW_ENTRY, SESSION_STARTED, CHAT_PANEL_STATE messages
  • Handles export download requests
      │
      ▼
popup.html / popup.js
  • Reads storage on open; listens for live updates via port
  • Renders feed; filters by All / Action Items / Attendees
  • Runs session duration timer
  • Builds summary and triggers file download on export
```

### Action-Item Detection

MeetSync uses a keyword + pattern heuristic (no LLM) to flag messages as action items. Signals include:

- Explicit phrases: *"action item"*, *"todo"*, *"follow-up"*, *"next steps"*
- Request language: *"please"*, *"can you"*, *"make sure"*, *"don't forget"*
- Deadline language: *"by EOD"*, *"by tomorrow"*, *"by Friday"*
- Obligation language: *"needs to"*, *"must fix"*, *"should review"*
- @mentions (strong assignment signal)

---

## Exported Data Format

### JSON (`meetsync_<id>_<timestamp>.json`)

```json
{
  "meetingId": "abc-defg-hij",
  "exportedAt": "2026-04-02T15:30:00.000Z",
  "sessionDuration": "47:22",
  "totalEntries": 34,
  "chatMessageCount": 28,
  "actionItemCount": 5,
  "eventCount": 6,
  "participantCount": 4,
  "participants": [
    { "name": "Alice Khan",   "joinedAt": "10:02 AM", "leftAt": null, "isPresent": true },
    { "name": "Bob Malik",    "joinedAt": "10:03 AM", "leftAt": "10:48 AM", "isPresent": false }
  ],
  "actionItems": [
    { "sender": "Alice Khan", "message": "Bob can you send the report by EOD?", "timestamp": "10:15 AM" }
  ],
  "knownLimitations": ["..."],
  "entries": [ ... ]
}
```

### CSV (`meetsync_<id>_<timestamp>.csv`)

```
Type,Timestamp,Sender,Message,IsActionItem,CapturedAt
chat,10:15 AM,Alice Khan,"Bob can you send the report by EOD?",TRUE,2026-04-02T05:15:00.000Z
event,10:20 AM,System,"Bob Malik left",FALSE,2026-04-02T05:20:00.000Z
```

---

## Known Limitations

| Limitation | Impact |
|------------|--------|
| **Chat-only** — verbal decisions not typed in chat are not captured | Core constraint; full ASR is Phase 4 scope |
| **Task detection is heuristic** — pattern-based, not LLM-based | May miss subtle phrasing; false positives possible |
| **Chat panel must stay open** — Meet destroys chat DOM when panel closes | User must keep panel open throughout the meeting |
| **Join/leave depends on Meet notifications** — some builds hide these | Participant list may be incomplete |
| **Google Meet DOM dependent** — Works against Meet's current CSS class names which may change | Extension may need updates after Meet UI changes |
| **English-language patterns only** | Task detection will miss non-English task language |

---

## Project Context

MeetSync is the Phase 3 MVP for an **AI Product Development** course project at **NUCES/FAST**.

**Problem addressed:** Decision Amnesia — critical tasks assigned verbally or via chat during meetings are lost because there is no real-time bridge between verbal intent and documented action.

**What this MVP tests:**
- Can keyword-based task detection provide enough signal to be useful without LLM costs?
- Will users keep the chat panel open if they know it logs action items?
- Does a structured post-meeting export reduce follow-up meeting frequency?

**Team:** Muhammad Usman (22I-0900), Abdul Wahab (22I-1178), Ahmed Ali (22I-1237), Hussain Waseem (22I-0893)

**What is intentionally NOT built:**
- Audio/speech transcription (requires ASR — Phase 4)
- Engagement pulse quizzes (Phase 4)
- Microsoft Teams support (Phase 4)
- LLM-based semantic task extraction (Phase 4)
- CRM / project management integrations (Phase 4)