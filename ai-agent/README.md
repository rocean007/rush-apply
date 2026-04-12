<div align="center">

# 🤖 RushApply — AI Agent

**Autonomous job application bot powered by Playwright browser automation and LLM-driven form filling.**

[![Python](https://img.shields.io/badge/Python-3.11-3776AB?style=flat-square&logo=python&logoColor=white)](https://python.org)
[![Playwright](https://img.shields.io/badge/Playwright-1.43-2EAD33?style=flat-square&logo=playwright&logoColor=white)](https://playwright.dev)
[![Pollinations](https://img.shields.io/badge/AI-Pollinations-blueviolet?style=flat-square)](https://pollinations.ai)
[![Groq](https://img.shields.io/badge/Fallback-Groq%20Llama3-orange?style=flat-square)](https://groq.com)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?style=flat-square&logo=docker&logoColor=white)](https://docker.com)

</div>

---

## What This Does

The AI agent is the execution layer of RushApply. It takes job listings from the backend, opens each application URL in a real Chromium browser, intelligently detects form fields, and fills them out using LLM-generated answers tailored to the specific role.

**It handles:**
- Name, email, phone, and address fields
- Work experience and education sections
- Custom screening questions ("Why do you want to work here?")
- Cover letter text areas — generated fresh per application
- File upload detection (flags for manual review)

**It does not auto-submit.** Forms are filled and logged. You review before anything is sent. This is intentional.

---

## How It Works

```
Backend API  ──→  Fetch pending jobs
                       │
                       ▼
              Open job URL in Chromium
                       │
                       ▼
           Scan page for form fields
                       │
                       ▼
        Send field names + job context to AI
                       │
                  ┌────┴────┐
            Pollinations   Groq (fallback)
                  └────┬────┘
                       │
                       ▼
            Fill fields with AI answers
                       │
                       ▼
        Record result back to backend
```

---

## Setup

### Option A — Docker (recommended)

No Python environment needed. Everything runs inside the container.

```bash
# Build the image
docker build -t applybot-agent .

# Create your env file
cp .env.example .env
nano .env   # fill in BACKEND_URL and INTERNAL_API_KEY at minimum

# Run
docker run --rm \
  --security-opt label=disable \
  --env-file .env \
  localhost/applybot-agent \
  --user-id YOUR_USER_ID \
  --email you@example.com \
  --password yourpassword \
  --jobs-limit 5
```

> **Podman users:** The `docker` command works as-is — Podman provides a Docker-compatible CLI. The `--security-opt label=disable` flag prevents SELinux from blocking `.env` file reads.

### Option B — Local Python

```bash
cd ai-agent
python3.11 -m venv venv
source venv/bin/activate        # Linux / macOS
# venv\Scripts\activate         # Windows

pip install -r requirements.txt
playwright install chromium
```

```bash
python apply_agent.py \
  --user-id YOUR_USER_ID \
  --email you@example.com \
  --password yourpassword \
  --jobs-limit 5
```

---

## Configuration

Create `.env` in the `ai-agent/` directory:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `BACKEND_URL` | ✅ | — | Base URL of your running backend (e.g. `http://localhost:8080`) |
| `INTERNAL_API_KEY` | ✅ | — | Must match `INTERNAL_API_KEY` in backend `.env` |
| `POLLINATIONS_API_URL` | ☐ | `https://text.pollinations.ai/` | Primary AI endpoint — free, no key needed |
| `GROQ_API_KEY` | ☐ | — | Groq fallback — free tier at [console.groq.com](https://console.groq.com) |
| `HEADLESS` | ☐ | `true` | Set to `false` to watch the browser in action |

---

## Running Modes

```bash
# Standard run — headless, 5 jobs
python apply_agent.py \
  --user-id abc123 \
  --email you@example.com \
  --password yourpassword \
  --jobs-limit 5

# Debug mode — browser window visible, fewer jobs
python apply_agent.py \
  --user-id abc123 \
  --email you@example.com \
  --password yourpassword \
  --jobs-limit 3 \
  --no-headless

# High volume — crank up the limit
python apply_agent.py \
  --user-id abc123 \
  --email you@example.com \
  --password yourpassword \
  --jobs-limit 50
```

---

## Automated Scheduling

### Cron (Linux/macOS)

Matches the scraper's 5-hour cycle — agent runs right after fresh jobs land.

```bash
crontab -e
```

```
0 */5 * * * docker run --rm --security-opt label=disable \
  --env-file /path/to/ai-agent/.env \
  localhost/applybot-agent \
  --user-id YOUR_USER_ID \
  --email you@example.com \
  --password yourpassword \
  --jobs-limit 20 >> /var/log/rushapply.log 2>&1
```

### Systemd Service (always-on server)

```bash
sudo cp applybot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable applybot
sudo systemctl start applybot

# Watch live logs
journalctl -u applybot -f
```

---

## Output

After each run the agent prints a summary:

```
========================================
  Applied:  14/20
  Failed:    6/20   (no form detected)
  Avg time:  8.3s per job
========================================
```

Every result — success or failure — is recorded in the backend with a timestamp and notes. Failures are never silently dropped.

---

## Safety

> Auto-submit is **off by default** and intentionally requires a code change to enable — not just a flag. This forces a deliberate decision before anything is submitted on your behalf.

To enable auto-submit once you've validated the agent's output:

1. Open `apply_agent.py`
2. Find the comment `# Do NOT auto-submit — safety measure`
3. Uncomment `await page.click("[type=submit]")`
4. Add `--auto-submit` argument handling if you want per-run control

---

## Troubleshooting

**`Connection timed out` on startup**
→ Your backend isn't reachable. Make sure it's running and `BACKEND_URL` in `.env` points to the correct IP/port. Inside Docker, `localhost` refers to the container — use your machine's LAN IP instead.

**`0 fields filled` on every job**
→ The job site likely renders forms with JavaScript after page load. Try `--no-headless` to watch what the browser sees, then adjust the `wait_for_load_state` timeout in `apply_agent.py`.

**Pollinations returning empty**
→ Set a `GROQ_API_KEY` as fallback. Groq's free tier is fast and reliable.