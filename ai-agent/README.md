# AI Agent — Auto Job Application Bot

Python 3.11 + Playwright browser automation + Pollinations/Groq AI for form filling.

## Setup

### 1. Python virtual environment

```bash
cd ai-agent
python3.11 -m venv venv
source venv/bin/activate        # Linux/macOS
# venv\Scripts\activate         # Windows

pip install -r requirements.txt
playwright install chromium
```

### 2. Environment config

```bash
cp .env.example .env
# Fill in values — at minimum BACKEND_URL and INTERNAL_API_KEY
```

### 3. Verify CUDA (optional, for local Llama inference)

```bash
python3 -c "import torch; print(torch.cuda.is_available())"
# Should print: True
nvidia-smi   # Check CUDA version
```

## Running

```bash
# Basic run — process 5 jobs for a user
python apply_agent.py \
  --user-id abc123 \
  --email you@example.com \
  --password yourpassword \
  --jobs-limit 5

# Visible browser (debug mode)
python apply_agent.py \
  --user-id abc123 \
  --email you@example.com \
  --password yourpassword \
  --jobs-limit 3 \
  --no-headless
```

## Configuration `.env`

| Variable | Required | Description |
|----------|----------|-------------|
| `BACKEND_URL` | **Yes** | Backend API base URL |
| `INTERNAL_API_KEY` | **Yes** | Must match backend `INTERNAL_API_KEY` |
| `POLLINATIONS_API_URL` | No | AI API (default: Pollinations) |
| `GROQ_API_KEY` | No | Groq fallback for faster inference |
| `HEADLESS` | No | Run browser headless (default: true) |

## Docker (with CUDA)

```bash
docker build -t applybot-agent .

docker run --gpus all \
  --env-file .env \
  applybot-agent \
  --user-id abc123 --email you@example.com --password pass --jobs-limit 10
```

## Systemd service (server deployment)

```bash
# Edit applybot.service — set USER_ID, USER_EMAIL, USER_PASSWORD in .env
sudo cp applybot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable applybot
sudo systemctl start applybot

# Monitor logs
journalctl -u applybot -f
```

## Workflow

1. Agent authenticates with backend using user credentials
2. Fetches pending job listings via `/api/jobs`
3. For each job:
   - Opens job URL in Playwright browser
   - Detects form fields on the page
   - Sends field names to Pollinations AI for smart answers
   - Fills in name, email, cover letter, and custom questions
   - Records application status back to backend
4. Prints summary: applied / failed / average time per job

## Safety Note

Auto-submit is intentionally disabled. The agent fills forms but does NOT click submit. Review filled applications before submitting. This avoids accidental applications to wrong jobs.

To enable submit (advanced users), uncomment the `page.click("[type=submit]")` line in `apply_agent.py` and add `--auto-submit` flag handling.
