# MeetSync: Video Presentation Script

**Total Estimated Time:** ~4.5 minutes

---

### 1. Problem (20–30 seconds)
**[Visual: Presenter looking at the camera, or a slide showing the Google Meet interface fading into "lost data" icons]**

**Audio (Script):**
"Have you ever walked out of a long Google Meet and realized you forgot exactly what was decided, who actively contributed, or when someone had to drop off? 
Currently, Google Meet is fantastic for real-time video, but terrible for retention. It doesn't permanently save the live captions, the in-meeting chats vanish once the meeting ends, and there's no native way to verify attendance or active engagement. Crucial information is simply lost the moment you hit 'leave call'. Furthermore, if you switch to another tab to take notes, Google Meet actually turns off its internal caption rendering to save CPU, meaning you can't even rely on basic background scraping."

---

### 2. Target User (15–20 seconds)
**[Visual: Icons or quick b-roll of students, project managers, and remote teams]**

**Audio (Script):**
"This is a massive pain point for three main groups: 
First, **Project Managers** and **Scrum Masters** who need precise records of what was discussed without paying for expensive AI enterprise bots. 
Second, **Educators** who desperately need to track student attendance and exact active participation minutes. 
And third, **Remote Workers** who frequently switch tabs to take notes but still need a continuous, unbroken transcript of the ongoing meeting."

---

### 3. MVP Demonstration (3–3.5 minutes)
**[Visual: Screen recording begins. Show a live Google Meet with a few participants (or simulated participants). Show the MeetSync Chrome Extension icon and open the side panel.]**

**Audio (Script):**
"To solve this, we built **MeetSync**, a lightweight but highly powerful Chrome extension. Let me show you how it works in real-time.

*(0:00 - 0:45: Captions and Background Rendering)*
Here we are in a live Google Meet. I'll turn on Google Meet's native captions. As people speak, you can see the captions appearing on the screen. Now, look at the MeetSync extension panel. MeetSync contains a proprietary extraction engine that uses a DOM `MutationObserver` to instantly capture these captions and save them directly to Chrome's local storage.
More importantly, watch what happens when I switch tabs to my document here. Historically, Google Meet shuts down caption rendering when hidden. But MeetSync injects a script into the main browser world to spoof the `visibilityState`, forcing Google Meet to think it's always in the foreground. Our transcription continues to record flawlessly in the background.

*(0:45 - 1:45: Chat and Action Items)*
Next, let's look at the chat functionality. I'm going to send a few messages in the Meet chat. MeetSync grabs these exactly as they are sent. It resolves complex Identity issues—even identifying the host properly when Meet's DOM hides the sender's name. You can see the messages populated right here in the extension. 

*(1:45 - 2:45: Engagement and Telemetry)*
Now for my favorite part: The Engagement Telemetry. As an educator or a host, I need to know who was actually here. Let's click over to the 'Engagement' tab. 
Instead of just a list of names, MeetSync calculates absolute metrics. Look at this table: we have the exact **Join Time** for each participant, the number of **Messages** they sent, the number of **Reactions** they used, and their exact **Active Minutes** on the call. 
If someone drops out of the call, MeetSync logs the timestamp and pauses their Active Minutes. When they rejoin, it resumes. 

*(2:45 - 3:15: Data Export/Wrap up feature)*
Because all of this is stored in `chrome.storage.local`, it persists across tabs. When the meeting ends, you have a perfect, cross-referenced database of the transcript, the chat log, and the granular attendance record, ready to be exported or reviewed at your convenience."

---

### 4. Key Insight (20–30 seconds)
**[Visual: Presenter returns to the camera, or a clean wrap-up slide with the MeetSync logo]**

**Audio (Script):**
"The most fascinating insight we gained building MeetSync was realizing how aggressively modern web applications throttle background activity. We couldn't just build a simple scraper; we had to engineer a way to intercept and spoof Chrome's visibility APIs to force Google Meet's WebRTC engine to stay awake. It taught us that building robust browser extensions isn't just about reading the DOM—it's about fundamentally altering how the web app perceives the user's presence to guarantee continuous data capture."
