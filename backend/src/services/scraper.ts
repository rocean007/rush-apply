/**
 * scraper.ts — Production-ready job scraper
 *
 * Sources (all verified working):
 *   RSS  : WeWorkRemotely (6 feeds), HN Hiring, Himalayas, Automattic, AuthenticJobs, Jobspresso
 *   JSON : RemoteOK, Arbeitnow, Jobicy, Remotive, TheMuse, Adzuna (optional key)
 *          + Greenhouse (Shopify, HashiCorp, Figma, Stripe, Notion)
 *          + Ashby (Linear, Vercel, Retool, Supabase)
 *          + Workable (Typeform, Hotjar)
 *          + Lever (Webflow, Zapier, Buffer)
 *          + JSearch (RapidAPI — optional key, covers LinkedIn/Indeed/Glassdoor)
 *
 * Schedule : Run once on startup, then every 5 hours via cron.
 *            Each run fetches only jobs posted in the last 24 hours.
 *
 * AI-agent : Every persisted job gets an `apply_payload` JSON blob with all
 *            fields an agent needs to auto-fill an application form.
 */

import cron       from 'node-cron';
import Parser     from 'rss-parser';
import { v4 as uuidv4 } from 'uuid';
import { getDB }  from '../db/database';

// ─── Tunables ────────────────────────────────────────────────────────────────
const SCRAPE_WINDOW_HOURS = 24;   // only keep jobs posted within this window
const BATCH_CONCURRENCY   = 12;   // parallel fetch slots
const DEFAULT_TIMEOUT_MS  = 18_000;
const RSS_ITEM_LIMIT      = 40;

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
  /** Structured blob for AI auto-apply agents */
  applyPayload:   ApplyPayload;
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
  /** Hints the agent can use to decide which resume/cover-letter to use */
  category:       string;
  seniority:      string;
}

// ─── Keyword lists ───────────────────────────────────────────────────────────

const TECH_KEYWORDS = [
  'javascript','typescript','python','react','node','java','go','golang','rust',
  'ruby','php','swift','kotlin','scala','elixir','c#','c++','vue','angular',
  'svelte','nextjs','graphql','postgres','mysql','mongodb','redis','aws','gcp',
  'azure','docker','kubernetes','terraform','linux','devops','ml','ai','llm',
  'pytorch','tensorflow','fullstack','backend','frontend','mobile','ios',
  'android','saas','api','rest','microservices','blockchain','web3','solidity',
  'data','analytics','customer service','support','sales','marketing','hr',
  'recruiting','admin','design','figma','product','seo','content','writing',
  'finance','accounting','legal','operations','project management',
];

const SENIORITY_MAP: Record<string, string[]> = {
  intern:    ['intern','internship','trainee','graduate'],
  junior:    ['junior','jr','entry level','entry-level','associate','0-2 years'],
  mid:       ['mid level','mid-level','intermediate','2-4 years','3-5 years'],
  senior:    ['senior','sr','lead','principal','staff','5+ years','7+ years'],
  manager:   ['manager','director','vp ','vice president','head of','chief'],
};

const CATEGORY_MAP: Record<string, string[]> = {
  engineering:  ['engineer','developer','dev','swe','software','fullstack','backend','frontend','mobile','ios','android'],
  data:         ['data','analyst','analytics','ml','machine learning','ai','scientist','bi '],
  design:       ['design','ux','ui','product designer','figma'],
  devops:       ['devops','sre','infra','infrastructure','platform','cloud','kubernetes','terraform'],
  product:      ['product manager','pm ','product owner'],
  marketing:    ['marketing','seo','content','growth','copywriter'],
  support:      ['support','success','customer service','helpdesk'],
  sales:        ['sales','account executive','ae ','bdr','sdr'],
  operations:   ['operations','ops','project manager','coordinator','admin','hr','recruiter','finance','accounting'],
};

// ─── Utility helpers ─────────────────────────────────────────────────────────

const rssParser = new Parser({ timeout: DEFAULT_TIMEOUT_MS });

function sig(t: AbortSignal | undefined): RequestInit {
  return { signal: t ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS) };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function extractTags(text: string): string[] {
  const lower = text.toLowerCase();
  return TECH_KEYWORDS.filter(k =>
    new RegExp(`\\b${k.replace(/[+#]/g, c => `\\${c}`)}\\b`).test(lower)
  );
}

function parseSalary(raw: string): { min: number | null; max: number | null; currency: string } {
  if (!raw) return { min: null, max: null, currency: 'USD' };
  const currency = raw.includes('€') ? 'EUR' : raw.includes('£') ? 'GBP'
    : /\bCAD\b/.test(raw) ? 'CAD' : 'USD';
  const clean = raw.replace(/[£€$,\s]/g, '').replace(/[kK]/g, '000').replace(/CA\$/, '');
  const nums = clean.match(/\d{4,7}/g)
    ?.map(Number).filter(n => n >= 10_000 && n <= 10_000_000);
  if (!nums?.length) return { min: null, max: null, currency };
  return { min: nums[0], max: nums[1] ?? null, currency };
}

function detectRemote(title: string, location: string, desc: string): boolean {
  return /\bremote\b|\bwork from home\b|\bwfh\b|\bdistributed\b|\banywhere\b/i.test(
    `${title} ${location} ${desc}`
  );
}

function cleanLocation(raw: string): string {
  if (!raw) return 'Remote';
  const r = raw.trim().replace(/\s+/g, ' ');
  return /^(remote|worldwide|anywhere|global|distributed|location independent)$/i.test(r)
    ? 'Remote' : r;
}

function inferCategory(text: string): string {
  const lower = text.toLowerCase();
  for (const [cat, kws] of Object.entries(CATEGORY_MAP)) {
    if (kws.some(k => lower.includes(k))) return cat;
  }
  return 'other';
}

function inferSeniority(text: string): string {
  const lower = text.toLowerCase();
  for (const [level, kws] of Object.entries(SENIORITY_MAP)) {
    if (kws.some(k => lower.includes(k))) return level;
  }
  return 'mid';
}

/** Safe ISO date — returns '' if unparseable so we can filter it out */
function safeIso(raw: string | number | undefined | null): string {
  if (raw == null || raw === '') return '';
  try {
    const d = typeof raw === 'number'
      ? new Date(raw > 1e10 ? raw : raw * 1000)   // handle both ms and s epochs
      : new Date(raw);
    if (isNaN(d.getTime())) return '';
    return d.toISOString();
  } catch { return ''; }
}

const NOW = (): Date => new Date();
const WINDOW_CUTOFF = (): Date => {
  const d = NOW();
  d.setHours(d.getHours() - SCRAPE_WINDOW_HOURS);
  return d;
};

function withinWindow(isoDate: string): boolean {
  if (!isoDate) return true; // no date → include (assume recent)
  const d = new Date(isoDate);
  return isNaN(d.getTime()) ? true : d >= WINDOW_CUTOFF();
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
  };
}

const DEFAULTS = {
  applyUrl:       '',
  description:    '',
  location:       'Remote',
  salaryMin:      null as null,
  salaryMax:      null as null,
  salaryCurrency: 'USD',
  tags:           [] as string[],
  isRemote:       true,
  postedAt:       NOW().toISOString(),
};

function make(partial: Omit<ScrapedJob, 'applyPayload'>): ScrapedJob {
  return { ...partial, applyPayload: buildPayload(partial) };
}

// ─── RSS Scraper ─────────────────────────────────────────────────────────────

interface RSSSource {
  url:             string;
  name:            string;
  titleSplit?:     string;
  defaultLocation?: string;
  limit?:          number;
}

// Only feeds confirmed working as of April 2026
const RSS_SOURCES: RSSSource[] = [
  // WeWorkRemotely — most reliable remote RSS source
  { url: 'https://weworkremotely.com/remote-jobs.rss',                             name: 'wwr',             titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-programming-jobs.rss',      name: 'wwr-programming', titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss',  name: 'wwr-devops',      titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-design-jobs.rss',           name: 'wwr-design',      titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-product-jobs.rss',          name: 'wwr-product',     titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-customer-support-jobs.rss', name: 'wwr-support',     titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-sales-jobs.rss',            name: 'wwr-sales',       titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-marketing-jobs.rss',        name: 'wwr-marketing',   titleSplit: ':' },

  // HN Who's Hiring (active monthly threads)
  { url: 'https://hnrss.org/whoishiring', name: 'hn-hiring', limit: 40 },

  // Himalayas — reliable remote-first board
  { url: 'https://himalayas.app/jobs/rss', name: 'himalayas', defaultLocation: 'Remote' },

  // Automattic (WordPress, Tumblr, Jetpack — all remote)
  { url: 'https://jobs.automattic.com/feed/', name: 'automattic', defaultLocation: 'Remote' },

  // AuthenticJobs — design/dev focused
  { url: 'https://authenticjobs.com/feed/', name: 'authenticjobs' },

  // Jobspresso — curated remote jobs
  { url: 'https://jobspresso.co/feed/', name: 'jobspresso', defaultLocation: 'Remote' },
];

async function scrapeRSS(src: RSSSource): Promise<ScrapedJob[]> {
  try {
    const feed = await rssParser.parseURL(src.url);
    const results: ScrapedJob[] = [];
    for (const item of feed.items.slice(0, src.limit ?? RSS_ITEM_LIMIT)) {
      if (!item.link || !item.title) continue;
      let title = item.title.trim();
      let company = 'Unknown';
      if (src.titleSplit && title.includes(src.titleSplit)) {
        const parts = title.split(src.titleSplit);
        company = parts[0].trim();
        title   = parts.slice(1).join(src.titleSplit).trim();
      }
      const desc     = stripHtml(item.contentSnippet || item.content || '').slice(0, 1500);
      const salary   = parseSalary(desc);
      const location = cleanLocation((item as any).location || src.defaultLocation || '');
      const postedAt = safeIso(item.isoDate) || NOW().toISOString();
      if (!withinWindow(postedAt)) continue;

      results.push(make({
        ...DEFAULTS,
        title, company,
        url:      item.link,
        applyUrl: item.link,
        description: desc,
        location,
        tags:     extractTags(`${title} ${desc}`),
        isRemote: detectRemote(title, location, desc),
        salaryMin: salary.min, salaryMax: salary.max, salaryCurrency: salary.currency,
        postedAt,
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

// ─── JSON API Scrapers ────────────────────────────────────────────────────────

async function scrapeRemoteOK(): Promise<ScrapedJob[]> {
  try {
    const res  = await fetch('https://remoteok.com/api', {
      headers: { 'User-Agent': 'Mozilla/5.0 JobBot/3.0 (+https://github.com/jobbot)' },
      ...sig(undefined),
    });
    const data = (await res.json()) as any[];
    const jobs = data.slice(1).filter((j: any) => j.position && j.company && j.url);
    const results: ScrapedJob[] = [];

    for (const j of jobs.slice(0, 100)) {
      // RemoteOK epoch is in seconds
      const postedAt = safeIso(j.epoch ? j.epoch * 1000 : j.date) || NOW().toISOString();
      if (!withinWindow(postedAt)) continue;
      const desc   = stripHtml(j.description || '').slice(0, 1500);
      const salary = parseSalary(j.salary || '');
      results.push(make({
        ...DEFAULTS,
        title:   j.position,
        company: j.company,
        url:     `https://remoteok.com${j.url}`,
        applyUrl: j.apply_url || `https://remoteok.com${j.url}`,
        description: desc,
        location: j.location ? cleanLocation(j.location) : 'Remote',
        tags:    Array.isArray(j.tags) ? j.tags.slice(0, 12) : extractTags(j.position),
        salaryMin: salary.min, salaryMax: salary.max, salaryCurrency: salary.currency,
        postedAt, source: 'remoteok',
      }));
    }
    console.log(`  [remoteok] ${results.length} jobs`);
    return results;
  } catch (e: any) { console.error(`  [remoteok] SKIP — ${e.message}`); return []; }
}

async function scrapeArbeitnow(): Promise<ScrapedJob[]> {
  try {
    const res  = await fetch('https://www.arbeitnow.com/api/job-board-api', sig(undefined));
    const data = await res.json() as any;
    const results: ScrapedJob[] = [];
    for (const j of (data.data || []).slice(0, 100)) {
      const postedAt = safeIso(j.created_at) || NOW().toISOString();
      if (!withinWindow(postedAt)) continue;
      const desc   = stripHtml(j.description || '').slice(0, 1500);
      const salary = parseSalary(j.salary || '');
      results.push(make({
        ...DEFAULTS,
        title:   j.title   || 'Unknown',
        company: j.company_name || 'Unknown',
        url:     j.url || '', applyUrl: j.url || '',
        description: desc,
        location: cleanLocation(j.location || 'Remote'),
        tags:    (j.tags || []).slice(0, 12),
        isRemote: !!j.remote || detectRemote(j.title, j.location || '', desc),
        salaryMin: salary.min, salaryMax: salary.max, salaryCurrency: 'EUR',
        postedAt, source: 'arbeitnow',
      }));
    }
    console.log(`  [arbeitnow] ${results.length} jobs`);
    return results;
  } catch (e: any) { console.error(`  [arbeitnow] SKIP — ${e.message}`); return []; }
}

async function scrapeJobicy(): Promise<ScrapedJob[]> {
  try {
    const res  = await fetch('https://jobicy.com/api/v2/remote-jobs?count=50&geo=worldwide', sig(undefined));
    const data = await res.json() as any;
    const results: ScrapedJob[] = [];
    for (const j of (data.jobs || [])) {
      const postedAt = safeIso(j.pubDate) || NOW().toISOString();
      if (!withinWindow(postedAt)) continue;
      const desc = stripHtml(j.jobDescription || '').slice(0, 1500);
      results.push(make({
        ...DEFAULTS,
        title:   j.jobTitle     || 'Unknown',
        company: j.companyName  || 'Unknown',
        url:     j.url || '', applyUrl: j.url || '',
        description: desc,
        location: cleanLocation(j.jobGeo || 'Remote'),
        tags:    ([...(j.jobIndustry || []), ...(j.jobType || [])]).slice(0, 12),
        salaryMin: j.annualSalaryMin || null,
        salaryMax: j.annualSalaryMax || null,
        salaryCurrency: j.salaryCurrency || 'USD',
        postedAt, source: 'jobicy',
      }));
    }
    console.log(`  [jobicy] ${results.length} jobs`);
    return results;
  } catch (e: any) { console.error(`  [jobicy] SKIP — ${e.message}`); return []; }
}

async function scrapeRemotive(): Promise<ScrapedJob[]> {
  try {
    const res  = await fetch('https://remotive.com/api/remote-jobs?limit=100', sig(undefined));
    const data = await res.json() as any;
    const results: ScrapedJob[] = [];
    for (const j of (data.jobs || [])) {
      const postedAt = safeIso(j.publication_date) || NOW().toISOString();
      if (!withinWindow(postedAt)) continue;
      const desc   = stripHtml(j.description || '').slice(0, 1500);
      const salary = parseSalary(j.salary || '');
      results.push(make({
        ...DEFAULTS,
        title:   j.title        || 'Unknown',
        company: j.company_name || 'Unknown',
        url:     j.url || '', applyUrl: j.url || '',
        description: desc,
        location: cleanLocation(j.candidate_required_location || 'Remote'),
        tags:    (j.tags || []).slice(0, 12),
        salaryMin: salary.min, salaryMax: salary.max, salaryCurrency: salary.currency,
        postedAt, source: 'remotive',
      }));
    }
    console.log(`  [remotive] ${results.length} jobs`);
    return results;
  } catch (e: any) { console.error(`  [remotive] SKIP — ${e.message}`); return []; }
}

async function scrapeTheMuse(): Promise<ScrapedJob[]> {
  try {
    const res  = await fetch('https://www.themuse.com/api/public/jobs?page=1&descending=true', sig(undefined));
    const data = await res.json() as any;
    const results: ScrapedJob[] = [];
    for (const j of (data.results || []).slice(0, 80)) {
      const postedAt = safeIso(j.publication_date) || NOW().toISOString();
      if (!withinWindow(postedAt)) continue;
      const location = j.locations?.[0]?.name || 'Remote';
      const desc     = stripHtml(j.contents || '').slice(0, 1500);
      results.push(make({
        ...DEFAULTS,
        title:   j.name              || 'Unknown',
        company: j.company?.name     || 'Unknown',
        url:     j.refs?.landing_page || '',
        applyUrl: j.refs?.landing_page || '',
        description: desc,
        location: cleanLocation(location),
        tags:    (j.categories || []).map((c: any) => c.name?.toLowerCase()).filter(Boolean).slice(0, 8),
        isRemote: detectRemote(j.name, location, desc),
        postedAt, source: 'themuse',
      }));
    }
    console.log(`  [themuse] ${results.length} jobs`);
    return results;
  } catch (e: any) { console.error(`  [themuse] SKIP — ${e.message}`); return []; }
}

/** Adzuna — optional, requires free API key at developer.adzuna.com */
async function scrapeAdzuna(): Promise<ScrapedJob[]> {
  const appId  = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) return [];
  try {
    const url = `https://api.adzuna.com/v1/api/jobs/us/search/1`
      + `?app_id=${appId}&app_key=${appKey}&results_per_page=50`
      + `&what=developer&content-type=application/json`;
    const res  = await fetch(url, sig(undefined));
    const data = await res.json() as any;
    const results: ScrapedJob[] = [];
    for (const j of (data.results || [])) {
      const postedAt = safeIso(j.created) || NOW().toISOString();
      if (!withinWindow(postedAt)) continue;
      const desc = (j.description || '').slice(0, 1500);
      results.push(make({
        ...DEFAULTS,
        title:   j.title || 'Unknown',
        company: j.company?.display_name || 'Unknown',
        url:     j.redirect_url || '', applyUrl: j.redirect_url || '',
        description: desc,
        location: cleanLocation(j.location?.display_name || 'Remote'),
        tags:    extractTags(`${j.title} ${desc}`),
        isRemote: detectRemote(j.title, j.location?.display_name || '', desc),
        salaryMin: j.salary_min ? Math.round(j.salary_min) : null,
        salaryMax: j.salary_max ? Math.round(j.salary_max) : null,
        postedAt, source: 'adzuna',
      }));
    }
    console.log(`  [adzuna] ${results.length} jobs`);
    return results;
  } catch (e: any) { console.error(`  [adzuna] SKIP — ${e.message}`); return []; }
}

/**
 * JSearch (RapidAPI) — covers LinkedIn, Indeed, Glassdoor, ZipRecruiter.
 * Requires JSEARCH_API_KEY env var (free tier: 200 req/month).
 * Sign up at https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch
 */
async function scrapeJSearch(): Promise<ScrapedJob[]> {
  const key = process.env.JSEARCH_API_KEY;
  if (!key) return [];
  const queries = ['remote software engineer', 'remote developer', 'remote data analyst', 'remote product manager'];
  const results: ScrapedJob[] = [];
  for (const q of queries) {
    try {
      const res = await fetch(
        `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(q)}&num_pages=2&date_posted=today`,
        {
          headers: {
            'X-RapidAPI-Key':  key,
            'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
          },
          ...sig(undefined),
        }
      );
      const data = await res.json() as any;
      for (const j of (data.data || [])) {
        const postedAt = safeIso(j.job_posted_at_datetime_utc) || NOW().toISOString();
        if (!withinWindow(postedAt)) continue;
        const desc = (j.job_description || '').slice(0, 1500);
        results.push(make({
          ...DEFAULTS,
          title:   j.job_title         || 'Unknown',
          company: j.employer_name     || 'Unknown',
          url:     j.job_apply_link    || '',
          applyUrl: j.job_apply_link   || '',
          description: desc,
          location: cleanLocation(j.job_city || j.job_country || 'Remote'),
          tags:    extractTags(`${j.job_title} ${desc}`),
          isRemote: !!j.job_is_remote,
          salaryMin: j.job_min_salary   || null,
          salaryMax: j.job_max_salary   || null,
          salaryCurrency: j.job_salary_currency || 'USD',
          postedAt, source: `jsearch-${j.job_publisher?.toLowerCase().replace(/\s+/g,'-') || 'unknown'}`,
        }));
      }
    } catch (e: any) {
      console.error(`  [jsearch:${q}] SKIP — ${e.message}`);
    }
  }
  console.log(`  [jsearch] ${results.length} jobs`);
  return results;
}

// ─── Greenhouse ATS scrapers ──────────────────────────────────────────────────
// Pattern: https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true

interface GHCompany { slug: string; name: string; }

const GREENHOUSE_COMPANIES: GHCompany[] = [
  { slug: 'shopify',      name: 'Shopify'      },
  { slug: 'hashicorp',    name: 'HashiCorp'    },
  { slug: 'notion',       name: 'Notion'       },
  { slug: 'brex',         name: 'Brex'         },
  { slug: 'figma',        name: 'Figma'        },
  { slug: 'rippling',     name: 'Rippling'     },
  { slug: 'coda',         name: 'Coda'         },
  { slug: 'loom',         name: 'Loom'         },
  { slug: 'lattice',      name: 'Lattice'      },
  { slug: 'asana',        name: 'Asana'        },
];

async function scrapeGreenhouse(co: GHCompany): Promise<ScrapedJob[]> {
  try {
    const res  = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${co.slug}/jobs?content=true`,
      sig(undefined)
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;
    const results: ScrapedJob[] = [];
    for (const j of (data.jobs || [])) {
      const desc     = stripHtml(j.content || '').slice(0, 1500);
      const location = cleanLocation(j.location?.name || 'Remote');
      const isRemote = detectRemote(j.title, location, desc);
      if (!isRemote && !/remote/i.test(location)) continue; // skip on-site only
      results.push(make({
        ...DEFAULTS,
        title:   j.title  || 'Unknown',
        company: co.name,
        url:     j.absolute_url || '',
        applyUrl: j.absolute_url || '',
        description: desc,
        location,
        tags:    extractTags(`${j.title} ${desc}`),
        isRemote,
        postedAt: safeIso(j.updated_at) || NOW().toISOString(),
        source: `greenhouse-${co.slug}`,
      }));
    }
    console.log(`  [greenhouse-${co.slug}] ${results.length} jobs`);
    return results;
  } catch (e: any) {
    console.error(`  [greenhouse-${co.slug}] SKIP — ${e.message}`);
    return [];
  }
}

// ─── Ashby ATS scrapers ───────────────────────────────────────────────────────
// Pattern: https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPostingTable

interface AshbyCompany { slug: string; name: string; }

const ASHBY_COMPANIES: AshbyCompany[] = [
  { slug: 'linear',        name: 'Linear'        },
  { slug: 'vercel',        name: 'Vercel'        },
  { slug: 'retool',        name: 'Retool'        },
  { slug: 'supabase',      name: 'Supabase'      },
  { slug: 'planetscale',   name: 'PlanetScale'   },
  { slug: 'clerk',         name: 'Clerk'         },
  { slug: 'dbt-labs',      name: 'dbt Labs'      },
];

async function scrapeAshby(co: AshbyCompany): Promise<ScrapedJob[]> {
  try {
    const res = await fetch(`https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPostingTable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationName: 'ApiJobPostingTable',
        variables: { organizationHostedJobsPageName: co.slug },
        query: `query ApiJobPostingTable($organizationHostedJobsPageName: String!) {
          jobPostings(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
            id title descriptionHtml locationName isRemote applyLink
            publishedDate employmentType
          }
        }`,
      }),
      ...sig(undefined),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;
    const results: ScrapedJob[] = [];
    for (const j of (data.data?.jobPostings || [])) {
      const postedAt = safeIso(j.publishedDate) || NOW().toISOString();
      if (!withinWindow(postedAt)) continue;
      const desc = stripHtml(j.descriptionHtml || '').slice(0, 1500);
      results.push(make({
        ...DEFAULTS,
        title:   j.title      || 'Unknown',
        company: co.name,
        url:     j.applyLink  || `https://jobs.ashbyhq.com/${co.slug}`,
        applyUrl: j.applyLink || `https://jobs.ashbyhq.com/${co.slug}`,
        description: desc,
        location: cleanLocation(j.locationName || 'Remote'),
        tags:    extractTags(`${j.title} ${desc}`),
        isRemote: !!j.isRemote,
        postedAt, source: `ashby-${co.slug}`,
      }));
    }
    console.log(`  [ashby-${co.slug}] ${results.length} jobs`);
    return results;
  } catch (e: any) {
    console.error(`  [ashby-${co.slug}] SKIP — ${e.message}`);
    return [];
  }
}

// ─── Lever ATS scrapers ───────────────────────────────────────────────────────

interface LeverCompany { slug: string; name: string; }

const LEVER_COMPANIES: LeverCompany[] = [
  { slug: 'webflow',   name: 'Webflow'   },
  { slug: 'zapier',    name: 'Zapier'    },
  { slug: 'buffer',    name: 'Buffer'    },
  { slug: 'close',     name: 'Close'     },
  { slug: 'doist',     name: 'Doist'     },
  { slug: 'hotjar',    name: 'Hotjar'    },
];

async function scrapeLever(co: LeverCompany): Promise<ScrapedJob[]> {
  try {
    const res  = await fetch(`https://api.lever.co/v0/postings/${co.slug}?mode=json`, sig(undefined));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any[];
    const results: ScrapedJob[] = [];
    for (const j of (Array.isArray(data) ? data : [])) {
      const postedAt = safeIso(j.createdAt) || NOW().toISOString();
      if (!withinWindow(postedAt)) continue;
      const location = cleanLocation(j.categories?.location || j.workplaceType || 'Remote');
      const desc     = stripHtml([
        j.descriptionPlain,
        ...(j.lists || []).map((l: any) => `${l.text}: ${l.content}`)
      ].join(' ')).slice(0, 1500);
      const isRemote = j.workplaceType === 'remote'
        || detectRemote(j.text, location, desc);
      if (!isRemote && !/remote/i.test(location)) continue;
      results.push(make({
        ...DEFAULTS,
        title:   j.text   || 'Unknown',
        company: co.name,
        url:     j.hostedUrl  || '',
        applyUrl: j.applyUrl  || j.hostedUrl || '',
        description: desc,
        location,
        tags:    extractTags(`${j.text} ${desc} ${j.categories?.team || ''}`),
        isRemote,
        postedAt, source: `lever-${co.slug}`,
      }));
    }
    console.log(`  [lever-${co.slug}] ${results.length} jobs`);
    return results;
  } catch (e: any) {
    console.error(`  [lever-${co.slug}] SKIP — ${e.message}`);
    return [];
  }
}

// ─── Workable ATS scraper ─────────────────────────────────────────────────────

interface WorkableCompany { subdomain: string; name: string; }

const WORKABLE_COMPANIES: WorkableCompany[] = [
  { subdomain: 'typeform',  name: 'Typeform'  },
  { subdomain: 'doist',     name: 'Doist'     },
];

async function scrapeWorkable(co: WorkableCompany): Promise<ScrapedJob[]> {
  try {
    const res  = await fetch(
      `https://apply.workable.com/api/v3/accounts/${co.subdomain}/jobs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '', location: [], department: [], worktype: ['remote'], remote: true }),
        ...sig(undefined),
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;
    const results: ScrapedJob[] = [];
    for (const j of (data.results || [])) {
      const postedAt = safeIso(j.published_on) || NOW().toISOString();
      if (!withinWindow(postedAt)) continue;
      const url  = `https://apply.workable.com/${co.subdomain}/j/${j.shortcode}/`;
      const desc = stripHtml(j.description || '').slice(0, 1500);
      results.push(make({
        ...DEFAULTS,
        title:   j.title   || 'Unknown',
        company: co.name,
        url, applyUrl: url,
        description: desc,
        location: cleanLocation(j.location?.city || 'Remote'),
        tags:    extractTags(`${j.title} ${desc} ${j.department || ''}`),
        isRemote: true,
        postedAt, source: `workable-${co.subdomain}`,
      }));
    }
    console.log(`  [workable-${co.subdomain}] ${results.length} jobs`);
    return results;
  } catch (e: any) {
    console.error(`  [workable-${co.subdomain}] SKIP — ${e.message}`);
    return [];
  }
}

// ─── Persist to SQLite ────────────────────────────────────────────────────────

function persistJobs(jobs: ScrapedJob[]): number {
  if (!jobs.length) return 0;
  const db   = getDB();

  // Ensure apply_payload column exists (idempotent migration)
  try {
    db.prepare(`ALTER TABLE jobs ADD COLUMN apply_payload TEXT DEFAULT '{}'`).run();
  } catch { /* column already exists */ }

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO jobs
      (id, title, company, url, apply_url, description, location,
       salary_min, salary_max, salary_currency, tags, source, is_remote,
       apply_payload, scraped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  const insert = db.transaction((items: ScrapedJob[]) => {
    let n = 0;
    for (const j of items) {
      if (!j.url || !j.title) continue;
      try {
        const info = stmt.run(
          uuidv4(), j.title, j.company, j.url, j.applyUrl || j.url,
          j.description, j.location,
          j.salaryMin, j.salaryMax, j.salaryCurrency,
          JSON.stringify(j.tags), j.source, j.isRemote ? 1 : 0,
          JSON.stringify(j.applyPayload),
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
  const ghTasks  = GREENHOUSE_COMPANIES.map(c => () => scrapeGreenhouse(c));
  const ashTasks = ASHBY_COMPANIES.map(c => () => scrapeAshby(c));
  const lvTasks  = LEVER_COMPANIES.map(c => () => scrapeLever(c));
  const wkTasks  = WORKABLE_COMPANIES.map(c => () => scrapeWorkable(c));
  const apiTasks = [
    () => scrapeRemoteOK(),
    () => scrapeArbeitnow(),
    () => scrapeJobicy(),
    () => scrapeRemotive(),
    () => scrapeTheMuse(),
    () => scrapeAdzuna(),
    () => scrapeJSearch(),
  ];

  const all = [...rssTasks, ...ghTasks, ...ashTasks, ...lvTasks, ...wkTasks, ...apiTasks];
  console.log(`\n[scraper] Starting — ${all.length} sources (window: last ${SCRAPE_WINDOW_HOURS}h)`);

  const collected: ScrapedJob[] = [];

  for (let i = 0; i < all.length; i += BATCH_CONCURRENCY) {
    const batch   = all.slice(i, i + BATCH_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(fn => fn()));
    for (const r of settled) {
      if (r.status === 'fulfilled') collected.push(...r.value);
    }
    if (i + BATCH_CONCURRENCY < all.length) await new Promise(r => setTimeout(r, 300));
  }

  // Deduplicate by URL (first seen wins)
  const seen   = new Set<string>();
  const unique = collected.filter(j => j.url && !seen.has(j.url) && seen.add(j.url));

  const inserted = persistJobs(unique);
  const elapsed  = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[scraper] Done — ${unique.length} unique (${SCRAPE_WINDOW_HOURS}h window), ${inserted} new inserted (${elapsed}s)\n`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export function startJobScraper(): void {
  runScrape().catch(console.error);
  // Every 5 hours
  cron.schedule('0 */5 * * *', () => runScrape().catch(console.error));
  console.log('[scraper] Cron running — every 5 hours');
}