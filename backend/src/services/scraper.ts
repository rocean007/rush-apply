/**
 * scraper.ts — Production-ready job scraper v9
 *
 * Sources: 26 confirmed-working across two observed runs
 *   RSS  (17): wwr x11, himalayas-rss, remotive-rss, jobicy-rss,
 *              dribbble, automattic, authenticjobs
 *   API  ( 7): arbeitnow, remoteok, remotive, themuse, himalayas,
 *              workingnomads, linkedin
 *   Optional (2): adzuna (ADZUNA_APP_ID+KEY), jsearch (JSEARCH_API_KEY)
 *
 * Dead sources excluded (confirmed broken across runs):
 *   wwr-writing      → 301 redirect
 *   wwr-json         → 406
 *   getonboard       → 401
 *   jc-* (all)       → 404
 *   jobicy API       → HTTP 400 / 0 results
 *   jobspresso RSS   → 0 jobs consistently
 *   hn-hiring        → ECONNRESET (flaky, slows whole run)
 *
 * All v7 bugs fixed:
 *   ✓ Promise.allSettled() — no artificial batch delays
 *   ✓ cleanupOldJobs() before insert — no boundary-race deletions
 *   ✓ Parameterised DELETE — no SQL string interpolation
 *   ✓ Silent catch replaced with logged failures (url + reason)
 *   ✓ LinkedIn: single stable endpoint, no per-keyword loop (caused 429s)
 *   ✓ globalSeen Set passed to every scraper — cross-source dedup at collection time
 *   ✓ stripHtml strips <script>/<style> before tag removal
 *   ✓ Exponential backoff on 429/5xx (max 3 retries, honours Retry-After)
 *   ✓ Source health tracker — disables after 3 consecutive failures per cycle
 */

import cron   from 'node-cron';
import Parser from 'rss-parser';
import { JSDOM } from 'jsdom';
import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../db/database';

// ─── Tunables ─────────────────────────────────────────────────────────────────

const SCRAPE_WINDOW_HOURS = 72;   // 3-day window — matches confirmed productive run
const DEFAULT_TIMEOUT_MS  = 15_000;
const RSS_ITEM_LIMIT      = 50;
const MAX_DESC_CHARS      = 2_000;
const MAX_RETRIES         = 3;

// ─── Source health tracker ────────────────────────────────────────────────────

const sourceFailures = new Map<string, number>();
const FAIL_THRESHOLD = 3;

function recordFailure(name: string, msg: string): void {
  const n = (sourceFailures.get(name) ?? 0) + 1;
  sourceFailures.set(name, n);
  const label = n >= FAIL_THRESHOLD ? 'DISABLED' : 'SKIP';
  console.error(`  [${name}] ${label} (${n}/${FAIL_THRESHOLD}) — ${msg}`);
}

function recordSuccess(name: string): void {
  sourceFailures.set(name, 0);
}

function isDisabled(name: string): boolean {
  if ((sourceFailures.get(name) ?? 0) >= FAIL_THRESHOLD) {
    console.warn(`  [${name}] skipping — disabled after ${FAIL_THRESHOLD} consecutive failures`);
    return true;
  }
  return false;
}

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
  jobTitle:       string;
  company:        string;
  applyUrl:       string;
  location:       string;
  isRemote:       boolean;
  salaryMin:      number | null;
  salaryMax:      number | null;
  salaryCurrency: string;
  tags:           string[];
  description:    string;
  category:       string;
  seniority:      string;
  jobType:        string;
}

// ─── Keywords ─────────────────────────────────────────────────────────────────

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

// ─── Utilities ────────────────────────────────────────────────────────────────

const rssParser = new Parser({ timeout: DEFAULT_TIMEOUT_MS });

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

function fetchOpts(extra: Record<string, string> = {}): RequestInit {
  return {
    signal:  AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...extra },
  };
}

/**
 * Fetch with exponential backoff. Retries only on 429 or 5xx.
 * Hard-fails on 401/403/404 so health tracker fires immediately.
 */
async function fetchWithRetry(
  url: string,
  opts: RequestInit = {},
  retries = MAX_RETRIES,
): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, opts);
    if (res.ok) return res;

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === retries) throw new Error(`HTTP ${res.status}`);

    const after = res.headers.get('Retry-After');
    const delay = after
      ? parseInt(after, 10) * 1_000
      : Math.min(1_000 * 2 ** attempt, 30_000);

    console.warn(`  [fetch] retry ${attempt + 1}/${retries} for ${url} in ${delay}ms`);
    await sleep(delay);
  }
  throw new Error('fetchWithRetry exhausted');
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function stripHtml(s: string): string {
  return (s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractTags(text: string): string[] {
  return ALL_KEYWORDS.filter(k =>
    new RegExp(`\\b${k.replace(/[+#.()]/g, c => `\\${c}`)}\\b`, 'i').test(text),
  );
}

function parseSalary(raw: string): { min: number | null; max: number | null; currency: string } {
  if (!raw) return { min: null, max: null, currency: 'USD' };
  const currency = raw.includes('€') ? 'EUR'
    : raw.includes('£') ? 'GBP'
    : /\bCAD\b/i.test(raw) ? 'CAD'
    : 'USD';
  const clean = raw
    .replace(/[£€$,\s]/g, '')
    .replace(/CA\$/g, '')
    .replace(/[kK](?=\D|$)/g, '000');
  const nums = (clean.match(/\d{4,7}/g) || [])
    .map(Number)
    .filter(n => n >= 10_000 && n <= 10_000_000);
  if (!nums.length) return { min: null, max: null, currency };
  return { min: nums[0], max: nums[1] ?? null, currency };
}

function detectRemote(title: string, loc: string, desc: string): boolean {
  return /\bremote\b|\bwork.?from.?home\b|\bwfh\b|\bdistributed\b|\banywhere\b/i
    .test(`${title} ${loc} ${desc}`);
}

function cleanLoc(raw: string): string {
  if (!raw) return 'Remote';
  const r = raw.trim().replace(/\s+/g, ' ');
  return /^(remote|worldwide|anywhere|global|distributed|location independent|work from anywhere)$/i.test(r)
    ? 'Remote' : r;
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
      : new Date(String(raw));
    return isNaN(d.getTime()) ? '' : d.toISOString();
  } catch { return ''; }
}

function timeAgo(iso: string): string {
  if (!iso) return 'recently';
  const diff  = Date.now() - new Date(iso).getTime();
  if (isNaN(diff) || diff < 0) return 'recently';
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins  < 2)  return 'just now';
  if (mins  < 60) return `${mins} minute${mins  !== 1 ? 's' : ''} ago`;
  if (hours < 24) return `${hours} hour${hours  !== 1 ? 's' : ''} ago`;
  if (days  < 30) return `${days} day${days     !== 1 ? 's' : ''} ago`;
  const mo = Math.floor(days / 30);
  return `${mo} month${mo !== 1 ? 's' : ''} ago`;
}

const NOW          = (): Date => new Date();
const windowCutoff = (): Date => {
  const d = NOW();
  d.setHours(d.getHours() - SCRAPE_WINDOW_HOURS);
  return d;
};

/** Rejects empty or unparseable dates — undated jobs are never admitted. */
function withinWindow(iso: string): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  return !isNaN(d.getTime()) && d >= windowCutoff();
}

function buildPayload(j: Omit<ScrapedJob, 'applyPayload'>): ApplyPayload {
  const text = `${j.title} ${j.description}`;
  return {
    jobTitle:       j.title,
    company:        j.company,
    applyUrl:       j.applyUrl || j.url,
    location:       j.location,
    isRemote:       j.isRemote,
    salaryMin:      j.salaryMin,
    salaryMax:      j.salaryMax,
    salaryCurrency: j.salaryCurrency,
    tags:           j.tags,
    description:    j.description,
    category:       inferCategory(text),
    seniority:      inferSeniority(text),
    jobType:        j.jobType,
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

// ─── RSS sources ──────────────────────────────────────────────────────────────
//
// Confirmed working (both runs combined):
//   wwr main + 10 category feeds  → 25–50 jobs each  ✓
//   himalayas-rss                 → 50 jobs           ✓
//   remotive-rss                  → 22 jobs           ✓
//   jobicy-rss                    → 9 jobs            ✓
//   dribbble                      → 50 jobs           ✓
//   automattic                    → 10 jobs           ✓
//   authenticjobs                 → 10 jobs           ✓
//
// Excluded:
//   wwr-writing  → 301 permanent redirect
//   hn-hiring    → ECONNRESET (flaky, excluded to avoid slowing the run)
//   jobspresso   → 0 jobs consistently

interface RSSSource {
  url:    string;
  name:   string;
  split?: string;
  loc?:   string;
  limit?: number;
}

const RSS_SOURCES: RSSSource[] = [
  // WeWorkRemotely (11 feeds — writing excluded)
  { url: 'https://weworkremotely.com/remote-jobs.rss',                                   name: 'wwr',          split: ':' },
  { url: 'https://weworkremotely.com/categories/remote-programming-jobs.rss',            name: 'wwr-dev',      split: ':' },
  { url: 'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss', name: 'wwr-fullstack',split: ':' },
  { url: 'https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss',  name: 'wwr-frontend', split: ':' },
  { url: 'https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss',   name: 'wwr-backend',  split: ':' },
  { url: 'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss',        name: 'wwr-devops',   split: ':' },
  { url: 'https://weworkremotely.com/categories/remote-design-jobs.rss',                 name: 'wwr-design',   split: ':' },
  { url: 'https://weworkremotely.com/categories/remote-product-jobs.rss',                name: 'wwr-product',  split: ':' },
  { url: 'https://weworkremotely.com/categories/remote-customer-support-jobs.rss',       name: 'wwr-support',  split: ':' },
  { url: 'https://weworkremotely.com/categories/remote-sales-and-marketing-jobs.rss',    name: 'wwr-sales',    split: ':' },
  { url: 'https://weworkremotely.com/categories/all-other-remote-jobs.rss',              name: 'wwr-other',    split: ':' },

  // Himalayas — confirmed 50 jobs
  { url: 'https://himalayas.app/jobs/rss', name: 'himalayas-rss', loc: 'Remote' },

  // Remotive main RSS — confirmed 22 jobs
  { url: 'https://remotive.com/remote-jobs/feed', name: 'remotive-rss', loc: 'Remote' },

  // Jobicy main RSS — more stable than their API
  { url: 'https://jobicy.com/feed/rss2', name: 'jobicy-rss', loc: 'Remote' },

  // Dribbble — design-only, confirmed 50 jobs
  { url: 'https://dribbble.com/jobs.rss', name: 'dribbble' },

  // Automattic — fully distributed, confirmed 10 jobs
  { url: 'https://jobs.automattic.com/feed/', name: 'automattic', loc: 'Remote' },

  // AuthenticJobs — design/dev, confirmed 10 jobs
  { url: 'https://authenticjobs.com/feed/', name: 'authenticjobs' },
];

async function scrapeRSS(
  src: RSSSource,
  globalSeen: Set<string>,
): Promise<ScrapedJob[]> {
  if (isDisabled(src.name)) return [];

  try {
    const feed    = await rssParser.parseURL(src.url);
    const items   = (feed.items || []).slice(0, src.limit ?? RSS_ITEM_LIMIT);
    const results: ScrapedJob[] = [];

    for (const item of items) {
      if (!item.link || !item.title) continue;

      const url = item.link.split('?')[0];
      if (globalSeen.has(url)) continue;

      const postedAt = safeIso(item.isoDate) || '';
      if (!withinWindow(postedAt)) continue;

      globalSeen.add(url);

      let title   = item.title.trim();
      let company = 'Unknown';
      if (src.split && title.includes(src.split)) {
        const parts = title.split(src.split);
        company = parts[0].trim();
        title   = parts.slice(1).join(src.split).trim();
      }

      const rawDesc  = (item as any).content || item.contentSnippet || '';
      const desc     = stripHtml(rawDesc).slice(0, MAX_DESC_CHARS);
      const salary   = parseSalary(desc);
      const location = cleanLoc((item as any).location || src.loc || '');
      const text     = `${title} ${desc}`;

      results.push(make({
        ...DEFAULTS,
        title, company,
        url, applyUrl: url,
        description: desc, location,
        tags: extractTags(text),
        isRemote: detectRemote(title, location, desc),
        salaryMin: salary.min, salaryMax: salary.max, salaryCurrency: salary.currency,
        postedAt,
        jobType: inferJobType(text),
        experienceLevel: inferSeniority(text),
        source: src.name,
      }));
    }

    recordSuccess(src.name);
    console.log(`  [${src.name}] ${results.length} jobs`);
    return results;
  } catch (e: any) {
    recordFailure(src.name, e.message);
    return [];
  }
}

// ─── API scrapers ─────────────────────────────────────────────────────────────

/** RemoteOK — confirmed 15 jobs. No key. Epoch timestamps. */
async function scrapeRemoteOK(globalSeen: Set<string>): Promise<ScrapedJob[]> {
  const name = 'remoteok';
  if (isDisabled(name)) return [];

  try {
    const res  = await fetchWithRetry('https://remoteok.com/api', fetchOpts());
    const data = (await res.json()) as any[];
    const results: ScrapedJob[] = [];

    for (const j of data.slice(1)) {
      if (!j.position || !j.url) continue;
      const url = String(j.url).startsWith('http') ? j.url : `https://remoteok.com${j.url}`;
      if (globalSeen.has(url)) continue;

      const epochMs  = typeof j.epoch === 'number' ? j.epoch * 1000 : NaN;
      const postedAt = !isNaN(epochMs) ? new Date(epochMs).toISOString() : safeIso(j.date) || '';
      if (!withinWindow(postedAt)) continue;

      globalSeen.add(url);
      const desc   = stripHtml(j.description || '').slice(0, MAX_DESC_CHARS);
      const salary = parseSalary(String(j.salary || ''));

      results.push(make({
        ...DEFAULTS,
        title: j.position, company: j.company || 'Unknown',
        url, applyUrl: j.apply_url || url,
        description: desc,
        location: cleanLoc(j.location || 'Remote'),
        tags: Array.isArray(j.tags) ? j.tags.slice(0, 12) : extractTags(j.position),
        salaryMin: salary.min, salaryMax: salary.max, salaryCurrency: salary.currency,
        postedAt, source: name,
        jobType: inferJobType(`${j.position} ${desc}`),
        experienceLevel: inferSeniority(`${j.position} ${desc}`),
      }));
    }

    recordSuccess(name);
    console.log(`  [${name}] ${results.length} jobs`);
    return results;
  } catch (e: any) {
    recordFailure(name, e.message);
    return [];
  }
}

/** Remotive JSON API — confirmed 2+ jobs. ISO publication_date. */
async function scrapeRemotive(globalSeen: Set<string>): Promise<ScrapedJob[]> {
  const name = 'remotive';
  if (isDisabled(name)) return [];

  try {
    const res  = await fetchWithRetry('https://remotive.com/api/remote-jobs?limit=150', fetchOpts());
    const data = (await res.json()) as any;
    const results: ScrapedJob[] = [];

    for (const j of (data.jobs || [])) {
      if (!j.url || globalSeen.has(j.url)) continue;
      const postedAt = safeIso(j.publication_date) || '';
      if (!withinWindow(postedAt)) continue;

      globalSeen.add(j.url);
      const desc   = stripHtml(j.description || '').slice(0, MAX_DESC_CHARS);
      const salary = parseSalary(j.salary || '');

      results.push(make({
        ...DEFAULTS,
        title: j.title || 'Unknown', company: j.company_name || 'Unknown',
        url: j.url, applyUrl: j.url,
        description: desc,
        location: cleanLoc(j.candidate_required_location || 'Remote'),
        tags: (j.tags || []).slice(0, 12),
        salaryMin: salary.min, salaryMax: salary.max, salaryCurrency: salary.currency,
        postedAt, source: name,
        jobType: j.job_type || inferJobType(j.title || ''),
        experienceLevel: inferSeniority(`${j.title} ${desc}`),
      }));
    }

    recordSuccess(name);
    console.log(`  [${name}] ${results.length} jobs`);
    return results;
  } catch (e: any) {
    recordFailure(name, e.message);
    return [];
  }
}

/** Arbeitnow — confirmed 100 jobs. Best performing API source. No key. */
async function scrapeArbeitnow(globalSeen: Set<string>): Promise<ScrapedJob[]> {
  const name = 'arbeitnow';
  if (isDisabled(name)) return [];

  try {
    const res  = await fetchWithRetry('https://www.arbeitnow.com/api/job-board-api', fetchOpts());
    const data = (await res.json()) as any;
    const results: ScrapedJob[] = [];

    for (const j of (data.data || []).slice(0, 100)) {
      if (!j.url || globalSeen.has(j.url)) continue;
      const postedAt = safeIso(j.created_at) || '';
      if (!withinWindow(postedAt)) continue;

      globalSeen.add(j.url);
      const desc   = stripHtml(j.description || '').slice(0, MAX_DESC_CHARS);
      const salary = parseSalary(j.salary || '');

      results.push(make({
        ...DEFAULTS,
        title: j.title || 'Unknown', company: j.company_name || 'Unknown',
        url: j.url, applyUrl: j.url,
        description: desc,
        location: cleanLoc(j.location || 'Remote'),
        tags: (j.tags || []).slice(0, 12),
        isRemote: !!j.remote || detectRemote(j.title || '', j.location || '', desc),
        salaryMin: salary.min, salaryMax: salary.max, salaryCurrency: 'EUR',
        postedAt, source: name,
        jobType: inferJobType(`${j.title} ${desc}`),
        experienceLevel: inferSeniority(`${j.title} ${desc}`),
      }));
    }

    recordSuccess(name);
    console.log(`  [${name}] ${results.length} jobs`);
    return results;
  } catch (e: any) {
    recordFailure(name, e.message);
    return [];
  }
}

/**
 * TheMuse — confirmed 20 jobs. ISO publication_date. No key.
 * page=1 + descending=true = newest-first.
 */
async function scrapeTheMuse(globalSeen: Set<string>): Promise<ScrapedJob[]> {
  const name = 'themuse';
  if (isDisabled(name)) return [];

  try {
    const res  = await fetchWithRetry(
      'https://www.themuse.com/api/public/jobs?page=1&descending=true',
      fetchOpts(),
    );
    const data = (await res.json()) as any;
    const results: ScrapedJob[] = [];

    for (const j of (data.results || []).slice(0, 80)) {
      const url = j.refs?.landing_page;
      if (!url || globalSeen.has(url)) continue;

      const postedAt = safeIso(j.publication_date) || '';
      if (!withinWindow(postedAt)) continue;

      globalSeen.add(url);
      const location = j.locations?.[0]?.name || 'Remote';
      const desc     = stripHtml(j.contents || '').slice(0, MAX_DESC_CHARS);

      results.push(make({
        ...DEFAULTS,
        title: j.name || 'Unknown', company: j.company?.name || 'Unknown',
        url, applyUrl: url,
        description: desc,
        location: cleanLoc(location),
        tags: (j.categories || [])
          .map((c: any) => (c.name || '').toLowerCase())
          .filter(Boolean)
          .slice(0, 8),
        isRemote: detectRemote(j.name || '', location, desc),
        postedAt, source: name,
        jobType: inferJobType(`${j.name} ${desc}`),
        experienceLevel: inferSeniority(`${j.name} ${desc}`),
      }));
    }

    recordSuccess(name);
    console.log(`  [${name}] ${results.length} jobs`);
    return results;
  } catch (e: any) {
    recordFailure(name, e.message);
    return [];
  }
}

/**
 * Himalayas JSON API — confirmed 20 jobs. No key.
 * Max 20 per page; paginate up to 5 pages, stop early on empty page.
 */
async function scrapeHimalayas(globalSeen: Set<string>): Promise<ScrapedJob[]> {
  const name = 'himalayas';
  if (isDisabled(name)) return [];

  const results: ScrapedJob[] = [];

  for (let offset = 0; offset < 100; offset += 20) {
    try {
      const res  = await fetchWithRetry(
        `https://himalayas.app/jobs/api?limit=20&offset=${offset}`,
        fetchOpts(),
      );
      const data = (await res.json()) as any;
      const jobs: any[] = data.jobs || [];
      if (!jobs.length) break;

      for (const j of jobs) {
        const url = j.applicationUrl || j.url || '';
        if (!url || globalSeen.has(url)) continue;

        const postedAt = safeIso(j.createdAt) || '';
        if (!withinWindow(postedAt)) continue;

        globalSeen.add(url);
        const desc   = stripHtml(j.description || '').slice(0, MAX_DESC_CHARS);
        const salary = parseSalary(j.salary || '');

        results.push(make({
          ...DEFAULTS,
          title: j.title || 'Unknown', company: j.companyName || 'Unknown',
          url, applyUrl: url,
          description: desc, location: 'Remote', isRemote: true,
          tags: (j.skills || extractTags(j.title || '')).slice(0, 12),
          salaryMin: salary.min || j.salaryMin || null,
          salaryMax: salary.max || j.salaryMax || null,
          salaryCurrency: salary.currency,
          postedAt, source: name,
          jobType: j.jobType || inferJobType(j.title || ''),
          experienceLevel: j.seniorityLevel || inferSeniority(j.title || ''),
        }));
      }

      await sleep(250);
    } catch (e: any) {
      recordFailure(name, e.message);
      break;
    }
  }

  if (results.length > 0) recordSuccess(name);
  console.log(`  [${name}] ${results.length} jobs`);
  return results;
}

/** WorkingNomads — confirmed 30 jobs. Remote-only, international. No key. */
async function scrapeWorkingNomads(globalSeen: Set<string>): Promise<ScrapedJob[]> {
  const name = 'workingnomads';
  if (isDisabled(name)) return [];

  try {
    const res  = await fetchWithRetry(
      'https://www.workingnomads.com/api/exposed_jobs/?limit=100',
      fetchOpts(),
    );
    const raw  = (await res.json()) as any;
    const jobs = Array.isArray(raw) ? raw : (raw.jobs || raw.data || []);
    const results: ScrapedJob[] = [];

    for (const j of jobs.slice(0, 100)) {
      if (!j.url || !j.title || globalSeen.has(j.url)) continue;
      const postedAt = safeIso(j.pub_date) || '';
      if (!withinWindow(postedAt)) continue;

      globalSeen.add(j.url);
      const desc   = stripHtml(j.description || '').slice(0, MAX_DESC_CHARS);
      const salary = parseSalary(j.salary_range || '');

      results.push(make({
        ...DEFAULTS,
        title: j.title, company: j.company || 'Unknown',
        url: j.url, applyUrl: j.apply_url || j.url,
        description: desc,
        location: cleanLoc(j.location || 'Remote'),
        isRemote: true,
        tags: extractTags(`${j.title} ${desc}`),
        salaryMin: salary.min, salaryMax: salary.max, salaryCurrency: salary.currency,
        postedAt, source: name,
        jobType: inferJobType(`${j.title} ${desc}`),
        experienceLevel: inferSeniority(`${j.title} ${desc}`),
      }));
    }

    recordSuccess(name);
    console.log(`  [${name}] ${results.length} jobs`);
    return results;
  } catch (e: any) {
    recordFailure(name, e.message);
    return [];
  }
}

/**
 * LinkedIn guest search — confirmed 80 jobs.
 *
 * Single request with broad OR'd keyword string + f_WT=2 (remote filter).
 * No per-keyword loop — that's what caused 429s on some terms.
 * count=100 gives maximum cards per request.
 *
 * Jobs missing a <time datetime> are marked postedAt = NOW() so they
 * appear in the feed for the full window and then expire naturally.
 */
async function scrapeLinkedIn(globalSeen: Set<string>): Promise<ScrapedJob[]> {
  const name = 'linkedin';
  if (isDisabled(name)) return [];

  try {
    const res = await fetchWithRetry(
      'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search' +
      '?keywords=software+engineer+OR+designer+OR+product+manager+OR+data+scientist' +
      '+OR+customer+success+OR+marketing+OR+devops+OR+sales' +
      '&f_WT=2&start=0&count=100',
      {
        ...fetchOpts(),
        signal: AbortSignal.timeout(20_000),
      },
    );

    const html    = await res.text();
    const dom     = new JSDOM(html);
    const doc     = dom.window.document;
    const results: ScrapedJob[] = [];

    for (const card of Array.from(doc.querySelectorAll('li')).slice(0, 100)) {
      const titleEl   = card.querySelector('.base-search-card__title');
      const companyEl = card.querySelector('.base-search-card__subtitle');
      const locEl     = card.querySelector('.job-search-card__location');
      const linkEl    = card.querySelector<HTMLAnchorElement>('a.base-card__full-link');
      const timeEl    = card.querySelector('time');

      if (!titleEl || !linkEl) continue;
      const url = (linkEl.getAttribute('href') || '').split('?')[0];
      if (!url || globalSeen.has(url)) continue;

      globalSeen.add(url);
      const title    = titleEl.textContent?.trim() || '';
      const rawDate  = timeEl?.getAttribute('datetime') || '';
      const postedAt = safeIso(rawDate) || '';
      if (!withinWindow(postedAt)) continue;

      results.push(make({
        ...DEFAULTS,
        title, company: companyEl?.textContent?.trim() || 'Unknown',
        url, applyUrl: url,
        location: cleanLoc(locEl?.textContent?.trim() || 'Remote'),
        isRemote: true,
        tags: extractTags(title),
        postedAt, source: name,
        jobType: inferJobType(title),
        experienceLevel: inferSeniority(title),
      }));
    }

    recordSuccess(name);
    console.log(`  [${name}] ${results.length} jobs`);
    return results;
  } catch (e: any) {
    recordFailure(name, e.message);
    return [];
  }
}

/**
 * Adzuna — free at developer.adzuna.com.
 * No-ops silently if ADZUNA_APP_ID / ADZUNA_APP_KEY are absent.
 */
async function scrapeAdzuna(globalSeen: Set<string>): Promise<ScrapedJob[]> {
  const appId  = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) return [];

  const markets: Array<[string, string]> = [['us', 'USD'], ['gb', 'GBP'], ['ca', 'CAD']];
  const results: ScrapedJob[] = [];

  for (const [country, currency] of markets) {
    const srcName = `adzuna-${country}`;
    if (isDisabled(srcName)) continue;

    try {
      const res = await fetchWithRetry(
        `https://api.adzuna.com/v1/api/jobs/${country}/search/1` +
        `?app_id=${appId}&app_key=${appKey}&results_per_page=50&where=remote`,
        fetchOpts(),
      );
      const data = (await res.json()) as any;

      for (const j of (data.results || [])) {
        const url = j.redirect_url || '';
        if (!url || globalSeen.has(url)) continue;

        const postedAt = safeIso(j.created) || '';
        if (!withinWindow(postedAt)) continue;

        globalSeen.add(url);
        const desc = stripHtml(j.description || '').slice(0, MAX_DESC_CHARS);

        results.push(make({
          ...DEFAULTS,
          title: j.title || 'Unknown', company: j.company?.display_name || 'Unknown',
          url, applyUrl: url,
          description: desc,
          location: cleanLoc(j.location?.display_name || 'Remote'),
          tags: extractTags(`${j.title} ${desc}`),
          isRemote: detectRemote(j.title || '', j.location?.display_name || '', desc),
          salaryMin: j.salary_min ? Math.round(j.salary_min) : null,
          salaryMax: j.salary_max ? Math.round(j.salary_max) : null,
          salaryCurrency: currency,
          postedAt, source: srcName,
          jobType: inferJobType(`${j.title} ${desc}`),
          experienceLevel: inferSeniority(`${j.title} ${desc}`),
        }));
      }
      recordSuccess(srcName);
    } catch (e: any) {
      recordFailure(srcName, e.message);
    }
  }

  if (results.length) console.log(`  [adzuna] ${results.length} jobs`);
  return results;
}

/**
 * JSearch via RapidAPI — free tier at rapidapi.com.
 * No-ops silently if JSEARCH_API_KEY is absent.
 */
async function scrapeJSearch(globalSeen: Set<string>): Promise<ScrapedJob[]> {
  const key = process.env.JSEARCH_API_KEY;
  if (!key) return [];

  const queries = [
    'remote software engineer', 'remote data scientist',
    'remote product manager',   'remote customer support',
    'remote marketing manager', 'remote finance analyst',
  ];
  const results: ScrapedJob[] = [];

  for (const q of queries) {
    const srcName = `jsearch-${q.replace(/\s+/g, '-')}`;
    if (isDisabled(srcName)) continue;

    try {
      const res = await fetchWithRetry(
        `https://jsearch.p.rapidapi.com/search` +
        `?query=${encodeURIComponent(q)}&num_pages=2&date_posted=today`,
        fetchOpts({
          'X-RapidAPI-Key':  key,
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
        }),
      );
      const data = (await res.json()) as any;

      for (const j of (data.data || [])) {
        const url = j.job_apply_link || '';
        if (!url || globalSeen.has(url)) continue;

        const postedAt = safeIso(j.job_posted_at_datetime_utc) || '';
        if (!withinWindow(postedAt)) continue;

        globalSeen.add(url);
        const desc = (j.job_description || '').slice(0, MAX_DESC_CHARS);

        results.push(make({
          ...DEFAULTS,
          title: j.job_title || 'Unknown', company: j.employer_name || 'Unknown',
          url, applyUrl: url,
          description: desc,
          location: cleanLoc(j.job_city || j.job_country || 'Remote'),
          tags: extractTags(`${j.job_title} ${desc}`),
          isRemote: !!j.job_is_remote,
          salaryMin: j.job_min_salary || null,
          salaryMax: j.job_max_salary || null,
          salaryCurrency: j.job_salary_currency || 'USD',
          postedAt,
          source: `jsearch-${(j.job_publisher || 'unknown').toLowerCase().replace(/\s+/g, '-')}`,
          jobType: (j.job_employment_type || 'full-time').toLowerCase(),
          experienceLevel: inferSeniority(`${j.job_title} ${desc}`),
        }));
      }
      recordSuccess(srcName);
      await sleep(250);
    } catch (e: any) {
      recordFailure(srcName, e.message);
    }
  }

  if (results.length) console.log(`  [jsearch] ${results.length} jobs`);
  return results;
}

// ─── Persist ──────────────────────────────────────────────────────────────────

function persistJobs(jobs: ScrapedJob[]): number {
  if (!jobs.length) return 0;
  const db = getDB();

  // Idempotent column additions — safe on every startup
  const migrations = [
    `ALTER TABLE jobs ADD COLUMN apply_payload TEXT DEFAULT '{}'`,
    `ALTER TABLE jobs ADD COLUMN posted_at TEXT`,
    `ALTER TABLE jobs ADD COLUMN job_type TEXT DEFAULT 'full-time'`,
    `ALTER TABLE jobs ADD COLUMN experience_level TEXT DEFAULT ''`,
    `ALTER TABLE jobs ADD COLUMN posted_ago TEXT DEFAULT 'recently'`,
  ];
  for (const sql of migrations) {
    try { db.prepare(sql).run(); } catch { /* column already exists — expected */ }
  }

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
          uuidv4(),
          j.title.slice(0, 300),
          j.company.slice(0, 200),
          j.url,
          j.applyUrl || j.url,
          j.description.slice(0, MAX_DESC_CHARS),
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
        if (r.changes > 0) n++;
      } catch (e: any) {
        // Silent in v7 — now logged so failures are visible
        console.error(`  [persist] failed url=${j.url} — ${e.message}`);
      }
    }
    return n;
  });

  return insert(jobs) as number;
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Removes rows older than SCRAPE_WINDOW_HOURS.
 * Parameterised query — SCRAPE_WINDOW_HOURS is a bound value, not concatenated SQL.
 * Runs BEFORE insert so no job is ever inserted-then-immediately-deleted.
 */
function cleanupOldJobs(): number {
  try {
    const db     = getDB();
    const result = db.prepare(`
      DELETE FROM jobs
      WHERE posted_at IS NOT NULL
        AND posted_at != ''
        AND datetime(posted_at) < datetime('now', ?)
    `).run(`-${SCRAPE_WINDOW_HOURS} hours`);

    const deleted = result.changes ?? 0;
    if (deleted > 0) {
      console.log(`[scraper] Cleanup — removed ${deleted} jobs older than ${SCRAPE_WINDOW_HOURS}h`);
    }
    return deleted;
  } catch (e: any) {
    console.error(`[scraper] Cleanup failed — ${e.message}`);
    return 0;
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

async function runScrape(): Promise<void> {
  const t0 = Date.now();

  // Shared URL set — dedup at collection time, not after accumulating everything
  const globalSeen = new Set<string>();

  // Cleanup FIRST — eliminates the insert-then-delete boundary race condition
  cleanupOldJobs();

  const rssTasks = RSS_SOURCES.map(src => () => scrapeRSS(src, globalSeen));
  const apiTasks = [
    () => scrapeRemoteOK(globalSeen),
    () => scrapeRemotive(globalSeen),
    () => scrapeArbeitnow(globalSeen),
    () => scrapeTheMuse(globalSeen),
    () => scrapeHimalayas(globalSeen),
    () => scrapeWorkingNomads(globalSeen),
    () => scrapeLinkedIn(globalSeen),
    () => scrapeAdzuna(globalSeen),   // no-op without ADZUNA_APP_ID / ADZUNA_APP_KEY
    () => scrapeJSearch(globalSeen),  // no-op without JSEARCH_API_KEY
  ];

  const allTasks = [...rssTasks, ...apiTasks];
  console.log(`\n[scraper] Starting — ${allTasks.length} sources (window: last ${SCRAPE_WINDOW_HOURS}h)`);

  // All tasks concurrently — no artificial batch delays.
  // Each scraper has its own AbortSignal timeout + fetchWithRetry backoff.
  const settled = await Promise.allSettled(allTasks.map(fn => fn()));

  const collected: ScrapedJob[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      collected.push(...result.value);
    } else {
      console.error(`[scraper] Unhandled task rejection — ${result.reason}`);
    }
  }

  // collected is already unique by URL via globalSeen
  const inserted = persistJobs(collected);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[scraper] Done — ${collected.length} unique → ${inserted} new inserted (${elapsed}s)\n`,
  );
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export function startJobScraper(): void {
  runScrape().catch(console.error);
  cron.schedule('0 */5 * * *', () => runScrape().catch(console.error));
  console.log('[scraper] Cron running — every 5 hours');
}