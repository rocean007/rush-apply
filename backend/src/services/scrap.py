#!/usr/bin/env python3
"""
Job Scraper with BeautifulSoup
Maintains all original logic from TypeScript version
"""

import os
import re
import json
import sqlite3
import time
import requests
from datetime import datetime, timedelta
from typing import List, Dict, Optional, Any, Tuple
from uuid import uuid4
from bs4 import BeautifulSoup
import feedparser
import schedule
import logging

# Configure logging
logging.basicConfig(level=logging.INFO, format='[%(name)s] %(message)s')
logger = logging.getLogger('scraper')

# ─────────────────────────────────────────────────────────────────────────────
# Types (Python dataclasses equivalent)
# ─────────────────────────────────────────────────────────────────────────────

class ScrapedJob:
    def __init__(self):
        self.title: str = ''
        self.company: str = ''
        self.url: str = ''
        self.applyUrl: str = ''
        self.description: str = ''
        self.location: str = ''
        self.salaryMin: Optional[int] = None
        self.salaryMax: Optional[int] = None
        self.salaryCurrency: str = 'USD'
        self.tags: List[str] = []
        self.source: str = ''
        self.isRemote: bool = True
        self.postedAt: str = ''

# ─────────────────────────────────────────────────────────────────────────────
# Helpers (exact same logic as your TypeScript)
# ─────────────────────────────────────────────────────────────────────────────

TECH_KEYWORDS = [
    'javascript', 'typescript', 'python', 'react', 'node', 'java', 'go', 'rust', 'ruby',
    'php', 'swift', 'kotlin', 'scala', 'elixir', 'c#', 'c++', 'vue', 'angular', 'svelte',
    'nextjs', 'graphql', 'postgres', 'mysql', 'mongodb', 'redis', 'aws', 'gcp', 'azure',
    'docker', 'kubernetes', 'terraform', 'linux', 'devops', 'ml', 'ai', 'llm', 'pytorch',
    'tensorflow', 'fullstack', 'backend', 'frontend', 'mobile', 'ios', 'android', 'saas',
    'api', 'rest', 'microservices', 'blockchain', 'web3', 'solidity', 'data', 'analytics',
    'customer service', 'support', 'sales', 'marketing', 'hr', 'recruiting', 'admin',
    'project manager', 'product manager', 'qa', 'quality assurance', 'security'
]

def extract_tags(text: str) -> List[str]:
    """Extract tech keywords from text - same logic as TypeScript"""
    text_lower = text.lower()
    tags = []
    for keyword in TECH_KEYWORDS:
        # Use regex word boundary matching
        pattern = r'\b' + re.escape(keyword) + r'\b'
        if re.search(pattern, text_lower):
            tags.append(keyword)
    return tags

def parse_salary(raw: str) -> Tuple[Optional[int], Optional[int], str]:
    """Parse salary from raw string - same logic as TypeScript"""
    if not raw:
        return (None, None, 'USD')
    
    # Detect currency
    currency = 'USD'
    if '€' in raw:
        currency = 'EUR'
    elif '£' in raw:
        currency = 'GBP'
    elif re.search(r'\bCAD\b', raw):
        currency = 'CAD'
    
    # Clean the string
    clean = re.sub(r'[£€$,\s]', '', raw)
    clean = re.sub(r'[kK]', '000', clean)
    clean = re.sub(r'CA\$', '', clean)
    
    # Extract numbers
    nums = re.findall(r'\d{4,7}', clean)
    nums = [int(n) for n in nums if 1000 <= int(n) <= 10000000]
    
    if not nums:
        return (None, None, currency)
    
    return (nums[0], nums[1] if len(nums) > 1 else None, currency)

def detect_remote(title: str, location: str, desc: str) -> bool:
    """Detect if job is remote - same logic as TypeScript"""
    text = f"{title} {location} {desc}".lower()
    return bool(re.search(r'\bremote\b|\bwork from home\b|\bwfh\b|\bdistributed\b|\banywhere\b', text))

def clean_location(raw: str) -> str:
    """Clean location string - same logic as TypeScript"""
    if not raw:
        return 'Remote'
    cleaned = ' '.join(raw.strip().split())
    if re.match(r'^(remote|worldwide|anywhere|global|distributed)$', cleaned, re.I):
        return 'Remote'
    return cleaned

def get_defaults() -> Dict:
    """Get default job values - same as DEFAULTS in TypeScript"""
    return {
        'applyUrl': '',
        'description': '',
        'location': 'Remote',
        'salaryMin': None,
        'salaryMax': None,
        'salaryCurrency': 'USD',
        'tags': [],
        'isRemote': True,
        'postedAt': datetime.now().isoformat()
    }

# ─────────────────────────────────────────────────────────────────────────────
# Database functions (matching your SQLite schema)
# ─────────────────────────────────────────────────────────────────────────────

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'jobs.db')

def get_db():
    """Get database connection"""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """Initialize database table if not exists"""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            title TEXT,
            company TEXT,
            url TEXT UNIQUE,
            apply_url TEXT,
            description TEXT,
            location TEXT,
            salary_min INTEGER,
            salary_max INTEGER,
            salary_currency TEXT,
            tags TEXT,
            source TEXT,
            is_remote INTEGER,
            scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.commit()
    conn.close()

def persist_jobs(jobs: List[ScrapedJob]) -> int:
    """Persist jobs to database - same logic as TypeScript"""
    if not jobs:
        return 0
    
    conn = get_db()
    cursor = conn.cursor()
    inserted = 0
    
    for job in jobs:
        if not job.url or not job.title:
            continue
        
        try:
            cursor.execute('''
                INSERT OR IGNORE INTO jobs
                (id, title, company, url, apply_url, description, location,
                 salary_min, salary_max, salary_currency, tags, source, is_remote)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                str(uuid4()), job.title, job.company, job.url, job.applyUrl or job.url,
                job.description[:1200], job.location,
                job.salaryMin, job.salaryMax, job.salaryCurrency,
                json.dumps(job.tags), job.source, 1 if job.isRemote else 0
            ))
            if cursor.rowcount > 0:
                inserted += 1
        except Exception as e:
            continue
    
    conn.commit()
    conn.close()
    return inserted

# ─────────────────────────────────────────────────────────────────────────────
# RSS Scraper (matching your TypeScript)
# ─────────────────────────────────────────────────────────────────────────────

def scrape_rss(feed_url: str, source_name: str, title_split: Optional[str] = None, 
               default_location: str = 'Remote', limit: int = 30) -> List[ScrapedJob]:
    """Generic RSS scraper - same logic as TypeScript"""
    results = []
    
    try:
        feed = feedparser.parse(feed_url)
        
        for item in feed.entries[:limit]:
            if not hasattr(item, 'link') or not hasattr(item, 'title'):
                continue
            
            title = item.title
            company = 'Unknown'
            
            if title_split and title_split in item.title:
                parts = item.title.split(title_split)
                company = parts[0].strip()
                title = title_split.join(parts[1:]).strip()
            
            desc = getattr(item, 'summary', '') or getattr(item, 'content', '')
            if isinstance(desc, list) and len(desc) > 0:
                desc = desc[0].get('value', '')
            
            # Clean HTML from description
            desc = re.sub(r'<[^>]+>', '', desc)
            
            salary_min, salary_max, salary_currency = parse_salary(desc)
            location = clean_location(getattr(item, 'location', default_location))
            
            job = ScrapedJob()
            job.title = title
            job.company = company
            job.url = item.link
            job.applyUrl = item.link
            job.description = desc[:1200]
            job.location = location
            job.tags = extract_tags(f"{title} {desc}")
            job.isRemote = detect_remote(title, location, desc)
            job.salaryMin = salary_min
            job.salaryMax = salary_max
            job.salaryCurrency = salary_currency
            job.postedAt = getattr(item, 'published', datetime.now().isoformat())
            job.source = source_name
            
            results.append(job)
        
        logger.info(f"  [{source_name}] {len(results)} jobs")
        return results
    
    except Exception as e:
        logger.error(f"  [{source_name}] failed: {str(e)}")
        return []

# ─────────────────────────────────────────────────────────────────────────────
# LinkedIn Scraper with BeautifulSoup
# ─────────────────────────────────────────────────────────────────────────────

def scrape_linkedin() -> List[ScrapedJob]:
    """Scrape LinkedIn jobs using requests + BeautifulSoup"""
    results = []
    
    try:
        logger.info(f"  [linkedin] Starting scrape...")
        
        # LinkedIn job search URL for remote positions
        url = "https://www.linkedin.com/jobs-guest/api/jobs/search"
        
        params = {
            'keywords': 'remote',
            'location': '',
            'f_WT': '2',  # Remote filter
            'start': 0,
            'count': 50
        }
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
        }
        
        response = requests.get(url, params=params, headers=headers, timeout=15)
        
        if response.status_code == 200:
            data = response.json()
            jobs_data = data.get('data', {}).get('jobPostings', [])
            
            for job_data in jobs_data[:50]:
                try:
                    job_info = job_data.get('jobPosting', {})
                    title = job_info.get('title', 'Unknown')
                    company = job_info.get('companyDetails', {}).get('companyName', 'Unknown')
                    job_url = f"https://www.linkedin.com/jobs/view/{job_info.get('jobPostingId', '')}"
                    description = job_info.get('description', {}).get('text', '')
                    location = job_info.get('formattedLocation', 'Remote')
                    
                    salary_min, salary_max, salary_currency = parse_salary(description)
                    is_remote = detect_remote(title, location, description)
                    
                    job = ScrapedJob()
                    job.title = title
                    job.company = company
                    job.url = job_url
                    job.applyUrl = job_url
                    job.description = description[:1200]
                    job.location = clean_location(location)
                    job.tags = extract_tags(f"{title} {description}")
                    job.isRemote = is_remote or 'remote' in location.lower()
                    job.salaryMin = salary_min
                    job.salaryMax = salary_max
                    job.salaryCurrency = salary_currency
                    job.postedAt = datetime.now().isoformat()
                    job.source = 'linkedin'
                    
                    results.append(job)
                    
                except Exception as e:
                    continue
            
            logger.info(f"  [linkedin] {len(results)} jobs")
        else:
            # Fallback to HTML scraping if API fails
            results = scrape_linkedin_html_fallback()
            
        return results
        
    except Exception as e:
        logger.error(f"  [linkedin] failed: {str(e)}")
        return scrape_linkedin_html_fallback()

def scrape_linkedin_html_fallback() -> List[ScrapedJob]:
    """Fallback HTML scraper for LinkedIn"""
    results = []
    try:
        url = "https://www.linkedin.com/jobs/search/?f_WT=2&keywords=remote"
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
        
        response = requests.get(url, headers=headers, timeout=15)
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # Find job cards
        job_cards = soup.find_all('div', {'class': re.compile('job-card')})[:30]
        
        for card in job_cards:
            try:
                title_elem = card.find('h3', {'class': re.compile('title')})
                company_elem = card.find('h4', {'class': re.compile('company')})
                location_elem = card.find('span', {'class': re.compile('location')})
                link_elem = card.find('a', href=True)
                
                title = title_elem.text.strip() if title_elem else 'Unknown'
                company = company_elem.text.strip() if company_elem else 'Unknown'
                location = location_elem.text.strip() if location_elem else 'Remote'
                job_url = link_elem['href'] if link_elem else ''
                if job_url and not job_url.startswith('http'):
                    job_url = 'https://www.linkedin.com' + job_url
                
                job = ScrapedJob()
                job.title = title
                job.company = company
                job.url = job_url
                job.applyUrl = job_url
                job.location = clean_location(location)
                job.tags = extract_tags(title)
                job.isRemote = detect_remote(title, location, '')
                job.source = 'linkedin-fallback'
                job.postedAt = datetime.now().isoformat()
                
                results.append(job)
                
            except Exception:
                continue
        
        logger.info(f"  [linkedin-fallback] {len(results)} jobs")
        return results
        
    except Exception as e:
        logger.error(f"  [linkedin-fallback] failed: {str(e)}")
        return []

# ─────────────────────────────────────────────────────────────────────────────
# Idealist Scraper with BeautifulSoup
# ─────────────────────────────────────────────────────────────────────────────

def scrape_idealist() -> List[ScrapedJob]:
    """Scrape Idealist jobs using BeautifulSoup"""
    results = []
    
    try:
        logger.info(f"  [idealist] Starting scrape...")
        
        url = "https://www.idealist.org/en/jobs"
        params = {
            'locationType': 'remote',
            'page': 1
        }
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml'
        }
        
        response = requests.get(url, params=params, headers=headers, timeout=15)
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # Find job listings
        job_elements = soup.find_all('div', {'class': re.compile('job-card|job-listing')})[:50]
        
        for element in job_elements:
            try:
                # Extract job details
                title_elem = element.find('h2') or element.find('h3')
                company_elem = element.find('div', {'class': re.compile('org|company')})
                location_elem = element.find('div', {'class': re.compile('location')})
                link_elem = element.find('a', href=True)
                desc_elem = element.find('div', {'class': re.compile('description|summary')})
                
                title = title_elem.text.strip() if title_elem else 'Unknown'
                company = company_elem.text.strip() if company_elem else 'Idealist Org'
                location = location_elem.text.strip() if location_elem else 'Remote'
                job_url = link_elem['href'] if link_elem else ''
                if job_url and not job_url.startswith('http'):
                    job_url = 'https://www.idealist.org' + job_url
                description = desc_elem.text.strip() if desc_elem else ''
                
                salary_min, salary_max, salary_currency = parse_salary(description)
                
                job = ScrapedJob()
                job.title = title
                job.company = company
                job.url = job_url
                job.applyUrl = job_url
                job.description = description[:1200]
                job.location = clean_location(location)
                job.tags = extract_tags(f"{title} {description}")
                job.isRemote = True  # All Idealist remote jobs
                job.salaryMin = salary_min
                job.salaryMax = salary_max
                job.salaryCurrency = salary_currency
                job.postedAt = datetime.now().isoformat()
                job.source = 'idealist'
                
                results.append(job)
                
            except Exception as e:
                continue
        
        logger.info(f"  [idealist] {len(results)} jobs")
        return results
        
    except Exception as e:
        logger.error(f"  [idealist] failed: {str(e)}")
        return []

# ─────────────────────────────────────────────────────────────────────────────
# Existing JSON API Scrapers (ported from TypeScript)
# ─────────────────────────────────────────────────────────────────────────────

def scrape_remoteok() -> List[ScrapedJob]:
    """Scrape RemoteOK API"""
    results = []
    try:
        response = requests.get('https://remoteok.com/api', 
                               headers={'User-Agent': 'Mozilla/5.0 JobBot/2.0'},
                               timeout=12)
        data = response.json()
        
        for job_data in data[1:101]:  # Skip first element (header)
            if not job_data.get('position') or not job_data.get('company'):
                continue
            
            salary_min, salary_max, salary_currency = parse_salary(job_data.get('salary', ''))
            
            job = ScrapedJob()
            job.title = job_data['position']
            job.company = job_data['company']
            job.url = f"https://remoteok.com{job_data['url']}"
            job.applyUrl = job_data.get('apply_url', f"https://remoteok.com{job_data['url']}")
            job.description = re.sub(r'<[^>]+>', '', job_data.get('description', ''))[:1200]
            job.location = clean_location(job_data.get('location', 'Remote'))
            job.tags = job_data.get('tags', [])[:10] if isinstance(job_data.get('tags'), list) else extract_tags(job_data['position'])
            job.salaryMin = salary_min
            job.salaryMax = salary_max
            job.salaryCurrency = salary_currency
            job.postedAt = datetime.fromtimestamp(job_data.get('date', time.time())).isoformat()
            job.source = 'remoteok'
            
            results.append(job)
        
        logger.info(f"  [remoteok] {len(results)} jobs")
        return results
    except Exception as e:
        logger.error(f"  [remoteok] {str(e)}")
        return []

def scrape_arbeitnow() -> List[ScrapedJob]:
    """Scrape Arbeitnow API"""
    results = []
    try:
        response = requests.get('https://www.arbeitnow.com/api/job-board-api', timeout=12)
        data = response.json()
        
        for job_data in data.get('data', [])[:80]:
            salary_min, salary_max, salary_currency = parse_salary(job_data.get('salary', ''))
            
            job = ScrapedJob()
            job.title = job_data.get('title', 'Unknown')
            job.company = job_data.get('company_name', 'Unknown')
            job.url = job_data.get('url', '')
            job.applyUrl = job_data.get('url', '')
            job.description = re.sub(r'<[^>]+>', '', job_data.get('description', ''))[:1200]
            job.location = clean_location(job_data.get('location', 'Remote'))
            job.tags = job_data.get('tags', [])[:10]
            job.isRemote = job_data.get('remote', False) or detect_remote(job.title, job.location, job.description)
            job.salaryMin = salary_min
            job.salaryMax = salary_max
            job.salaryCurrency = 'EUR'
            job.postedAt = job_data.get('created_at', datetime.now().isoformat())
            job.source = 'arbeitnow'
            
            results.append(job)
        
        logger.info(f"  [arbeitnow] {len(results)} jobs")
        return results
    except Exception as e:
        logger.error(f"  [arbeitnow] {str(e)}")
        return []

def scrape_jobicy() -> List[ScrapedJob]:
    """Scrape Jobicy API"""
    results = []
    try:
        response = requests.get('https://jobicy.com/api/v2/remote-jobs?count=50&geo=worldwide', timeout=12)
        data = response.json()
        
        for job_data in data.get('jobs', []):
            job = ScrapedJob()
            job.title = job_data.get('jobTitle', 'Unknown')
            job.company = job_data.get('companyName', 'Unknown')
            job.url = job_data.get('url', '')
            job.applyUrl = job_data.get('url', '')
            job.description = re.sub(r'<[^>]+>', '', job_data.get('jobDescription', ''))[:1200]
            job.location = clean_location(job_data.get('jobGeo', 'Remote'))
            job.tags = (job_data.get('jobIndustry', []) + job_data.get('jobType', []))[:10]
            job.salaryMin = job_data.get('annualSalaryMin')
            job.salaryMax = job_data.get('annualSalaryMax')
            job.salaryCurrency = job_data.get('salaryCurrency', 'USD')
            job.postedAt = job_data.get('pubDate', datetime.now().isoformat())
            job.source = 'jobicy'
            
            results.append(job)
        
        logger.info(f"  [jobicy] {len(results)} jobs")
        return results
    except Exception as e:
        logger.error(f"  [jobicy] {str(e)}")
        return []

def scrape_remotive() -> List[ScrapedJob]:
    """Scrape Remotive API"""
    results = []
    try:
        response = requests.get('https://remotive.com/api/remote-jobs?limit=100', timeout=12)
        data = response.json()
        
        for job_data in data.get('jobs', []):
            salary_min, salary_max, salary_currency = parse_salary(job_data.get('salary', ''))
            
            job = ScrapedJob()
            job.title = job_data.get('title', 'Unknown')
            job.company = job_data.get('company_name', 'Unknown')
            job.url = job_data.get('url', '')
            job.applyUrl = job_data.get('url', '')
            job.description = re.sub(r'<[^>]+>', '', job_data.get('description', ''))[:1200]
            job.location = clean_location(job_data.get('candidate_required_location', 'Remote'))
            job.tags = job_data.get('tags', [])[:10]
            job.salaryMin = salary_min
            job.salaryMax = salary_max
            job.salaryCurrency = salary_currency
            job.postedAt = job_data.get('publication_date', datetime.now().isoformat())
            job.source = 'remotive'
            
            results.append(job)
        
        logger.info(f"  [remotive] {len(results)} jobs")
        return results
    except Exception as e:
        logger.error(f"  [remotive] {str(e)}")
        return []

def scrape_themuse() -> List[ScrapedJob]:
    """Scrape The Muse API"""
    results = []
    try:
        response = requests.get('https://www.themuse.com/api/public/jobs?page=1&descending=true', timeout=12)
        data = response.json()
        
        for job_data in data.get('results', [])[:60]:
            location = job_data.get('locations', [{}])[0].get('name', 'Remote')
            
            job = ScrapedJob()
            job.title = job_data.get('name', 'Unknown')
            job.company = job_data.get('company', {}).get('name', 'Unknown')
            job.url = job_data.get('refs', {}).get('landing_page', '')
            job.applyUrl = job_data.get('refs', {}).get('landing_page', '')
            job.description = re.sub(r'<[^>]+>', '', job_data.get('contents', ''))[:1200]
            job.location = clean_location(location)
            job.tags = [c.get('name', '').lower() for c in job_data.get('categories', []) if c.get('name')][:8]
            job.isRemote = detect_remote(job.title, location, job_data.get('contents', ''))
            job.postedAt = job_data.get('publication_date', datetime.now().isoformat())
            job.source = 'themuse'
            
            results.append(job)
        
        logger.info(f"  [themuse] {len(results)} jobs")
        return results
    except Exception as e:
        logger.error(f"  [themuse] {str(e)}")
        return []

def scrape_adzuna() -> List[ScrapedJob]:
    """Scrape Adzuna API (requires API keys)"""
    app_id = os.environ.get('ADZUNA_APP_ID')
    app_key = os.environ.get('ADZUNA_APP_KEY')
    
    if not app_id or not app_key:
        return []
    
    results = []
    try:
        url = f"https://api.adzuna.com/v1/api/jobs/us/search/1?app_id={app_id}&app_key={app_key}&results_per_page=50&what=developer&content-type=application/json"
        response = requests.get(url, timeout=12)
        data = response.json()
        
        for job_data in data.get('results', []):
            job = ScrapedJob()
            job.title = job_data.get('title', 'Unknown')
            job.company = job_data.get('company', {}).get('display_name', 'Unknown')
            job.url = job_data.get('redirect_url', '')
            job.applyUrl = job_data.get('redirect_url', '')
            job.description = job_data.get('description', '')[:1200]
            job.location = clean_location(job_data.get('location', {}).get('display_name', 'Remote'))
            job.tags = extract_tags(f"{job.title} {job.description}")
            job.isRemote = detect_remote(job.title, job.location, job.description)
            job.salaryMin = round(job_data.get('salary_min', 0)) if job_data.get('salary_min') else None
            job.salaryMax = round(job_data.get('salary_max', 0)) if job_data.get('salary_max') else None
            job.postedAt = job_data.get('created', datetime.now().isoformat())
            job.source = 'adzuna'
            
            results.append(job)
        
        logger.info(f"  [adzuna] {len(results)} jobs")
        return results
    except Exception as e:
        logger.error(f"  [adzuna] {str(e)}")
        return []

# ─────────────────────────────────────────────────────────────────────────────
# RSS Sources (filtered to working ones only)
# ─────────────────────────────────────────────────────────────────────────────

RSS_SOURCES = [
    # We Work Remotely (working categories)
    {'url': 'https://weworkremotely.com/remote-jobs.rss', 'name': 'wwr', 'title_split': ':'},
    {'url': 'https://weworkremotely.com/categories/remote-programming-jobs.rss', 'name': 'wwr-programming', 'title_split': ':'},
    {'url': 'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss', 'name': 'wwr-devops', 'title_split': ':'},
    {'url': 'https://weworkremotely.com/categories/remote-design-jobs.rss', 'name': 'wwr-design', 'title_split': ':'},
    {'url': 'https://weworkremotely.com/categories/remote-product-jobs.rss', 'name': 'wwr-product', 'title_split': ':'},
    {'url': 'https://weworkremotely.com/categories/remote-customer-support-jobs.rss', 'name': 'wwr-support', 'title_split': ':'},
    
    # HN Hiring
    {'url': 'https://hnrss.org/whoishiring', 'name': 'hn-hiring', 'limit': 40},
    
    # Remote boards
    {'url': 'https://jobspresso.co/feed/', 'name': 'jobspresso'},
    {'url': 'https://authenticjobs.com/feed/', 'name': 'authenticjobs'},
    {'url': 'https://himalayas.app/jobs/rss', 'name': 'himalayas', 'default_location': 'Remote'},
    {'url': 'https://jobs.automattic.com/feed/', 'name': 'automattic', 'default_location': 'Remote'},
    {'url': 'https://dribbble.com/jobs.rss', 'name': 'dribbble-jobs'},
    
    # Tech
    {'url': 'https://stackoverflow.com/jobs/feed?location=remote', 'name': 'stackoverflow', 'title_split': ' at '},
    {'url': 'https://smashingmagazine.com/jobs/feed/', 'name': 'smashing-jobs'},
    
    # Greenhouse boards
    {'url': 'https://boards.greenhouse.io/rss/gitlab', 'name': 'gitlab-gh'},
    {'url': 'https://boards.greenhouse.io/rss/cloudflare', 'name': 'cloudflare-gh'},
    {'url': 'https://boards.greenhouse.io/rss/elastic', 'name': 'elastic-gh'},
    
    # Lever boards
    {'url': 'https://jobs.lever.co/netlify/rss', 'name': 'netlify'},
    {'url': 'https://jobs.lever.co/cloudflare/rss', 'name': 'cloudflare-lv'},
    
    # Direct company
    {'url': 'https://about.gitlab.com/jobs.rss', 'name': 'gitlab-direct'},
    
    # Design
    {'url': 'https://designerjobs.co/jobs.rss', 'name': 'designerjobs'},
    
    # Language-specific
    {'url': 'https://rustjobs.dev/feed.xml', 'name': 'rustjobs'},
    {'url': 'https://pythonjobs.github.io/feed.xml', 'name': 'pythonjobs'},
]

# ─────────────────────────────────────────────────────────────────────────────
# Main Orchestrator
# ─────────────────────────────────────────────────────────────────────────────

def run_scrape():
    """Main orchestration function - runs all scrapers"""
    start_time = time.time()
    logger.info(f"\n[scraper] Starting — {len(RSS_SOURCES)} RSS feeds + 7 JSON APIs + LinkedIn + Idealist")
    
    all_jobs = []
    
    # Scrape RSS feeds
    for source in RSS_SOURCES:
        jobs = scrape_rss(
            source['url'], 
            source['name'],
            title_split=source.get('title_split'),
            default_location=source.get('default_location', 'Remote'),
            limit=source.get('limit', 30)
        )
        all_jobs.extend(jobs)
        time.sleep(0.25)  # Small delay between requests
    
    # Scrape JSON APIs
    api_scrapers = [
        scrape_remoteok,
        scrape_arbeitnow,
        scrape_jobicy,
        scrape_remotive,
        scrape_themuse,
        scrape_adzuna,
        scrape_linkedin,
        scrape_idealist,
    ]
    
    for scraper in api_scrapers:
        jobs = scraper()
        all_jobs.extend(jobs)
        time.sleep(0.5)  # Larger delay for APIs
    
    # Filter jobs from last 24 hours only
    one_day_ago = datetime.now() - timedelta(days=1)
    recent_jobs = []
    
    for job in all_jobs:
        try:
            posted_date = datetime.fromisoformat(job.postedAt.replace('Z', '+00:00'))
            if posted_date >= one_day_ago:
                recent_jobs.append(job)
        except:
            # If date parsing fails, include anyway
            recent_jobs.append(job)
    
    # Deduplicate by URL
    seen_urls = set()
    unique_jobs = []
    for job in recent_jobs:
        if job.url and job.url not in seen_urls:
            seen_urls.add(job.url)
            unique_jobs.append(job)
    
    # Save to database
    inserted = persist_jobs(unique_jobs)
    elapsed = time.time() - start_time
    
    logger.info(f"[scraper] Done — {len(unique_jobs)} recent unique, {inserted} new inserted ({elapsed:.1f}s)\n")

def start_scraper():
    """Start the scraper with cron schedule (every 5 hours)"""
    init_db()
    
    # Run once on startup
    run_scrape()
    
    # Schedule every 5 hours
    schedule.every(5).hours.do(run_scrape)
    
    logger.info("[scraper] Cron running every 5 hours")
    
    # Keep running
    while True:
        schedule.run_pending()
        time.sleep(60)

# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    try:
        start_scraper()
    except KeyboardInterrupt:
        logger.info("[scraper] Stopped by user")
    except Exception as e:
        logger.error(f"[scraper] Fatal error: {e}")