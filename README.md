# MeetSync — Chrome Extension MVP (Phase 3)

> **AI Product Development Course Project — NUCES/FAST**  
> Team: Muhammad Usman · Abdul Wahab · Ahmed Ali · Hussain Waseem

---

## What It Does

MeetSync is a Chrome Extension that the **meeting organizer** loads during a Google Meet session. For the MVP it provides:

| Feature | Detail |
|---|---|
| **Participant Tracking** | Captures every participant's **join time**, **leave time**, and **total duration** in the call |
| **Chat Recording** | Captures all public chat messages (**sender**, **text**, **timestamp**) — includes pre-existing messages at activation |
| **Live Popup Dashboard** | Real-time panel showing current participant list and full chat log |
| **HTML Attendance Report** | One-click download of a beautifully formatted self-contained HTML report |

Everything runs entirely **client-side** — no backend, no API keys, no data leaves the browser.

---

## File Structure

```
Meetsync extension/
├── manifest.json       Chrome Extension Manifest V3
├── background.js       Service worker — state management via chrome.storage.session
├── content.js          Injected into meet.google.com — DOM observation & tracking
├── popup.html          Extension popup UI shell
├── popup.js            Popup logic — renders data, handles download & clear
├── popup.css           Premium dark-mode styles (Inter font + gradient accents)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## How to Install (Developer Mode)

1. Open Chrome and navigate to **`chrome://extensions`**
2. Enable **Developer mode** (top-right toggle)
3. Click **"Load unpacked"**
4. Select the **`Meetsync extension`** folder
5. The MeetSync icon (⚡) will appear in your Chrome toolbar

---

## How to Use

1. **Join or start a Google Meet** at `meet.google.com`
2. MeetSync **auto-starts tracking** as soon as it detects an active call (~3 second delay to let Meet fully load)
3. It **auto-opens the People panel** to begin participant detection
4. It **auto-opens the Chat panel** to capture any existing messages, then watches for new ones
5. Click the **MeetSync icon** in the toolbar anytime to see the live dashboard
6. When the meeting ends, click **"Download Report"** to get the HTML attendance + chat log

---

## Technical Details

### Participant Detection
- Uses `MutationObserver` on the document body watching for `data-participant-id` attribute changes — Google Meet's most stable participant identifier
- A **periodic re-scan** every 6 seconds acts as a backup for any observer misses
- Participants who disappear from the video grid are automatically marked as "left"

### Chat Recording
- Scans **pre-existing** chat messages in the DOM immediately after opening the chat panel
- Watches for **new messages** via a `MutationObserver` on the chat container
- Deduplication via sender+text key prevents double-counting

### State Management
- All data is stored in **`chrome.storage.session`** (auto-cleared on browser close)
- Content script → Background: `chrome.runtime.sendMessage`
- Popup → State: `chrome.storage.session.get` (polls every 2 seconds)

### Selector Resilience
Google Meet uses obfuscated class names that change with deployments. MeetSync uses a **priority-ordered fallback list** for every selector:
1. Stable `data-*` attributes (`data-participant-id`)
2. Semantic `aria-label` patterns (e.g. `[aria-label*="Chat" i]`)
3. Known BEM-like class names (`.zWGUib`, `.oIy2qc`)

If selectors break after a Meet update, edit the `SEL` object at the top of `content.js`.

---

## MVP Limitations (Intentional)

- ❌ No AI-based task extraction (Phase 4)
- ❌ No audio / speech recognition (Phase 4)  
- ❌ No Microsoft Teams or Zoom support (Phase 4)
- ❌ No cloud sync / authentication (Phase 4)
- ⚠️ Participant names depend on Google Meet's DOM — a major Meet update may break name extraction
- ⚠️ Chat sender attribution relies on DOM structure — works for the standard Meet UI

---

## Known Assumptions Being Tested

| Assumption | What This MVP Tests |
|---|---|
| A1 — Verbal/written decisions are lost | Chat log proves written decisions are capturable |
| A5 — Engagement scoring is acceptable | Attendance duration data is the non-invasive first step |
| A8 — Compliance within MVP budget | Client-side only; no data transmission = minimal regulatory risk |
