<div align="center">

# ⚙️ RushApply — Backend API

**The data and orchestration layer. Scrapes 40+ job boards, stores everything, serves the frontend, and coordinates the AI agent.**

[![Node.js](https://img.shields.io/badge/Node.js-20-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Express](https://img.shields.io/badge/Express-4-000000?style=flat-square&logo=express&logoColor=white)](https://expressjs.com)
[![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://sqlite.org)

</div>

---

## What This Does

The backend is the brain of RushApply. It runs three jobs simultaneously:

**Scraper** — Pulls fresh job listings from 40+ sources every 5 hours. RSS feeds, JSON APIs, and ATS boards (Greenhouse, Ashby, Lever, Workable). Every job gets tagged with category, seniority, salary range, tech stack, and a structured `applyPayload` blob ready for the AI agent to consume.

**REST API** — Serves job listings, user profiles, application history, and auth to the frontend. Also exposes endpoints the AI agent calls to fetch jobs and record results.

**Auth** — JWT-based sessions in HTTP-only cookies. Registration, login, logout, and profile management with AI-assisted resume generation.

---

## Setup

```bash
cd backend
cp .env.example .env
```

Fill in `.env`, then:

```bash
npm install
npm run dev        # starts on :8080 with hot reload
```

The database schema is applied automatically on first start. No manual migration step needed.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | ☐ | `8080` | Server port |
| `JWT_SECRET` | ✅ | — | Long random string for JWT signing. Use `openssl rand -hex 32` |
| `DATABASE_URL` | ☐ | `./data/jobs.db` | SQLite file path |
| `ALLOWED_ORIGINS` | ✅ | — | Comma-separated CORS origins e.g. `http://localhost:3000,https://yourapp.vercel.app` |
| `INTERNAL_API_KEY` | ✅ | — | Shared secret between backend and AI agent. Any long random string |
| `POLLINATIONS_API_URL` | ☐ | `https://text.pollinations.ai/` | AI endpoint for resume generation |
| `GROQ_API_KEY` | ☐ | — | Groq fallback — free tier at console.groq.com |
| `ADZUNA_APP_ID` | ☐ | — | Optional — unlocks Adzuna job source |
| `ADZUNA_APP_KEY` | ☐ | — | Optional — pair with above |
| `JSEARCH_API_KEY` | ☐ | — | Optional — unlocks LinkedIn/Indeed/Glassdoor via RapidAPI |

---

## API Reference

### Authentication

```bash
# Register a new account
curl -X POST http://localhost:8080/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"yourpassword","fullName":"Jane Doe"}'

# Login — sets session cookie
curl -X POST http://localhost:8080/api/auth/login \
  -c cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"yourpassword","rememberMe":false}'

# Logout
curl -X POST http://localhost:8080/api/auth/logout -b cookies.txt
```

### Jobs

```bash
# Browse jobs — supports filtering and pagination
curl "http://localhost:8080/api/jobs?page=1&limit=20"
curl "http://localhost:8080/api/jobs?search=react&source=remoteok&limit=50"
curl "http://localhost:8080/api/jobs?remote=true&salary_min=80000"

# Apply to a job (records intent, triggers agent queue)
curl -X POST http://localhost:8080/api/jobs/apply/JOB_ID \
  -b cookies.txt
```

### User Profile

```bash
# Get your profile
curl http://localhost:8080/api/user/profile -b cookies.txt

# Update profile and skills
curl -X PUT http://localhost:8080/api/user/profile \
  -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"title":"Senior Full Stack Engineer","skills":["React","TypeScript","Node.js"]}'

# Generate AI-tailored resume for a specific job
curl -X POST http://localhost:8080/api/user/resume/generate \
  -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"jobDescription":"We are looking for a React developer with 5+ years..."}'

# View all your applications
curl http://localhost:8080/api/user/applications -b cookies.txt
```

---

## Job Sources

The scraper pulls from these verified working sources every 5 hours:

**RSS Feeds** — WeWorkRemotely (8 category feeds), Himalayas, Automattic, AuthenticJobs, Jobspresso, HN Who's Hiring

**JSON APIs** — RemoteOK, Remotive, Jobicy, Arbeitnow, TheMuse, Adzuna *(optional key)*, JSearch/LinkedIn+Indeed *(optional key)*

**ATS Boards** *(direct API, no scraping)*
- Greenhouse: Shopify, HashiCorp, Notion, Figma, Asana, Rippling, Brex, Loom, Lattice, Coda
- Ashby: Linear, Vercel, Retool, Supabase, PlanetScale, Clerk, dbt Labs
- Lever: Webflow, Zapier, Buffer, Close, Doist, Hotjar
- Workable: Typeform, Doist

Only jobs posted in the **last 24 hours** are kept. The database stays clean.

---

## Security

| Feature | Implementation |
|---|---|
| Passwords | bcrypt, 12 rounds |
| Sessions | JWT in HTTP-only cookies, not localStorage |
| CORS | Explicit origin whitelist |
| Rate limiting | 100 requests / 15 min per IP |
| Headers | Helmet.js — XSS, clickjacking, MIME sniffing protection |
| Input | express-validator on all user-facing endpoints |
| Agent auth | `x-api-key` header checked on all internal endpoints |

---

## Deployment

### Render (free tier)

Push to GitHub, connect repo on render.com, set env vars in the dashboard. Build command: `npm install && npm run build`. Start command: `npm start`.

### Railway

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### Self-hosted

```bash
npm run build
NODE_ENV=production npm start
```

Use `pm2` or `systemd` to keep it alive.