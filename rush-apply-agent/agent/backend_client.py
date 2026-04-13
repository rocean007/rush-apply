"""Backend client for RushApply portal."""
from __future__ import annotations

import json
import logging
import os
from typing import Optional

import requests

from .models import Job, UserProfile

log = logging.getLogger("rush.backend")

API_BASE = os.getenv("BACKEND_URL", "http://localhost:8080")
API_KEY  = os.getenv("INTERNAL_API_KEY", "")


class BackendClient:
    def __init__(self, base_url: str = API_BASE, api_key: str = API_KEY, user_id: str = ""):
        self.base = base_url.rstrip("/")
        self.api_key = api_key
        self.user_id = user_id
        self._session_cookie: Optional[str] = None

    def _headers(self) -> dict:
        h = {"x-api-key": self.api_key, "Content-Type": "application/json"}
        if self._session_cookie:
            h["Cookie"] = self._session_cookie
        return h

    # ── Auth ──────────────────────────────────

    def login(self, email: str, password: str) -> bool:
        try:
            r = requests.post(
                f"{self.base}/api/auth/login",
                json={"email": email, "password": password, "rememberMe": False},
                timeout=15,
            )
            if r.ok:
                cookie = r.headers.get("set-cookie", "")
                self._session_cookie = cookie.split(";")[0] if cookie else None
                log.info("✓ Authenticated as %s", email)
                return True
            log.error("Login failed [%s]: %s", r.status_code, r.text[:200])
        except Exception as e:
            log.error("Login error: %s", e)
        return False

    # ── Profile ───────────────────────────────

    def get_profile(self) -> Optional[UserProfile]:
        try:
            r = requests.get(f"{self.base}/api/user/profile", headers=self._headers(), timeout=15)
            if not r.ok:
                log.error("Profile fetch failed: %s", r.text[:200])
                return None
            d = r.json()
            return UserProfile(
                id=d["id"],
                email=d["email"],
                full_name=d.get("full_name", d.get("name", "")),
                title=d.get("title", ""),
                phone=d.get("phone", ""),
                location=d.get("location", ""),
                linkedin=d.get("linkedin", ""),
                github=d.get("github", ""),
                portfolio=d.get("portfolio", ""),
                summary=d.get("summary", ""),
                skills=d.get("skills", []),
                experience=d.get("experience", []),
                education=d.get("education", []),
                certifications=d.get("certifications", []),
                resume_text=d.get("resume_text", ""),
            )
        except Exception as e:
            log.error("get_profile error: %s", e)
            return None

    # ── Jobs ──────────────────────────────────

    def get_pending_jobs(self, limit: int = 10) -> list[Job]:
        """Fetch jobs from portal that haven't been applied to yet."""
        try:
            r = requests.get(
                f"{self.base}/api/jobs",
                params={"limit": limit, "page": 1, "status": "pending"},
                headers=self._headers(),
                timeout=15,
            )
            if not r.ok:
                log.error("Jobs fetch failed: %s", r.text[:200])
                return []
            data = r.json()
            jobs_raw = data if isinstance(data, list) else data.get("jobs", [])
            result = []
            for j in jobs_raw:
                tags = j.get("tags", [])
                if isinstance(tags, str):
                    try:
                        tags = json.loads(tags)
                    except Exception:
                        tags = []
                result.append(Job(
                    id=str(j["id"]),
                    title=j.get("title", ""),
                    company=j.get("company", ""),
                    url=j.get("url", j.get("link", "")),
                    description=j.get("description", ""),
                    location=j.get("location", ""),
                    salary=j.get("salary", ""),
                    tags=tags,
                    source=j.get("source", ""),
                ))
            log.info("Fetched %d jobs from portal", len(result))
            return result
        except Exception as e:
            log.error("get_pending_jobs error: %s", e)
            return []

    # ── Recording ────────────────────────────

    def record_application(self, job_id: str, status: str, notes: str = "") -> bool:
        try:
            r = requests.post(
                f"{self.base}/api/jobs/apply/{job_id}",
                headers=self._headers(),
                json={"agentApplied": True, "status": status, "notes": notes},
                timeout=10,
            )
            ok = r.ok or r.status_code == 409
            if not ok:
                log.warning("record_application %s → %s", job_id, r.status_code)
            return ok
        except Exception as e:
            log.error("record_application error: %s", e)
            return False
