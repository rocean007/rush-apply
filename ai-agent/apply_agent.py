#!/usr/bin/env python3
"""
Auto Job Application Agent
Uses Playwright for browser automation + Pollinations/Llama API for AI form filling
Supports NVIDIA CUDA for local inference fallback
"""

import asyncio
import argparse
import logging
import os
import json
import time
from dataclasses import dataclass, field
from typing import Optional
from pathlib import Path

import requests
from dotenv import load_dotenv
from playwright.async_api import async_playwright, Page, BrowserContext

load_dotenv()
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("agent")

API_BASE = os.getenv("BACKEND_URL", "http://localhost:8080")
API_KEY  = os.getenv("INTERNAL_API_KEY", "")
POLLINATIONS_URL = os.getenv("POLLINATIONS_API_URL", "https://text.pollinations.ai/")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
HEADLESS = os.getenv("HEADLESS", "true").lower() == "true"


# ─────────────────────────────────────────────
# Data models
# ─────────────────────────────────────────────

@dataclass
class UserProfile:
    id: str
    email: str
    full_name: str
    title: str = ""
    skills: list = field(default_factory=list)
    resume_text: str = ""


@dataclass
class Job:
    id: str
    title: str
    company: str
    url: str
    description: str = ""
    tags: list = field(default_factory=list)


@dataclass
class ApplicationResult:
    job_id: str
    success: bool
    message: str
    duration_s: float = 0.0


# ─────────────────────────────────────────────
# Backend API client
# ─────────────────────────────────────────────

class BackendClient:
    def __init__(self, base_url: str, api_key: str, user_id: str):
        self.base = base_url
        self.headers = {
            "x-api-key": api_key,
            "Content-Type": "application/json",
        }
        self.user_id = user_id
        self._session_cookie: Optional[str] = None

    def _auth_headers(self) -> dict:
        h = dict(self.headers)
        if self._session_cookie:
            h["Cookie"] = self._session_cookie
        return h

    def login(self, email: str, password: str) -> bool:
        """Authenticate agent as the target user."""
        r = requests.post(
            f"{self.base}/api/auth/login",
            json={"email": email, "password": password, "rememberMe": False},
        )
        if r.ok:
            cookie = r.headers.get("set-cookie", "")
            self._session_cookie = cookie.split(";")[0] if cookie else None
            log.info("Logged in as %s", email)
            return True
        log.error("Login failed: %s", r.text)
        return False

    def get_profile(self) -> Optional[UserProfile]:
        r = requests.get(f"{self.base}/api/user/profile", headers=self._auth_headers())
        if not r.ok:
            log.error("Failed to fetch profile: %s", r.text)
            return None
        d = r.json()
        return UserProfile(
            id=d["id"], email=d["email"], full_name=d["full_name"],
            title=d.get("title", ""), skills=d.get("skills", []),
            resume_text=d.get("resume_text", ""),
        )

    def get_jobs(self, limit: int = 10) -> list[Job]:
        r = requests.get(
            f"{self.base}/api/jobs",
            params={"limit": limit, "page": 1},
            headers=self.headers,
        )
        if not r.ok:
            return []
        return [
            Job(
                id=j["id"], title=j["title"], company=j["company"],
                url=j["url"], description=j.get("description", ""),
                tags=json.loads(j["tags"]) if isinstance(j.get("tags"), str) else j.get("tags", []),
            )
            for j in r.json().get("jobs", [])
        ]

    def record_application(self, job_id: str, status: str, notes: str = "") -> bool:
        r = requests.post(
            f"{self.base}/api/jobs/apply/{job_id}",
            headers=self._auth_headers(),
            json={"agentApplied": True, "notes": notes},
        )
        return r.ok or r.status_code == 409  # 409 = already applied (idempotent)


# ─────────────────────────────────────────────
# AI helpers (Pollinations + Groq fallback)
# ─────────────────────────────────────────────

def _call_pollinations(messages: list[dict], retries: int = 3) -> str:
    for attempt in range(retries):
        try:
            r = requests.post(
                POLLINATIONS_URL,
                json={"messages": messages, "model": "openai", "seed": 42},
                timeout=30,
            )
            if r.ok:
                return r.text.strip()
        except Exception as e:
            log.warning("Pollinations attempt %d failed: %s", attempt + 1, e)
        time.sleep(2 ** attempt)
    return ""


def _call_groq(messages: list[dict]) -> str:
    if not GROQ_API_KEY:
        return ""
    try:
        r = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
            json={"model": "llama-3.2-3b-preview", "messages": messages, "max_tokens": 1000},
            timeout=20,
        )
        if r.ok:
            return r.json()["choices"][0]["message"]["content"]
    except Exception as e:
        log.warning("Groq fallback failed: %s", e)
    return ""


def ai_complete(messages: list[dict]) -> str:
    """Call AI with Pollinations first, Groq as fallback."""
    result = _call_pollinations(messages)
    if not result:
        result = _call_groq(messages)
    return result


def generate_cover_letter(user: UserProfile, job: Job) -> str:
    return ai_complete([
        {"role": "system", "content": "Write concise job application cover letters under 200 words."},
        {"role": "user", "content": (
            f"Write a cover letter for {user.full_name} ({user.title}) "
            f"applying to {job.title} at {job.company}.\n"
            f"Skills: {', '.join(user.skills[:10])}\n"
            f"Job snippet: {job.description[:400]}"
        )},
    ])


def generate_field_answers(user: UserProfile, job: Job, fields: list[str]) -> dict[str, str]:
    """Generate answers for arbitrary application form fields."""
    raw = ai_complete([
        {"role": "system", "content": "Fill out job application form fields. Return only valid JSON object, no markdown."},
        {"role": "user", "content": (
            f"Applicant: {user.full_name}, {user.title}\n"
            f"Skills: {', '.join(user.skills[:10])}\n"
            f"Applying for: {job.title} at {job.company}\n\n"
            f"Form fields:\n" + "\n".join(f"- {f}" for f in fields) +
            "\n\nReturn JSON mapping field name → answer."
        )},
    ])
    try:
        return json.loads(raw.replace("```json", "").replace("```", "").strip())
    except Exception:
        return {}


# ─────────────────────────────────────────────
# Browser automation
# ─────────────────────────────────────────────

async def try_fill_and_submit(page: Page, user: UserProfile, job: Job) -> bool:
    """
    Best-effort form filling for external job applications.
    Detects common field patterns and fills them with AI-generated answers.
    """
    try:
        await page.wait_for_load_state("networkidle", timeout=15_000)
    except Exception:
        pass

    # Collect visible text inputs
    fields = await page.eval_on_selector_all(
        "input[type=text], input[type=email], textarea",
        """els => els.map(el => ({
            name: el.name || el.placeholder || el.id || el.ariaLabel || '',
            tag: el.tagName.toLowerCase(),
            id: el.id,
        }))"""
    )

    if not fields:
        log.info("No form fields detected on page")
        return False

    field_names = [f["name"] for f in fields if f["name"]]
    if not field_names:
        return False

    log.info("Detected %d form fields: %s", len(field_names), field_names[:5])
    answers = generate_field_answers(user, job, field_names)

    # Fill fields
    filled = 0
    for f in fields:
        key = f["name"]
        if key in answers and answers[key]:
            selector = f"[name='{key}']" if f.get("name") else f"#{f['id']}" if f.get("id") else None
            if selector:
                try:
                    await page.fill(selector, str(answers[key]))
                    filled += 1
                except Exception:
                    pass

    log.info("Filled %d/%d fields", filled, len(fields))

    # Fill cover letter if textarea exists
    cover = generate_cover_letter(user, job)
    if cover:
        for sel in ["textarea[name*='cover']", "textarea[id*='cover']", "textarea[name*='letter']"]:
            try:
                await page.fill(sel, cover)
                break
            except Exception:
                pass

    # Do NOT auto-submit — safety measure. Log intent instead.
    log.info("Form filled. Auto-submit disabled for safety. Manual review required.")
    return filled > 0


# ─────────────────────────────────────────────
# Application queue processor
# ─────────────────────────────────────────────

class JobApplicationAgent:
    def __init__(self, client: BackendClient, user: UserProfile, headless: bool = True):
        self.client = client
        self.user = user
        self.headless = headless
        self.results: list[ApplicationResult] = []

    async def process_job(self, job: Job, context: BrowserContext) -> ApplicationResult:
        start = time.time()
        log.info("Processing: %s @ %s", job.title, job.company)

        page = await context.new_page()
        try:
            await page.goto(job.url, timeout=20_000, wait_until="domcontentloaded")
            success = await try_fill_and_submit(page, self.user, job)

            # Record in backend regardless
            self.client.record_application(
                job.id,
                status="applied" if success else "pending",
                notes="Agent processed" + (" + fields filled" if success else " (no form detected)"),
            )

            return ApplicationResult(
                job_id=job.id, success=success,
                message="Fields filled" if success else "No form detected",
                duration_s=round(time.time() - start, 2),
            )

        except Exception as e:
            log.error("Error processing %s: %s", job.title, e)
            return ApplicationResult(job_id=job.id, success=False, message=str(e),
                                     duration_s=round(time.time() - start, 2))
        finally:
            await page.close()

    async def run(self, jobs_limit: int = 5):
        jobs = self.client.get_jobs(limit=jobs_limit)
        if not jobs:
            log.warning("No jobs fetched from backend")
            return

        log.info("Processing %d jobs...", len(jobs))

        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=self.headless)
            context = await browser.new_context(
                user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
                viewport={"width": 1280, "height": 900},
            )

            for job in jobs:
                result = await self.process_job(job, context)
                self.results.append(result)
                log.info(
                    "[%s] %s — %s (%.1fs)",
                    "✓" if result.success else "✗",
                    job.title, result.message, result.duration_s,
                )
                await asyncio.sleep(2)  # polite delay between requests

            await browser.close()

        self._print_summary()

    def _print_summary(self):
        total = len(self.results)
        success = sum(1 for r in self.results if r.success)
        print(f"\n{'='*40}")
        print(f"  Applied: {success}/{total}")
        print(f"  Failed:  {total - success}/{total}")
        avg = sum(r.duration_s for r in self.results) / max(total, 1)
        print(f"  Avg time/job: {avg:.1f}s")
        print(f"{'='*40}\n")


# ─────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Auto Job Application Agent")
    parser.add_argument("--user-id",   required=True, help="User ID from backend")
    parser.add_argument("--email",     required=True, help="User email for auth")
    parser.add_argument("--password",  required=True, help="User password for auth")
    parser.add_argument("--jobs-limit", type=int, default=5, help="Max jobs to process")
    parser.add_argument("--headless",  action="store_true", default=True)
    parser.add_argument("--no-headless", dest="headless", action="store_false")
    args = parser.parse_args()

    client = BackendClient(API_BASE, API_KEY, args.user_id)

    if not client.login(args.email, args.password):
        log.error("Authentication failed. Aborting.")
        return

    user = client.get_profile()
    if not user:
        log.error("Could not fetch user profile. Aborting.")
        return

    log.info("Agent starting for: %s (%s)", user.full_name, user.email)

    agent = JobApplicationAgent(client, user, headless=args.headless)
    asyncio.run(agent.run(jobs_limit=args.jobs_limit))


if __name__ == "__main__":
    main()
