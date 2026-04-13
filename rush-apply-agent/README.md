<div align="center">

```
██████╗ ██╗   ██╗███████╗██╗  ██╗ █████╗ ██████╗ ██████╗ ██╗  ██╗   ██╗
██╔══██╗██║   ██║██╔════╝██║  ██║██╔══██╗██╔══██╗██╔══██╗██║  ╚██╗ ██╔╝
██████╔╝██║   ██║███████╗███████║███████║██████╔╝██████╔╝██║   ╚████╔╝ 
██╔══██╗██║   ██║╚════██║██╔══██║██╔══██║██╔═══╝ ██╔═══╝██║    ╚██╔╝  
██║  ██║╚██████╔╝███████║██║  ██║██║  ██║██║     ██║     ███████╗██║   
╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝     ╚══════╝╚═╝   
                                                          AI AGENT v1.0
```

**Autonomous job application engine. Configure once. Apply everywhere.**

[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?style=flat-square&logo=python&logoColor=white)](https://python.org)
[![Playwright](https://img.shields.io/badge/Playwright-1.44+-45ba4b?style=flat-square&logo=playwright&logoColor=white)](https://playwright.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Skill-orange?style=flat-square)](CLAUDE.md)
[![AI Providers](https://img.shields.io/badge/AI-Claude_|_Groq_|_OpenAI_|_Pollinations-blueviolet?style=flat-square)](#ai-engine)

</div>

---

## What is this?

Most job seekers spend **45–90 minutes per application** — tailoring their CV, writing a cover letter, copying the same information into 10 different form fields, uploading files, and clicking submit. Multiply that by 50 applications and you've lost a week of your life doing something a machine can do better.

**RushApply Agent** is an AI agent that plugs into your RushApply portal and does all of it autonomously:

1. Fetches your pending jobs from the portal
2. Rewrites your CV with keywords tailored to each specific job description
3. Writes a personalised cover letter (not a template — actually personalised)
4. Exports both as professional A4 PDFs
5. Navigates to the job application URL in a real browser
6. Detects and fills every form field intelligently
7. Uploads your CV and cover letter where file inputs exist
8. Submits the application
9. Records the result back to your portal

The agent runs as a Claude Code skill, meaning you can invoke it with a single command or integrate it into any AI coding environment.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/your-org/rush-apply-agent/main/scripts/install.sh | bash
cd rush-apply-agent
cp .env.example .env
```

Then edit `.env` with your credentials and run:

```bash
python main.py --email you@example.com --password yourpassword
```

**Manual install:**

```bash
git clone https://github.com/your-org/rush-apply-agent
cd rush-apply-agent
pip install -r requirements.txt
playwright install chromium
cp .env.example .env
python main.py --email you@example.com --password yourpassword
```

**As a Claude Code skill:**

```bash
# Drop into any Claude Code project — it auto-discovers CLAUDE.md
curl -O https://raw.githubusercontent.com/your-org/rush-apply-agent/main/CLAUDE.md
```

---

## Configuration

Copy `.env.example` to `.env`. The only required fields are your backend URL and credentials:

```env
# ── Required ────────────────────────────────────────────────────────────────
BACKEND_URL=http://localhost:8080
INTERNAL_API_KEY=your_internal_key

# ── AI Providers (priority order: Claude → Groq → OpenAI → Pollinations) ───
# At least one is recommended. Pollinations works with no key at all.
ANTHROPIC_API_KEY=sk-ant-...
GROQ_API_KEY=gsk_...
OPENAI_API_KEY=sk-proj-...

# ── Browser ─────────────────────────────────────────────────────────────────
HEADLESS=true   # set false to watch the agent work
```

**AI provider priority** — the agent tries each in order and falls back automatically:

| Priority | Provider | Quality | Cost |
|---|---|---|---|
| 1 | Claude (Anthropic) | Best | Paid |
| 2 | Groq (Llama 3.3 70B) | Very good | Free tier |
| 3 | OpenAI (GPT-4o mini) | Good | Paid |
| 4 | Pollinations | Good enough | Free, no key |

The agent **works out of the box with zero API keys** via Pollinations. Add an Anthropic or Groq key for better quality output.

---

## Usage

```bash
# Apply to 10 jobs (default)
python main.py --email me@example.com --password secret

# Apply to 20 jobs
python main.py --email me@example.com --password secret --jobs-limit 20

# Show the browser window while running (useful for debugging)
python main.py --email me@example.com --password secret --no-headless

# Dry run — generate PDFs only, skip browser automation entirely
python main.py --email me@example.com --password secret --dry-run

# Point at a different backend
python main.py --email me@example.com --password secret --backend-url https://api.yourdomain.com

# Save PDFs to a custom directory
python main.py --email me@example.com --password secret --output-dir ~/applications/2025
```

**All options:**

```
--email TEXT          RushApply login email (required)
--password TEXT       RushApply login password (required)
--jobs-limit INT      Max jobs to process per run [default: 10]
--output-dir PATH     Where to save generated PDFs [default: ./output]
--dry-run             Generate PDFs only, no browser
--no-headless         Show browser window
--backend-url URL     Override BACKEND_URL from .env
--api-key KEY         Override INTERNAL_API_KEY from .env
```

---

## How it works

The agent runs a sequential pipeline for every job:

```
RushApply Portal
      │
      ▼
BackendClient.get_pending_jobs()
      │
      ▼
AIEngine.generate_cv_content()        ← tailors CV to job description
      │
AIEngine.generate_cover_letter()      ← writes personalised letter
      │
PDFMaker.build_cv()                   ← exports professional A4 PDF
PDFMaker.build_cover_letter()         ← exports cover letter PDF
      │
      ▼
Playwright → page.goto(job.url)
      │
      ├── detect all inputs (text, email, tel, textarea, select)
      ├── AIEngine.generate_form_answers() ← maps answers to each field
      ├── page.fill() for every field
      ├── page.set_input_files() for file uploads
      └── click submit button
      │
      ▼
BackendClient.record_application()    ← writes status back to portal
      │
      ▼
output/run_report.json                ← local JSON summary
```

**CV tailoring** — the AI receives your full profile + the job description and returns a structured JSON with a rewritten summary, reordered skills ranked by relevance, per-company bullet rewrites, and key achievements. This is not find-and-replace. The model rewrites the content so ATS keyword matching is maximised for that specific job.

**Form filling** — Playwright extracts every input element with its `name`, `id`, `placeholder`, `aria-label`, and associated `<label>` text. The AI receives all of this context plus your profile and returns a field-index-to-answer mapping. Standard fields (name, email, phone, LinkedIn) are filled directly. Cover letter fields are detected by label text and filled with the generated letter.

**Submit detection** — tries these selectors in order: `button[type=submit]`, `input[type=submit]`, `button:has-text('Submit')`, `button:has-text('Apply')`, `button:has-text('Send Application')`, `[data-testid*='submit']`. If none match, the application is flagged as `form_not_found` for manual review.

---

## Standalone mode (no backend)

Don't have a RushApply backend running? Edit `config/profile.json` with your details:

```json
{
  "full_name": "Your Name",
  "title": "Senior Software Engineer",
  "email": "you@example.com",
  "phone": "+1 555 000 0000",
  "skills": ["Python", "TypeScript", "React", "..."],
  "experience": [
    {
      "role": "Senior Engineer",
      "company": "Acme Corp",
      "start": "2022",
      "end": "Present",
      "bullets": ["Led migration...", "Built real-time..."]
    }
  ]
}
```

Then set `BACKEND_URL=standalone` in `.env`. The agent reads your profile from the JSON file and you can pass job URLs directly.

---

## Project structure

```
rush-apply-agent/
│
├── main.py                       # CLI entry point
├── CLAUDE.md                     # Claude Code / OpenClaw skill definition
├── requirements.txt
├── .env.example
│
├── agent/
│   ├── __init__.py
│   ├── orchestrator.py           # Main pipeline — coordinates all modules
│   ├── ai_engine.py              # Multi-provider AI with automatic fallback
│   ├── cv_builder.py             # Tailored CV content generation
│   ├── cover_letter.py           # Cover letter generation
│   ├── pdf_maker.py              # Professional PDF export (ReportLab)
│   ├── backend_client.py         # RushApply portal API client
│   └── models.py                 # Shared dataclasses
│
├── config/
│   ├── cv_config.json            # PDF appearance (colours, fonts, margins)
│   ├── cover_letter_config.json  # Tone, word count, greeting style
│   └── profile.json              # Standalone mode profile
│
└── scripts/
    └── install.sh                # curl installer
```

---

## Output

Each run creates files in `./output/` (or your `--output-dir`):

```
output/
├── CV_Jane_Smith_Acme_Corp.pdf
├── CoverLetter_Jane_Smith_Acme_Corp.pdf
├── CV_Jane_Smith_TechCorp_Ltd.pdf
├── CoverLetter_Jane_Smith_TechCorp_Ltd.pdf
└── run_report.json
```

`run_report.json` contains a full record of every application attempted:

```json
[
  {
    "job_id": "abc123",
    "success": true,
    "message": "Application submitted",
    "cv_path": "output/CV_Jane_Smith_Acme_Corp.pdf",
    "cl_path": "output/CoverLetter_Jane_Smith_Acme_Corp.pdf",
    "duration_s": 43.2
  }
]
```

Logs are written to both stdout and `agent.log` (appended each run).

---

## Requirements

- Python 3.11+
- Chromium (installed automatically by `playwright install chromium`)
- Network access to your RushApply backend
- At least one AI provider (or none — Pollinations is the free fallback)

```
playwright>=1.44.0
requests>=2.31.0
python-dotenv>=1.0.0
reportlab>=4.2.0
```

---

## Claude Code / OpenClaw / Codex

This repo ships a `CLAUDE.md` skill definition file. Drop it into any Claude Code project and the agent becomes a registered skill:

```bash
# From your Claude Code project root:
curl -O https://raw.githubusercontent.com/your-org/rush-apply-agent/main/CLAUDE.md
```

Then you can say:

> *"Apply to all pending jobs in my RushApply portal"*

and Claude Code will run the agent, show you a summary, and save all PDFs automatically.

---

## License

MIT — do whatever you want with it.

---

<div align="center">
<sub>Built to solve a real problem. Configure once, apply everywhere.</sub>
</div>
