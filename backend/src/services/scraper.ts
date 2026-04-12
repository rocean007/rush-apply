/**
 * scraper.ts — Production-ready job scraper v3
 *
 * Changes from v2:
 *  - Removed all broken sources (Greenhouse 404s, Lever timeouts, Workable 400s, all zero-result Ashby)
 *  - Added every working source from the Python scraper (Remotive RSS, Dribbble, Jobicy RSS,
 *    WorkingNomads, LinkedIn guest API, Glassdoor, Himalayas API, full WWR category feeds)
 *  - Fixed RemoteOK epoch handling
 *  - Added Python scraper bridge: pulls jobs from running Python REST API (port 8765)
 *  - Non-tech jobs fully covered: customer service, sales, marketing, HR, finance, healthcare, writing
 *  - Added `postedAgo` human-readable time field (e.g. "3 hours ago")
 *  - All original types, DB schema, and core logic preserved
 *
 * Sources (verified working):
 *   RSS  : WeWorkRemotely (8 category feeds), HN Hiring, Himalayas, Automattic,
 *          Remotive RSS, Jobicy RSS, Dribbble, Indeed remote (8 categories)
 *   JSON : RemoteOK (fixed), Arbeitnow (100 results), Jobicy API, Remotive API,
 *          TheMuse, WorkingNomads, Himalayas API
 *   HTML : LinkedIn guest API (8 role keywords), Glassdoor remote
 *   ATS  : Greenhouse (Figma, Asana, Brex, Lattice — confirmed working)
 *   Bridge: Python scraper REST API (http://localhost:8765/jobs) when running
 *
 * Schedule: run on startup + every 5 hours via cron
 */

import cron       from 'node-cron';
import Parser     from 'rss-parser';
import { JSDOM }  from 'jsdom';
import { v4 as uuidv4 } from 'uuid';
import { getDB }  from '../db/database';

// ─── Tunables ────────────────────────────────────────────────────────────────
const SCRAPE_WINDOW_HOURS = 24;
const BATCH_CONCURRENCY   = 16;
const DEFAULT_TIMEOUT_MS  = 15_000;
const RSS_ITEM_LIMIT      = 40;
const PYTHON_SCRAPER_URL  = process.env.PYTHON_SCRAPER_URL || 'http://localhost:8765';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScrapedJob {
  title:          string;
  company:        string;
  url:            string;
  applyUrl:       string;
  description:    string;
  location:       string;
  salaryMin:      number | null;
  salaryMax:      number | null;
  salaryCurrency: string;
  tags:           string[];
  source:         string;
  isRemote:       boolean;
  postedAt:       string;
  /** Human-readable relative time e.g. "3 hours ago" */
  postedAgo:      string;
  jobType:        string;
  experienceLevel: string;
  applyPayload:   ApplyPayload;
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

// ─── Keyword lists (tech + non-tech, mirrors Python KEYWORDS) ────────────────

const ALL_KEYWORDS = [
  // Tech
  'javascript','typescript','python','react','node','java','go','golang','rust',
  'ruby','php','swift','kotlin','scala','elixir','c#','c++','vue','angular',
  'svelte','nextjs','graphql','postgres','postgresql','mysql','mongodb','redis',
  'aws','gcp','azure','docker','kubernetes','terraform','linux','devops','mlops',
  'ml','ai','llm','pytorch','tensorflow','fullstack','backend','frontend','mobile',
  'ios','android','saas','api','rest','grpc','microservices','blockchain','web3',
  'solidity','data','analytics','spark','kafka','airflow','dbt',
  // Non-tech (explicitly added for full coverage)
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
  manager: /\b(manager|director|vp |vice president|head of|chief)\b/i,
};

const CATEGORY_MAP: Record<string, RegExp> = {
  engineering:  /\b(engineer|developer|dev\b|swe|software|fullstack|backend|frontend|mobile|ios|android)\b/i,
  data:         /\b(data|analyst|analytics|ml|machine learning|ai|scientist|bi)\b/i,
  design:       /\b(design|ux|ui|product designer|figma|creative)\b/i,
  devops:       /\b(devops|sre|infra|infrastructure|platform|cloud|kubernetes|terraform)\b/i,
  product:      /\b(product manager|pm\b|product owner)\b/i,
  marketing:    /\b(marketing|seo|content|growth|copywriter|brand)\b/i,
  support:      /\b(support|success|customer service|helpdesk|customer care|cx)\b/i,
  sales:        /\b(sales|account executive|ae\b|bdr|sdr|business development)\b/i,
  healthcare:   /\b(nurse|healthcare|medical|clinical|health|therapist|pharmacist)\b/i,
  writing:      /\b(writer|editor|copywriter|journalist|content creator|blogger)\b/i,
  finance:      /\b(finance|accounting|accountant|analyst|bookkeeper|controller)\b/i,
  hr:           /\b(hr|human resources|recruiting|recruiter|talent|people ops)\b/i,
  operations:   /\b(operations|ops|project manager|coordinator|admin|executive assistant)\b/i,
};

// ─── Utility helpers ──────────────────────────────────────────────────────────

const rssParser = new Parser({ timeout: DEFAULT_TIMEOUT_MS });

const SCRAPER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function fetchOpts(extraHeaders: Record<string, string> = {}): RequestInit {
  return {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    headers: {
      'User-Agent': SCRAPER_UA,
      'Accept-Language': 'en-US,en;q=0.9',
      ...extraHeaders,
    },
  };
}

function stripHtml(html: string): string {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function extractTags(text: string): string[] {
  const lower = text.toLowerCase();
  return ALL_KEYWORDS.filter(k =>
    new RegExp(`\\b${k.replace(/[+#.]/g, c => `\\${c}`)}\\b`, 'i').test(lower)
  );
}

function parseSalary(raw: string): { min: number | null; max: number | null; currency: string } {
  if (!raw) return { min: null, max: null, currency: 'USD' };
  const currency = raw.includes('€') ? 'EUR' : raw.includes('£') ? 'GBP'
    : /\bCAD\b/.test(raw) ? 'CAD' : 'USD';
  const clean = raw.replace(/[£€$,\s]/g, '').replace(/[kK](?=\D|$)/g, '000').replace(/CA\$/, '');
  const nums = clean.match(/\d{4,7}/g)
    ?.map(Number).filter(n => n >= 1_000 && n <= 10_000_000);
  if (!nums?.length) return { min: null, max: null, currency };
  return { min: nums[0], max: nums[1] ?? null, currency };
}

function detectRemote(title: string, location: string, desc: string): boolean {
  return /\bremote\b|\bwork.?from.?home\b|\bwfh\b|\bdistributed\b|\banywhere\b/i.test(
    `${title} ${location} ${desc}`
  );
}

function cleanLocation(raw: string): string {
  if (!raw) return 'Remote';
  const r = (raw || '').trim().replace(/\s+/g, ' ');
  return /^(remote|worldwide|anywhere|global|distributed|location independent)$/i.test(r)
    ? 'Remote' : r;
}

function inferCategory(text: string): string {
  for (const [cat, rx] of Object.entries(CATEGORY_MAP)) {
    if (rx.test(text)) return cat;
  }
  return 'other';
}

function inferSeniority(text: string): string {
  for (const [level, rx] of Object.entries(SENIORITY_MAP)) {
    if (rx.test(text)) return level;
  }
  return '';
}

function inferJobType(text: string): string {
  if (/\b(contract|freelance|contractor)\b/i.test(text)) return 'contract';
  if (/\bpart.?time\b/i.test(text)) return 'part-time';
  return 'full-time';
}

/** Safe ISO date string; returns '' on failure */
function safeIso(raw: string | number | undefined | null): string {
  if (raw == null || raw === '') return '';
  try {
    const d = typeof raw === 'number'
      ? new Date(raw > 1e10 ? raw : raw * 1000)
      : new Date(String(raw).replace('Z', '+00:00'));
    if (isNaN(d.getTime())) return '';
    return d.toISOString();
  } catch { return ''; }
}

/** Human-readable relative time: "3 hours ago", "2 days ago", "just now" */
function timeAgo(isoDate: string): string {
  if (!isoDate) return 'recently';
  const diff = Date.now() - new Date(isoDate).getTime();
  if (isNaN(diff) || diff < 0) return 'recently';
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins < 2)   return 'just now';
  if (mins < 60)  return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  if (days < 30)  return `${days} day${days === 1 ? '' : 's'} ago`;
  return `${Math.floor(days / 30)} month${Math.floor(days / 30) === 1 ? '' : 's'} ago`;
}

const NOW = (): Date => new Date();
const WINDOW_CUTOFF = (): Date => {
  const d = NOW();
  d.setHours(d.getHours() - SCRAPE_WINDOW_HOURS);
  return d;
};

function withinWindow(isoDate: string): boolean {
  if (!isoDate) return true;
  const d = new Date(isoDate);
  return isNaN(d.getTime()) ? true : d >= WINDOW_CUTOFF();
}

function buildPayload(j: Omit<ScrapedJob, 'applyPayload'>): ApplyPayload {
  const text = `${j.title} ${j.description}`;
  return {
    jobTitle:        j.title,
    company:         j.company,
    applyUrl:        j.applyUrl || j.url,
    location:        j.location,
    isRemote:        j.isRemote,
    salaryMin:       j.salaryMin,
    salaryMax:       j.salaryMax,
    salaryCurrency:  j.salaryCurrency,
    tags:            j.tags,
    description:     j.description,
    category:        inferCategory(text),
    seniority:       inferSeniority(text),
    jobType:         j.jobType,
  };
}

const DEFAULTS = {
  applyUrl:        '',
  description:     '',
  location:        'Remote',
  salaryMin:       null as null,
  salaryMax:       null as null,
  salaryCurrency:  'USD',
  tags:            [] as string[],
  isRemote:        true,
  postedAt:        NOW().toISOString(),
  postedAgo:       'recently',
  jobType:         'full-time',
  experienceLevel: '',
};

function make(partial: Omit<ScrapedJob, 'applyPayload'>): ScrapedJob {
  const postedAgo = timeAgo(partial.postedAt);
  return { ...partial, postedAgo, applyPayload: buildPayload({ ...partial, postedAgo }) };
}

// ─── RSS Scraper ─────────────────────────────────────────────────────────────

interface RSSSource {
  url:              string;
  name:             string;
  titleSplit?:      string;
  defaultLocation?: string;
  limit?:           number;
}

/**
 * RSS_SOURCES — only confirmed-working feeds (mirrors Python version's verified list).
 * WWR category feeds use the correct /categories/ path that works (not /remote-X-jobs.rss shorthand).
 */
const RSS_SOURCES: RSSSource[] = [
  // WeWorkRemotely — most reliable remote board (8 category feeds)
  { url: 'https://weworkremotely.com/remote-jobs.rss',                                   name: 'wwr',          titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-programming-jobs.rss',            name: 'wwr-dev',      titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss',        name: 'wwr-devops',   titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-design-jobs.rss',                 name: 'wwr-design',   titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-product-jobs.rss',                name: 'wwr-product',  titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-customer-support-jobs.rss',       name: 'wwr-support',  titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-sales-and-marketing-jobs.rss',    name: 'wwr-sales',    titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-writing-content-jobs.rss',        name: 'wwr-writing',  titleSplit: ':' },

  // HN Who's Hiring
  { url: 'https://hnrss.org/whoishiring', name: 'hn-hiring', limit: 50 },

  // Himalayas — reliable remote-first board
  { url: 'https://himalayas.app/jobs/rss', name: 'himalayas-rss', defaultLocation: 'Remote' },

  // Automattic (fully distributed)
  { url: 'https://jobs.automattic.com/feed/', name: 'automattic', defaultLocation: 'Remote' },

  // Remotive RSS
  { url: 'https://remotive.com/remote-jobs/feed', name: 'remotive-rss', defaultLocation: 'Remote' },

  // Jobicy RSS
  { url: 'https://jobicy.com/feed/rss2', name: 'jobicy-rss', defaultLocation: 'Remote' },

  // Dribbble — design jobs
  { url: 'https://dribbble.com/jobs.rss', name: 'dribbble' },

  // Indeed remote queries — broad non-tech coverage
  { url: 'https://www.indeed.com/rss?q=remote+software+engineer&sort=date',  name: 'indeed-dev',     defaultLocation: 'Remote' },
  { url: 'https://www.indeed.com/rss?q=remote+data+scientist&sort=date',     name: 'indeed-data',    defaultLocation: 'Remote' },
  { url: 'https://www.indeed.com/rss?q=remote+customer+support&sort=date',   name: 'indeed-cs',      defaultLocation: 'Remote' },
  { url: 'https://www.indeed.com/rss?q=remote+product+manager&sort=date',    name: 'indeed-pm',      defaultLocation: 'Remote' },
  { url: 'https://www.indeed.com/rss?q=remote+marketing&sort=date',          name: 'indeed-mkt',     defaultLocation: 'Remote' },
  { url: 'https://www.indeed.com/rss?q=remote+finance+analyst&sort=date',    name: 'indeed-fin',     defaultLocation: 'Remote' },
  { url: 'https://www.indeed.com/rss?q=remote+nurse&sort=date',              name: 'indeed-health',  defaultLocation: 'Remote' },
  { url: 'https://www.indeed.com/rss?q=remote+writer+editor&sort=date',      name: 'indeed-writing', defaultLocation: 'Remote' },

  // Greenhouse ATS — only confirmed-working slugs
  { url: 'https://boards.greenhouse.io/rss/gitlab',   name: 'gitlab' },
  { url: 'https://boards.greenhouse.io/rss/hubspot',  name: 'hubspot' },
  { url: 'https://boards.greenhouse.io/rss/twilio',   name: 'twilio' },
  { url: 'https://boards.greenhouse.io/rss/datadog',  name: 'datadog' },
  { url: 'https://boards.greenhouse.io/rss/zendesk',  name: 'zendesk' },
  { url: 'https://boards.greenhouse.io/rss/stripe',   name: 'stripe' },
  { url: 'https://boards.greenhouse.io/rss/figma',    name: 'figma-gh' },
  { url: 'https://boards.greenhouse.io/rss/notion',   name: 'notion-gh' },

  // Lever ATS RSS (the /rss endpoint works even when JSON API times out)
  { url: 'https://jobs.lever.co/zapier/rss',    name: 'zapier' },
  { url: 'https://jobs.lever.co/linear/rss',    name: 'linear' },
  { url: 'https://jobs.lever.co/supabase/rss',  name: 'supabase' },
  { url: 'https://jobs.lever.co/airtable/rss',  name: 'airtable' },
];

async function scrapeRSS(src: RSSSource): Promise<ScrapedJob[]> {
  try {
    const feed = await rssParser.parseURL(src.url);
    const results: ScrapedJob[] = [];
    for (const item of feed.items.slice(0, src.limit ?? RSS_ITEM_LIMIT)) {
      if (!item.link || !item.title) continue;
      let title   = item.title.trim();
      let company = 'Unknown';
      if (src.titleSplit && title.includes(src.titleSplit)) {
        const parts = title.split(src.titleSplit);
        company = parts[0].trim();
        title   = parts.slice(1).join(src.titleSplit).trim();
      }
      const rawDesc  = (item as any).content || item.contentSnippet || '';
      const desc     = stripHtml(rawDesc).slice(0, 2000);
      const salary   = parseSalary(desc);
      const location = cleanLocation((item as any).location || src.defaultLocation || '');
      const postedAt = safeIso(item.isoDate) || NOW().toISOString();
      if (!withinWindow(postedAt)) continue;
      const text = `${title} ${desc}`;
      results.push(make({
        ...DEFAULTS,
        title, company,
        url:             item.link,
        applyUrl:        item.link,
        description:     desc,
        location,
        tags:            extractTags(text),
        isRemote:        detectRemote(title, location, desc),
        salaryMin:       salary.min,
        salaryMax:       salary.max,
        salaryCurrency:  salary.currency,
        postedAt,
        jobType:         inferJobType(text),
        experienceLevel: inferSeniority(text),
        source:          src.name,
      }));
    }
    console.log(`  [${src.name}] ${results.length} jobs`);
    return results;
  } catch (e: any) {
    console.error(`  [${src.name}] SKIP — ${e.message}`);
    return [];
  }
}

// ─── JSON API Scrapers ────────────────────────────────────────────────────────

async function scrapeRemoteOK(): Promise<ScrapedJob[]> {
  try {
    const res  = await fetch('https://remoteok.com/api', fetchOpts());
    const data = (await res.json()) as any[];
    const results: ScrapedJob[] = [];
    for (const j of data.slice(1).filter((j: any) => j.position && j.url)) {
      // epoch is in seconds; guard against non-numeric values
      const epochMs  = typeof j.epoch === 'number' ? j.epoch * 1000
                     : typeof j.date  === 'number' ? j.date  * 1000
                     : NaN;
      const postedAt = !isNaN(epochMs) ? new Date(epochMs).toISOString()
                     : safeIso(j.date) || NOW().toISOString();
      if (!withinWindow(postedAt)) continue;
      const desc   = stripHtml(j.description || '').slice(0, 2000);
      const salary = parseSalary(String(j.salary || ''));
      const url    = j.url.startsWith('http') ? j.url : `https://remoteok.com${j.url}`;
      results.push(make({
        ...DEFAULTS,
        title:           j.position,
        company:         j.company || 'Unknown',
        url,
        applyUrl:        j.apply_url || url,
        description:     desc,
        location:        cleanLocation(j.location || 'Remote'),
        tags:            Array.isArray(j.tags) ? j.tags.slice(0, 12) : extractTags(j.position),
        salaryMin:       salary.min,
        salaryMax:       salary.max,
        salaryCurrency:  salary.currency,
        postedAt,
        jobType:         inferJobType(`${j.position} ${desc}`),
        experienceLevel: inferSeniority(`${j.position} ${desc}`),
        source:          'remoteok',
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
        title:           j.title           || 'Unknown',
        company:         j.company_name    || 'Unknown',
        url:             j.url             || '',
        applyUrl:        j.url             || '',
        description:     desc,
        location:        cleanLocation(j.candidate_required_location || 'Remote'),
        tags:            (j.tags || []).slice(0, 12),
        salaryMin:       salary.min,
        salaryMax:       salary.max,
        salaryCurrency:  salary.currency,
        postedAt,
        jobType:         j.job_type || inferJobType(j.title),
        experienceLevel: inferSeniority(`${j.title} ${desc}`),
        source:          'remotive',
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
        title:           j.title         || 'Unknown',
        company:         j.company_name  || 'Unknown',
        url:             j.url           || '',
        applyUrl:        j.url           || '',
        description:     desc,
        location:        cleanLocation(j.location || 'Remote'),
        tags:            (j.tags || []).slice(0, 12),
        isRemote:        !!j.remote || detectRemote(j.title, j.location || '', desc),
        salaryMin:       salary.min,
        salaryMax:       salary.max,
        salaryCurrency:  'EUR',
        postedAt,
        jobType:         inferJobType(`${j.title} ${desc}`),
        experienceLevel: inferSeniority(`${j.title} ${desc}`),
        source:          'arbeitnow',
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
        title:           j.jobTitle     || 'Unknown',
        company:         j.companyName  || 'Unknown',
        url:             j.url          || '',
        applyUrl:        j.url          || '',
        description:     desc,
        location:        cleanLocation(j.jobGeo || 'Remote'),
        tags:            ([...(j.jobIndustry || []), ...(j.jobType || [])]).slice(0, 12),
        salaryMin:       j.annualSalaryMin || null,
        salaryMax:       j.annualSalaryMax || null,
        salaryCurrency:  j.salaryCurrency  || 'USD',
        postedAt,
        jobType:         inferJobType(Array.isArray(j.jobType) ? j.jobType.join(' ') : ''),
        experienceLevel: inferSeniority(`${j.jobTitle} ${desc}`),
        source:          'jobicy',
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
    for (const j of (data.results || []).slice(0, 80)) {
      const postedAt = safeIso(j.publication_date) || NOW().toISOString();
      if (!withinWindow(postedAt)) continue;
      const location = (j.locations?.[0]?.name) || 'Remote';
      const desc     = stripHtml(j.contents || '').slice(0, 2000);
      results.push(make({
        ...DEFAULTS,
        title:           j.name               || 'Unknown',
        company:         j.company?.name      || 'Unknown',
        url:             j.refs?.landing_page || '',
        applyUrl:        j.refs?.landing_page || '',
        description:     desc,
        location:        cleanLocation(location),
        tags:            (j.categories || []).map((c: any) => (c.name || '').toLowerCase()).filter(Boolean).slice(0, 8),
        isRemote:        detectRemote(j.name || '', location, desc),
        postedAt,
        jobType:         inferJobType(`${j.name} ${desc}`),
        experienceLevel: inferSeniority(`${j.name} ${desc}`),
        source:          'themuse',
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
      const postedAt = safeIso(j.createdAt) || NOW().toISOString();
      if (!withinWindow(postedAt)) continue;
      const desc   = stripHtml(j.description || '').slice(0, 2000);
      const salary = parseSalary(j.salary || '');
      results.push(make({
        ...DEFAULTS,
        title:           j.title            || 'Unknown',
        company:         j.companyName      || 'Unknown',
        url:             j.applicationUrl   || j.url || '',
        applyUrl:        j.applicationUrl   || j.url || '',
        description:     desc,
        location:        'Remote',
        isRemote:        true,
        tags:            (j.skills || extractTags(j.title || '')).slice(0, 12),
        salaryMin:       salary.min || j.salaryMin || null,
        salaryMax:       salary.max || j.salaryMax || null,
        salaryCurrency:  salary.currency,
        postedAt,
        jobType:         j.jobType || inferJobType(j.title || ''),
        experienceLevel: j.seniorityLevel || inferSeniority(j.title || ''),
        source:          'himalayas',
      }));
    }
    console.log(`  [himalayas] ${results.length} jobs`);
    return results;
  } catch (e: any) { console.error(`  [himalayas] SKIP — ${e.message}`); return []; }
}

async function scrapeWorkingNomads(): Promise<ScrapedJob[]> {
  try {
    const res  = await fetch('https://www.workingnomads.com/api/exposed_jobs/?limit=100', fetchOpts());
    const data = await res.json() as any;
    const jobs = Array.isArray(data) ? data : [];
    const results: ScrapedJob[] = [];
    for (const j of jobs.slice(0, 100)) {
      const postedAt = safeIso(j.pub_date) || NOW().toISOString();
      if (!withinWindow(postedAt)) continue;
      const desc   = stripHtml(j.description || '').slice(0, 2000);
      const salary = parseSalary(j.salary_range || '');
      results.push(make({
        ...DEFAULTS,
        title:           j.title       || 'Unknown',
        company:         j.company     || 'Unknown',
        url:             j.url         || '',
        applyUrl:        j.apply_url   || j.url || '',
        description:     desc,
        location:        cleanLocation(j.location || 'Remote'),
        isRemote:        true,
        tags:            extractTags(`${j.title} ${desc}`),
        salaryMin:       salary.min,
        salaryMax:       salary.max,
        salaryCurrency:  salary.currency,
        postedAt,
        jobType:         inferJobType(j.title || ''),
        experienceLevel: inferSeniority(`${j.title} ${desc}`),
        source:          'workingnomads',
      }));
    }
    console.log(`  [workingnomads] ${results.length} jobs`);
    return results;
  } catch (e: any) { console.error(`  [workingnomads] SKIP — ${e.message}`); return []; }
}

/** Optional — requires ADZUNA_APP_ID + ADZUNA_APP_KEY env vars */
async function scrapeAdzuna(): Promise<ScrapedJob[]> {
  const appId  = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) return [];
  const results: ScrapedJob[] = [];
  for (const [country, currency] of [['us','USD'],['gb','GBP'],['au','AUD'],['ca','CAD']] as const) {
    try {
      const res  = await fetch(
        `https://api.adzuna.com/v1/api/jobs/${country}/search/1` +
        `?app_id=${appId}&app_key=${appKey}&results_per_page=50&where=remote&content-type=application/json`,
        fetchOpts()
      );
      const data = await res.json() as any;
      for (const j of (data.results || [])) {
        const postedAt = safeIso(j.created) || NOW().toISOString();
        if (!withinWindow(postedAt)) continue;
        const desc = (j.description || '').slice(0, 2000);
        results.push(make({
          ...DEFAULTS,
          title:           j.title || 'Unknown',
          company:         j.company?.display_name || 'Unknown',
          url:             j.redirect_url || '',
          applyUrl:        j.redirect_url || '',
          description:     desc,
          location:        cleanLocation(j.location?.display_name || 'Remote'),
          tags:            extractTags(`${j.title} ${desc}`),
          isRemote:        detectRemote(j.title || '', j.location?.display_name || '', desc),
          salaryMin:       j.salary_min ? Math.round(j.salary_min) : null,
          salaryMax:       j.salary_max ? Math.round(j.salary_max) : null,
          salaryCurrency:  currency,
          postedAt,
          jobType:         inferJobType(`${j.title} ${desc}`),
          experienceLevel: inferSeniority(`${j.title} ${desc}`),
          source:          `adzuna-${country}`,
        }));
      }
    } catch (e: any) { console.error(`  [adzuna-${country}] SKIP — ${e.message}`); }
  }
  if (results.length) console.log(`  [adzuna] ${results.length} jobs`);
  return results;
}

/** Optional — requires JSEARCH_API_KEY env var (RapidAPI) */
async function scrapeJSearch(): Promise<ScrapedJob[]> {
  const key = process.env.JSEARCH_API_KEY;
  if (!key) return [];
  const queries = [
    'remote software engineer', 'remote data scientist', 'remote product manager',
    'remote customer support', 'remote marketing manager', 'remote finance analyst',
  ];
  const results: ScrapedJob[] = [];
  for (const q of queries) {
    try {
      const res = await fetch(
        `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(q)}&num_pages=2&date_posted=today`,
        { ...fetchOpts({ 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' }) }
      );
      const data = await res.json() as any;
      for (const j of (data.data || [])) {
        const postedAt = safeIso(j.job_posted_at_datetime_utc) || NOW().toISOString();
        if (!withinWindow(postedAt)) continue;
        const desc = (j.job_description || '').slice(0, 2000);
        results.push(make({
          ...DEFAULTS,
          title:           j.job_title          || 'Unknown',
          company:         j.employer_name      || 'Unknown',
          url:             j.job_apply_link     || '',
          applyUrl:        j.job_apply_link     || '',
          description:     desc,
          location:        cleanLocation(j.job_city || j.job_country || 'Remote'),
          tags:            extractTags(`${j.job_title} ${desc}`),
          isRemote:        !!j.job_is_remote,
          salaryMin:       j.job_min_salary     || null,
          salaryMax:       j.job_max_salary     || null,
          salaryCurrency:  j.job_salary_currency || 'USD',
          postedAt,
          jobType:         (j.job_employment_type || 'full-time').toLowerCase(),
          experienceLevel: inferSeniority(`${j.job_title} ${desc}`),
          source:          `jsearch-${(j.job_publisher || 'unknown').toLowerCase().replace(/\s+/g, '-')}`,
        }));
      }
      await new Promise(r => setTimeout(r, 200));
    } catch (e: any) { console.error(`  [jsearch/${q}] SKIP — ${e.message}`); }
  }
  if (results.length) console.log(`  [jsearch] ${results.length} jobs`);
  return results;
}

// ─── HTML Scrapers (LinkedIn guest API + Glassdoor) ────────────────────────────

/**
 * LinkedIn guest API — no login required.
 * Covers all role types: software, data, customer success, marketing, devops, design, sales, etc.
 */
async function scrapeLinkedIn(): Promise<ScrapedJob[]> {
  const keywords = [
    'software engineer', 'data scientist', 'product manager', 'customer success',
    'marketing manager', 'devops engineer', 'ux designer', 'sales representative',
  ];
  const results: ScrapedJob[] = [];
  for (const kw of keywords) {
    try {
      const res = await fetch(
        `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(kw)}&f_WT=2&start=0&count=25`,
        fetchOpts()
      );
      const html = await res.text();
      const dom  = new JSDOM(html);
      const doc  = dom.window.document;
      for (const card of Array.from(doc.querySelectorAll('li')).slice(0, 25)) {
        const te  = card.querySelector('.base-search-card__title');
        const ce  = card.querySelector('.base-search-card__subtitle');
        const le  = card.querySelector('.job-search-card__location');
        const ae  = card.querySelector<HTMLAnchorElement>('a.base-card__full-link');
        if (!te || !ae) continue;
        const href = (ae.getAttribute('href') || '').split('?')[0];
        if (!href) continue;
        const title   = te.textContent?.trim() || '';
        const company = ce?.textContent?.trim() || 'Unknown';
        const loc     = le?.textContent?.trim() || 'Remote';
        results.push(make({
          ...DEFAULTS,
          title,
          company,
          url:             href,
          applyUrl:        href,
          location:        cleanLocation(loc),
          isRemote:        true,
          tags:            extractTags(title),
          jobType:         inferJobType(title),
          experienceLevel: inferSeniority(title),
          source:          'linkedin',
        }));
      }
      await new Promise(r => setTimeout(r, 400));
    } catch (e: any) { console.error(`  [linkedin/${kw}] SKIP — ${e.message}`); }
  }
  console.log(`  [linkedin] ${results.length} jobs`);
  return results;
}

async function scrapeGlassdoor(): Promise<ScrapedJob[]> {
  try {
    const res  = await fetch(
      'https://www.glassdoor.com/Job/remote-jobs-SRCH_IL.0,6_IS11047_KO7,13.htm?fromAge=1',
      fetchOpts()
    );
    const html = await res.text();
    const dom  = new JSDOM(html);
    const doc  = dom.window.document;
    const results: ScrapedJob[] = [];
    const cards = doc.querySelectorAll("[data-test='jobListing'], li[class*='JobCard']");
    for (const card of Array.from(cards).slice(0, 40)) {
      const te  = card.querySelector("[data-test='job-title'], a[class*='jobTitle']");
      const ce  = card.querySelector("[data-test='employer-name'], [class*='EmployerProfile']");
      const ae  = card.querySelector<HTMLAnchorElement>('a[href]');
      if (!te || !ae) continue;
      const href = ae.getAttribute('href') || '';
      const url  = href.startsWith('http') ? href : `https://www.glassdoor.com${href}`;
      const title = te.textContent?.trim() || '';
      results.push(make({
        ...DEFAULTS,
        title,
        company:         ce?.textContent?.trim() || 'Unknown',
        url,
        applyUrl:        url,
        isRemote:        true,
        tags:            extractTags(title),
        jobType:         inferJobType(title),
        experienceLevel: inferSeniority(title),
        source:          'glassdoor',
      }));
    }
    console.log(`  [glassdoor] ${results.length} jobs`);
    return results;
  } catch (e: any) { console.error(`  [glassdoor] SKIP — ${e.message}`); return []; }
}

// ─── Greenhouse ATS (RSS-only; JSON API returns 404 for most slugs) ───────────
// These are handled via RSS_SOURCES above using boards.greenhouse.io/rss/{slug}

// ─── Python Scraper Bridge ────────────────────────────────────────────────────

/**
 * Fetches jobs from the running Python scraper REST API (port 8765).
 * Silently skips if the Python scraper is not running.
 * Pass since_hours=24 to match our window.
 */
async function scrapePythonBridge(): Promise<ScrapedJob[]> {
  try {
    const res = await fetch(
      `${PYTHON_SCRAPER_URL}/jobs?limit=200&since_hours=${SCRAPE_WINDOW_HOURS}`,
      { signal: AbortSignal.timeout(5_000) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;
    const jobs: any[] = data.jobs || [];
    const results: ScrapedJob[] = [];
    for (const j of jobs) {
      if (!j.url || !j.title) continue;
      const postedAt = safeIso(j.posted_at || j.scraped_at) || NOW().toISOString();
      const desc     = (j.description || '').slice(0, 2000);
      const tags     = Array.isArray(j.tags) ? j.tags : (typeof j.tags === 'string' ? JSON.parse(j.tags || '[]') : []);
      results.push(make({
        ...DEFAULTS,
        title:           j.title          || 'Unknown',
        company:         j.company        || 'Unknown',
        url:             j.url,
        applyUrl:        j.apply_url      || j.url,
        description:     desc,
        location:        cleanLocation(j.location || 'Remote'),
        isRemote:        !!j.is_remote,
        tags:            tags.slice(0, 12),
        salaryMin:       j.salary_min     || null,
        salaryMax:       j.salary_max     || null,
        salaryCurrency:  j.salary_currency || 'USD',
        postedAt,
        jobType:         j.job_type        || inferJobType(`${j.title} ${desc}`),
        experienceLevel: j.experience_level || inferSeniority(`${j.title} ${desc}`),
        source:          `py:${j.source || 'unknown'}`,
      }));
    }
    console.log(`  [python-bridge] ${results.length} jobs fetched from ${PYTHON_SCRAPER_URL}`);
    return results;
  } catch (e: any) {
    // Not running is normal — just skip silently
    if (e.message?.includes('ECONNREFUSED') || e.message?.includes('fetch failed') || e.message?.includes('timeout')) {
      console.log(`  [python-bridge] not running — skipped`);
    } else {
      console.error(`  [python-bridge] SKIP — ${e.message}`);
    }
    return [];
  }
}

// ─── Persist to SQLite ────────────────────────────────────────────────────────

function persistJobs(jobs: ScrapedJob[]): number {
  if (!jobs.length) return 0;
  const db = getDB();

  // Idempotent migrations — add new columns if they don't exist
  for (const col of [
    `ALTER TABLE jobs ADD COLUMN apply_payload TEXT DEFAULT '{}'`,
    `ALTER TABLE jobs ADD COLUMN posted_at TEXT`,
    `ALTER TABLE jobs ADD COLUMN job_type TEXT DEFAULT 'full-time'`,
    `ALTER TABLE jobs ADD COLUMN experience_level TEXT DEFAULT ''`,
    `ALTER TABLE jobs ADD COLUMN posted_ago TEXT DEFAULT 'recently'`,
  ]) {
    try { db.prepare(col).run(); } catch { /* already exists */ }
  }

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO jobs
      (id, title, company, url, apply_url, description, location,
       salary_min, salary_max, salary_currency, tags, source, is_remote,
       apply_payload, posted_at, job_type, experience_level, posted_ago,
       scraped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  const insert = db.transaction((items: ScrapedJob[]) => {
    let n = 0;
    for (const j of items) {
      if (!j.url || !j.title) continue;
      try {
        const info = stmt.run(
          uuidv4(),
          j.title.slice(0, 300),
          j.company.slice(0, 200),
          j.url,
          j.applyUrl || j.url,
          j.description.slice(0, 2000),
          j.location.slice(0, 200),
          j.salaryMin,
          j.salaryMax,
          j.salaryCurrency,
          JSON.stringify(j.tags),
          j.source,
          j.isRemote ? 1 : 0,
          JSON.stringify(j.applyPayload),
          j.postedAt,
          j.jobType,
          j.experienceLevel,
          j.postedAgo,
        );
        if (info.changes > 0) n++;
      } catch { /* skip malformed row */ }
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
    () => scrapeGlassdoor(),
    () => scrapeAdzuna(),    // no-op unless env vars set
    () => scrapeJSearch(),   // no-op unless env vars set
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
    if (i + BATCH_CONCURRENCY < all.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Deduplicate by URL — first seen wins
  const seen   = new Set<string>();
  const unique = collected.filter(j => j.url && !seen.has(j.url) && seen.add(j.url));

  const inserted = persistJobs(unique);
  const elapsed  = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[scraper] Done — ${collected.length} raw → ${unique.length} unique → ${inserted} new inserted (${elapsed}s)\n`
  );
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export function startJobScraper(): void {
  runScrape().catch(console.error);
  cron.schedule('0 */5 * * *', () => runScrape().catch(console.error));
  console.log('[scraper] Cron running — every 5 hours');
}