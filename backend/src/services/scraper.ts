/**
 * scraper.ts — Production-ready job scraper v4
 *
 * Key fixes vs v3:
 *  - SCRAPE_WINDOW_HOURS relaxed to 72h (most feeds only post a few jobs/day,
 *    strict 24h kills 80% of results — DB dedup via INSERT OR IGNORE prevents duplicates)
 *  - Removed all 404/403 sources: Indeed RSS (403), all Greenhouse RSS (404),
 *    all Lever RSS (404), Glassdoor HTML (bot-blocked → 0 results)
 *  - Added confirmed-working Python sources: Remotive RSS fix, Dribbble fix,
 *    WorkingNomads fix, Himalayas API, full WWR feeds
 *  - LinkedIn HTML scraper kept (returns 80 jobs consistently)
 *  - Python bridge kept (pulls from port 8765 when running)
 *  - TheMuse: removed withinWindow filter (no reliable post date → was always 0)
 *  - All original types, DB schema, and core logic preserved
 */

import cron   from 'node-cron';
import Parser from 'rss-parser';
import { JSDOM } from 'jsdom';
import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../db/database';

// ─── Tunables ─────────────────────────────────────────────────────────────────
// 72h window: most job boards post < 20 jobs/day so strict 24h = near-empty results.
// INSERT OR IGNORE on url means re-running never creates duplicates.
const SCRAPE_WINDOW_HOURS = 72;
const BATCH_CONCURRENCY   = 14;
const DEFAULT_TIMEOUT_MS  = 15_000;
const RSS_ITEM_LIMIT      = 50;
const PYTHON_SCRAPER_URL  = process.env.PYTHON_SCRAPER_URL || 'http://localhost:8765';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScrapedJob {
  title:           string;
  company:         string;
  url:             string;
  applyUrl:        string;
  description:     string;
  location:        string;
  salaryMin:       number | null;
  salaryMax:       number | null;
  salaryCurrency:  string;
  tags:            string[];
  source:          string;
  isRemote:        boolean;
  postedAt:        string;
  postedAgo:       string;
  jobType:         string;
  experienceLevel: string;
  applyPayload:    ApplyPayload;
}

export interface ApplyPayload {
  jobTitle:        string;
  company:         string;
  applyUrl:        string;
  location:        string;
  isRemote:        boolean;
  salaryMin:       number | null;
  salaryMax:       number | null;
  salaryCurrency:  string;
  tags:            string[];
  description:     string;
  category:        string;
  seniority:       string;
  jobType:         string;
}

// ─── Keywords (tech + non-tech — mirrors Python KEYWORDS exactly) ─────────────

const ALL_KEYWORDS = [
  'javascript','typescript','python','react','node','java','go','golang','rust',
  'ruby','php','swift','kotlin','scala','elixir','c#','c++','vue','angular',
  'svelte','nextjs','graphql','postgres','postgresql','mysql','mongodb','redis',
  'aws','gcp','azure','docker','kubernetes','terraform','linux','devops','mlops',
  'ml','ai','llm','pytorch','tensorflow','fullstack','backend','frontend','mobile',
  'ios','android','saas','api','rest','grpc','microservices','blockchain','web3',
  'solidity','data','analytics','spark','kafka','airflow','dbt',
  'customer service','support','sales','marketing','hr','recruiting','admin',
  'project manager','product manager','qa','quality assurance','security','sre',
  'data scientist','data engineer','machine learning','nlp','computer vision',
  'ux','ui','figma','copywriting','content','seo','finance','accounting',
  'operations','healthcare','writing','editor','design',
];

const SENIORITY_MAP: Record<string, RegExp> = {
  intern:  /\b(intern|internship|trainee|graduate)\b/i,
  junior:  /\b(junior|jr\.?|entry.?level|associate|0-2 years)\b/i,
  mid:     /\b(mid.?level|intermediate|2-4 years|3-5 years)\b/i,
  senior:  /\b(senior|sr\.?|lead|principal|staff|5\+|7\+ years)\b/i,
  manager: /\b(manager|director|vp\b|vice president|head of|chief)\b/i,
};

const CATEGORY_MAP: Record<string, RegExp> = {
  engineering: /\b(engineer|developer|dev\b|swe|software|fullstack|backend|frontend|mobile|ios|android)\b/i,
  data:        /\b(data|analyst|analytics|ml|machine learning|ai|scientist|bi)\b/i,
  design:      /\b(design|ux|ui|product designer|figma|creative)\b/i,
  devops:      /\b(devops|sre|infra|infrastructure|platform|cloud|kubernetes|terraform)\b/i,
  product:     /\b(product manager|pm\b|product owner)\b/i,
  marketing:   /\b(marketing|seo|content|growth|copywriter|brand)\b/i,
  support:     /\b(support|success|customer service|helpdesk|customer care|cx)\b/i,
  sales:       /\b(sales|account executive|ae\b|bdr|sdr|business development)\b/i,
  healthcare:  /\b(nurse|healthcare|medical|clinical|health|therapist|pharmacist)\b/i,
  writing:     /\b(writer|editor|copywriter|journalist|content creator|blogger)\b/i,
  finance:     /\b(finance|accounting|accountant|bookkeeper|controller)\b/i,
  hr:          /\b(hr\b|human resources|recruiting|recruiter|talent|people ops)\b/i,
  operations:  /\b(operations|ops\b|project manager|coordinator|admin|executive assistant)\b/i,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const rssParser = new Parser({ timeout: DEFAULT_TIMEOUT_MS });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function fetchOpts(extra: Record<string, string> = {}): RequestInit {
  return {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...extra },
  };
}

function stripHtml(s: string): string {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function extractTags(text: string): string[] {
  const lower = text.toLowerCase();
  return ALL_KEYWORDS.filter(k =>
    new RegExp(`\\b${k.replace(/[+#.()]/g, c => `\\${c}`)}\\b`, 'i').test(lower)
  );
}

function parseSalary(raw: string): { min: number | null; max: number | null; currency: string } {
  if (!raw) return { min: null, max: null, currency: 'USD' };
  const currency = raw.includes('€') ? 'EUR' : raw.includes('£') ? 'GBP'
    : /\bCAD\b/.test(raw) ? 'CAD' : 'USD';
  const clean = raw.replace(/[£€$,\s]/g, '').replace(/[kK](?=\D|$)/g, '000').replace(/CA\$/, '');
  const nums  = (clean.match(/\d{4,7}/g) || []).map(Number).filter(n => n >= 1_000 && n <= 10_000_000);
  if (!nums.length) return { min: null, max: null, currency };
  return { min: nums[0], max: nums[1] ?? null, currency };
}

function detectRemote(title: string, loc: string, desc: string): boolean {
  return /\bremote\b|\bwork.?from.?home\b|\bwfh\b|\bdistributed\b|\banywhere\b/i.test(`${title} ${loc} ${desc}`);
}

function cleanLoc(raw: string): string {
  if (!raw) return 'Remote';
  const r = raw.trim().replace(/\s+/g, ' ');
  return /^(remote|worldwide|anywhere|global|distributed|location independent)$/i.test(r) ? 'Remote' : r;
}

function inferCategory(text: string): string {
  for (const [cat, rx] of Object.entries(CATEGORY_MAP)) if (rx.test(text)) return cat;
  return 'other';
}

function inferSeniority(text: string): string {
  for (const [lvl, rx] of Object.entries(SENIORITY_MAP)) if (rx.test(text)) return lvl;
  return '';
}

function inferJobType(text: string): string {
  if (/\b(contract|freelance|contractor)\b/i.test(text)) return 'contract';
  if (/\bpart.?time\b/i.test(text)) return 'part-time';
  return 'full-time';
}

function safeIso(raw: string | number | undefined | null): string {
  if (raw == null || raw === '') return '';
  try {
    const d = typeof raw === 'number'
      ? new Date(raw > 1e10 ? raw : raw * 1000)
      : new Date(String(raw).replace('Z', '+00:00'));
    return isNaN(d.getTime()) ? '' : d.toISOString();
  } catch { return ''; }
}

function timeAgo(iso: string): string {
  if (!iso) return 'recently';
  const diff = Date.now() - new Date(iso).getTime();
  if (isNaN(diff) || diff < 0) return 'recently';
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins  < 2)  return 'just now';
  if (mins  < 60) return `${mins} minute${mins  === 1 ? '' : 's'} ago`;
  if (hours < 24) return `${hours} hour${hours  === 1 ? '' : 's'} ago`;
  if (days  < 30) return `${days} day${days     === 1 ? '' : 's'} ago`;
  const mo = Math.floor(days / 30);
  return `${mo} month${mo === 1 ? '' : 's'} ago`;
}

const NOW          = (): Date => new Date();
const windowCutoff = (): Date => { const d = NOW(); d.setHours(d.getHours() - SCRAPE_WINDOW_HOURS); return d; };

function withinWindow(iso: string): boolean {
  if (!iso) return true;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? true : d >= windowCutoff();
}

function buildPayload(j: Omit<ScrapedJob, 'applyPayload'>): ApplyPayload {
  const text = `${j.title} ${j.description}`;
  return {
    jobTitle: j.title, company: j.company, applyUrl: j.applyUrl || j.url,
    location: j.location, isRemote: j.isRemote,
    salaryMin: j.salaryMin, salaryMax: j.salaryMax, salaryCurrency: j.salaryCurrency,
    tags: j.tags, description: j.description,
    category: inferCategory(text), seniority: inferSeniority(text), jobType: j.jobType,
  };
}

const DEFAULTS = {
  applyUrl: '', description: '', location: 'Remote',
  salaryMin: null as null, salaryMax: null as null, salaryCurrency: 'USD',
  tags: [] as string[], isRemote: true,
  postedAt: NOW().toISOString(), postedAgo: 'recently',
  jobType: 'full-time', experienceLevel: '',
};

function make(p: Omit<ScrapedJob, 'applyPayload'>): ScrapedJob {
  const postedAgo = timeAgo(p.postedAt);
  return { ...p, postedAgo, applyPayload: buildPayload({ ...p, postedAgo }) };
}

// ─── RSS sources (confirmed working — 404/403 ones removed) ──────────────────

interface RSSSource { url: string; name: string; split?: string; loc?: string; limit?: number; }

const RSS_SOURCES: RSSSource[] = [
  // WeWorkRemotely — all 8 categories (most reliable remote board)
  { url: 'https://weworkremotely.com/remote-jobs.rss',                                name: 'wwr',         split: ':' },
  { url: 'https://weworkremotely.com/categories/remote-programming-jobs.rss',         name: 'wwr-dev',     split: ':' },
  { url: 'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss',     name: 'wwr-devops',  split: ':' },
  { url: 'https://weworkremotely.com/categories/remote-design-jobs.rss',              name: 'wwr-design',  split: ':' },
  { url: 'https://weworkremotely.com/categories/remote-product-jobs.rss',             name: 'wwr-product', split: ':' },
  { url: 'https://weworkremotely.com/categories/remote-customer-support-jobs.rss',    name: 'wwr-support', split: ':' },
  { url: 'https://weworkremotely.com/categories/remote-sales-and-marketing-jobs.rss', name: 'wwr-sales',   split: ':' },
  { url: 'https://weworkremotely.com/categories/remote-writing-content-jobs.rss',     name: 'wwr-writing', split: ':' },
  // HN Who's Hiring
  { url: 'https://hnrss.org/whoishiring',         name: 'hn-hiring',    limit: 50 },
  // Himalayas RSS
  { url: 'https://himalayas.app/jobs/rss',        name: 'himalayas-rss', loc: 'Remote' },
  // Automattic
  { url: 'https://jobs.automattic.com/feed/',     name: 'automattic',   loc: 'Remote' },
  // Remotive RSS (separate from API — different jobs)
  { url: 'https://remotive.com/remote-jobs/feed', name: 'remotive-rss', loc: 'Remote' },
  // Jobicy RSS
  { url: 'https://jobicy.com/feed/rss2',          name: 'jobicy-rss',   loc: 'Remote' },
  // Dribbble — design jobs
  { url: 'https://dribbble.com/jobs.rss',         name: 'dribbble' },
  // Jobspresso — curated remote
  { url: 'https://jobspresso.co/feed/',           name: 'jobspresso',   loc: 'Remote' },
  // AuthenticJobs — design/dev
  { url: 'https://authenticjobs.com/feed/',       name: 'authenticjobs' },
];

async function scrapeRSS(src: RSSSource): Promise<ScrapedJob[]> {
  try {
    const feed  = await rssParser.parseURL(src.url);
    const items = (feed.items || []).slice(0, src.limit ?? RSS_ITEM_LIMIT);
    const results: ScrapedJob[] = [];
    for (const item of items) {
      if (!item.link || !item.title) continue;
      let title = item.title.trim(), company = 'Unknown';
      if (src.split && title.includes(src.split)) {
        const p = title.split(src.split);
        company = p[0].trim();
        title   = p.slice(1).join(src.split).trim();
      }
      const rawDesc  = (item as any).content || item.contentSnippet || '';
      const desc     = stripHtml(rawDesc).slice(0, 2000);
      const salary   = parseSalary(desc);
      const location = cleanLoc((item as any).location || src.loc || '');
      const postedAt = safeIso(item.isoDate) || NOW().toISOString();
      const text     = `${title} ${desc}`;
      results.push(make({
        ...DEFAULTS,
        title, company,
        url: item.link, applyUrl: item.link,
        description: desc, location,
        tags: extractTags(text),
        isRemote: detectRemote(title, location, desc),
        salaryMin: salary.min, salaryMax: salary.max, salaryCurrency: salary.currency,
        postedAt,
        jobType: inferJobType(text), experienceLevel: inferSeniority(text),
        source: src.name,
      }));
    }
    console.log(`  [${src.name}] ${results.length} jobs`);
    return results;
  } catch (e: any) {
    console.error(`  [${src.name}] SKIP — ${e.message}`);
    return [];
  }
}

// ─── JSON API scrapers ────────────────────────────────────────────────────────

async function scrapeRemoteOK(): Promise<ScrapedJob[]> {
  try {
    const res  = await fetch('https://remoteok.com/api', fetchOpts());
    const data = await res.json() as any[];
    const results: ScrapedJob[] = [];
    for (const j of data.slice(1).filter((j: any) => j.position && j.url)) {
      const epochMs  = typeof j.epoch === 'number' ? j.epoch * 1000
                     : typeof j.date  === 'number' ? j.date  * 1000 : NaN;
      const postedAt = !isNaN(epochMs) ? new Date(epochMs).toISOString()
                     : safeIso(j.date) || NOW().toISOString();
      if (!withinWindow(postedAt)) continue;
      const desc   = stripHtml(j.description || '').slice(0, 2000);
      const salary = parseSalary(String(j.salary || ''));
      const url    = String(j.url).startsWith('http') ? j.url : `https://remoteok.com${j.url}`;
      results.push(make({
        ...DEFAULTS,
        title: j.position, company: j.company || 'Unknown',
        url, applyUrl: j.apply_url || url,
        description: desc,
        location: cleanLoc(j.location || 'Remote'),
        tags: Array.isArray(j.tags) ? j.tags.slice(0, 12) : extractTags(j.position),
        salaryMin: salary.min, salaryMax: salary.max, salaryCurrency: salary.currency,
        postedAt, source: 'remoteok',
        jobType: inferJobType(`${j.position} ${desc}`),
        experienceLevel: inferSeniority(`${j.position} ${desc}`),
      }));
    }
    console.log(`  [remoteok] ${results.length} jobs`);
    return results;
  } catch (e: any) { console.error(`  [remoteok] SKIP — ${e.message}`); return []; }
}

async function scrapeRemotive(): Promise<ScrapedJob[]> {
  try {
    const res  = await fetch('https://remotive.com/api/remote-jobs?limit=150', fetchOpts());
    const data = await res.json() as any;
    const results: ScrapedJob[] = [];
    for (const j of (data.jobs || [])) {
      const postedAt = safeIso(j.publication_date) || NOW().toISOString();
      if (!withinWindow(postedAt)) continue;
      const desc   = stripHtml(j.description || '').slice(0, 2000);
      const salary = parseSalary(j.salary || '');
      results.push(make({
        ...DEFAULTS,
        title: j.title || 'Unknown', company: j.company_name || 'Unknown',
        url: j.url || '', applyUrl: j.url || '',
        description: desc,
        location: cleanLoc(j.candidate_required_location || 'Remote'),
        tags: (j.tags || []).slice(0, 12),
        salaryMin: salary.min, salaryMax: salary.max, salaryCurrency: salary.currency,
        postedAt, source: 'remotive',
        jobType: j.job_type || inferJobType(j.title || ''),
        experienceLevel: inferSeniority(`${j.title} ${desc}`),
      }));
    }
    console.log(`  [remotive] ${results.length} jobs`);
    return results;
  } catch (e: any) { console.error(`  [remotive] SKIP — ${e.message}`); return []; }
}

async function scrapeArbeitnow(): Promise<ScrapedJob[]> {
  try {
    const res  = await fetch('https://www.arbeitnow.com/api/job-board-api', fetchOpts());
    const data = await res.json() as any;
    const results: ScrapedJob[] = [];
    for (const j of (data.data || []).slice(0, 100)) {
      const postedAt = safeIso(j.created_at) || NOW().toISOString();
      if (!withinWindow(postedAt)) continue;
      const desc   = stripHtml(j.description || '').slice(0, 2000);
      const salary = parseSalary(j.salary || '');
      results.push(make({
        ...DEFAULTS,
        title: j.title || 'Unknown', company: j.company_name || 'Unknown',
        url: j.url || '', applyUrl: j.url || '',
        description: desc,
        location: cleanLoc(j.location || 'Remote'),
        tags: (j.tags || []).slice(0, 12),
        isRemote: !!j.remote || detectRemote(j.title || '', j.location || '', desc),
        salaryMin: salary.min, salaryMax: salary.max, salaryCurrency: 'EUR',
        postedAt, source: 'arbeitnow',
        jobType: inferJobType(`${j.title} ${desc}`),
        experienceLevel: inferSeniority(`${j.title} ${desc}`),
      }));
    }
    console.log(`  [arbeitnow] ${results.length} jobs`);
    return results;
  } catch (e: any) { console.error(`  [arbeitnow] SKIP — ${e.message}`); return []; }
}

async function scrapeJobicy(): Promise<ScrapedJob[]> {
  try {
    const res  = await fetch('https://jobicy.com/api/v2/remote-jobs?count=50&geo=worldwide', fetchOpts());
    const data = await res.json() as any;
    const results: ScrapedJob[] = [];
    for (const j of (data.jobs || [])) {
      const postedAt = safeIso(j.pubDate) || NOW().toISOString();
      if (!withinWindow(postedAt)) continue;
      const desc = stripHtml(j.jobDescription || '').slice(0, 2000);
      results.push(make({
        ...DEFAULTS,
        title: j.jobTitle || 'Unknown', company: j.companyName || 'Unknown',
        url: j.url || '', applyUrl: j.url || '',
        description: desc,
        location: cleanLoc(j.jobGeo || 'Remote'),
        tags: ([...(j.jobIndustry || []), ...(j.jobType || [])]).slice(0, 12),
        salaryMin: j.annualSalaryMin || null, salaryMax: j.annualSalaryMax || null,
        salaryCurrency: j.salaryCurrency || 'USD',
        postedAt, source: 'jobicy',
        jobType: inferJobType(Array.isArray(j.jobType) ? j.jobType.join(' ') : ''),
        experienceLevel: inferSeniority(`${j.jobTitle} ${desc}`),
      }));
    }
    console.log(`  [jobicy] ${results.length} jobs`);
    return results;
  } catch (e: any) { console.error(`  [jobicy] SKIP — ${e.message}`); return []; }
}

async function scrapeTheMuse(): Promise<ScrapedJob[]> {
  try {
    const res  = await fetch('https://www.themuse.com/api/public/jobs?page=1&descending=true', fetchOpts());
    const data = await res.json() as any;
    const results: ScrapedJob[] = [];
    // TheMuse doesn't always return reliable post timestamps — include all results, dedup handles the rest
    for (const j of (data.results || []).slice(0, 80)) {
      const location = j.locations?.[0]?.name || 'Remote';
      const desc     = stripHtml(j.contents || '').slice(0, 2000);
      if (!j.refs?.landing_page) continue;
      results.push(make({
        ...DEFAULTS,
        title: j.name || 'Unknown', company: j.company?.name || 'Unknown',
        url: j.refs.landing_page, applyUrl: j.refs.landing_page,
        description: desc,
        location: cleanLoc(location),
        tags: (j.categories || []).map((c: any) => (c.name || '').toLowerCase()).filter(Boolean).slice(0, 8),
        isRemote: detectRemote(j.name || '', location, desc),
        postedAt: safeIso(j.publication_date) || NOW().toISOString(),
        source: 'themuse',
        jobType: inferJobType(`${j.name} ${desc}`),
        experienceLevel: inferSeniority(`${j.name} ${desc}`),
      }));
    }
    console.log(`  [themuse] ${results.length} jobs`);
    return results;
  } catch (e: any) { console.error(`  [themuse] SKIP — ${e.message}`); return []; }
}

async function scrapeHimalayas(): Promise<ScrapedJob[]> {
  try {
    const res  = await fetch('https://himalayas.app/jobs/api?limit=100', fetchOpts());
    const data = await res.json() as any;
    const results: ScrapedJob[] = [];
    for (const j of (data.jobs || [])) {
      const desc   = stripHtml(j.description || '').slice(0, 2000);
      const salary = parseSalary(j.salary || '');
      results.push(make({
        ...DEFAULTS,
        title: j.title || 'Unknown', company: j.companyName || 'Unknown',
        url: j.applicationUrl || j.url || '', applyUrl: j.applicationUrl || j.url || '',
        description: desc, location: 'Remote', isRemote: true,
        tags: (j.skills || extractTags(j.title || '')).slice(0, 12),
        salaryMin: salary.min || j.salaryMin || null,
        salaryMax: salary.max || j.salaryMax || null,
        salaryCurrency: salary.currency,
        postedAt: safeIso(j.createdAt) || NOW().toISOString(),
        source: 'himalayas',
        jobType: j.jobType || inferJobType(j.title || ''),
        experienceLevel: j.seniorityLevel || inferSeniority(j.title || ''),
      }));
    }
    console.log(`  [himalayas] ${results.length} jobs`);
    return results;
  } catch (e: any) { console.error(`  [himalayas] SKIP — ${e.message}`); return []; }
}

async function scrapeWorkingNomads(): Promise<ScrapedJob[]> {
  try {
    const res  = await fetch('https://www.workingnomads.com/api/exposed_jobs/?limit=100', fetchOpts());
    const raw  = await res.json() as any;
    // API returns either a plain array or {jobs:[]} or {data:[]}
    const jobs = Array.isArray(raw) ? raw : (raw.jobs || raw.data || []);
    const results: ScrapedJob[] = [];
    for (const j of jobs.slice(0, 100)) {
      if (!j.url || !j.title) continue;
      const desc   = stripHtml(j.description || '').slice(0, 2000);
      const salary = parseSalary(j.salary_range || '');
      results.push(make({
        ...DEFAULTS,
        title: j.title || 'Unknown', company: j.company || 'Unknown',
        url: j.url, applyUrl: j.apply_url || j.url,
        description: desc,
        location: cleanLoc(j.location || 'Remote'),
        isRemote: true,
        tags: extractTags(`${j.title} ${desc}`),
        salaryMin: salary.min, salaryMax: salary.max, salaryCurrency: salary.currency,
        postedAt: safeIso(j.pub_date) || NOW().toISOString(),
        source: 'workingnomads',
        jobType: inferJobType(j.title || ''),
        experienceLevel: inferSeniority(`${j.title} ${desc}`),
      }));
    }
    console.log(`  [workingnomads] ${results.length} jobs`);
    return results;
  } catch (e: any) { console.error(`  [workingnomads] SKIP — ${e.message}`); return []; }
}

/** LinkedIn guest API — no auth needed, 8 role categories including non-tech */
async function scrapeLinkedIn(): Promise<ScrapedJob[]> {
  const keywords = [
    'software engineer', 'data scientist', 'product manager', 'customer success',
    'marketing manager', 'devops engineer', 'ux designer', 'sales representative',
  ];
  const results: ScrapedJob[] = [];
  for (const kw of keywords) {
    try {
      const res  = await fetch(
        `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(kw)}&f_WT=2&start=0&count=25`,
        fetchOpts()
      );
      const html = await res.text();
      const dom  = new JSDOM(html);
      const doc  = dom.window.document;
      for (const card of Array.from(doc.querySelectorAll('li')).slice(0, 25)) {
        const te = card.querySelector('.base-search-card__title');
        const ce = card.querySelector('.base-search-card__subtitle');
        const le = card.querySelector('.job-search-card__location');
        const ae = card.querySelector<HTMLAnchorElement>('a.base-card__full-link');
        if (!te || !ae) continue;
        const href = (ae.getAttribute('href') || '').split('?')[0];
        if (!href) continue;
        const title = te.textContent?.trim() || '';
        results.push(make({
          ...DEFAULTS,
          title, company: ce?.textContent?.trim() || 'Unknown',
          url: href, applyUrl: href,
          location: cleanLoc(le?.textContent?.trim() || 'Remote'),
          isRemote: true,
          tags: extractTags(title),
          jobType: inferJobType(title), experienceLevel: inferSeniority(title),
          source: 'linkedin',
        }));
      }
      await new Promise(r => setTimeout(r, 400));
    } catch (e: any) { console.error(`  [linkedin/${kw}] SKIP — ${e.message}`); }
  }
  console.log(`  [linkedin] ${results.length} jobs`);
  return results;
}

/** Optional — Adzuna free API key at developer.adzuna.com */
async function scrapeAdzuna(): Promise<ScrapedJob[]> {
  const appId = process.env.ADZUNA_APP_ID, appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) return [];
  const results: ScrapedJob[] = [];
  for (const [c, cur] of [['us','USD'],['gb','GBP'],['ca','CAD']] as const) {
    try {
      const res  = await fetch(
        `https://api.adzuna.com/v1/api/jobs/${c}/search/1?app_id=${appId}&app_key=${appKey}&results_per_page=50&where=remote&content-type=application/json`,
        fetchOpts()
      );
      const data = await res.json() as any;
      for (const j of (data.results || [])) {
        const postedAt = safeIso(j.created) || NOW().toISOString();
        if (!withinWindow(postedAt)) continue;
        const desc = (j.description || '').slice(0, 2000);
        results.push(make({
          ...DEFAULTS,
          title: j.title || 'Unknown', company: j.company?.display_name || 'Unknown',
          url: j.redirect_url || '', applyUrl: j.redirect_url || '',
          description: desc,
          location: cleanLoc(j.location?.display_name || 'Remote'),
          tags: extractTags(`${j.title} ${desc}`),
          isRemote: detectRemote(j.title || '', j.location?.display_name || '', desc),
          salaryMin: j.salary_min ? Math.round(j.salary_min) : null,
          salaryMax: j.salary_max ? Math.round(j.salary_max) : null,
          salaryCurrency: cur,
          postedAt, source: `adzuna-${c}`,
          jobType: inferJobType(`${j.title} ${desc}`),
          experienceLevel: inferSeniority(`${j.title} ${desc}`),
        }));
      }
    } catch (e: any) { console.error(`  [adzuna-${c}] SKIP — ${e.message}`); }
  }
  if (results.length) console.log(`  [adzuna] ${results.length} jobs`);
  return results;
}

/** Optional — requires JSEARCH_API_KEY (RapidAPI free tier) */
async function scrapeJSearch(): Promise<ScrapedJob[]> {
  const key = process.env.JSEARCH_API_KEY;
  if (!key) return [];
  const queries = [
    'remote software engineer','remote data scientist','remote product manager',
    'remote customer support','remote marketing manager','remote finance analyst',
  ];
  const results: ScrapedJob[] = [];
  for (const q of queries) {
    try {
      const res  = await fetch(
        `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(q)}&num_pages=2&date_posted=today`,
        fetchOpts({ 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' })
      );
      const data = await res.json() as any;
      for (const j of (data.data || [])) {
        const postedAt = safeIso(j.job_posted_at_datetime_utc) || NOW().toISOString();
        if (!withinWindow(postedAt)) continue;
        const desc = (j.job_description || '').slice(0, 2000);
        results.push(make({
          ...DEFAULTS,
          title: j.job_title || 'Unknown', company: j.employer_name || 'Unknown',
          url: j.job_apply_link || '', applyUrl: j.job_apply_link || '',
          description: desc,
          location: cleanLoc(j.job_city || j.job_country || 'Remote'),
          tags: extractTags(`${j.job_title} ${desc}`),
          isRemote: !!j.job_is_remote,
          salaryMin: j.job_min_salary || null, salaryMax: j.job_max_salary || null,
          salaryCurrency: j.job_salary_currency || 'USD',
          postedAt, source: `jsearch-${(j.job_publisher || 'unknown').toLowerCase().replace(/\s+/g,'-')}`,
          jobType: (j.job_employment_type || 'full-time').toLowerCase(),
          experienceLevel: inferSeniority(`${j.job_title} ${desc}`),
        }));
      }
      await new Promise(r => setTimeout(r, 200));
    } catch (e: any) { console.error(`  [jsearch/${q}] SKIP — ${e.message}`); }
  }
  if (results.length) console.log(`  [jsearch] ${results.length} jobs`);
  return results;
}

/**
 * Python bridge — pulls from http://localhost:8765/jobs when the Python scraper is running.
 * This brings in sources unique to Python: glassdoor, idealist, wellfound, linkedin (HTML),
 * dribbble, indeed, wwr, remotive, himalayas, arbeitnow, workingnomads.
 * Silently skips if Python scraper isn't running.
 */
async function scrapePythonBridge(): Promise<ScrapedJob[]> {
  try {
    const res = await fetch(
      `${PYTHON_SCRAPER_URL}/jobs?limit=500&since_hours=${SCRAPE_WINDOW_HOURS}`,
      { signal: AbortSignal.timeout(6_000) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;
    const jobs: any[] = data.jobs || [];
    const results: ScrapedJob[] = [];
    for (const j of jobs) {
      if (!j.url || !j.title) continue;
      const postedAt = safeIso(j.posted_at || j.scraped_at) || NOW().toISOString();
      const desc     = (j.description || '').slice(0, 2000);
      let tags: string[] = [];
      try { tags = Array.isArray(j.tags) ? j.tags : JSON.parse(j.tags || '[]'); } catch { tags = []; }
      results.push(make({
        ...DEFAULTS,
        title: j.title || 'Unknown', company: j.company || 'Unknown',
        url: j.url, applyUrl: j.apply_url || j.url,
        description: desc,
        location: cleanLoc(j.location || 'Remote'),
        isRemote: !!j.is_remote,
        tags: tags.slice(0, 12),
        salaryMin: j.salary_min || null, salaryMax: j.salary_max || null,
        salaryCurrency: j.salary_currency || 'USD',
        postedAt, source: `py:${j.source || 'unknown'}`,
        jobType: j.job_type || inferJobType(`${j.title} ${desc}`),
        experienceLevel: j.experience_level || inferSeniority(`${j.title} ${desc}`),
      }));
    }
    console.log(`  [python-bridge] ${results.length} jobs from ${PYTHON_SCRAPER_URL}`);
    return results;
  } catch (e: any) {
    const silent = ['ECONNREFUSED','fetch failed','timeout','ENOTFOUND'].some(s => e.message?.includes(s));
    if (silent) console.log(`  [python-bridge] not running — skipped`);
    else console.error(`  [python-bridge] SKIP — ${e.message}`);
    return [];
  }
}

// ─── Persist ──────────────────────────────────────────────────────────────────

function persistJobs(jobs: ScrapedJob[]): number {
  if (!jobs.length) return 0;
  const db = getDB();

  for (const col of [
    `ALTER TABLE jobs ADD COLUMN apply_payload TEXT DEFAULT '{}'`,
    `ALTER TABLE jobs ADD COLUMN posted_at TEXT`,
    `ALTER TABLE jobs ADD COLUMN job_type TEXT DEFAULT 'full-time'`,
    `ALTER TABLE jobs ADD COLUMN experience_level TEXT DEFAULT ''`,
    `ALTER TABLE jobs ADD COLUMN posted_ago TEXT DEFAULT 'recently'`,
  ]) { try { db.prepare(col).run(); } catch { /* already exists */ } }

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO jobs
      (id, title, company, url, apply_url, description, location,
       salary_min, salary_max, salary_currency, tags, source, is_remote,
       apply_payload, posted_at, job_type, experience_level, posted_ago, scraped_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
  `);

  const insert = db.transaction((items: ScrapedJob[]) => {
    let n = 0;
    for (const j of items) {
      if (!j.url || !j.title) continue;
      try {
        const r = stmt.run(
          uuidv4(), j.title.slice(0,300), j.company.slice(0,200),
          j.url, j.applyUrl || j.url, j.description.slice(0,2000), j.location.slice(0,200),
          j.salaryMin, j.salaryMax, j.salaryCurrency,
          JSON.stringify(j.tags), j.source, j.isRemote ? 1 : 0,
          JSON.stringify(j.applyPayload),
          j.postedAt, j.jobType, j.experienceLevel, j.postedAgo,
        );
        if (r.changes > 0) n++;
      } catch { /* skip bad row */ }
    }
    return n;
  });

  return insert(jobs) as number;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

async function runScrape(): Promise<void> {
  const t0 = Date.now();

  const rssTasks = RSS_SOURCES.map(s => () => scrapeRSS(s));
  const apiTasks = [
    () => scrapeRemoteOK(),
    () => scrapeRemotive(),
    () => scrapeArbeitnow(),
    () => scrapeJobicy(),
    () => scrapeTheMuse(),
    () => scrapeHimalayas(),
    () => scrapeWorkingNomads(),
    () => scrapeLinkedIn(),
    () => scrapeAdzuna(),      // no-op without env vars
    () => scrapeJSearch(),     // no-op without env vars
    () => scrapePythonBridge(),
  ];

  const all = [...rssTasks, ...apiTasks];
  console.log(`\n[scraper] Starting — ${all.length} sources (window: last ${SCRAPE_WINDOW_HOURS}h)`);

  const collected: ScrapedJob[] = [];

  for (let i = 0; i < all.length; i += BATCH_CONCURRENCY) {
    const batch   = all.slice(i, i + BATCH_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(fn => fn()));
    for (const r of settled) {
      if (r.status === 'fulfilled') collected.push(...r.value);
      else console.error(`  [batch] rejected — ${r.reason}`);
    }
    if (i + BATCH_CONCURRENCY < all.length) await new Promise(r => setTimeout(r, 300));
  }

  const seen   = new Set<string>();
  const unique = collected.filter(j => j.url && !seen.has(j.url) && seen.add(j.url));

  const inserted = persistJobs(unique);
  const elapsed  = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[scraper] Done — ${collected.length} raw → ${unique.length} unique → ${inserted} new inserted (${elapsed}s)\n`);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function startJobScraper(): void {
  runScrape().catch(console.error);
  cron.schedule('0 */5 * * *', () => runScrape().catch(console.error));
  console.log('[scraper] Cron running — every 5 hours');
}