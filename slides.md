# MeetSync: The Ultimate Google Meet Telemetry & Transcription Extension

## Slide 1: The Problem
**Navigating the Limitations of Google Meet**
* **Lost Spoken Information:** Once a meeting ends, the organic conversations and critical details discussed are often lost unless meticulously recorded or manually transcribed.
* **Lack of Concrete Engagement Metrics:** Hosts struggle to accurately measure who actively participated, when users exactly joined or left, and how long they were actually present during long meetings.
* **Background Throttling:** Built-in Meet functions (like Live Captions) are heavily optimized by Google to pause functionality when a user switches tabs, making it impossible to capture complete logs while multitasking.

## Slide 2: The Solution - MeetSync
**A Silent, Real-Time Capture Engine**
* **Live, Pervasive Transcription:** Uses advanced DOM `MutationObserver` algorithms to capture Google Meet's live CC text segment-by-segment. 
* **Background Continuity:** Injects an isolated script into the main browser world to actively spoof `document.visibilityState`. MeetSync fools Google Meet into thinking the tab is always visible, guaranteeing uninterrupted transcription and chat logging even when minimized.
* **Persistent Chat Logging:** Extracts all message and chat payload data cleanly, overcoming Google's highly-obfuscated and grouped DOM layout variants.

## Slide 3: Advanced Telemetry & Architecture
**Under the Hood of Engagement Tracking**
* **Chrome Storage Persistence:** Seamlessly pipelines parsed DOM elements (transcripts, chat messages, system joining/leaving toasts) into a structured `chrome.storage.local` database for immediate cross-tab access.
* **Granular Engagement Metrics:** Processes system events algorithmically to compute precise engagement data per user:
  * Absolute `Join Time`
  * Exact `Active Mins` (attendance duration)
  * Message frequency and Reaction count tracking
* **Lightweight UI:** Provides an elegant side-panel popup overlay displaying real-time leaderboards of session stats, turning generic video calls into fully-analyzable digital assets.
