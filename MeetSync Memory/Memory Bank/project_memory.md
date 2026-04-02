# MeetSync — Project Memory Bank

> **Last updated:** Phase 2 (March 2026)

---

## 1. Project Overview

**Project Name:** MeetSync
**University:** National University of Computer and Emerging Sciences (NUCES/FAST)
**Course:** AI Product Development
**Team Members:**
- Muhammad Usman (22I-0900)
- Abdul Wahab (22I-1178)
- Ahmed Ali (22I-1237)
- Hussain Waseem (22I-0893)

**One-liner:** An AI-powered meeting intelligence tool that converts verbal chaos into actionable clarity through real-time task extraction and engagement auditing.

---

## 2. Problem Statement

Two core pain points identified in Phase 0:

1. **Decision Amnesia** — Critical tasks assigned verbally during meetings are lost because there is no real-time bridge between verbal intent and documented action.
2. **Engagement Blindness** — Passive participation in remote/informal meetings goes unnoticed due to a lack of real-time engagement feedback.

**Key statistics:**
- 71% of meetings are unproductive, costing USD 34B annually
- Employees spend ~31 hours/month in unproductive meetings
- 55% of workers multitask during meetings
- "Quiet meetings" (fully muted participants) rose to 7.2% in 2023

---

## 3. Target Users

**Primary Users:**
- Project Leads & Scrum Masters in small-to-mid tech teams (10–50 employees)
- Educators & Online Instructors conducting live/hybrid sessions

**Secondary Stakeholders:**
- Individual team members (rework due to missed context)
- Students (falling behind when lack of participation is unaddressed)

**Buyer vs. User tension:** The developer uses the tool, but the CTO/Team Lead must buy into the "engagement scoring" concept.

---

## 4. Phase-by-Phase Summary

### Phase 0 — Problem & Product Framing (Approved)
- Identified Decision Amnesia and Engagement Blindness as core problems
- Validated problem existence through public forums, informal conversations
- Identified primary users (project leads, educators) and secondary users
- Current workarounds: camera-on rule, manual scribing, passive attendance logs
- Existing alternatives: Otter.ai, Fireflies.ai (passive tools), Canvas/Moodle (track submission, not engagement)
- High-level product intuition: real-time engagement checkpoints using ASR, NLP, and LLM intent extraction

### Phase 1 — Business Viability Stress Test (Approved)
**Lean Model Canvas:**
- Problem: Decision Amnesia + Engagement Blindness
- Solution: Real-time Task Extraction + Contextual Quizzes
- UVP: "Turning verbal chaos into actionable clarity with real-time engagement auditing."
- Unfair Advantage: Proprietary "Contextual Quiz" logic for actual comprehension
- Revenue: Freemium for students, $10/user/month Pro
- Cost Structure: LLM API costs, Cloud hosting, B2B Acquisition
- Channels: Slack/Teams Apps, LinkedIn, Startup Incubators
- Customer Segments: Agile Scrum Masters & Project Leads in small tech startups (10–50 employees); Student project groups

**Critical Mismatch Analysis:**
- Customer Segments ↔ Channels: Legal/compliance blocks for AI "listening" in corporate environments
- Customer Segments ↔ Revenue: Small teams have lowest willingness to pay, prefer free tools
- Cost Structure ↔ Revenue: Real-time ASR and LLM token usage are expensive; free tier could bankrupt
- Key Metrics ↔ Solution: "Accuracy" is hard to measure; single miss → total trust loss

**SMART Goals (Objective):**
1. Reduce follow-up meetings by 30% within 3 months
2. Achieve $5,000 MRR within 12 months post-launch
3. Maintain 95% F1-score for intent extraction (continuous monitoring)

**SMART Goals (Subjective):**
1. Build user trust — users feel "verbal = documented" (NPS surveys)
2. Reduce meeting stress — lower perceived stress of missing something (bi-annual)
3. Perceived reliability — tool seen as source of truth (6 months post-launch)

**Competitors Analyzed:**
- Fireflies.ai: ✓ Accurate transcription, speaker ID; ✗ Fully passive
- Fathom: ✓ Free, high-quality highlights; ✗ No task ownership or engagement quizzes
- Fellow.app: ✓ Excellent for agendas; ✗ Requires manual input, no AI speech extraction
- Manual Notes: ✓ Zero cost, privacy; ✗ Prone to human error, decision amnesia

**Decision:** Proceed, but must investigate "on-device" processing and softer engagement UX to mitigate privacy and cultural risks.

### Phase 2 — Research Report (Current)
**What was confirmed:**
- Verbal decisions ARE systematically lost in meetings (validated)
- All existing tools are passive — none offer real-time decision capture or engagement verification (validated)
- Market is large ($2.44–2.76B in 2024, ~25% CAGR) and structurally favorable (validated)

**What remains risky:**
- Cultural acceptance of real-time engagement scoring (HIGH RISK)
- Regulatory compliance costs (GDPR + EU AI Act) within MVP budget (HIGH RISK)
- LLM token cost trajectory vs. usage growth (MEDIUM RISK)
- Free tier sustainability (MEDIUM RISK)

**Scope changes:**
- REMOVED: Full transcription (commoditized), calendar/agenda management (Fellow's domain)
- RETAINED: Real-time intent extraction, contextual engagement pulses, post-meeting accountability report
- ADDED: Ephemeral-capture design principle, team-level (not individual) engagement aggregation

---

## 5. Competitive Landscape

| Tool | Type | Price (Pro) | Strengths | Gaps |
|------|------|-------------|-----------|------|
| Otter.ai | Passive transcription | $8.33/user/mo | Real-time transcription, speaker ID, mobile app | No task extraction, no engagement tracking, English-only |
| Fireflies.ai | Passive transcription | $10/user/mo | 100+ languages, CRM integration, sentiment analysis | No real-time intervention, complex pricing |
| Fathom | Passive summary | $19/user/mo | Generous free tier, unlimited recording | Zoom-only natively, basic action items |
| Fellow.app | Meeting management | $7/user/mo | Structured agendas, collaborative notes | Manual input, no AI speech extraction |
| Gong.io | Revenue intelligence | Enterprise | Deep conversation analytics, deal coaching | Enterprise-only, sales-focused |
| Manual Notes | Manual | Free | Zero cost, full privacy | Error-prone, no engagement data |

**MeetSync's differentiation:** ACTIVE (interrupts to confirm decisions + measures engagement), unlike all passive competitors.

---

## 6. Market Data

- **AI Meeting Assistant Market:** USD 2.44–2.76B (2024), projected USD 3.02–3.47B (2025)
- **CAGR:** 24.7–28.2% (2024–2029)
- **Meeting Management Software Market:** USD 4.72B (2024), 10% CAGR
- **Remote work:** 50% of remote-capable employees work hybrid; 86% of meetings have ≥1 remote participant
- **Meeting volume:** Tripled since 2020; employees average 11.3 hours/week in meetings
- **SaaS inflation:** 12.2% in 2024 (vs 2.7% general inflation)

---

## 7. Key Risks

1. **Cultural/Privacy:** Employees may perceive engagement scoring as surveillance
2. **Regulatory:** GDPR explicit consent requirements; EU AI Act (full compliance by Aug 2026) may classify engagement scoring as high-risk AI
3. **Cost:** LLM API costs + real-time audio processing are expensive; free tier risk
4. **Technical:** Sub-second latency requirement for real-time ASR + LLM inference
5. **API Dependency:** Reliance on third-party LLM providers (outage/pricing risk)
6. **Macro-Economic:** SaaS-specific inflation, higher-for-longer interest rates, PKR volatility

---

## 8. MVP Plan (Phase 3 Focus)

**Will include:**
1. Zoom/Google Meet plugin with real-time action-item detection + speaker confirmation
2. Lightweight engagement pulse (single-question pop-up) at natural pauses
3. Post-meeting report with task–owner mapping and team-level engagement score

**Will exclude:**
- Microsoft Teams support (Phase 4)
- CRM and project-management integrations
- On-device/edge processing (cloud-only for MVP)
- Individual-level engagement scoring (team-level only)

---

## 9. Revenue Model

- **Free tier:** Capped at 5 meetings/month, 30-minute sessions (students)
- **Pro tier:** $10/user/month (small teams)
- **Target:** $5,000 MRR within 12 months post-launch (requires ~500 paid users)

---

## 10. Technology Stack (High-Level)

- **ASR (Automatic Speech Recognition):** For real-time audio transcription
- **NLP + LLM:** For intent extraction and task identification
- **Contextual Quiz Engine:** Proprietary logic for comprehension verification
- **Cloud Infrastructure:** AWS/GCP for low-latency GPU instances
- **Integration:** Zoom/Google Meet plugin architecture
