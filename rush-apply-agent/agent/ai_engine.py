"""
AI Engine — multi-provider with automatic fallback chain.
Priority: Claude (Anthropic) → Groq → OpenAI → Pollinations (free, no key)
"""
from __future__ import annotations

import json
import logging
import os
import time

import requests

from .models import Job, UserProfile

log = logging.getLogger("rush.ai")

ANTHROPIC_KEY  = os.getenv("ANTHROPIC_API_KEY", "")
GROQ_KEY       = os.getenv("GROQ_API_KEY", "")
OPENAI_KEY     = os.getenv("OPENAI_API_KEY", "")
POLLINATIONS   = os.getenv("POLLINATIONS_API_URL", "https://text.pollinations.ai/")


class AIEngine:
    """Unified AI interface with provider fallback chain."""

    def __init__(self):
        self.providers = self._build_chain()
        log.info("AI providers available: %s", [p["name"] for p in self.providers])

    def _build_chain(self) -> list[dict]:
        chain = []
        if ANTHROPIC_KEY:
            chain.append({"name": "Claude", "fn": self._call_anthropic})
        if GROQ_KEY:
            chain.append({"name": "Groq",   "fn": self._call_groq})
        if OPENAI_KEY:
            chain.append({"name": "OpenAI", "fn": self._call_openai})
        # Always append free Pollinations as last resort
        chain.append({"name": "Pollinations", "fn": self._call_pollinations})
        return chain

    def complete(self, system: str, user_msg: str, json_mode: bool = False) -> str:
        messages = [{"role": "user", "content": user_msg}]
        for p in self.providers:
            try:
                result = p["fn"](system, messages)
                if result:
                    return result
            except Exception as e:
                log.warning("Provider %s failed: %s", p["name"], e)
        return ""

    # ──────────────────────────────────────────
    # Provider implementations
    # ──────────────────────────────────────────

    def _call_anthropic(self, system: str, messages: list[dict]) -> str:
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": "claude-opus-4-5",
                "max_tokens": 2000,
                "system": system,
                "messages": messages,
            },
            timeout=30,
        )
        r.raise_for_status()
        return r.json()["content"][0]["text"].strip()

    def _call_groq(self, system: str, messages: list[dict]) -> str:
        r = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {GROQ_KEY}", "Content-Type": "application/json"},
            json={
                "model": "llama-3.3-70b-versatile",
                "messages": [{"role": "system", "content": system}] + messages,
                "max_tokens": 2000,
            },
            timeout=25,
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"].strip()

    def _call_openai(self, system: str, messages: list[dict]) -> str:
        r = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENAI_KEY}", "Content-Type": "application/json"},
            json={
                "model": "gpt-4o-mini",
                "messages": [{"role": "system", "content": system}] + messages,
                "max_tokens": 2000,
            },
            timeout=25,
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"].strip()

    def _call_pollinations(self, system: str, messages: list[dict]) -> str:
        full_messages = [{"role": "system", "content": system}] + messages
        for attempt in range(3):
            try:
                r = requests.post(
                    POLLINATIONS,
                    json={"messages": full_messages, "model": "openai", "seed": 42},
                    timeout=30,
                )
                if r.ok:
                    return r.text.strip()
            except Exception as e:
                log.warning("Pollinations attempt %d: %s", attempt + 1, e)
            time.sleep(2 ** attempt)
        return ""

    # ──────────────────────────────────────────
    # High-level task methods
    # ──────────────────────────────────────────

    async def generate_cv_content(self, user: UserProfile, job: Job) -> dict:
        """Return structured CV data tailored for the given job."""
        system = (
            "You are a professional CV writer. Given a candidate profile and job description, "
            "return ONLY a valid JSON object (no markdown) with these keys: "
            "summary, skills_highlight (list of 8 most relevant skills), "
            "experience_bullets (dict of {company: [bullet,...]}), "
            "key_achievements (list of 3)."
        )
        user_msg = (
            f"Candidate: {user.full_name}, {user.title}\n"
            f"Current skills: {', '.join(user.skills[:20])}\n"
            f"Experience: {json.dumps(user.experience[:4])}\n\n"
            f"Target Job: {job.title} at {job.company}\n"
            f"Job Description: {job.description[:800]}\n\n"
            "Tailor the CV content to maximise keyword match. Return JSON only."
        )
        raw = self.complete(system, user_msg)
        try:
            clean = raw.replace("```json", "").replace("```", "").strip()
            return json.loads(clean)
        except Exception:
            return {}

    async def generate_cover_letter(self, user: UserProfile, job: Job) -> str:
        system = (
            "You are an expert cover letter writer. Write a professional, "
            "personalised cover letter under 250 words. No placeholders. No markdown."
        )
        user_msg = (
            f"Write a cover letter for {user.full_name} ({user.title}) "
            f"applying to {job.title} at {job.company}.\n"
            f"Candidate summary: {user.summary or 'Experienced professional'}\n"
            f"Top skills: {', '.join(user.skills[:8])}\n"
            f"Job description: {job.description[:600]}\n"
            f"Candidate location: {user.location}\n"
        )
        return self.complete(system, user_msg)

    async def generate_form_answers(
        self,
        user: UserProfile,
        job: Job,
        field_descriptions: list[str],
        cover_letter: str,
    ) -> dict[str, str]:
        system = (
            "You are a job application form filler. Given candidate info and form fields, "
            "return ONLY a valid JSON object mapping field index (as string) to the best answer. "
            "Use empty string for fields you cannot answer. No markdown."
        )
        user_msg = (
            f"Candidate name: {user.full_name}\n"
            f"Email: {user.email}\n"
            f"Phone: {user.phone}\n"
            f"Location: {user.location}\n"
            f"Title: {user.title}\n"
            f"LinkedIn: {user.linkedin}\n"
            f"GitHub: {user.github}\n"
            f"Portfolio: {user.portfolio}\n"
            f"Skills: {', '.join(user.skills[:15])}\n"
            f"Cover letter (use for cover letter fields): {cover_letter[:400]}\n\n"
            f"Job: {job.title} at {job.company}\n\n"
            f"Form fields:\n" + "\n".join(field_descriptions) +
            "\n\nReturn JSON object: {{\"0\": \"answer\", \"1\": \"answer\", ...}}"
        )
        raw = self.complete(system, user_msg)
        try:
            clean = raw.replace("```json", "").replace("```", "").strip()
            return json.loads(clean)
        except Exception:
            return {}
