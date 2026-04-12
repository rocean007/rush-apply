#!/usr/bin/env python3
"""
Production-Ready Job Scraper
────────────────────────────
• Scrapes 20+ top job boards (RSS + JSON APIs + HTML fallbacks)
• Runs on startup then every 5 hours via APScheduler
• Filters to jobs posted within the last 24 hours
• Exposes a structured JSON REST API so AI agents can browse + apply
• Deduplicates by URL (UNIQUE constraint in SQLite)
• Thread-safe SQLite writes via a write-lock
• Graceful error handling per-source — one failure never kills the run
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Tuple
from uuid import uuid4

import feedparser
import requests
from apscheduler.schedulers.background import BackgroundScheduler
from bs4 import BeautifulSoup
from flask import Flask, jsonify, request
from flask_cors import CORS

# ─────────────────────────────────────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("job-scraper")

# ─────────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────────

DB_PATH        = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "jobs.db"))
API_PORT       = int(os.environ.get("SCRAPER_PORT", 8765))
SCRAPE_HOURS   = int(os.environ.get("SCRAPE_INTERVAL_HOURS", 5))
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", 24))
MAX_WORKERS    = int(os.environ.get("MAX_WORKERS", 12))
REQUEST_TIMEOUT = 18   # seconds per HTTP request
DESC_MAX_LEN    = 2000 # characters stored per description

ADZUNA_APP_ID  = os.environ.get("ADZUNA_APP_ID", "")
ADZUNA_APP_KEY = os.environ.get("ADZUNA_APP_KEY", "")
JSEARCH_KEY    = os.environ.get("JSEARCH_KEY", "")     # RapidAPI JSearch
REED_KEY       = os.environ.get("REED_API_KEY", "")    # reed.co.uk

_DB_LOCK = threading.Lock()

# ─────────────────────────────────────────────────────────────────────────────
# Data model
# ─────────────────────────────────────────────────────────────────────────────

class Job:
    __slots__ = (
        "id", "title", "company", "url", "apply_url", "description",
        "location", "salary_min", "salary_max", "salary_currency",
        "tags", "source", "is_remote", "posted_at", "scraped_at",
        "job_type", "experience_level", "apply_instructions",
    )

    def __init__(self):
        self.id: str                      = str(uuid4())
        self.title: str                   = ""
        self.company: str                 = ""
        self.url: str                     = ""
        self.apply_url: str               = ""
        self.description: str             = ""
        self.location: str                = "Remote"
        self.salary_min: Optional[int]    = None
        self.salary_max: Optional[int]    = None
        self.salary_currency: str         = "USD"
        self.tags: List[str]              = []
        self.source: str                  = ""
        self.is_remote: bool              = True
        self.posted_at: str               = datetime.now(timezone.utc).isoformat()
        self.scraped_at: str              = datetime.now(timezone.utc).isoformat()
        self.job_type: str                = ""   # full-time / part-time / contract
        self.experience_level: str        = ""   # junior / mid / senior
        self.apply_instructions: str      = ""   # extra context for AI agents

    def to_dict(self) -> dict:
        return {s: getattr(self, s) for s in self.__slots__}


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

TECH_KEYWORDS = [
    "javascript","typescript","python","react","node","java","go","golang","rust",
    "ruby","php","swift","kotlin","scala","elixir","c#","c++","vue","angular",
    "svelte","nextjs","next.js","graphql","postgres","postgresql","mysql","mongodb",
    "redis","aws","gcp","azure","docker","kubernetes","terraform","linux","devops",
    "mlops","ml","ai","llm","pytorch","tensorflow","fullstack","backend","frontend",
    "mobile","ios","android","saas","api","rest","grpc","microservices","blockchain",
    "web3","solidity","data","analytics","spark","hadoop","kafka","airflow","dbt",
    "customer service","support","sales","marketing","hr","recruiting","admin",
    "project manager","product manager","qa","quality assurance","security","sre",
    "site reliability","data scientist","data engineer","machine learning","nlp",
    "computer vision","embedded","firmware","hardware","product design","ux","ui",
    "figma","sketch","adobe","copywriting","content","seo","social media","finance",
    "accounting","legal","operations","logistics","supply chain","healthcare",
]

_KEYWORD_PATTERNS = [
    (kw, re.compile(r"\b" + re.escape(kw) + r"\b", re.I))
    for kw in TECH_KEYWORDS
]

def extract_tags(text: str) -> List[str]:
    return [kw for kw, pat in _KEYWORD_PATTERNS if pat.search(text)]

def parse_salary(raw: str) -> Tuple[Optional[int], Optional[int], str]:
    if not raw:
        return None, None, "USD"
    currency = "EUR" if "€" in raw else "GBP" if "£" in raw else "CAD" if "CAD" in raw else "USD"
    clean = re.sub(r"[£€$,\s]", "", raw)
    clean = re.sub(r"[kK](?=\D|$)", "000", clean)
    nums = [int(n) for n in re.findall(r"\d{4,7}", clean) if 1_000 <= int(n) <= 10_000_000]
    if not nums:
        return None, None, currency
    return nums[0], nums[1] if len(nums) > 1 else None, currency

def detect_remote(title: str, location: str, desc: str) -> bool:
    combined = f"{title} {location} {desc}".lower()
    return bool(re.search(r"\bremote\b|\bwork.?from.?home\b|\bwfh\b|\bdistributed\b|\banywhere\b", combined))

def clean_location(raw: str) -> str:
    if not raw:
        return "Remote"
    r = " ".join(raw.strip().split())
    return "Remote" if re.match(r"^(remote|worldwide|anywhere|global|distributed|anywhere in the world)$", r, re.I) else r

def detect_experience(text: str) -> str:
    t = text.lower()
    if re.search(r"\b(senior|sr\.?|lead|principal|staff|architect)\b", t):
        return "senior"
    if re.search(r"\b(junior|jr\.?|entry.?level|graduate|intern)\b", t):
        return "junior"
    if re.search(r"\b(mid|intermediate|associate)\b", t):
        return "mid"
    return ""

def detect_job_type(text: str) -> str:
    t = text.lower()
    if re.search(r"\b(contract|freelance|contractor)\b", t):
        return "contract"
    if re.search(r"\bpart.?time\b", t):
        return "part-time"
    return "full-time"

def strip_html(html: str) -> str:
    return re.sub(r"<[^>]+>", " ", html).strip()

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def _session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "en-US,en;q=0.9",
    })
    return s

SESSION = _session()

def _get(url: str, **kwargs) -> requests.Response:
    kwargs.setdefault("timeout", REQUEST_TIMEOUT)
    return SESSION.get(url, **kwargs)

# ─────────────────────────────────────────────────────────────────────────────
# Database
# ─────────────────────────────────────────────────────────────────────────────

def init_db() -> None:
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS jobs (
            id               TEXT PRIMARY KEY,
            title            TEXT NOT NULL,
            company          TEXT,
            url              TEXT UNIQUE NOT NULL,
            apply_url        TEXT,
            description      TEXT,
            location         TEXT,
            salary_min       INTEGER,
            salary_max       INTEGER,
            salary_currency  TEXT DEFAULT 'USD',
            tags             TEXT DEFAULT '[]',
            source           TEXT,
            is_remote        INTEGER DEFAULT 1,
            posted_at        TEXT,
            scraped_at       TEXT,
            job_type         TEXT DEFAULT 'full-time',
            experience_level TEXT DEFAULT '',
            apply_instructions TEXT DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_jobs_posted_at  ON jobs(posted_at);
        CREATE INDEX IF NOT EXISTS idx_jobs_source     ON jobs(source);
        CREATE INDEX IF NOT EXISTS idx_jobs_is_remote  ON jobs(is_remote);
        CREATE INDEX IF NOT EXISTS idx_jobs_scraped_at ON jobs(scraped_at);
    """)
    conn.commit()
    conn.close()
    logger.info(f"Database ready: {DB_PATH}")

def persist_jobs(jobs: List[Job]) -> int:
    if not jobs:
        return 0
    inserted = 0
    with _DB_LOCK:
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        for j in jobs:
            if not j.url or not j.title:
                continue
            try:
                cur.execute(
                    """INSERT OR IGNORE INTO jobs
                       (id,title,company,url,apply_url,description,location,
                        salary_min,salary_max,salary_currency,tags,source,
                        is_remote,posted_at,scraped_at,job_type,experience_level,
                        apply_instructions)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        j.id, j.title[:300], j.company[:200],
                        j.url, j.apply_url or j.url,
                        j.description[:DESC_MAX_LEN], j.location[:200],
                        j.salary_min, j.salary_max, j.salary_currency,
                        json.dumps(j.tags), j.source,
                        1 if j.is_remote else 0,
                        j.posted_at, j.scraped_at,
                        j.job_type, j.experience_level,
                        j.apply_instructions,
                    ),
                )
                if cur.rowcount:
                    inserted += 1
            except Exception:
                pass
        conn.commit()
        conn.close()
    return inserted

# ─────────────────────────────────────────────────────────────────────────────
# RSS scraper (generic)
# ─────────────────────────────────────────────────────────────────────────────

def scrape_rss(
    feed_url: str,
    source_name: str,
    title_split: Optional[str] = None,
    default_location: str = "Remote",
    limit: int = 40,
) -> List[Job]:
    try:
        feed = feedparser.parse(feed_url, request_headers={"User-Agent": SESSION.headers["User-Agent"]})
        results: List[Job] = []
        for entry in feed.entries[:limit]:
            link = getattr(entry, "link", None)
            raw_title = getattr(entry, "title", None)
            if not link or not raw_title:
                continue

            title, company = raw_title, "Unknown"
            if title_split and title_split in raw_title:
                parts = raw_title.split(title_split, 1)
                company, title = parts[0].strip(), parts[1].strip()

            desc_html = (
                getattr(entry, "summary", "")
                or (entry.get("content", [{}])[0].get("value", "") if hasattr(entry, "content") else "")
            )
            desc = strip_html(desc_html)
            sal_min, sal_max, sal_cur = parse_salary(desc)
            location = clean_location(getattr(entry, "location", default_location) or default_location)

            posted = getattr(entry, "published", None) or getattr(entry, "updated", None)
            if posted:
                try:
                    import email.utils
                    parsed = email.utils.parsedate_to_datetime(posted)
                    posted_iso = parsed.isoformat()
                except Exception:
                    posted_iso = now_iso()
            else:
                posted_iso = now_iso()

            j = Job()
            j.title            = title
            j.company          = company
            j.url              = link
            j.apply_url        = link
            j.description      = desc[:DESC_MAX_LEN]
            j.location         = location
            j.tags             = extract_tags(f"{title} {desc}")
            j.is_remote        = detect_remote(title, location, desc)
            j.salary_min       = sal_min
            j.salary_max       = sal_max
            j.salary_currency  = sal_cur
            j.posted_at        = posted_iso
            j.source           = source_name
            j.job_type         = detect_job_type(f"{title} {desc}")
            j.experience_level = detect_experience(f"{title} {desc}")
            j.apply_instructions = f"Visit {link} to apply directly."
            results.append(j)

        logger.info(f"  [{source_name}] {len(results)} jobs")
        return results
    except Exception as e:
        logger.error(f"  [{source_name}] RSS failed: {e}")
        return []

# ─────────────────────────────────────────────────────────────────────────────
# RSS sources
# ─────────────────────────────────────────────────────────────────────────────

RSS_SOURCES = [
    # ── We Work Remotely ─────────────────────────────────────────────────
    {"url": "https://weworkremotely.com/remote-jobs.rss",                                     "name": "wwr",              "title_split": ":"},
    {"url": "https://weworkremotely.com/categories/remote-programming-jobs.rss",              "name": "wwr-programming",  "title_split": ":"},
    {"url": "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss",          "name": "wwr-devops",       "title_split": ":"},
    {"url": "https://weworkremotely.com/categories/remote-design-jobs.rss",                   "name": "wwr-design",       "title_split": ":"},
    {"url": "https://weworkremotely.com/categories/remote-product-jobs.rss",                  "name": "wwr-product",      "title_split": ":"},
    {"url": "https://weworkremotely.com/categories/remote-customer-support-jobs.rss",         "name": "wwr-support",      "title_split": ":"},
    {"url": "https://weworkremotely.com/categories/remote-sales-and-marketing-jobs.rss",      "name": "wwr-sales",        "title_split": ":"},
    {"url": "https://weworkremotely.com/categories/remote-finance-legal-jobs.rss",            "name": "wwr-finance",      "title_split": ":"},
    {"url": "https://weworkremotely.com/categories/remote-data-science-jobs.rss",             "name": "wwr-data",         "title_split": ":"},
    # ── Remotive categories ───────────────────────────────────────────────
    {"url": "https://remotive.com/remote-jobs/feed",                                          "name": "remotive-rss"},
    # ── Hacker News Who's Hiring ──────────────────────────────────────────
    {"url": "https://hnrss.org/whoishiring",                                                  "name": "hn-hiring",        "limit": 50},
    # ── Niche remote boards ───────────────────────────────────────────────
    {"url": "https://jobspresso.co/feed/",                                                    "name": "jobspresso"},
    {"url": "https://himalayas.app/jobs/rss",                                                 "name": "himalayas",        "default_location": "Remote"},
    {"url": "https://jobs.automattic.com/feed/",                                              "name": "automattic",       "default_location": "Remote"},
    {"url": "https://dribbble.com/jobs.rss",                                                  "name": "dribbble-jobs"},
    {"url": "https://smashingmagazine.com/jobs/feed/",                                        "name": "smashing-jobs"},
    # ── Greenhouse ATS feeds ──────────────────────────────────────────────
    {"url": "https://boards.greenhouse.io/rss/gitlab",                                        "name": "gitlab-gh"},
    {"url": "https://boards.greenhouse.io/rss/cloudflare",                                    "name": "cloudflare-gh"},
    {"url": "https://boards.greenhouse.io/rss/elastic",                                       "name": "elastic-gh"},
    {"url": "https://boards.greenhouse.io/rss/hashicorp",                                     "name": "hashicorp-gh"},
    {"url": "https://boards.greenhouse.io/rss/figma",                                         "name": "figma-gh"},
    {"url": "https://boards.greenhouse.io/rss/notion",                                        "name": "notion-gh"},
    {"url": "https://boards.greenhouse.io/rss/stripe",                                        "name": "stripe-gh"},
    # ── Lever ATS feeds ───────────────────────────────────────────────────
    {"url": "https://jobs.lever.co/netlify/rss",                                              "name": "netlify-lv"},
    {"url": "https://jobs.lever.co/cloudflare/rss",                                           "name": "cloudflare-lv"},
    {"url": "https://jobs.lever.co/vercel/rss",                                               "name": "vercel-lv"},
    # ── Language / niche ──────────────────────────────────────────────────
    {"url": "https://rustjobs.dev/feed.xml",                                                  "name": "rustjobs"},
    {"url": "https://pythonjobs.github.io/feed.xml",                                          "name": "pythonjobs"},
    {"url": "https://golangjobs.xyz/feed",                                                    "name": "golangjobs"},
    # ── Design ────────────────────────────────────────────────────────────
    {"url": "https://designerjobs.co/jobs.rss",                                               "name": "designerjobs"},
    # ── Non-tech / general remote ─────────────────────────────────────────
    {"url": "https://jobicy.com/feed/rss2",                                                   "name": "jobicy-rss"},
    {"url": "https://remote.co/feed/",                                                        "name": "remoteco"},
    {"url": "https://nodesk.co/remote-jobs/feed/",                                            "name": "nodesk"},
    {"url": "https://flexjobs.com/blog/feed/",                                                "name": "flexjobs-blog"},
]

# ─────────────────────────────────────────────────────────────────────────────
# JSON API scrapers
# ─────────────────────────────────────────────────────────────────────────────

def scrape_remoteok() -> List[Job]:
    try:
        r = _get("https://remoteok.com/api")
        data = r.json()
        results: List[Job] = []
        for d in data[1:]:
            if not d.get("position") or not d.get("url"):
                continue
            sal_min, sal_max, sal_cur = parse_salary(d.get("salary", ""))
            desc = strip_html(d.get("description", ""))
            j = Job()
            j.title            = d["position"]
            j.company          = d.get("company", "Unknown")
            j.url              = f"https://remoteok.com{d['url']}"
            j.apply_url        = d.get("apply_url") or j.url
            j.description      = desc[:DESC_MAX_LEN]
            j.location         = clean_location(d.get("location", "Remote"))
            j.tags             = (d.get("tags") or extract_tags(j.title))[:12]
            j.salary_min       = sal_min
            j.salary_max       = sal_max
            j.salary_currency  = sal_cur
            j.posted_at        = datetime.fromtimestamp(d.get("date", time.time()), tz=timezone.utc).isoformat()
            j.source           = "remoteok"
            j.job_type         = detect_job_type(f"{j.title} {desc}")
            j.experience_level = detect_experience(f"{j.title} {desc}")
            j.apply_instructions = f"Apply at: {j.apply_url}"
            results.append(j)
        logger.info(f"  [remoteok] {len(results)} jobs")
        return results
    except Exception as e:
        logger.error(f"  [remoteok] {e}")
        return []

def scrape_remotive() -> List[Job]:
    try:
        r = _get("https://remotive.com/api/remote-jobs?limit=150")
        results: List[Job] = []
        for d in r.json().get("jobs", []):
            sal_min, sal_max, sal_cur = parse_salary(d.get("salary", ""))
            desc = strip_html(d.get("description", ""))
            j = Job()
            j.title            = d.get("title", "Unknown")
            j.company          = d.get("company_name", "Unknown")
            j.url              = d.get("url", "")
            j.apply_url        = d.get("url", "")
            j.description      = desc[:DESC_MAX_LEN]
            j.location         = clean_location(d.get("candidate_required_location", "Remote"))
            j.tags             = (d.get("tags") or [])[:12]
            j.salary_min       = sal_min
            j.salary_max       = sal_max
            j.salary_currency  = sal_cur
            j.posted_at        = d.get("publication_date", now_iso())
            j.source           = "remotive"
            j.job_type         = d.get("job_type", detect_job_type(j.title))
            j.experience_level = detect_experience(f"{j.title} {desc}")
            j.apply_instructions = f"Apply at: {j.url}"
            results.append(j)
        logger.info(f"  [remotive] {len(results)} jobs")
        return results
    except Exception as e:
        logger.error(f"  [remotive] {e}")
        return []

def scrape_arbeitnow() -> List[Job]:
    try:
        r = _get("https://www.arbeitnow.com/api/job-board-api")
        results: List[Job] = []
        for d in r.json().get("data", [])[:100]:
            desc = strip_html(d.get("description", ""))
            sal_min, sal_max, _ = parse_salary(d.get("salary", ""))
            j = Job()
            j.title            = d.get("title", "Unknown")
            j.company          = d.get("company_name", "Unknown")
            j.url              = d.get("url", "")
            j.apply_url        = d.get("url", "")
            j.description      = desc[:DESC_MAX_LEN]
            j.location         = clean_location(d.get("location", "Remote"))
            j.tags             = (d.get("tags") or [])[:12]
            j.is_remote        = bool(d.get("remote")) or detect_remote(j.title, j.location, desc)
            j.salary_min       = sal_min
            j.salary_max       = sal_max
            j.salary_currency  = "EUR"
            j.posted_at        = d.get("created_at", now_iso())
            j.source           = "arbeitnow"
            j.job_type         = detect_job_type(f"{j.title} {desc}")
            j.experience_level = detect_experience(f"{j.title} {desc}")
            j.apply_instructions = f"Apply at: {j.url}"
            results.append(j)
        logger.info(f"  [arbeitnow] {len(results)} jobs")
        return results
    except Exception as e:
        logger.error(f"  [arbeitnow] {e}")
        return []

def scrape_jobicy() -> List[Job]:
    try:
        r = _get("https://jobicy.com/api/v2/remote-jobs?count=50&geo=worldwide")
        results: List[Job] = []
        for d in r.json().get("jobs", []):
            desc = strip_html(d.get("jobDescription", ""))
            j = Job()
            j.title            = d.get("jobTitle", "Unknown")
            j.company          = d.get("companyName", "Unknown")
            j.url              = d.get("url", "")
            j.apply_url        = d.get("url", "")
            j.description      = desc[:DESC_MAX_LEN]
            j.location         = clean_location(d.get("jobGeo", "Remote"))
            j.tags             = ((d.get("jobIndustry") or []) + (d.get("jobType") or []))[:12]
            j.salary_min       = d.get("annualSalaryMin")
            j.salary_max       = d.get("annualSalaryMax")
            j.salary_currency  = d.get("salaryCurrency", "USD")
            j.posted_at        = d.get("pubDate", now_iso())
            j.source           = "jobicy"
            j.job_type         = detect_job_type(" ".join(d.get("jobType") or []))
            j.experience_level = detect_experience(f"{j.title} {desc}")
            j.apply_instructions = f"Apply at: {j.url}"
            results.append(j)
        logger.info(f"  [jobicy] {len(results)} jobs")
        return results
    except Exception as e:
        logger.error(f"  [jobicy] {e}")
        return []

def scrape_themuse() -> List[Job]:
    try:
        r = _get("https://www.themuse.com/api/public/jobs?page=1&descending=true")
        results: List[Job] = []
        for d in r.json().get("results", [])[:80]:
            location = (d.get("locations") or [{}])[0].get("name", "Remote")
            desc = strip_html(d.get("contents", ""))
            j = Job()
            j.title            = d.get("name", "Unknown")
            j.company          = d.get("company", {}).get("name", "Unknown")
            j.url              = d.get("refs", {}).get("landing_page", "")
            j.apply_url        = j.url
            j.description      = desc[:DESC_MAX_LEN]
            j.location         = clean_location(location)
            j.tags             = [c.get("name", "").lower() for c in d.get("categories", []) if c.get("name")][:10]
            j.is_remote        = detect_remote(j.title, location, desc)
            j.posted_at        = d.get("publication_date", now_iso())
            j.source           = "themuse"
            j.job_type         = detect_job_type(f"{j.title} {desc}")
            j.experience_level = detect_experience(f"{j.title} {desc}")
            j.apply_instructions = f"Apply at: {j.url}"
            results.append(j)
        logger.info(f"  [themuse] {len(results)} jobs")
        return results
    except Exception as e:
        logger.error(f"  [themuse] {e}")
        return []

def scrape_adzuna() -> List[Job]:
    if not ADZUNA_APP_ID or not ADZUNA_APP_KEY:
        return []
    results: List[Job] = []
    for country in ["us", "gb", "au"]:
        try:
            r = _get(
                f"https://api.adzuna.com/v1/api/jobs/{country}/search/1",
                params={
                    "app_id": ADZUNA_APP_ID,
                    "app_key": ADZUNA_APP_KEY,
                    "results_per_page": 50,
                    "where": "remote",
                    "content-type": "application/json",
                },
            )
            for d in r.json().get("results", []):
                desc = d.get("description", "")
                j = Job()
                j.title            = d.get("title", "Unknown")
                j.company          = d.get("company", {}).get("display_name", "Unknown")
                j.url              = d.get("redirect_url", "")
                j.apply_url        = j.url
                j.description      = desc[:DESC_MAX_LEN]
                j.location         = clean_location(d.get("location", {}).get("display_name", "Remote"))
                j.tags             = extract_tags(f"{j.title} {desc}")
                j.is_remote        = detect_remote(j.title, j.location, desc)
                j.salary_min       = round(d["salary_min"]) if d.get("salary_min") else None
                j.salary_max       = round(d["salary_max"]) if d.get("salary_max") else None
                j.salary_currency  = "GBP" if country == "gb" else "AUD" if country == "au" else "USD"
                j.posted_at        = d.get("created", now_iso())
                j.source           = f"adzuna-{country}"
                j.job_type         = detect_job_type(f"{j.title} {desc}")
                j.experience_level = detect_experience(f"{j.title} {desc}")
                j.apply_instructions = f"Apply at: {j.url}"
                results.append(j)
        except Exception as e:
            logger.error(f"  [adzuna-{country}] {e}")
    logger.info(f"  [adzuna] {len(results)} jobs")
    return results

def scrape_reed() -> List[Job]:
    """reed.co.uk — UK's largest job board (requires free API key)"""
    if not REED_KEY:
        return []
    try:
        r = _get(
            "https://www.reed.co.uk/api/1.0/search",
            params={"keywords": "remote", "locationName": "Remote", "resultsToTake": 100},
            auth=(REED_KEY, ""),
        )
        results: List[Job] = []
        for d in r.json().get("results", []):
            desc = d.get("jobDescription", "")
            j = Job()
            j.title            = d.get("jobTitle", "Unknown")
            j.company          = d.get("employerName", "Unknown")
            j.url              = d.get("jobUrl", "")
            j.apply_url        = d.get("jobUrl", "")
            j.description      = desc[:DESC_MAX_LEN]
            j.location         = clean_location(d.get("locationName", "Remote"))
            j.tags             = extract_tags(f"{j.title} {desc}")
            j.is_remote        = True
            j.salary_min       = d.get("minimumSalary")
            j.salary_max       = d.get("maximumSalary")
            j.salary_currency  = "GBP"
            j.posted_at        = d.get("date", now_iso())
            j.source           = "reed"
            j.job_type         = "full-time" if not d.get("partTime") else "part-time"
            j.experience_level = detect_experience(f"{j.title} {desc}")
            j.apply_instructions = f"Apply at: {j.url}"
            results.append(j)
        logger.info(f"  [reed] {len(results)} jobs")
        return results
    except Exception as e:
        logger.error(f"  [reed] {e}")
        return []

def scrape_jsearch() -> List[Job]:
    """RapidAPI JSearch — aggregates LinkedIn, Indeed, Glassdoor, ZipRecruiter"""
    if not JSEARCH_KEY:
        return []
    results: List[Job] = []
    queries = ["remote software engineer", "remote data scientist", "remote product manager",
               "remote customer support", "remote marketing", "remote finance"]
    for query in queries:
        try:
            r = _get(
                "https://jsearch.p.rapidapi.com/search",
                params={"query": query, "num_pages": "2", "date_posted": "today"},
                headers={
                    "X-RapidAPI-Key": JSEARCH_KEY,
                    "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
                },
            )
            for d in r.json().get("data", []):
                desc = d.get("job_description", "")
                j = Job()
                j.title            = d.get("job_title", "Unknown")
                j.company          = d.get("employer_name", "Unknown")
                j.url              = d.get("job_apply_link", "")
                j.apply_url        = d.get("job_apply_link", "")
                j.description      = desc[:DESC_MAX_LEN]
                j.location         = clean_location(
                    f"{d.get('job_city','')}, {d.get('job_country','')}" if d.get("job_city") else "Remote"
                )
                j.tags             = extract_tags(f"{j.title} {desc}")
                j.is_remote        = bool(d.get("job_is_remote")) or detect_remote(j.title, j.location, desc)
                j.salary_min       = d.get("job_min_salary")
                j.salary_max       = d.get("job_max_salary")
                j.salary_currency  = d.get("job_salary_currency", "USD")
                j.posted_at        = (
                    datetime.fromtimestamp(d["job_posted_at_timestamp"], tz=timezone.utc).isoformat()
                    if d.get("job_posted_at_timestamp") else now_iso()
                )
                j.source           = f"jsearch-{d.get('job_publisher','').lower().replace(' ','-')}"
                j.job_type         = d.get("job_employment_type", detect_job_type(j.title)).lower()
                j.experience_level = detect_experience(f"{j.title} {desc}")
                j.apply_instructions = (
                    f"Apply directly at: {j.apply_url}. "
                    + (f"Easy apply: {d.get('job_apply_is_direct', False)}. " if d.get("job_apply_is_direct") else "")
                    + (f"Qualifications: {'; '.join(d.get('job_required_qualifications', {}).get('items', [])[:3])}" if d.get("job_required_qualifications") else "")
                )
                results.append(j)
            time.sleep(0.3)
        except Exception as e:
            logger.error(f"  [jsearch/{query}] {e}")
    logger.info(f"  [jsearch] {len(results)} jobs")
    return results

def scrape_github_jobs_api() -> List[Job]:
    """
    Scrapes the GitHub-hosted jobs.github.com (now redirects to job boards).
    Falls back to scraping remote developer jobs from the GitHub Jobs XML feed.
    """
    try:
        r = _get("https://github.com/about/careers")
        soup = BeautifulSoup(r.text, "html.parser")
        results: List[Job] = []
        for a in soup.select("a[href*='/careers/']")[:30]:
            title = a.get_text(strip=True)
            if not title or len(title) < 4:
                continue
            href = a["href"]
            url = href if href.startswith("http") else f"https://github.com{href}"
            j = Job()
            j.title            = title
            j.company          = "GitHub"
            j.url              = url
            j.apply_url        = url
            j.location         = "Remote"
            j.is_remote        = True
            j.source           = "github-careers"
            j.tags             = extract_tags(title)
            j.apply_instructions = f"Apply at GitHub Careers: {url}"
            results.append(j)
        logger.info(f"  [github-careers] {len(results)} jobs")
        return results
    except Exception as e:
        logger.error(f"  [github-careers] {e}")
        return []

def scrape_remote_co() -> List[Job]:
    """Scrape remote.co job listings via HTML"""
    results: List[Job] = []
    categories = ["software-dev", "customer-service", "marketing", "writing", "design",
                  "data-entry", "project-management", "sales", "accounting-finance", "hr"]
    for cat in categories[:6]:  # limit to avoid rate limiting
        try:
            r = _get(f"https://remote.co/remote-jobs/{cat}/")
            soup = BeautifulSoup(r.text, "html.parser")
            for card in soup.select("li.job_listing")[:15]:
                title_el = card.select_one(".job_listing-title")
                company_el = card.select_one(".job_listing-company")
                link_el = card.select_one("a")
                if not title_el or not link_el:
                    continue
                href = link_el.get("href", "")
                url = href if href.startswith("http") else f"https://remote.co{href}"
                title = title_el.get_text(strip=True)
                company = company_el.get_text(strip=True) if company_el else "Unknown"
                j = Job()
                j.title            = title
                j.company          = company
                j.url              = url
                j.apply_url        = url
                j.location         = "Remote"
                j.is_remote        = True
                j.source           = f"remoteco-{cat}"
                j.tags             = extract_tags(title)
                j.experience_level = detect_experience(title)
                j.apply_instructions = f"Apply at: {url}"
                results.append(j)
            time.sleep(0.5)
        except Exception as e:
            logger.error(f"  [remote.co/{cat}] {e}")
    logger.info(f"  [remote.co] {len(results)} jobs")
    return results

def scrape_linkedin_public() -> List[Job]:
    """Scrape LinkedIn public job listings (no login, guest API)"""
    results: List[Job] = []
    searches = [
        ("software engineer remote", ""),
        ("data scientist remote", ""),
        ("product manager remote", ""),
        ("customer success remote", ""),
        ("marketing remote", ""),
    ]
    for keywords, location in searches:
        try:
            r = _get(
                "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search",
                params={
                    "keywords": keywords,
                    "location": location,
                    "f_WT": "2",
                    "start": 0,
                },
                headers={"Accept": "application/json"},
            )
            soup = BeautifulSoup(r.text, "html.parser")
            for card in soup.select("li")[:20]:
                title_el   = card.select_one(".base-search-card__title")
                company_el = card.select_one(".base-search-card__subtitle")
                location_el= card.select_one(".job-search-card__location")
                link_el    = card.select_one("a.base-card__full-link")
                if not title_el or not link_el:
                    continue
                url = link_el.get("href", "").split("?")[0]
                j = Job()
                j.title            = title_el.get_text(strip=True)
                j.company          = company_el.get_text(strip=True) if company_el else "Unknown"
                j.url              = url
                j.apply_url        = url
                j.location         = clean_location(location_el.get_text(strip=True) if location_el else "Remote")
                j.is_remote        = True
                j.source           = "linkedin-public"
                j.tags             = extract_tags(j.title)
                j.experience_level = detect_experience(j.title)
                j.apply_instructions = f"Apply via LinkedIn: {url}"
                results.append(j)
            time.sleep(1)
        except Exception as e:
            logger.error(f"  [linkedin/{keywords}] {e}")
    logger.info(f"  [linkedin-public] {len(results)} jobs")
    return results

def scrape_indeed_rss() -> List[Job]:
    """Indeed RSS feeds for remote positions"""
    queries = [
        "remote+software+engineer",
        "remote+data+analyst",
        "remote+customer+support",
        "remote+product+manager",
        "remote+marketing",
    ]
    results: List[Job] = []
    for q in queries:
        try:
            url = f"https://www.indeed.com/rss?q={q}&l=Remote&sort=date"
            feed = feedparser.parse(url, request_headers={"User-Agent": SESSION.headers["User-Agent"]})
            for entry in feed.entries[:20]:
                desc = strip_html(getattr(entry, "summary", ""))
                sal_min, sal_max, sal_cur = parse_salary(desc)
                title = getattr(entry, "title", "Unknown")
                j = Job()
                j.title            = title
                j.company          = getattr(entry, "source", {}).get("title", "Unknown") if hasattr(entry, "source") else "Unknown"
                j.url              = getattr(entry, "link", "")
                j.apply_url        = j.url
                j.description      = desc[:DESC_MAX_LEN]
                j.location         = "Remote"
                j.is_remote        = True
                j.tags             = extract_tags(f"{title} {desc}")
                j.salary_min       = sal_min
                j.salary_max       = sal_max
                j.salary_currency  = sal_cur
                j.posted_at        = getattr(entry, "published", now_iso())
                j.source           = "indeed-rss"
                j.experience_level = detect_experience(f"{title} {desc}")
                j.apply_instructions = f"Apply on Indeed: {j.url}"
                results.append(j)
        except Exception as e:
            logger.error(f"  [indeed-rss/{q}] {e}")
    logger.info(f"  [indeed-rss] {len(results)} jobs")
    return results

def scrape_glassdoor_rss() -> List[Job]:
    """Glassdoor public RSS for remote jobs"""
    try:
        url = "https://www.glassdoor.com/Job/remote-jobs-SRCH_IL.0,6_IS11047_KO7,13.htm?jobType=fulltime&fromAge=1"
        r = _get(url)
        soup = BeautifulSoup(r.text, "html.parser")
        results: List[Job] = []
        for card in soup.select("[data-test='jobListing']")[:40]:
            title_el   = card.select_one("[data-test='job-title']")
            company_el = card.select_one("[data-test='employer-name']")
            location_el= card.select_one("[data-test='emp-location']")
            link_el    = card.select_one("a[href]")
            if not title_el or not link_el:
                continue
            href = link_el["href"]
            url = href if href.startswith("http") else f"https://www.glassdoor.com{href}"
            j = Job()
            j.title            = title_el.get_text(strip=True)
            j.company          = company_el.get_text(strip=True) if company_el else "Unknown"
            j.url              = url
            j.apply_url        = url
            j.location         = clean_location(location_el.get_text(strip=True) if location_el else "Remote")
            j.is_remote        = True
            j.source           = "glassdoor"
            j.tags             = extract_tags(j.title)
            j.experience_level = detect_experience(j.title)
            j.apply_instructions = f"Apply on Glassdoor: {url}"
            results.append(j)
        logger.info(f"  [glassdoor] {len(results)} jobs")
        return results
    except Exception as e:
        logger.error(f"  [glassdoor] {e}")
        return []

def scrape_angel_list() -> List[Job]:
    """Wellfound (formerly AngelList Talent) — startup jobs"""
    try:
        r = _get(
            "https://wellfound.com/role/r/software-engineer",
            headers={"Accept": "application/json", "X-Requested-With": "XMLHttpRequest"},
        )
        soup = BeautifulSoup(r.text, "html.parser")
        results: List[Job] = []
        for card in soup.select("[class*='JobListingCard']")[:40]:
            title_el   = card.select_one("a[href*='/role/']")
            company_el = card.select_one("[class*='startup-name']")
            if not title_el:
                continue
            href = title_el.get("href", "")
            url = href if href.startswith("http") else f"https://wellfound.com{href}"
            title = title_el.get_text(strip=True)
            company = company_el.get_text(strip=True) if company_el else "Unknown"
            j = Job()
            j.title            = title
            j.company          = company
            j.url              = url
            j.apply_url        = url
            j.is_remote        = True
            j.source           = "wellfound"
            j.tags             = extract_tags(title)
            j.experience_level = detect_experience(title)
            j.apply_instructions = f"Apply on Wellfound (AngelList): {url}"
            results.append(j)
        logger.info(f"  [wellfound] {len(results)} jobs")
        return results
    except Exception as e:
        logger.error(f"  [wellfound] {e}")
        return []

def scrape_himalayas() -> List[Job]:
    """Himalayas.app JSON API — curated remote jobs"""
    try:
        r = _get("https://himalayas.app/jobs/api?limit=100")
        results: List[Job] = []
        for d in r.json().get("jobs", []):
            desc = strip_html(d.get("description", ""))
            sal_min, sal_max, sal_cur = parse_salary(d.get("salary", ""))
            j = Job()
            j.title            = d.get("title", "Unknown")
            j.company          = d.get("companyName", "Unknown")
            j.url              = d.get("applicationUrl") or d.get("url", "")
            j.apply_url        = j.url
            j.description      = desc[:DESC_MAX_LEN]
            j.location         = "Remote"
            j.is_remote        = True
            j.tags             = (d.get("skills") or extract_tags(j.title))[:12]
            j.salary_min       = sal_min or d.get("salaryMin")
            j.salary_max       = sal_max or d.get("salaryMax")
            j.salary_currency  = sal_cur
            j.posted_at        = d.get("createdAt", now_iso())
            j.source           = "himalayas-api"
            j.job_type         = d.get("jobType", detect_job_type(j.title))
            j.experience_level = d.get("seniorityLevel", detect_experience(j.title))
            j.apply_instructions = f"Apply at Himalayas: {j.url}"
            results.append(j)
        logger.info(f"  [himalayas-api] {len(results)} jobs")
        return results
    except Exception as e:
        logger.error(f"  [himalayas-api] {e}")
        return []

def scrape_justremote() -> List[Job]:
    """JustRemote — remote-only job board"""
    try:
        r = _get("https://justremote.co/remote-jobs/feed.rss")
        feed = feedparser.parse(r.text)
        results: List[Job] = []
        for entry in feed.entries[:60]:
            desc = strip_html(getattr(entry, "summary", ""))
            title = getattr(entry, "title", "Unknown")
            j = Job()
            j.title            = title
            j.company          = "Unknown"
            j.url              = getattr(entry, "link", "")
            j.apply_url        = j.url
            j.description      = desc[:DESC_MAX_LEN]
            j.location         = "Remote"
            j.is_remote        = True
            j.tags             = extract_tags(f"{title} {desc}")
            j.posted_at        = getattr(entry, "published", now_iso())
            j.source           = "justremote"
            j.experience_level = detect_experience(f"{title} {desc}")
            j.apply_instructions = f"Apply at: {j.url}"
            results.append(j)
        logger.info(f"  [justremote] {len(results)} jobs")
        return results
    except Exception as e:
        logger.error(f"  [justremote] {e}")
        return []

def scrape_working_nomads() -> List[Job]:
    """WorkingNomads — curated remote jobs"""
    try:
        r = _get("https://www.workingnomads.com/api/exposed_jobs/?limit=100")
        results: List[Job] = []
        for d in r.json()[:100]:
            desc = strip_html(d.get("description", ""))
            j = Job()
            j.title            = d.get("title", "Unknown")
            j.company          = d.get("company", "Unknown")
            j.url              = d.get("url", "")
            j.apply_url        = d.get("apply_url", j.url)
            j.description      = desc[:DESC_MAX_LEN]
            j.location         = clean_location(d.get("location", "Remote"))
            j.is_remote        = True
            j.tags             = extract_tags(f"{j.title} {desc}")
            j.salary_min, j.salary_max, j.salary_currency = parse_salary(d.get("salary_range", ""))
            j.posted_at        = d.get("pub_date", now_iso())
            j.source           = "workingnomads"
            j.job_type         = detect_job_type(j.title)
            j.experience_level = detect_experience(f"{j.title} {desc}")
            j.apply_instructions = f"Apply at Working Nomads: {j.apply_url}"
            results.append(j)
        logger.info(f"  [workingnomads] {len(results)} jobs")
        return results
    except Exception as e:
        logger.error(f"  [workingnomads] {e}")
        return []

def scrape_naukri_remote() -> List[Job]:
    """Naukri.com RSS for remote IT jobs (covers South/Southeast Asia)"""
    try:
        r = _get("https://www.naukri.com/rss/jobs-by-category/it-software-jobs.rss")
        feed = feedparser.parse(r.text)
        results: List[Job] = []
        for entry in feed.entries[:50]:
            title = getattr(entry, "title", "Unknown")
            desc  = strip_html(getattr(entry, "summary", ""))
            if not detect_remote(title, "", desc):
                continue
            j = Job()
            j.title            = title
            j.company          = "Unknown"
            j.url              = getattr(entry, "link", "")
            j.apply_url        = j.url
            j.description      = desc[:DESC_MAX_LEN]
            j.location         = "Remote"
            j.is_remote        = True
            j.tags             = extract_tags(f"{title} {desc}")
            j.posted_at        = getattr(entry, "published", now_iso())
            j.source           = "naukri-remote"
            j.experience_level = detect_experience(f"{title} {desc}")
            j.apply_instructions = f"Apply at Naukri: {j.url}"
            results.append(j)
        logger.info(f"  [naukri-remote] {len(results)} jobs")
        return results
    except Exception as e:
        logger.error(f"  [naukri-remote] {e}")
        return []


# ─────────────────────────────────────────────────────────────────────────────
# Orchestrator
# ─────────────────────────────────────────────────────────────────────────────

# All JSON/HTML scraper functions
API_SCRAPERS = [
    scrape_remoteok,
    scrape_remotive,
    scrape_arbeitnow,
    scrape_jobicy,
    scrape_themuse,
    scrape_adzuna,
    scrape_reed,
    scrape_jsearch,
    scrape_himalayas,
    scrape_working_nomads,
    scrape_justremote,
    scrape_linkedin_public,
    scrape_remote_co,
    scrape_indeed_rss,
    scrape_glassdoor_rss,
    scrape_angel_list,
    scrape_github_jobs_api,
    scrape_naukri_remote,
]

def _is_within_lookback(posted_at: str) -> bool:
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=LOOKBACK_HOURS)
        dt_str = posted_at.replace("Z", "+00:00")
        dt = datetime.fromisoformat(dt_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt >= cutoff
    except Exception:
        return True  # include if we can't parse

def run_scrape() -> None:
    t0 = time.time()
    logger.info(
        f"[scraper] Starting — {len(RSS_SOURCES)} RSS + {len(API_SCRAPERS)} API/HTML scrapers"
    )

    collected: List[Job] = []

    # ── RSS sources (thread pool) ──────────────────────────────────────────
    def _rss_task(src):
        return scrape_rss(
            src["url"],
            src["name"],
            title_split=src.get("title_split"),
            default_location=src.get("default_location", "Remote"),
            limit=src.get("limit", 40),
        )

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(_rss_task, s): s["name"] for s in RSS_SOURCES}
        for fut in as_completed(futures):
            try:
                collected.extend(fut.result())
            except Exception as e:
                logger.error(f"  [RSS future error] {e}")

    # ── API / HTML scrapers (sequential with small delay) ─────────────────
    for fn in API_SCRAPERS:
        try:
            collected.extend(fn())
        except Exception as e:
            logger.error(f"  [{fn.__name__}] unhandled: {e}")
        time.sleep(0.4)

    # ── Filter to lookback window ──────────────────────────────────────────
    recent = [j for j in collected if _is_within_lookback(j.posted_at)]

    # ── Deduplicate by URL ────────────────────────────────────────────────
    seen: set = set()
    unique: List[Job] = []
    for j in recent:
        if j.url and j.url not in seen:
            seen.add(j.url)
            unique.append(j)

    inserted = persist_jobs(unique)
    elapsed  = time.time() - t0
    logger.info(
        f"[scraper] Done — {len(collected)} raw → {len(recent)} recent → "
        f"{len(unique)} unique → {inserted} new inserted ({elapsed:.1f}s)"
    )


# ─────────────────────────────────────────────────────────────────────────────
# REST API (AI-agent friendly)
# ─────────────────────────────────────────────────────────────────────────────

app = Flask(__name__)
CORS(app)

def _query_jobs(
    limit: int = 50,
    offset: int = 0,
    source: Optional[str] = None,
    is_remote: Optional[bool] = None,
    tags: Optional[str] = None,
    title: Optional[str] = None,
    company: Optional[str] = None,
    location: Optional[str] = None,
    salary_min: Optional[int] = None,
    experience_level: Optional[str] = None,
    job_type: Optional[str] = None,
    since_hours: int = 24,
) -> List[dict]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    clauses = ["1=1"]
    params: list = []

    cutoff = (datetime.now(timezone.utc) - timedelta(hours=since_hours)).isoformat()
    clauses.append("scraped_at >= ?")
    params.append(cutoff)

    if source:
        clauses.append("source LIKE ?")
        params.append(f"%{source}%")
    if is_remote is not None:
        clauses.append("is_remote = ?")
        params.append(1 if is_remote else 0)
    if tags:
        for tag in tags.split(","):
            clauses.append("tags LIKE ?")
            params.append(f"%{tag.strip()}%")
    if title:
        clauses.append("title LIKE ?")
        params.append(f"%{title}%")
    if company:
        clauses.append("company LIKE ?")
        params.append(f"%{company}%")
    if location:
        clauses.append("location LIKE ?")
        params.append(f"%{location}%")
    if salary_min is not None:
        clauses.append("(salary_min >= ? OR salary_max >= ?)")
        params.extend([salary_min, salary_min])
    if experience_level:
        clauses.append("experience_level = ?")
        params.append(experience_level)
    if job_type:
        clauses.append("job_type = ?")
        params.append(job_type)

    sql = f"""
        SELECT * FROM jobs
        WHERE {' AND '.join(clauses)}
        ORDER BY posted_at DESC
        LIMIT ? OFFSET ?
    """
    params.extend([limit, offset])
    rows = cur.execute(sql, params).fetchall()
    conn.close()

    result = []
    for row in rows:
        d = dict(row)
        d["tags"] = json.loads(d.get("tags") or "[]")
        d["is_remote"] = bool(d["is_remote"])
        result.append(d)
    return result


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "timestamp": now_iso()})

@app.route("/jobs", methods=["GET"])
def get_jobs():
    """
    List jobs with filtering.

    Query params:
      limit          int   (default 50, max 200)
      offset         int   (default 0)
      source         str   partial match on source name
      is_remote      bool  1/0/true/false
      tags           str   comma-separated, e.g. python,aws
      title          str   partial match
      company        str   partial match
      location       str   partial match
      salary_min     int   minimum salary
      experience     str   junior|mid|senior
      job_type       str   full-time|part-time|contract
      since_hours    int   how many hours back to look (default 24)
    """
    limit = min(int(request.args.get("limit", 50)), 200)
    offset = int(request.args.get("offset", 0))
    is_remote_raw = request.args.get("is_remote")
    is_remote = None
    if is_remote_raw in ("1", "true"):
        is_remote = True
    elif is_remote_raw in ("0", "false"):
        is_remote = False

    jobs = _query_jobs(
        limit=limit,
        offset=offset,
        source=request.args.get("source"),
        is_remote=is_remote,
        tags=request.args.get("tags"),
        title=request.args.get("title"),
        company=request.args.get("company"),
        location=request.args.get("location"),
        salary_min=int(request.args.get("salary_min")) if request.args.get("salary_min") else None,
        experience_level=request.args.get("experience"),
        job_type=request.args.get("job_type"),
        since_hours=int(request.args.get("since_hours", 24)),
    )
    return jsonify({"total": len(jobs), "offset": offset, "limit": limit, "jobs": jobs})


@app.route("/jobs/<job_id>", methods=["GET"])
def get_job(job_id: str):
    """Get a single job by ID — includes full description + apply_instructions for AI agents."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    row = cur.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    conn.close()
    if not row:
        return jsonify({"error": "not found"}), 404
    d = dict(row)
    d["tags"] = json.loads(d.get("tags") or "[]")
    d["is_remote"] = bool(d["is_remote"])
    return jsonify(d)


@app.route("/jobs/apply/<job_id>", methods=["GET"])
def get_apply_info(job_id: str):
    """
    AI-agent endpoint — returns structured application info for a job.
    Includes apply_url, apply_instructions, requirements extracted from description.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    row = cur.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    conn.close()
    if not row:
        return jsonify({"error": "not found"}), 404
    d = dict(row)
    d["tags"] = json.loads(d.get("tags") or "[]")

    # Extract requirements from description for AI agents
    desc = d.get("description", "")
    requirements = []
    for line in desc.split("\n"):
        line = line.strip().lstrip("-•*").strip()
        if any(kw in line.lower() for kw in ["require", "must", "experience", "proficient", "knowledge of"]):
            if 10 < len(line) < 200:
                requirements.append(line)

    return jsonify({
        "id": d["id"],
        "title": d["title"],
        "company": d["company"],
        "apply_url": d["apply_url"],
        "apply_instructions": d.get("apply_instructions", f"Apply at: {d['apply_url']}"),
        "source": d["source"],
        "is_remote": bool(d["is_remote"]),
        "salary_min": d["salary_min"],
        "salary_max": d["salary_max"],
        "salary_currency": d["salary_currency"],
        "job_type": d.get("job_type", "full-time"),
        "experience_level": d.get("experience_level", ""),
        "location": d["location"],
        "tags": d["tags"],
        "requirements_extracted": requirements[:10],
        "description_preview": desc[:500],
    })


@app.route("/stats", methods=["GET"])
def get_stats():
    """Aggregated stats — useful for dashboards and monitoring."""
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    total      = cur.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
    last_24h   = cur.execute(
        "SELECT COUNT(*) FROM jobs WHERE scraped_at >= ?",
        ((datetime.now(timezone.utc) - timedelta(hours=24)).isoformat(),)
    ).fetchone()[0]
    by_source  = cur.execute(
        "SELECT source, COUNT(*) as count FROM jobs GROUP BY source ORDER BY count DESC LIMIT 30"
    ).fetchall()
    remote_pct = cur.execute(
        "SELECT ROUND(100.0 * SUM(is_remote) / COUNT(*), 1) FROM jobs"
    ).fetchone()[0]
    conn.close()
    return jsonify({
        "total_jobs": total,
        "new_last_24h": last_24h,
        "remote_percentage": remote_pct,
        "by_source": [{"source": r[0], "count": r[1]} for r in by_source],
    })


@app.route("/scrape/trigger", methods=["POST"])
def trigger_scrape():
    """Manually trigger a scrape (useful for testing / forced refresh)."""
    t = threading.Thread(target=run_scrape, daemon=True)
    t.start()
    return jsonify({"status": "triggered", "message": "Scrape started in background"})


# ─────────────────────────────────────────────────────────────────────────────
# Startup
# ─────────────────────────────────────────────────────────────────────────────

def start():
    init_db()

    # Initial scrape in background so the API is immediately available
    t = threading.Thread(target=run_scrape, daemon=True)
    t.start()

    # Scheduler
    scheduler = BackgroundScheduler(timezone="UTC")
    scheduler.add_job(run_scrape, "interval", hours=SCRAPE_HOURS, id="job_scraper")
    scheduler.start()
    logger.info(f"[scheduler] Will scrape every {SCRAPE_HOURS} hours")

    # Flask API
    logger.info(f"[api] Starting on port {API_PORT}")
    app.run(host="0.0.0.0", port=API_PORT, debug=False, use_reloader=False)


if __name__ == "__main__":
    start()