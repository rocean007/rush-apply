<div align="center">

<img src="https://img.shields.io/badge/status-active-brightgreen?style=for-the-badge" />
<img src="https://img.shields.io/badge/AI-powered-blueviolet?style=for-the-badge" />
<img src="https://img.shields.io/badge/built%20with-typescript-blue?style=for-the-badge" />
<img src="https://img.shields.io/badge/automation-playwright-orange?style=for-the-badge" />

# 🤖 AutoApply

### The job hunt is broken. We fixed it.

**AutoApply** scrapes hundreds of remote job boards every 5 hours, uses AI to match you to the best roles, and automatically fills out application forms — while you sleep.

[Live Demo](#) · [Report Bug](issues) · [Request Feature](issues)

</div>

---

## 😤 The Problem

You spend 4 hours a day copy-pasting your name, email, and work history into identical forms across 50 different job sites. You miss good postings because they're buried on boards you've never heard of. You forget to follow up. You apply to the same job twice.

**That's not a job search. That's data entry.**

---

## ✨ What AutoApply Does

AutoApply is a full-stack platform that turns your job search into a background process.

**It scrapes.** Every 5 hours, the engine pulls fresh listings from 40+ job boards — WeWorkRemotely, Remotive, Himalayas, Jobicy, Greenhouse ATS boards (Shopify, Notion, Figma, HashiCorp), Ashby boards (Linear, Vercel, Supabase), Lever boards (Zapier, Webflow, Buffer), and more. Only jobs posted in the last 24 hours make it in. No stale listings.

**It understands.** Every job gets tagged with category (engineering, design, marketing, ops), seniority level (intern → senior → manager), tech stack, salary range, and an AI-generated `applyPayload` — a structured blob with everything an agent needs to fill out a form without re-reading the description.

**It applies.** The AI agent opens each job's application URL in a real Chromium browser, detects the form fields, calls an LLM to generate context-aware answers, and fills them in — name, email, work history, custom questions, cover letter. All of it.

**It tracks.** Every application is logged with status, timestamp, and notes. Your dashboard shows what's been applied to, what's pending, and what needs your attention.

---

## 🧠 The AI Stack

The agent isn't just pasting your resume into boxes. It reads the job description, understands what the company is looking for, and writes answers that are specific to that role.

- **Pollinations AI** — primary inference, free, no API key needed
- **Groq (Llama 3)** — fallback, blazing fast, free tier available
- Both fail gracefully — if AI is down, the agent skips that field rather than crashing

Cover letters are generated fresh for every application. Custom questions ("What's your biggest weakness?", "Why do you want to work here?") get real answers, not generic filler.

---

## 🖥️ The Dashboard

A clean React frontend gives you full visibility and control.

- Browse all scraped jobs with filters by category, seniority, salary, remote status
- See your application history with status tracking
- Trigger manual apply runs
- Review AI-filled forms before they go out (auto-submit is off by default — you stay in control)
- Real-time stats: jobs scraped today, applications sent this week, response rate

---

## ⚙️ How It's Built

| Layer | Tech | What it does |
|---|---|---|
| Frontend | React 18, TypeScript, Vite, TailwindCSS | Dashboard and job browser |
| Backend | Node.js, Express, TypeScript, SQLite | API, job storage, scraper orchestration |
| Scraper | TypeScript, RSS + JSON APIs | Pulls from 40+ job boards every 5 hours |
| AI Agent | Python, Playwright, Pollinations, Groq | Browser automation + form filling |
| Database | SQLite / Turso | Stores jobs, applications, user profiles |

---

## 🆓 Runs Completely Free

No credit card required. The entire stack runs on free tiers.

| Service | What it hosts | Cost |
|---|---|---|
| Vercel | React frontend | Free forever |
| Render / Railway | Node.js backend | Free tier |
| Turso | SQLite database | Free, 9GB |
| GitHub Actions | Scraper cron every 5h | Free, 2000 min/month |
| Pollinations | AI inference | Free, no key needed |
| Groq | AI fallback | Free tier |

---

## 🚀 Getting Started

```bash
git clone https://github.com/yourusername/autoapply
cd autoapply
npm install
cp backend/.env.example backend/.env
cp ai-agent/.env.example ai-agent/.env
npm run dev
```

Fill in your profile once. Let it run. Check your dashboard.

---

## 🔒 Safety First

Auto-submit is **disabled by default**. The agent fills forms but does not click submit — you review everything before it goes out. This prevents accidental applications, wrong jobs, and embarrassing mistakes.

When you're confident in the setup, you can enable auto-submit per job category or seniority level from the dashboard.

---

## 🗺️ Roadmap

- [ ] Resume tailoring per job (rewrite bullet points to match JD keywords)
- [ ] Email follow-up automation
- [ ] Interview scheduling integration
- [ ] Chrome extension for one-click apply on any job site
- [ ] Multi-user support
- [ ] Response rate analytics and A/B testing cover letters

---

## 🤝 Contributing

PRs welcome. If a job board you care about isn't in the scraper, adding it is usually 15 lines of TypeScript — open an issue or just send the PR.

---

<div align="center">

Built because the job market is brutal enough without doing data entry on top of it.

**Star this repo if it saves you time. ⭐**

</div>