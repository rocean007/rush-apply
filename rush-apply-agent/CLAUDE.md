# RushApply AI Agent — Claude Code Skill

## Skill Overview

This is an **autonomous job application agent** that integrates with the RushApply portal.

### What this agent does autonomously:
1. Authenticates with the RushApply backend
2. Fetches pending job listings from your portal
3. Generates a **tailored CV** per job (AI-powered keyword matching)
4. Generates a **personalised cover letter** per job
5. Exports both as **professional PDFs** (A4, branded design)
6. Opens each job URL in a browser and **fills the application form**
7. **Uploads your CV/cover letter** where file inputs are detected
8. Submits the application
9. Records the result back to your RushApply portal

---

## Quick Start (Claude Code / Codex / OpenClaw)

```bash
# 1. Install
curl -fsSL https://raw.githubusercontent.com/your-org/rush-apply-agent/main/scripts/install.sh | bash

# 2. Configure
cp .env.example .env
# Edit .env with your credentials

# 3. Run
python main.py --email you@example.com --password yourpassword
```

---

## Configuration

Edit `.env` (see `.env.example`):

| Variable | Description | Required |
|---|---|---|
| `BACKEND_URL` | Your RushApply backend URL | ✅ |
| `INTERNAL_API_KEY` | Backend API key | ✅ |
| `ANTHROPIC_API_KEY` | Claude API key (best quality) | ⭐ recommended |
| `GROQ_API_KEY` | Groq fallback (fast, free tier) | optional |
| `OPENAI_API_KEY` | OpenAI fallback | optional |
| `HEADLESS` | `true` = no browser window | optional |

**AI Provider Priority:** Claude → Groq → OpenAI → Pollinations (free, no key needed)

---

## Skill Modules

```
agent/
├── orchestrator.py      # Main agent loop
├── ai_engine.py         # Multi-provider AI (Claude/Groq/OpenAI/Pollinations)
├── cv_builder.py        # Tailored CV content generation
├── cover_letter.py      # Cover letter generation
├── pdf_maker.py         # Professional PDF export (ReportLab)
├── backend_client.py    # RushApply portal API client
└── models.py            # Shared data models
```

---

## Claude Code Usage

When using this as a Claude Code skill, you can invoke it by describing your goal:

```
Apply to all pending jobs in my RushApply portal using my profile
```

Claude Code will:
- Read your `.env` for credentials
- Run the agent autonomously
- Show you a summary of applications submitted
- Save PDFs to `./output/`

---

## CLI Reference

```bash
python main.py --help

# Apply to 10 jobs (default)
python main.py --email me@example.com --password secret

# Apply to 20 jobs, show browser
python main.py --email me@example.com --password secret --jobs-limit 20 --no-headless

# Dry run: generate PDFs only, no browser
python main.py --email me@example.com --password secret --dry-run

# Custom backend
python main.py --email me@example.com --password secret --backend-url https://api.myrushaply.com
```

---

## Output

All generated files are saved in `./output/`:
```
output/
├── CV_John_Doe_Acme_Corp.pdf
├── CoverLetter_John_Doe_Acme_Corp.pdf
├── CV_John_Doe_TechCorp.pdf
├── CoverLetter_John_Doe_TechCorp.pdf
└── run_report.json      # Summary of all applications
```

---

## Customisation

### CV Template
Edit `config/cv_config.json` to customise:
- Colour scheme
- Section order
- Font preferences
- Page margins

### Cover Letter Template
Edit `config/cover_letter_config.json` to set:
- Tone (formal/conversational/technical)
- Max word count
- Greeting style

### Profile (standalone mode)
Edit `config/profile.json` with your details instead of fetching from backend.

---

## Requirements

- Python 3.11+
- Playwright (Chromium)
- ReportLab
- See `requirements.txt`
