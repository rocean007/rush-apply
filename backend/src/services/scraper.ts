import cron from 'node-cron';
import Parser from 'rss-parser';
import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../db/database';

const rssParser = new Parser({ timeout: 12000 });

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ScrapedJob {
  title: string;
  company: string;
  url: string;
  applyUrl: string;
  description: string;
  location: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string;
  tags: string[];
  source: string;
  isRemote: boolean;
  postedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const TECH_KEYWORDS = [
  'javascript','typescript','python','react','node','java','go','rust','ruby',
  'php','swift','kotlin','scala','elixir','c#','c++','vue','angular','svelte',
  'nextjs','graphql','postgres','mysql','mongodb','redis','aws','gcp','azure',
  'docker','kubernetes','terraform','linux','devops','ml','ai','llm','pytorch',
  'tensorflow','fullstack','backend','frontend','mobile','ios','android','saas',
  'api','rest','microservices','blockchain','web3','solidity','data','analytics',
];

function extractTags(text: string): string[] {
  const lower = text.toLowerCase();
  return TECH_KEYWORDS.filter(k => new RegExp(`\\b${k.replace('+','\\+')}\\b`).test(lower));
}

function parseSalary(raw: string): { min: number | null; max: number | null; currency: string } {
  if (!raw) return { min: null, max: null, currency: 'USD' };
  const currency = raw.includes('€') ? 'EUR' : raw.includes('£') ? 'GBP' : raw.match(/\bCAD\b/) ? 'CAD' : 'USD';
  const clean = raw.replace(/[£€$,\s]/g,'').replace(/[kK]/g,'000').replace(/CA\$/g,'');
  const nums = clean.match(/\d{4,7}/g)?.map(Number).filter(n => n >= 1000 && n <= 10_000_000);
  if (!nums?.length) return { min: null, max: null, currency };
  return { min: nums[0], max: nums[1] ?? null, currency };
}

function detectRemote(title: string, location: string, desc: string): boolean {
  return /\bremote\b|\bwork from home\b|\bwfh\b|\bdistributed\b|\banywhere\b/.test(
    `${title} ${location} ${desc}`.toLowerCase()
  );
}

function cleanLocation(raw: string): string {
  if (!raw) return 'Remote';
  const r = raw.trim().replace(/\s+/g, ' ');
  return /^(remote|worldwide|anywhere|global|distributed)$/i.test(r) ? 'Remote' : r;
}

const DEFAULTS: Omit<ScrapedJob, 'title'|'company'|'url'|'source'> = {
  applyUrl: '',
  description: '',
  location: 'Remote',
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: 'USD',
  tags: [],
  isRemote: true,
  postedAt: new Date().toISOString(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Generic RSS scraper
// ─────────────────────────────────────────────────────────────────────────────

async function scrapeRSS(
  feedUrl: string,
  sourceName: string,
  opts: { titleSplit?: string; defaultLocation?: string; limit?: number } = {}
): Promise<ScrapedJob[]> {
  try {
    const feed = await rssParser.parseURL(feedUrl);
    const results: ScrapedJob[] = [];
    for (const item of feed.items.slice(0, opts.limit ?? 30)) {
      if (!item.link || !item.title) continue;
      let title = item.title, company = 'Unknown';
      if (opts.titleSplit && item.title.includes(opts.titleSplit)) {
        const parts = item.title.split(opts.titleSplit);
        company = parts[0].trim();
        title = parts.slice(1).join(opts.titleSplit).trim();
      }
      const desc = item.contentSnippet || item.content || '';
      const salary = parseSalary(desc);
      const location = cleanLocation((item as any).location || opts.defaultLocation || 'Remote');
      results.push({
        ...DEFAULTS,
        title, company,
        url: item.link,
        applyUrl: item.link,
        description: desc.slice(0, 1200),
        location,
        tags: extractTags(`${title} ${desc}`),
        isRemote: detectRemote(title, location, desc),
        salaryMin: salary.min, salaryMax: salary.max, salaryCurrency: salary.currency,
        postedAt: item.isoDate || new Date().toISOString(),
        source: sourceName,
      });
    }
    console.log(`  [${sourceName}] ${results.length} jobs`);
    return results;
  } catch (e: any) {
    console.error(`  [${sourceName}] failed: ${e.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON API scrapers
// ─────────────────────────────────────────────────────────────────────────────

async function scrapeRemoteOK(): Promise<ScrapedJob[]> {
  try {
    const res = await fetch('https://remoteok.com/api', {
      headers: { 'User-Agent': 'Mozilla/5.0 JobBot/2.0' },
      signal: AbortSignal.timeout(12000),
    });
    const data = (await res.json()) as any[];
    return data.slice(1).filter((j: any) => j.position && j.company && j.url).slice(0, 100)
      .map((j: any) => {
        const salary = parseSalary(j.salary || '');
        return {
          ...DEFAULTS,
          title: j.position, company: j.company,
          url: `https://remoteok.com${j.url}`,
          applyUrl: j.apply_url || `https://remoteok.com${j.url}`,
          description: (j.description || '').replace(/<[^>]+>/g,'').slice(0,1200),
          location: j.location ? cleanLocation(j.location) : 'Remote',
          tags: Array.isArray(j.tags) ? j.tags.slice(0,10) : extractTags(j.position),
          salaryMin: salary.min, salaryMax: salary.max, salaryCurrency: salary.currency,
          postedAt: j.date ? new Date(j.date * 1000).toISOString() : new Date().toISOString(),
          source: 'remoteok',
        } as ScrapedJob;
      });
  } catch (e: any) { console.error(`  [remoteok] ${e.message}`); return []; }
}

async function scrapeArbeitnow(): Promise<ScrapedJob[]> {
  try {
    const res = await fetch('https://www.arbeitnow.com/api/job-board-api', { signal: AbortSignal.timeout(12000) });
    const data = await res.json() as any;
    return (data.data || []).slice(0,80).map((j: any) => {
      const salary = parseSalary(j.salary || '');
      return {
        ...DEFAULTS,
        title: j.title||'Unknown', company: j.company_name||'Unknown',
        url: j.url||'', applyUrl: j.url||'',
        description: (j.description||'').replace(/<[^>]+>/g,'').slice(0,1200),
        location: cleanLocation(j.location||'Remote'),
        tags: (j.tags||[]).slice(0,10),
        isRemote: !!j.remote || detectRemote(j.title, j.location||'', j.description||''),
        salaryMin: salary.min, salaryMax: salary.max, salaryCurrency: 'EUR',
        postedAt: j.created_at||new Date().toISOString(),
        source: 'arbeitnow',
      } as ScrapedJob;
    });
  } catch (e: any) { console.error(`  [arbeitnow] ${e.message}`); return []; }
}

async function scrapeJobicy(): Promise<ScrapedJob[]> {
  try {
    const res = await fetch('https://jobicy.com/api/v2/remote-jobs?count=50&geo=worldwide', { signal: AbortSignal.timeout(12000) });
    const data = await res.json() as any;
    return (data.jobs||[]).map((j: any) => ({
      ...DEFAULTS,
      title: j.jobTitle||'Unknown', company: j.companyName||'Unknown',
      url: j.url||'', applyUrl: j.url||'',
      description: (j.jobDescription||'').replace(/<[^>]+>/g,'').slice(0,1200),
      location: cleanLocation(j.jobGeo||'Remote'),
      tags: (j.jobIndustry||[]).concat(j.jobType||[]).slice(0,10),
      salaryMin: j.annualSalaryMin||null, salaryMax: j.annualSalaryMax||null,
      salaryCurrency: j.salaryCurrency||'USD',
      postedAt: j.pubDate||new Date().toISOString(),
      source: 'jobicy',
    } as ScrapedJob));
  } catch (e: any) { console.error(`  [jobicy] ${e.message}`); return []; }
}

async function scrapeRemotive(): Promise<ScrapedJob[]> {
  try {
    const res = await fetch('https://remotive.com/api/remote-jobs?limit=100', { signal: AbortSignal.timeout(12000) });
    const data = await res.json() as any;
    return (data.jobs||[]).map((j: any) => {
      const salary = parseSalary(j.salary||'');
      return {
        ...DEFAULTS,
        title: j.title||'Unknown', company: j.company_name||'Unknown',
        url: j.url||'', applyUrl: j.url||'',
        description: (j.description||'').replace(/<[^>]+>/g,'').slice(0,1200),
        location: cleanLocation(j.candidate_required_location||'Remote'),
        tags: (j.tags||[]).slice(0,10),
        salaryMin: salary.min, salaryMax: salary.max, salaryCurrency: salary.currency,
        postedAt: j.publication_date||new Date().toISOString(),
        source: 'remotive',
      } as ScrapedJob;
    });
  } catch (e: any) { console.error(`  [remotive] ${e.message}`); return []; }
}

async function scrapeTheMuse(): Promise<ScrapedJob[]> {
  try {
    const res = await fetch('https://www.themuse.com/api/public/jobs?page=1&descending=true', { signal: AbortSignal.timeout(12000) });
    const data = await res.json() as any;
    return (data.results||[]).slice(0,60).map((j: any) => {
      const location = j.locations?.[0]?.name || 'Remote';
      return {
        ...DEFAULTS,
        title: j.name||'Unknown', company: j.company?.name||'Unknown',
        url: j.refs?.landing_page||'', applyUrl: j.refs?.landing_page||'',
        description: (j.contents||'').replace(/<[^>]+>/g,'').slice(0,1200),
        location: cleanLocation(location),
        tags: (j.categories||[]).map((c: any) => c.name?.toLowerCase()).filter(Boolean).slice(0,8),
        isRemote: detectRemote(j.name, location, j.contents||''),
        postedAt: j.publication_date||new Date().toISOString(),
        source: 'themuse',
      } as ScrapedJob;
    });
  } catch (e: any) { console.error(`  [themuse] ${e.message}`); return []; }
}

async function scrapeAdzuna(): Promise<ScrapedJob[]> {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) return [];
  try {
    const res = await fetch(
      `https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=${appId}&app_key=${appKey}&results_per_page=50&what=developer&content-type=application/json`,
      { signal: AbortSignal.timeout(12000) }
    );
    const data = await res.json() as any;
    return (data.results||[]).map((j: any) => ({
      ...DEFAULTS,
      title: j.title||'Unknown', company: j.company?.display_name||'Unknown',
      url: j.redirect_url||'', applyUrl: j.redirect_url||'',
      description: (j.description||'').slice(0,1200),
      location: cleanLocation(j.location?.display_name||'Remote'),
      tags: extractTags(`${j.title} ${j.description}`),
      isRemote: detectRemote(j.title, j.location?.display_name||'', j.description||''),
      salaryMin: j.salary_min ? Math.round(j.salary_min) : null,
      salaryMax: j.salary_max ? Math.round(j.salary_max) : null,
      postedAt: j.created||new Date().toISOString(),
      source: 'adzuna',
    } as ScrapedJob));
  } catch (e: any) { console.error(`  [adzuna] ${e.message}`); return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// RSS source list — 100+ feeds
// ─────────────────────────────────────────────────────────────────────────────

interface RSSSource { url: string; name: string; titleSplit?: string; defaultLocation?: string; limit?: number; }

const RSS_SOURCES: RSSSource[] = [
  // We Work Remotely — all categories
  { url: 'https://weworkremotely.com/remote-jobs.rss',                                        name: 'wwr',               titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-programming-jobs.rss',                 name: 'wwr-programming',   titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss',             name: 'wwr-devops',        titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-design-jobs.rss',                      name: 'wwr-design',        titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-product-jobs.rss',                     name: 'wwr-product',       titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-finance-legal-jobs.rss',               name: 'wwr-finance',       titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-marketing-jobs.rss',                   name: 'wwr-marketing',     titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-data-science-jobs.rss',                name: 'wwr-data',          titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-customer-support-jobs.rss',            name: 'wwr-support',       titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-sales-jobs.rss',                       name: 'wwr-sales',         titleSplit: ':' },

  // HN hiring threads
  { url: 'https://hnrss.org/whoishiring',                                                     name: 'hn-hiring',         limit: 40 },
  { url: 'https://hnhiring.com/rss',                                                          name: 'hnhiring' },

  // Remote-focused boards
  { url: 'https://remote.co/remote-jobs/feed/',                                               name: 'remoteco' },
  { url: 'https://jobspresso.co/feed/',                                                       name: 'jobspresso' },
  { url: 'https://nodesk.co/remote-jobs/rss.xml',                                            name: 'nodesk' },
  { url: 'https://remoteworkhub.com/remote-jobs/feed/',                                      name: 'remoteworkhub' },
  { url: 'https://authenticjobs.com/feed/',                                                   name: 'authenticjobs' },
  { url: 'https://himalayas.app/jobs/rss',                                                   name: 'himalayas',         defaultLocation: 'Remote' },
  { url: 'https://remoteindex.co/jobs.rss',                                                  name: 'remoteindex' },
  { url: 'https://remote.io/rss',                                                            name: 'remoteio' },
  { url: 'https://remoteleaf.com/whoishiring.xml',                                           name: 'remoteleaf' },
  { url: 'https://jobbit.io/feed',                                                           name: 'jobbit' },
  { url: 'https://europeremotely.com/feed.rss',                                              name: 'europeremotely',    defaultLocation: 'Europe Remote' },
  { url: 'https://remotebase.com/jobs/rss',                                                  name: 'remotebase' },
  { url: 'https://4dayweek.io/feed.xml',                                                     name: '4dayweek',          defaultLocation: 'Remote' },

  // Tech-general
  { url: 'https://stackoverflow.com/jobs/feed',                                               name: 'stackoverflow',     titleSplit: ' at ' },
  { url: 'https://www.workatastartup.com/jobs.rss',                                          name: 'workatastartup' },
  { url: 'https://www.ycombinator.com/jobs.rss',                                             name: 'yc-jobs' },
  { url: 'https://jobs.techstars.com/feeds/jobs.rss',                                        name: 'techstars' },
  { url: 'https://angel.co/job_listings.rss',                                                name: 'angelco' },
  { url: 'https://www.producthunt.com/jobs.rss',                                             name: 'producthunt-jobs' },
  { url: 'https://jobsintech.io/jobs.rss',                                                   name: 'jobsintech' },
  { url: 'https://smashingmagazine.com/jobs/feed/',                                          name: 'smashing-jobs' },
  { url: 'https://wellfound.com/jobs.rss',                                                   name: 'wellfound' },
  { url: 'https://geekwork.com/rss',                                                         name: 'geekwork' },

  // Greenhouse boards — top tech companies
  { url: 'https://boards.greenhouse.io/rss/stripe',                                          name: 'stripe' },
  { url: 'https://boards.greenhouse.io/rss/airbnb',                                          name: 'airbnb' },
  { url: 'https://boards.greenhouse.io/rss/notion',                                          name: 'notion' },
  { url: 'https://boards.greenhouse.io/rss/figma',                                           name: 'figma' },
  { url: 'https://boards.greenhouse.io/rss/linear',                                          name: 'linear' },
  { url: 'https://boards.greenhouse.io/rss/vercel',                                          name: 'vercel' },
  { url: 'https://boards.greenhouse.io/rss/supabase',                                        name: 'supabase' },
  { url: 'https://boards.greenhouse.io/rss/dropbox',                                         name: 'dropbox' },
  { url: 'https://boards.greenhouse.io/rss/twilio',                                          name: 'twilio' },
  { url: 'https://boards.greenhouse.io/rss/gitlab',                                          name: 'gitlab-gh' },
  { url: 'https://boards.greenhouse.io/rss/hashicorp',                                       name: 'hashicorp' },
  { url: 'https://boards.greenhouse.io/rss/plaid',                                           name: 'plaid' },
  { url: 'https://boards.greenhouse.io/rss/shopify',                                         name: 'shopify' },
  { url: 'https://boards.greenhouse.io/rss/mongodb',                                         name: 'mongodb' },
  { url: 'https://boards.greenhouse.io/rss/confluent',                                       name: 'confluent' },
  { url: 'https://boards.greenhouse.io/rss/databricks',                                      name: 'databricks' },
  { url: 'https://boards.greenhouse.io/rss/snowflake',                                       name: 'snowflake' },
  { url: 'https://boards.greenhouse.io/rss/retool',                                          name: 'retool' },
  { url: 'https://boards.greenhouse.io/rss/brex',                                            name: 'brex' },
  { url: 'https://boards.greenhouse.io/rss/ramp',                                            name: 'ramp' },
  { url: 'https://boards.greenhouse.io/rss/scale',                                           name: 'scale-ai' },
  { url: 'https://boards.greenhouse.io/rss/coinbase',                                        name: 'coinbase' },
  { url: 'https://boards.greenhouse.io/rss/robinhood',                                       name: 'robinhood' },
  { url: 'https://boards.greenhouse.io/rss/gusto',                                           name: 'gusto' },
  { url: 'https://boards.greenhouse.io/rss/carta',                                           name: 'carta' },
  { url: 'https://boards.greenhouse.io/rss/lattice',                                         name: 'lattice' },
  { url: 'https://boards.greenhouse.io/rss/doordash',                                        name: 'doordash' },
  { url: 'https://boards.greenhouse.io/rss/lyft',                                            name: 'lyft' },
  { url: 'https://boards.greenhouse.io/rss/instacart',                                       name: 'instacart' },
  { url: 'https://boards.greenhouse.io/rss/grammarly',                                       name: 'grammarly' },
  { url: 'https://boards.greenhouse.io/rss/calm',                                            name: 'calm' },
  { url: 'https://boards.greenhouse.io/rss/duolingo',                                        name: 'duolingo' },
  { url: 'https://boards.greenhouse.io/rss/discord',                                         name: 'discord' },
  { url: 'https://boards.greenhouse.io/rss/zendesk',                                         name: 'zendesk' },
  { url: 'https://boards.greenhouse.io/rss/amplitude',                                       name: 'amplitude' },
  { url: 'https://boards.greenhouse.io/rss/mixpanel',                                        name: 'mixpanel' },
  { url: 'https://boards.greenhouse.io/rss/segment',                                         name: 'segment' },
  { url: 'https://boards.greenhouse.io/rss/datadog',                                         name: 'datadog' },
  { url: 'https://boards.greenhouse.io/rss/pagerduty',                                       name: 'pagerduty' },
  { url: 'https://boards.greenhouse.io/rss/sendgrid',                                        name: 'sendgrid' },
  { url: 'https://boards.greenhouse.io/rss/cloudflare',                                      name: 'cloudflare-gh' },
  { url: 'https://boards.greenhouse.io/rss/fastly',                                          name: 'fastly' },
  { url: 'https://boards.greenhouse.io/rss/elastic',                                         name: 'elastic-gh' },

  // Lever boards
  { url: 'https://jobs.lever.co/openai/rss',                                                 name: 'openai' },
  { url: 'https://jobs.lever.co/anthropic/rss',                                              name: 'anthropic' },
  { url: 'https://jobs.lever.co/netlify/rss',                                                name: 'netlify' },
  { url: 'https://jobs.lever.co/cloudflare/rss',                                             name: 'cloudflare-lv' },
  { url: 'https://jobs.lever.co/reddit/rss',                                                 name: 'reddit' },
  { url: 'https://jobs.lever.co/hubspot/rss',                                                name: 'hubspot' },
  { url: 'https://jobs.lever.co/squarespace/rss',                                            name: 'squarespace' },
  { url: 'https://jobs.lever.co/pinterest/rss',                                              name: 'pinterest' },
  { url: 'https://jobs.lever.co/asana/rss',                                                  name: 'asana' },
  { url: 'https://jobs.lever.co/zapier/rss',                                                 name: 'zapier' },
  { url: 'https://jobs.lever.co/airtable/rss',                                               name: 'airtable' },
  { url: 'https://jobs.lever.co/intercom/rss',                                               name: 'intercom' },
  { url: 'https://jobs.lever.co/loom/rss',                                                   name: 'loom' },
  { url: 'https://jobs.lever.co/miro/rss',                                                   name: 'miro' },

  // Direct company feeds
  { url: 'https://about.gitlab.com/jobs/rss.xml',                                            name: 'gitlab-direct' },
  { url: 'https://jobs.automattic.com/feed/',                                                 name: 'automattic',        defaultLocation: 'Remote' },

  // AI / ML
  { url: 'https://aijobs.net/feed/',                                                         name: 'aijobs' },
  { url: 'https://mlremote.com/feed/',                                                       name: 'mlremote',          defaultLocation: 'Remote' },

  // Crypto / Web3
  { url: 'https://cryptojobslist.com/rss',                                                   name: 'cryptojobslist' },
  { url: 'https://web3.career/remote-jobs.rss',                                              name: 'web3career',        defaultLocation: 'Remote' },

  // Design
  { url: 'https://dribbble.com/jobs.rss',                                                    name: 'dribbble-jobs' },
  { url: 'https://designerjobs.co/jobs.rss',                                                 name: 'designerjobs' },

  // Data
  { url: 'https://www.datascienceweekly.org/rss/data-science-jobs.xml',                      name: 'datascienceweekly' },
  { url: 'https://datajobs.com/rss',                                                         name: 'datajobs' },

  // DevOps / SRE
  { url: 'https://devops.jobs/feed/',                                                        name: 'devops-jobs' },

  // Product
  { url: 'https://productmanagerhq.com/jobs/feed/',                                          name: 'pmhq' },

  // Language-specific
  { url: 'https://golangprojects.com/golang-go-job-rss-feed.xml',                           name: 'golangprojects' },
  { url: 'https://rustjobs.dev/feed.xml',                                                   name: 'rustjobs' },
  { url: 'https://elixirjobs.net/rss',                                                      name: 'elixirjobs' },
  { url: 'https://www.rubyonremote.com/remote-jobs.rss',                                    name: 'rubyonremote' },
  { url: 'https://pythonjobs.github.io/feed.xml',                                           name: 'pythonjobs' },
  { url: 'https://javascriptjob.app/feed.xml',                                              name: 'javascriptjob' },

  // Mobile
  { url: 'https://iosdevjobs.com/feed/',                                                     name: 'iosdevjobs' },
  { url: 'https://www.androidjobs.io/rss.xml',                                              name: 'androidjobs' },

  // Security
  { url: 'https://cybersecjobs.com/jobs.rss',                                               name: 'cybersecjobs' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Persist to DB
// ─────────────────────────────────────────────────────────────────────────────

function persistJobs(jobs: ScrapedJob[]): number {
  if (!jobs.length) return 0;
  const db = getDB();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO jobs
      (id, title, company, url, apply_url, description, location,
       salary_min, salary_max, salary_currency, tags, source, is_remote, scraped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);
  const run = db.transaction((items: ScrapedJob[]) => {
    let n = 0;
    for (const j of items) {
      if (!j.url || !j.title) continue;
      try {
        const info = stmt.run(
          uuidv4(), j.title, j.company, j.url, j.applyUrl || j.url,
          j.description, j.location,
          j.salaryMin, j.salaryMax, j.salaryCurrency,
          JSON.stringify(j.tags), j.source, j.isRemote ? 1 : 0
        );
        if (info.changes > 0) n++;
      } catch { /* skip bad row */ }
    }
    return n;
  });
  return run(jobs) as number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator — batched parallel execution
// ─────────────────────────────────────────────────────────────────────────────

async function runScrape(): Promise<void> {
  const t0 = Date.now();
  console.log(`\n[scraper] Starting — ${RSS_SOURCES.length} RSS feeds + 6 JSON APIs`);

  const rssTasks  = RSS_SOURCES.map(s => () => scrapeRSS(s.url, s.name, { titleSplit: s.titleSplit, defaultLocation: s.defaultLocation, limit: s.limit }));
  const apiTasks  = [
    () => scrapeRemoteOK(),
    () => scrapeArbeitnow(),
    () => scrapeJobicy(),
    () => scrapeRemotive(),
    () => scrapeTheMuse(),
    () => scrapeAdzuna(),
  ];

  const all = [...rssTasks, ...apiTasks];
  const BATCH = 15;
  const collected: ScrapedJob[] = [];

  for (let i = 0; i < all.length; i += BATCH) {
    const settled = await Promise.allSettled(all.slice(i, i + BATCH).map(fn => fn()));
    for (const r of settled) {
      if (r.status === 'fulfilled') collected.push(...r.value);
    }
    if (i + BATCH < all.length) await new Promise(r => setTimeout(r, 250));
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  const unique = collected.filter(j => j.url && !seen.has(j.url) && seen.add(j.url));

  const inserted = persistJobs(unique);
  const elapsed  = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[scraper] Done — ${unique.length} unique, ${inserted} new inserted (${elapsed}s)\n`);
}

/** Start cron — every 30 minutes */
export function startJobScraper(): void {
  runScrape();
  cron.schedule('*/30 * * * *', runScrape);
  console.log('[scraper] Cron running every 30 minutes');
}
