<div align="center">

# 🖥️ AutoApply — Frontend

**React dashboard for browsing scraped jobs, tracking applications, and managing your AI-powered job search.**

[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vitejs.dev)
[![TailwindCSS](https://img.shields.io/badge/TailwindCSS-3-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Zustand](https://img.shields.io/badge/Zustand-state-brown?style=flat-square)](https://zustand-demo.pmnd.rs)

</div>

---

## What This Does

The frontend is the control center for your automated job search. It gives you visibility into everything the scraper has found, lets you manage what the agent applies to, and shows you the status of every application in real time.

**Job browser** — Search and filter hundreds of fresh listings updated every 5 hours. Filter by role category, seniority, salary range, remote status, tech stack, and source. Every card shows the AI-inferred category and seniority so you can scan quickly.

**Application tracker** — A dashboard that shows every job the agent has touched: filled, pending, applied, or failed. Nothing gets lost silently.

**Resume builder** — Paste a job description, get an AI-tailored resume back in seconds. The AI reads the JD and rewrites your experience to match what the company is looking for.

**Auth** — Full registration and login with persistent sessions. Your profile, skills, and resume text are stored and sent to the agent automatically.

---

## Setup

```bash
cd frontend
cp .env.example .env
npm install
npm run dev        # http://localhost:3000
```

For production:

```bash
npm run build      # outputs to dist/
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `VITE_API_URL` | Backend base URL. Leave empty if frontend and backend share the same origin. Set to your Railway/Render URL in production. |
| `VITE_APP_NAME` | Display name shown in the navbar and page title. |

---

## Architecture

State is managed across three Zustand stores, all with persistence middleware so sessions survive page refreshes.

**`useAuthStore`** handles the user session — login, register, logout, profile fetch. Components read `user` and `isAuthenticated` from here.

**`useJobStore`** owns all job data — the current listing page, search query, active filters, pagination, and the apply action. The job browser components are purely derived views of this store.

**`useAppStore`** handles cross-cutting concerns — dark/light theme preference, cookie consent state, and the application history list.

---

## Key Features

**Glassmorphism UI** — Cards use backdrop blur and translucent fills. The design works in both light and dark mode without separate style sheets.

**Dark / light mode** — Reads system preference on first load. User toggle persists to localStorage. No flash of wrong theme on reload.

**Skeleton loaders** — Every async surface has a shimmer placeholder. Nothing shows a blank white box while data loads.

**Code splitting** — All three pages (`Landing`, `Dashboard`, `ResumeBuilder`) are lazy-loaded. The initial bundle is small.

**Framer Motion** — Job cards animate in with a staggered list effect. The auth modal slides in from the right. Transitions are under 200ms so they feel instant.

**Zod validation** — Auth forms validate client-side before any network request. Error messages are inline, not toasts.

**IndexedDB cache** — Job listings are cached offline via `idb`. If the backend is unreachable, the last known listings still render.

**Web Worker** — Resume text parsing runs off the main thread so pasting a large PDF extract doesn't freeze the UI.

**Error boundary** — A top-level `ErrorBoundary` catches render errors and shows a recovery UI instead of a blank screen.

**GDPR banner** — Functional cookies only. Consent choice is stored in localStorage and the banner never re-appears after a decision.

---

## Component Structure

```
src/
├── components/
│   ├── layout/         Navbar, root Layout with Outlet
│   ├── features/       AuthModal, JobCard — the meaty UI pieces
│   └── ui/             Skeletons, ErrorBoundary, CookieBanner, FullPageLoader
├── pages/
│   ├── Landing.tsx     Job search and listings
│   ├── Dashboard.tsx   Application tracker
│   └── ResumeBuilder   AI resume generator
├── store/              Zustand stores — auth, jobs, app
├── utils/
│   ├── api.ts          Typed fetch wrapper with retry and auth header injection
│   └── cache.ts        IndexedDB read/write helpers
├── workers/
│   └── resumeParser    Off-thread resume text parsing
└── types/              Shared TypeScript interfaces used across all layers
```

---

## Deployment

### Vercel (recommended — free)

```bash
# From repo root
vercel deploy
```

The `vercel.json` in the project root handles API rewrites so frontend and backend can share a domain. Set `VITE_API_URL` to your backend URL in the Vercel dashboard under Environment Variables.

### Manual (any static host)

```bash
npm run build
# Upload dist/ to S3, Cloudflare Pages, Netlify, or any static host
```

---

## Troubleshooting

**Blank page after login**
→ Check `VITE_API_URL` is set correctly and the backend is reachable from the browser. Open DevTools → Network and look for failing requests to `/api/user/profile`.

**Jobs not loading**
→ The backend scraper may not have run yet. Check backend logs for `[scraper] Done` output. The scraper runs on startup and then every 5 hours.

**Dark mode flashes on reload**
→ Make sure `VITE_APP_NAME` is set — an undefined env var can cause a hydration mismatch on first render.