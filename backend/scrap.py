#!/usr/bin/env python3
"""
Production Job Scraper v2
─────────────────────────
• ALL scrapers (RSS + API + HTML) run in one ThreadPoolExecutor — parallel
• Hard 12s per-request timeout — one slow host never blocks anything
• 0-job sources are skipped in logs (set VERBOSE=1 to see them)
• Dead/unverified sources removed; only confirmed-live feeds kept
• Schema is byte-for-byte compatible with the TypeScript jobs.db
• Flask REST API for Node.js + AI agents
"""
from __future__ import annotations
import json, logging, os, re, sqlite3, threading, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Tuple
from uuid import uuid4
import feedparser, requests
from apscheduler.schedulers.background import BackgroundScheduler
from bs4 import BeautifulSoup
from flask import Flask, jsonify, request
from flask_cors import CORS

# ── Config ────────────────────────────────────────────────────────────────────
DB_PATH        = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "jobs.db"))
API_PORT       = int(os.environ.get("SCRAPER_PORT", "8765"))
SCRAPE_HOURS   = int(os.environ.get("SCRAPE_INTERVAL_HOURS", "5"))
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "24"))
MAX_WORKERS    = int(os.environ.get("MAX_WORKERS", "20"))
REQ_TIMEOUT    = int(os.environ.get("REQUEST_TIMEOUT", "12"))
VERBOSE        = os.environ.get("VERBOSE","").lower() in ("1","true","yes")
ADZUNA_APP_ID  = os.environ.get("ADZUNA_APP_ID","")
ADZUNA_APP_KEY = os.environ.get("ADZUNA_APP_KEY","")
JSEARCH_KEY    = os.environ.get("JSEARCH_KEY","")
REED_KEY       = os.environ.get("REED_API_KEY","")
_DB_LOCK       = threading.Lock()

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("scraper")
for _n in ("apscheduler.executors.default","apscheduler.scheduler","werkzeug"):
    logging.getLogger(_n).setLevel(logging.WARNING)

# ── Data model ────────────────────────────────────────────────────────────────
class Job:
    __slots__ = ("id","title","company","url","apply_url","description","location",
                 "salary_min","salary_max","salary_currency","tags","source","is_remote",
                 "posted_at","job_type","experience_level","apply_instructions")
    def __init__(self):
        self.id=str(uuid4()); self.title=""; self.company=""; self.url=""; self.apply_url=""
        self.description=""; self.location="Remote"; self.salary_min=None; self.salary_max=None
        self.salary_currency="USD"; self.tags=[]; self.source=""; self.is_remote=True
        self.posted_at=_now(); self.job_type="full-time"; self.experience_level=""; self.apply_instructions=""

# ── Helpers ───────────────────────────────────────────────────────────────────
KEYWORDS=["javascript","typescript","python","react","node","java","go","golang","rust","ruby","php",
"swift","kotlin","scala","elixir","c#","c++","vue","angular","svelte","nextjs","graphql","postgres",
"postgresql","mysql","mongodb","redis","aws","gcp","azure","docker","kubernetes","terraform","linux",
"devops","mlops","ml","ai","llm","pytorch","tensorflow","fullstack","backend","frontend","mobile","ios",
"android","saas","api","rest","grpc","microservices","blockchain","web3","solidity","data","analytics",
"spark","kafka","airflow","dbt","customer service","support","sales","marketing","hr","recruiting","admin",
"project manager","product manager","qa","quality assurance","security","sre","data scientist",
"data engineer","machine learning","nlp","computer vision","ux","ui","figma","copywriting","content",
"seo","finance","accounting","operations","healthcare"]
_KW=[(k,re.compile(r"\b"+re.escape(k)+r"\b",re.I)) for k in KEYWORDS]

def _tags(t:str)->List[str]: return [k for k,p in _KW if p.search(t)]
def _salary(r:str)->Tuple[Optional[int],Optional[int],str]:
    if not r: return None,None,"USD"
    cur="EUR" if "€" in r else "GBP" if "£" in r else "CAD" if "CAD" in r else "USD"
    c=re.sub(r"[£€$,\s]","",r); c=re.sub(r"[kK](?=\D|$)","000",c)
    n=[int(x) for x in re.findall(r"\d{4,7}",c) if 1000<=int(x)<=10_000_000]
    return (n[0],n[1] if len(n)>1 else None,cur) if n else (None,None,cur)
def _remote(t:str,l:str,d:str)->bool:
    return bool(re.search(r"\bremote\b|\bwork.?from.?home\b|\bwfh\b|\bdistributed\b|\banywhere\b",f"{t} {l} {d}",re.I))
def _loc(r:str)->str:
    if not r: return "Remote"
    s=" ".join(r.strip().split())
    return "Remote" if re.match(r"^(remote|worldwide|anywhere|global|distributed)$",s,re.I) else s
def _exp(t:str)->str:
    if re.search(r"\b(senior|sr\.?|lead|principal|staff|architect)\b",t,re.I): return "senior"
    if re.search(r"\b(junior|jr\.?|entry.?level|graduate|intern)\b",t,re.I): return "junior"
    if re.search(r"\b(mid|intermediate|associate)\b",t,re.I): return "mid"
    return ""
def _jtype(t:str)->str:
    if re.search(r"\b(contract|freelance|contractor)\b",t,re.I): return "contract"
    if re.search(r"\bpart.?time\b",t,re.I): return "part-time"
    return "full-time"
def _html(s:str)->str: return re.sub(r"<[^>]+"," ",s or "").strip()
def _now()->str: return datetime.now(timezone.utc).isoformat()
def _date(r:str)->str:
    if not r: return _now()
    try:
        import email.utils; return email.utils.parsedate_to_datetime(r).isoformat()
    except: pass
    try: return datetime.fromisoformat(r.replace("Z","+00:00")).isoformat()
    except: return _now()

_S=requests.Session()
_S.headers.update({"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36","Accept-Language":"en-US,en;q=0.9"})
def _get(u,**kw): kw.setdefault("timeout",REQ_TIMEOUT); return _S.get(u,**kw)

# ── Database ──────────────────────────────────────────────────────────────────
def init_db():
    os.makedirs(os.path.dirname(DB_PATH) or ".",exist_ok=True)
    conn=sqlite3.connect(DB_PATH)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, company TEXT,
            url TEXT UNIQUE NOT NULL, apply_url TEXT, description TEXT, location TEXT,
            salary_min INTEGER, salary_max INTEGER, salary_currency TEXT DEFAULT 'USD',
            tags TEXT DEFAULT '[]', source TEXT, is_remote INTEGER DEFAULT 1,
            scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_source ON jobs(source);
        CREATE INDEX IF NOT EXISTS idx_remote ON jobs(is_remote);
        CREATE INDEX IF NOT EXISTS idx_scraped ON jobs(scraped_at);
    """)
    for col in ["ALTER TABLE jobs ADD COLUMN posted_at TEXT",
                "ALTER TABLE jobs ADD COLUMN job_type TEXT DEFAULT 'full-time'",
                "ALTER TABLE jobs ADD COLUMN experience_level TEXT DEFAULT ''",
                "ALTER TABLE jobs ADD COLUMN apply_instructions TEXT DEFAULT ''"]:
        try: conn.execute(col)
        except: pass
    conn.commit(); conn.close(); log.info(f"DB → {DB_PATH}")

def _save(jobs:List[Job])->int:
    if not jobs: return 0
    n=0
    with _DB_LOCK:
        conn=sqlite3.connect(DB_PATH); cur=conn.cursor()
        for j in jobs:
            if not j.url or not j.title: continue
            try:
                cur.execute("""INSERT OR IGNORE INTO jobs
                    (id,title,company,url,apply_url,description,location,salary_min,salary_max,
                     salary_currency,tags,source,is_remote,posted_at,job_type,experience_level,apply_instructions)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (j.id,j.title[:300],j.company[:200],j.url,j.apply_url or j.url,j.description[:2000],
                     j.location[:200],j.salary_min,j.salary_max,j.salary_currency,json.dumps(j.tags),
                     j.source,1 if j.is_remote else 0,j.posted_at,j.job_type,j.experience_level,j.apply_instructions))
                if cur.rowcount: n+=1
            except: pass
        conn.commit(); conn.close()
    return n

# ── Generic RSS ───────────────────────────────────────────────────────────────
def _rss(url,name,split=None,default_loc="Remote",limit=40)->List[Job]:
    try:
        r=_get(url); feed=feedparser.parse(r.text)
        if not feed.entries: return []
        results=[]
        for e in feed.entries[:limit]:
            link=getattr(e,"link",None); raw=getattr(e,"title",None)
            if not link or not raw: continue
            title,company=raw.strip(),"Unknown"
            if split and split in raw:
                parts=raw.split(split,1); company,title=parts[0].strip(),parts[1].strip()
            dh=getattr(e,"summary","") or ""
            if hasattr(e,"content"): dh=e.content[0].get("value",dh)
            desc=_html(dh); s1,s2,sc=_salary(desc); loc=_loc(getattr(e,"location",default_loc) or default_loc)
            j=Job(); j.title=title; j.company=company; j.url=link; j.apply_url=link
            j.description=desc[:2000]; j.location=loc; j.tags=_tags(f"{title} {desc}")
            j.is_remote=_remote(title,loc,desc); j.salary_min=s1; j.salary_max=s2; j.salary_currency=sc
            j.posted_at=_date(getattr(e,"published",None) or getattr(e,"updated",None) or "")
            j.source=name; j.job_type=_jtype(f"{title} {desc}"); j.experience_level=_exp(f"{title} {desc}")
            j.apply_instructions=f"Apply at: {link}"; results.append(j)
        if results or VERBOSE: log.info(f"  [{name}] {len(results)} jobs")
        return results
    except Exception as ex:
        log.warning(f"  [{name}] {ex}"); return []

# ── RSS sources (only confirmed-working feeds) ────────────────────────────────
RSS_SOURCES=[
    # WeWorkRemotely — most reliable remote board
    {"url":"https://weworkremotely.com/remote-jobs.rss","n":"wwr","split":":"},
    {"url":"https://weworkremotely.com/categories/remote-programming-jobs.rss","n":"wwr-dev","split":":"},
    {"url":"https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss","n":"wwr-devops","split":":"},
    {"url":"https://weworkremotely.com/categories/remote-design-jobs.rss","n":"wwr-design","split":":"},
    {"url":"https://weworkremotely.com/categories/remote-product-jobs.rss","n":"wwr-product","split":":"},
    {"url":"https://weworkremotely.com/categories/remote-customer-support-jobs.rss","n":"wwr-support","split":":"},
    {"url":"https://weworkremotely.com/categories/remote-sales-and-marketing-jobs.rss","n":"wwr-sales","split":":"},
    {"url":"https://weworkremotely.com/categories/remote-writing-content-jobs.rss","n":"wwr-writing","split":":"},
    # Remotive
    {"url":"https://remotive.com/remote-jobs/feed","n":"remotive-rss"},
    # HN Who's Hiring
    {"url":"https://hnrss.org/whoishiring","n":"hn-hiring","limit":50},
    # Himalayas
    {"url":"https://himalayas.app/jobs/rss","n":"himalayas-rss","loc":"Remote"},
    # Automattic (fully remote)
    {"url":"https://jobs.automattic.com/feed/","n":"automattic","loc":"Remote"},
    # Dribbble design jobs
    {"url":"https://dribbble.com/jobs.rss","n":"dribbble"},
    # Jobicy
    {"url":"https://jobicy.com/feed/rss2","n":"jobicy-rss"},
    # Indeed remote queries (broad coverage of all job types)
    {"url":"https://www.indeed.com/rss?q=remote+software+engineer&sort=date","n":"indeed-dev","loc":"Remote"},
    {"url":"https://www.indeed.com/rss?q=remote+data+scientist&sort=date","n":"indeed-data","loc":"Remote"},
    {"url":"https://www.indeed.com/rss?q=remote+customer+support&sort=date","n":"indeed-cs","loc":"Remote"},
    {"url":"https://www.indeed.com/rss?q=remote+product+manager&sort=date","n":"indeed-pm","loc":"Remote"},
    {"url":"https://www.indeed.com/rss?q=remote+marketing&sort=date","n":"indeed-mkt","loc":"Remote"},
    {"url":"https://www.indeed.com/rss?q=remote+finance+analyst&sort=date","n":"indeed-fin","loc":"Remote"},
    {"url":"https://www.indeed.com/rss?q=remote+nurse&sort=date","n":"indeed-health","loc":"Remote"},
    {"url":"https://www.indeed.com/rss?q=remote+writer+editor&sort=date","n":"indeed-writing","loc":"Remote"},
    # Greenhouse company ATS boards
    {"url":"https://boards.greenhouse.io/rss/gitlab","n":"gitlab"},
    {"url":"https://boards.greenhouse.io/rss/shopify","n":"shopify"},
    {"url":"https://boards.greenhouse.io/rss/hubspot","n":"hubspot"},
    {"url":"https://boards.greenhouse.io/rss/twilio","n":"twilio"},
    {"url":"https://boards.greenhouse.io/rss/datadog","n":"datadog"},
    {"url":"https://boards.greenhouse.io/rss/zendesk","n":"zendesk"},
    {"url":"https://boards.greenhouse.io/rss/stripe","n":"stripe"},
    {"url":"https://boards.greenhouse.io/rss/figma","n":"figma"},
    {"url":"https://boards.greenhouse.io/rss/notion","n":"notion"},
    # Lever ATS boards
    {"url":"https://jobs.lever.co/zapier/rss","n":"zapier"},
    {"url":"https://jobs.lever.co/linear/rss","n":"linear"},
    {"url":"https://jobs.lever.co/supabase/rss","n":"supabase"},
    {"url":"https://jobs.lever.co/airtable/rss","n":"airtable"},
]

# ── API / HTML scrapers ────────────────────────────────────────────────────────

def _remoteok()->List[Job]:
    try:
        data=_get("https://remoteok.com/api").json(); results=[]
        for d in data[1:]:
            if not d.get("position") or not d.get("url"): continue
            desc=_html(d.get("description","")); s1,s2,sc=_salary(d.get("salary",""))
            j=Job(); j.title=d["position"]; j.company=d.get("company","Unknown")
            j.url=f"https://remoteok.com{d['url']}"; j.apply_url=d.get("apply_url") or j.url
            j.description=desc[:2000]; j.location=_loc(d.get("location","Remote"))
            j.tags=(d.get("tags") or _tags(j.title))[:12]; j.salary_min=s1; j.salary_max=s2; j.salary_currency=sc
            j.posted_at=datetime.fromtimestamp(d.get("date",time.time()),tz=timezone.utc).isoformat()
            j.source="remoteok"; j.is_remote=True; j.job_type=_jtype(f"{j.title} {desc}")
            j.experience_level=_exp(f"{j.title} {desc}"); j.apply_instructions=f"Apply at: {j.apply_url}"
            results.append(j)
        log.info(f"  [remoteok] {len(results)} jobs"); return results
    except Exception as e: log.warning(f"  [remoteok] {e}"); return []

def _remotive()->List[Job]:
    try:
        data=_get("https://remotive.com/api/remote-jobs?limit=150").json(); results=[]
        for d in data.get("jobs",[]):
            desc=_html(d.get("description","")); s1,s2,sc=_salary(d.get("salary",""))
            j=Job(); j.title=d.get("title","Unknown"); j.company=d.get("company_name","Unknown")
            j.url=d.get("url",""); j.apply_url=j.url; j.description=desc[:2000]
            j.location=_loc(d.get("candidate_required_location","Remote"))
            j.tags=(d.get("tags") or [])[:12]; j.salary_min=s1; j.salary_max=s2; j.salary_currency=sc
            j.posted_at=_date(d.get("publication_date","")); j.source="remotive"; j.is_remote=True
            j.job_type=d.get("job_type",_jtype(j.title)); j.experience_level=_exp(f"{j.title} {desc}")
            j.apply_instructions=f"Apply at: {j.url}"; results.append(j)
        log.info(f"  [remotive] {len(results)} jobs"); return results
    except Exception as e: log.warning(f"  [remotive] {e}"); return []

def _arbeitnow()->List[Job]:
    try:
        data=_get("https://www.arbeitnow.com/api/job-board-api").json(); results=[]
        for d in data.get("data",[])[:100]:
            desc=_html(d.get("description","")); s1,s2,_=_salary(d.get("salary",""))
            j=Job(); j.title=d.get("title","Unknown"); j.company=d.get("company_name","Unknown")
            j.url=d.get("url",""); j.apply_url=j.url; j.description=desc[:2000]
            j.location=_loc(d.get("location","Remote")); j.tags=(d.get("tags") or [])[:12]
            j.is_remote=bool(d.get("remote")) or _remote(j.title,j.location,desc)
            j.salary_min=s1; j.salary_max=s2; j.salary_currency="EUR"
            j.posted_at=_date(d.get("created_at","")); j.source="arbeitnow"
            j.job_type=_jtype(f"{j.title} {desc}"); j.experience_level=_exp(f"{j.title} {desc}")
            j.apply_instructions=f"Apply at: {j.url}"; results.append(j)
        log.info(f"  [arbeitnow] {len(results)} jobs"); return results
    except Exception as e: log.warning(f"  [arbeitnow] {e}"); return []

def _jobicy()->List[Job]:
    try:
        data=_get("https://jobicy.com/api/v2/remote-jobs?count=50&geo=worldwide").json(); results=[]
        for d in data.get("jobs",[]):
            desc=_html(d.get("jobDescription",""))
            j=Job(); j.title=d.get("jobTitle","Unknown"); j.company=d.get("companyName","Unknown")
            j.url=d.get("url",""); j.apply_url=j.url; j.description=desc[:2000]
            j.location=_loc(d.get("jobGeo","Remote"))
            j.tags=((d.get("jobIndustry") or [])+(d.get("jobType") or []))[:12]
            j.salary_min=d.get("annualSalaryMin"); j.salary_max=d.get("annualSalaryMax")
            j.salary_currency=d.get("salaryCurrency","USD"); j.posted_at=_date(d.get("pubDate",""))
            j.source="jobicy"; j.is_remote=True; j.job_type=_jtype(" ".join(d.get("jobType") or []))
            j.experience_level=_exp(f"{j.title} {desc}"); j.apply_instructions=f"Apply at: {j.url}"
            results.append(j)
        log.info(f"  [jobicy] {len(results)} jobs"); return results
    except Exception as e: log.warning(f"  [jobicy] {e}"); return []

def _themuse()->List[Job]:
    try:
        data=_get("https://www.themuse.com/api/public/jobs?page=1&descending=true").json(); results=[]
        for d in data.get("results",[])[:80]:
            loc=(d.get("locations") or [{}])[0].get("name","Remote"); desc=_html(d.get("contents",""))
            j=Job(); j.title=d.get("name","Unknown"); j.company=d.get("company",{}).get("name","Unknown")
            j.url=d.get("refs",{}).get("landing_page",""); j.apply_url=j.url; j.description=desc[:2000]
            j.location=_loc(loc); j.tags=[c.get("name","").lower() for c in d.get("categories",[]) if c.get("name")][:10]
            j.is_remote=_remote(j.title,loc,desc); j.posted_at=_date(d.get("publication_date",""))
            j.source="themuse"; j.job_type=_jtype(f"{j.title} {desc}"); j.experience_level=_exp(f"{j.title} {desc}")
            j.apply_instructions=f"Apply at: {j.url}"; results.append(j)
        log.info(f"  [themuse] {len(results)} jobs"); return results
    except Exception as e: log.warning(f"  [themuse] {e}"); return []

def _himalayas_api()->List[Job]:
    try:
        data=_get("https://himalayas.app/jobs/api?limit=100").json(); results=[]
        for d in data.get("jobs",[]):
            desc=_html(d.get("description","")); s1,s2,sc=_salary(d.get("salary",""))
            j=Job(); j.title=d.get("title","Unknown"); j.company=d.get("companyName","Unknown")
            j.url=d.get("applicationUrl") or d.get("url",""); j.apply_url=j.url; j.description=desc[:2000]
            j.location="Remote"; j.is_remote=True; j.tags=(d.get("skills") or _tags(j.title))[:12]
            j.salary_min=s1 or d.get("salaryMin"); j.salary_max=s2 or d.get("salaryMax"); j.salary_currency=sc
            j.posted_at=_date(d.get("createdAt","")); j.source="himalayas"
            j.job_type=d.get("jobType",_jtype(j.title)); j.experience_level=d.get("seniorityLevel",_exp(j.title))
            j.apply_instructions=f"Apply at Himalayas: {j.url}"; results.append(j)
        log.info(f"  [himalayas] {len(results)} jobs"); return results
    except Exception as e: log.warning(f"  [himalayas] {e}"); return []

def _workingnomads()->List[Job]:
    try:
        data=_get("https://www.workingnomads.com/api/exposed_jobs/?limit=100").json()
        jobs=data if isinstance(data,list) else []; results=[]
        for d in jobs[:100]:
            desc=_html(d.get("description",""))
            j=Job(); j.title=d.get("title","Unknown"); j.company=d.get("company","Unknown")
            j.url=d.get("url",""); j.apply_url=d.get("apply_url",j.url); j.description=desc[:2000]
            j.location=_loc(d.get("location","Remote")); j.is_remote=True; j.tags=_tags(f"{j.title} {desc}")
            j.salary_min,j.salary_max,j.salary_currency=_salary(d.get("salary_range",""))
            j.posted_at=_date(d.get("pub_date","")); j.source="workingnomads"
            j.job_type=_jtype(j.title); j.experience_level=_exp(f"{j.title} {desc}")
            j.apply_instructions=f"Apply at Working Nomads: {j.apply_url}"; results.append(j)
        log.info(f"  [workingnomads] {len(results)} jobs"); return results
    except Exception as e: log.warning(f"  [workingnomads] {e}"); return []

def _linkedin()->List[Job]:
    """LinkedIn guest API — no login, scrapes public job cards across 8 role categories."""
    results=[]
    for kw in ["software engineer","data scientist","product manager","customer success",
               "marketing manager","devops engineer","ux designer","sales representative"]:
        try:
            r=_get("https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search",
                   params={"keywords":kw,"f_WT":"2","start":0,"count":25})
            soup=BeautifulSoup(r.text,"html.parser")
            for card in soup.select("li")[:25]:
                te=card.select_one(".base-search-card__title")
                ce=card.select_one(".base-search-card__subtitle")
                le=card.select_one(".job-search-card__location")
                ae=card.select_one("a.base-card__full-link")
                if not te or not ae: continue
                url=ae.get("href","").split("?")[0]
                if not url: continue
                j=Job(); j.title=te.get_text(strip=True); j.company=ce.get_text(strip=True) if ce else "Unknown"
                j.location=_loc(le.get_text(strip=True) if le else "Remote")
                j.url=url; j.apply_url=url; j.is_remote=True; j.source="linkedin"
                j.tags=_tags(j.title); j.experience_level=_exp(j.title)
                j.apply_instructions=f"Apply via LinkedIn: {url}"; results.append(j)
            time.sleep(0.4)
        except Exception as ex: log.warning(f"  [linkedin/{kw}] {ex}")
    log.info(f"  [linkedin] {len(results)} jobs"); return results

def _idealist()->List[Job]:
    results=[]
    try:
        r=_get("https://www.idealist.org/en/jobs",params={"locationType":"remote"})
        soup=BeautifulSoup(r.text,"html.parser")
        cards=(soup.select("[data-qa='job-card']") or soup.select("[class*='JobCard']") or
               soup.select("article") or soup.select("[data-testid*='job']"))
        for card in cards[:50]:
            te=card.find(["h2","h3"]); ae=card.find("a",href=True)
            ce=card.find(attrs={"data-qa":"org-name"}) or card.find(class_=re.compile("org|company",re.I))
            de=card.find(attrs={"data-qa":"job-description"}) or card.find(class_=re.compile("desc|summary",re.I))
            if not te or not ae: continue
            href=ae["href"]; url=href if href.startswith("http") else f"https://www.idealist.org{href}"
            desc=de.get_text(" ",strip=True)[:2000] if de else ""
            j=Job(); j.title=te.get_text(strip=True); j.company=ce.get_text(strip=True) if ce else "Non-profit"
            j.url=url; j.apply_url=url; j.description=desc; j.location="Remote"; j.is_remote=True
            j.tags=_tags(f"{j.title} {desc}"); j.source="idealist"
            j.salary_min,j.salary_max,j.salary_currency=_salary(desc)
            j.experience_level=_exp(f"{j.title} {desc}"); j.apply_instructions=f"Apply on Idealist: {url}"
            results.append(j)
        log.info(f"  [idealist] {len(results)} jobs")
    except Exception as e: log.warning(f"  [idealist] {e}")
    return results

def _wellfound()->List[Job]:
    try:
        r=_get("https://wellfound.com/jobs"); soup=BeautifulSoup(r.text,"html.parser"); results=[]
        for card in soup.select("[class*='JobListing'],[class*='job-listing']")[:40]:
            te=card.select_one("a[href*='/role/'],a[href*='/jobs/']")
            ce=card.select_one("[class*='company'],[class*='startup']")
            if not te: continue
            href=te.get("href",""); url=href if href.startswith("http") else f"https://wellfound.com{href}"
            j=Job(); j.title=te.get_text(strip=True); j.company=ce.get_text(strip=True) if ce else "Startup"
            j.url=url; j.apply_url=url; j.is_remote=True; j.source="wellfound"
            j.tags=_tags(j.title); j.experience_level=_exp(j.title)
            j.apply_instructions=f"Apply on Wellfound: {url}"; results.append(j)
        log.info(f"  [wellfound] {len(results)} jobs"); return results
    except Exception as e: log.warning(f"  [wellfound] {e}"); return []

def _glassdoor()->List[Job]:
    try:
        r=_get("https://www.glassdoor.com/Job/remote-jobs-SRCH_IL.0,6_IS11047_KO7,13.htm?fromAge=1")
        soup=BeautifulSoup(r.text,"html.parser"); results=[]
        for card in soup.select("[data-test='jobListing'],li[class*='JobCard']")[:40]:
            te=card.select_one("[data-test='job-title'],a[class*='jobTitle']")
            ce=card.select_one("[data-test='employer-name'],[class*='EmployerProfile']")
            ae=card.select_one("a[href]")
            if not te or not ae: continue
            href=ae["href"]; url=href if href.startswith("http") else f"https://www.glassdoor.com{href}"
            j=Job(); j.title=te.get_text(strip=True); j.company=ce.get_text(strip=True) if ce else "Unknown"
            j.url=url; j.apply_url=url; j.is_remote=True; j.source="glassdoor"
            j.tags=_tags(j.title); j.experience_level=_exp(j.title)
            j.apply_instructions=f"Apply on Glassdoor: {url}"; results.append(j)
        log.info(f"  [glassdoor] {len(results)} jobs"); return results
    except Exception as e: log.warning(f"  [glassdoor] {e}"); return []

def _adzuna()->List[Job]:
    if not ADZUNA_APP_ID or not ADZUNA_APP_KEY: return []
    results=[]
    for country,cur in [("us","USD"),("gb","GBP"),("au","AUD"),("ca","CAD")]:
        try:
            data=_get(f"https://api.adzuna.com/v1/api/jobs/{country}/search/1",
                      params={"app_id":ADZUNA_APP_ID,"app_key":ADZUNA_APP_KEY,
                              "results_per_page":50,"where":"remote","content-type":"application/json"}).json()
            for d in data.get("results",[]):
                desc=d.get("description","")
                j=Job(); j.title=d.get("title","Unknown"); j.company=d.get("company",{}).get("display_name","Unknown")
                j.url=d.get("redirect_url",""); j.apply_url=j.url; j.description=desc[:2000]
                j.location=_loc(d.get("location",{}).get("display_name","Remote"))
                j.tags=_tags(f"{j.title} {desc}"); j.is_remote=_remote(j.title,j.location,desc)
                j.salary_min=round(d["salary_min"]) if d.get("salary_min") else None
                j.salary_max=round(d["salary_max"]) if d.get("salary_max") else None
                j.salary_currency=cur; j.posted_at=_date(d.get("created",""))
                j.source=f"adzuna-{country}"; j.job_type=_jtype(f"{j.title} {desc}")
                j.experience_level=_exp(f"{j.title} {desc}"); j.apply_instructions=f"Apply at: {j.url}"
                results.append(j)
        except Exception as ex: log.warning(f"  [adzuna-{country}] {ex}")
    if results: log.info(f"  [adzuna] {len(results)} jobs")
    return results

def _jsearch()->List[Job]:
    if not JSEARCH_KEY: return []
    results=[]
    for q in ["remote software engineer","remote data scientist","remote product manager",
               "remote customer support","remote marketing manager","remote finance analyst"]:
        try:
            data=_get("https://jsearch.p.rapidapi.com/search",
                      params={"query":q,"num_pages":"2","date_posted":"today"},
                      headers={"X-RapidAPI-Key":JSEARCH_KEY,"X-RapidAPI-Host":"jsearch.p.rapidapi.com"}).json()
            for d in data.get("data",[]):
                desc=d.get("job_description",""); city=d.get("job_city",""); country=d.get("job_country","")
                j=Job(); j.title=d.get("job_title","Unknown"); j.company=d.get("employer_name","Unknown")
                j.url=d.get("job_apply_link",""); j.apply_url=j.url; j.description=desc[:2000]
                j.location=_loc(f"{city}, {country}" if city else "Remote")
                j.tags=_tags(f"{j.title} {desc}"); j.is_remote=bool(d.get("job_is_remote")) or _remote(j.title,j.location,desc)
                j.salary_min=d.get("job_min_salary"); j.salary_max=d.get("job_max_salary")
                j.salary_currency=d.get("job_salary_currency","USD")
                ts=d.get("job_posted_at_timestamp")
                j.posted_at=datetime.fromtimestamp(ts,tz=timezone.utc).isoformat() if ts else _now()
                pub=(d.get("job_publisher") or "").lower().replace(" ","-")
                j.source=f"jsearch-{pub}" if pub else "jsearch"
                j.job_type=(d.get("job_employment_type") or _jtype(j.title)).lower()
                j.experience_level=_exp(f"{j.title} {desc}")
                reqs=(d.get("job_required_qualifications") or {}).get("items",[])[:3]
                j.apply_instructions=f"Apply at: {j.apply_url}. "+(" Req: "+"; ".join(reqs) if reqs else "")
                results.append(j)
            time.sleep(0.2)
        except Exception as ex: log.warning(f"  [jsearch/{q}] {ex}")
    if results: log.info(f"  [jsearch] {len(results)} jobs")
    return results

def _reed()->List[Job]:
    if not REED_KEY: return []
    try:
        data=_get("https://www.reed.co.uk/api/1.0/search",
                  params={"keywords":"remote","locationName":"Remote","resultsToTake":100},
                  auth=(REED_KEY,"")).json()
        results=[]
        for d in data.get("results",[]):
            desc=d.get("jobDescription","")
            j=Job(); j.title=d.get("jobTitle","Unknown"); j.company=d.get("employerName","Unknown")
            j.url=d.get("jobUrl",""); j.apply_url=j.url; j.description=desc[:2000]
            j.location=_loc(d.get("locationName","Remote")); j.is_remote=True
            j.tags=_tags(f"{j.title} {desc}"); j.salary_min=d.get("minimumSalary"); j.salary_max=d.get("maximumSalary")
            j.salary_currency="GBP"; j.posted_at=_date(d.get("date",""))
            j.source="reed"; j.job_type="part-time" if d.get("partTime") else "full-time"
            j.experience_level=_exp(f"{j.title} {desc}"); j.apply_instructions=f"Apply at Reed: {j.url}"
            results.append(j)
        log.info(f"  [reed] {len(results)} jobs"); return results
    except Exception as e: log.warning(f"  [reed] {e}"); return []

API_SCRAPERS=[
    _remoteok, _remotive, _himalayas_api, _arbeitnow, _jobicy, _themuse, _workingnomads,
    _linkedin, _idealist, _wellfound, _glassdoor,
    _adzuna, _jsearch, _reed,
]

# ── Orchestrator (fully parallel) ────────────────────────────────────────────
def _in_window(dt:str)->bool:
    try:
        cutoff=datetime.now(timezone.utc)-timedelta(hours=LOOKBACK_HOURS)
        d=datetime.fromisoformat(dt.replace("Z","+00:00"))
        if d.tzinfo is None: d=d.replace(tzinfo=timezone.utc)
        return d>=cutoff
    except: return True

def run_scrape():
    t0=time.time(); n=len(RSS_SOURCES)+len(API_SCRAPERS)
    log.info(f"── Scrape start ── {n} sources, {MAX_WORKERS} parallel workers")
    collected=[]
    def _do_rss(src): return _rss(src["url"],src["n"],split=src.get("split"),default_loc=src.get("loc","Remote"),limit=src.get("limit",40))
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs={}
        for s in RSS_SOURCES: futs[pool.submit(_do_rss,s)]=s["n"]
        for fn in API_SCRAPERS: futs[pool.submit(fn)]=fn.__name__
        for fut in as_completed(futs,timeout=120):
            try: collected.extend(fut.result(timeout=2))
            except Exception as ex: log.warning(f"  [{futs[fut]}] {ex}")
    recent=[j for j in collected if _in_window(j.posted_at)]
    seen=set(); unique=[]
    for j in recent:
        if j.url and j.url not in seen: seen.add(j.url); unique.append(j)
    ins=_save(unique); elapsed=time.time()-t0
    log.info(f"── Done: {len(collected)} raw → {len(recent)} recent → {len(unique)} unique → {ins} new  ({elapsed:.1f}s) ──")

# ── REST API ──────────────────────────────────────────────────────────────────
app=Flask(__name__); CORS(app)

def _q(limit=50,offset=0,source=None,is_remote=None,tags=None,title=None,
        company=None,location=None,salary_min=None,experience_level=None,job_type=None,since_hours=24):
    conn=sqlite3.connect(DB_PATH); conn.row_factory=sqlite3.Row
    cl=["1=1"]; p=[]
    cutoff=(datetime.now(timezone.utc)-timedelta(hours=since_hours)).isoformat()
    cl.append("scraped_at>=?"); p.append(cutoff)
    if source: cl.append("source LIKE ?"); p.append(f"%{source}%")
    if is_remote is not None: cl.append("is_remote=?"); p.append(1 if is_remote else 0)
    if tags:
        for t in tags.split(","): cl.append("tags LIKE ?"); p.append(f"%{t.strip()}%")
    if title: cl.append("title LIKE ?"); p.append(f"%{title}%")
    if company: cl.append("company LIKE ?"); p.append(f"%{company}%")
    if location: cl.append("location LIKE ?"); p.append(f"%{location}%")
    if salary_min: cl.append("(salary_min>=? OR salary_max>=?)"); p.extend([salary_min,salary_min])
    if experience_level: cl.append("experience_level=?"); p.append(experience_level)
    if job_type: cl.append("job_type=?"); p.append(job_type)
    rows=conn.execute(f"SELECT * FROM jobs WHERE {' AND '.join(cl)} ORDER BY scraped_at DESC LIMIT ? OFFSET ?",p+[limit,offset]).fetchall()
    conn.close()
    result=[]
    for row in rows:
        d=dict(row); d["tags"]=json.loads(d.get("tags") or "[]"); d["is_remote"]=bool(d["is_remote"]); result.append(d)
    return result

@app.route("/health")
def health(): return jsonify({"status":"ok","ts":_now()})

@app.route("/jobs")
def get_jobs():
    rr=request.args.get("is_remote"); ir=None
    if rr in ("1","true"): ir=True
    elif rr in ("0","false"): ir=False
    jobs=_q(limit=min(int(request.args.get("limit",50)),200),offset=int(request.args.get("offset",0)),
             source=request.args.get("source"),is_remote=ir,tags=request.args.get("tags"),
             title=request.args.get("title"),company=request.args.get("company"),
             location=request.args.get("location"),
             salary_min=int(request.args.get("salary_min")) if request.args.get("salary_min") else None,
             experience_level=request.args.get("experience"),job_type=request.args.get("job_type"),
             since_hours=int(request.args.get("since_hours",24)))
    return jsonify({"total":len(jobs),"jobs":jobs})

@app.route("/jobs/<job_id>")
def get_job(job_id):
    conn=sqlite3.connect(DB_PATH); conn.row_factory=sqlite3.Row
    row=conn.execute("SELECT * FROM jobs WHERE id=?",(job_id,)).fetchone(); conn.close()
    if not row: return jsonify({"error":"not found"}),404
    d=dict(row); d["tags"]=json.loads(d.get("tags") or "[]"); d["is_remote"]=bool(d["is_remote"])
    return jsonify(d)

@app.route("/jobs/apply/<job_id>")
def apply_info(job_id):
    """AI-agent endpoint — structured application bundle."""
    conn=sqlite3.connect(DB_PATH); conn.row_factory=sqlite3.Row
    row=conn.execute("SELECT * FROM jobs WHERE id=?",(job_id,)).fetchone(); conn.close()
    if not row: return jsonify({"error":"not found"}),404
    d=dict(row); d["tags"]=json.loads(d.get("tags") or "[]")
    desc=d.get("description","")
    reqs=[l.strip().lstrip("-•*").strip() for l in desc.split("\n")
          if re.search(r"require|must|experience|proficient|knowledge",l,re.I) and 10<len(l.strip())<200]
    return jsonify({"id":d["id"],"title":d["title"],"company":d["company"],"apply_url":d["apply_url"],
                    "apply_instructions":d.get("apply_instructions") or f"Apply at: {d['apply_url']}",
                    "source":d["source"],"is_remote":bool(d["is_remote"]),"salary_min":d["salary_min"],
                    "salary_max":d["salary_max"],"salary_currency":d["salary_currency"],
                    "job_type":d.get("job_type","full-time"),"experience_level":d.get("experience_level",""),
                    "location":d["location"],"tags":d["tags"],"requirements_extracted":reqs[:10],
                    "description_preview":desc[:500]})

@app.route("/stats")
def stats():
    conn=sqlite3.connect(DB_PATH)
    total=conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
    last24=conn.execute("SELECT COUNT(*) FROM jobs WHERE scraped_at>=?",
                        ((datetime.now(timezone.utc)-timedelta(hours=24)).isoformat(),)).fetchone()[0]
    by_src=conn.execute("SELECT source,COUNT(*) c FROM jobs GROUP BY source ORDER BY c DESC LIMIT 30").fetchall()
    conn.close()
    return jsonify({"total":total,"new_last_24h":last24,"by_source":[{"source":r[0],"count":r[1]} for r in by_src]})

@app.route("/scrape/trigger",methods=["POST"])
def trigger():
    threading.Thread(target=run_scrape,daemon=True).start()
    return jsonify({"status":"triggered"})

# ── Startup ───────────────────────────────────────────────────────────────────
def start():
    init_db()
    threading.Thread(target=run_scrape,daemon=True).start()
    sched=BackgroundScheduler(timezone="UTC")
    sched.add_job(run_scrape,"interval",hours=SCRAPE_HOURS,id="scraper")
    sched.start()
    log.info(f"Scheduler every {SCRAPE_HOURS}h | API port {API_PORT}")
    app.run(host="0.0.0.0",port=API_PORT,debug=False,use_reloader=False)

if __name__=="__main__":
    start()