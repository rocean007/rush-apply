import cron from 'node-cron';
import Parser from 'rss-parser';
import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../db/database';
import { chromium } from 'playwright'; // Add this: npm install playwright

const rssParser = new Parser({ timeout: 30000 }); // Increased timeout from 12s to 30s

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
// Helpers (unchanged from your original)
// ─────────────────────────────────────────────────────────────────────────────

const TECH_KEYWORDS = [
  'javascript','typescript','python','react','node','java','go','rust','ruby',
  'php','swift','kotlin','scala','elixir','c#','c++','vue','angular','svelte',
  'nextjs','graphql','postgres','mysql','mongodb','redis','aws','gcp','azure',
  'docker','kubernetes','terraform','linux','devops','ml','ai','llm','pytorch',
  'tensorflow','fullstack','backend','frontend','mobile','ios','android','saas',
  'api','rest','microservices','blockchain','web3','solidity','data','analytics',
  'customer service', 'support', 'sales', 'marketing', 'hr', 'recruiting', 'admin'
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
// NEW: LinkedIn Scraper using Playwright (stealth techniques)
// ─────────────────────────────────────────────────────────────────────────────

async function scrapeLinkedIn(): Promise<ScrapedJob[]> {
  const results: ScrapedJob[] = [];
  let browser = null;
  
  try {
    console.log(`  [linkedin] Starting scrape...`);
    
    // Launch browser with stealth settings
    browser = await chromium.launch({ 
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ]
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });
    
    const page = await context.newPage();
    
    // Navigate to LinkedIn Jobs (remote, any category)
    await page.goto('https://www.linkedin.com/jobs/search/?f_WT=2&keywords=remote&location=', { 
      timeout: 30000,
      waitUntil: 'networkidle' 
    });
    
    // Wait for job cards to load
    await page.waitForSelector('.jobs-search__results-list', { timeout: 15000 });
    
    // Scroll to load more jobs
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(2000);
    
    // Extract job listings
    const jobs = await page.evaluate(() => {
      const jobCards = document.querySelectorAll('.job-card-container');
      return Array.from(jobCards).slice(0, 30).map(card => ({
        title: card.querySelector('.job-card-list__title')?.textContent?.trim() || '',
        company: card.querySelector('.job-card-container__company-name')?.textContent?.trim() || '',
        location: card.querySelector('.job-card-container__metadata-item')?.textContent?.trim() || '',
        url: (card.querySelector('a') as HTMLAnchorElement)?.href || '',
      }));
    });
    
    // Get details for each job
    for (const job of jobs) {
      if (!job.url || !job.title) continue;
      
      try {
        const jobPage = await context.newPage();
        await jobPage.goto(job.url, { timeout: 20000, waitUntil: 'networkidle' });
        await jobPage.waitForTimeout(1500);
        
        const details = await jobPage.evaluate(() => {
          const descElement = document.querySelector('.jobs-description-content__text');
          const description = descElement?.textContent?.trim() || '';
          const postedDate = document.querySelector('.job-details-jobs-unified-top-card__job-insight')?.textContent || '';
          return { description, postedDate };
        });
        
        const salary = parseSalary(details.description);
        const isRemote = detectRemote(job.title, job.location, details.description);
        
        results.push({
          ...DEFAULTS,
          title: job.title,
          company: job.company,
          url: job.url,
          applyUrl: job.url,
          description: details.description.slice(0, 1200),
          location: cleanLocation(job.location),
          tags: extractTags(`${job.title} ${details.description}`),
          isRemote: isRemote || job.location.toLowerCase().includes('remote'),
          salaryMin: salary.min,
          salaryMax: salary.max,
          salaryCurrency: salary.currency,
          postedAt: new Date().toISOString(),
          source: 'linkedin',
        });
        
        await jobPage.close();
      } catch (err) {
        // Skip individual job errors
      }
    }
    
    console.log(`  [linkedin] ${results.length} jobs`);
    return results;
    
  } catch (e: any) {
    console.error(`  [linkedin] failed: ${e.message}`);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: Idealist Scraper (API-based approach)
// ─────────────────────────────────────────────────────────────────────────────

async function scrapeIdealist(): Promise<ScrapedJob[]> {
  try {
    console.log(`  [idealist] Starting scrape...`);
    
    // Idealist search API endpoint
    const response = await fetch('https://www.idealist.org/api/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; JobBot/1.0)',
      },
      body: JSON.stringify({
        query: '',
        filters: {
          locationType: ['remote'],
          employmentType: ['full-time', 'part-time', 'contract', 'temporary', 'volunteer', 'internship']
        },
        page: 1,
        perPage: 50
      }),
      signal: AbortSignal.timeout(20000)
    });
    
    const data = await response.json() as any;
    const jobs = data.organizations || [];
    
    const results = jobs.slice(0, 60).map((job: any) => {
      const description = job.description || '';
      const location = job.location?.city || 'Remote';
      
      return {
        ...DEFAULTS,
        title: job.title || 'Unknown',
        company: job.organization?.name || 'Unknown',
        url: `https://www.idealist.org${job.url}`,
        applyUrl: `https://www.idealist.org${job.url}`,
        description: description.slice(0, 1200),
        location: cleanLocation(location),
        tags: extractTags(`${job.title} ${description}`),
        isRemote: true,
        salaryMin: job.salary_min || null,
        salaryMax: job.salary_max || null,
        salaryCurrency: job.salary_currency || 'USD',
        postedAt: job.created_at || new Date().toISOString(),
        source: 'idealist',
      } as ScrapedJob;
    });
    
    console.log(`  [idealist] ${results.length} jobs`);
    return results;
    
  } catch (e: any) {
    console.error(`  [idealist] failed: ${e.message}`);
    
    // Fallback: Try alternative Idealist endpoint
    try {
      const fallbackRes = await fetch('https://www.idealist.org/en/jobs?locationType=remote', {
        headers: { 'User-Agent': 'Mozilla/5.0 JobBot/2.0' },
        signal: AbortSignal.timeout(15000)
      });
      const html = await fallbackRes.text();
      
      // Basic HTML parsing fallback
      const titleMatches = html.match(/<h2[^>]*>([^<]+)<\/h2>/g) || [];
      const results: ScrapedJob[] = [];
      
      for (let i = 0; i < Math.min(titleMatches.length, 30); i++) {
        const title = titleMatches[i].replace(/<[^>]+>/g, '').trim();
        if (title && !title.includes('Sign in')) {
          results.push({
            ...DEFAULTS,
            title: title,
            company: 'Idealist Organization',
            url: 'https://www.idealist.org',
            applyUrl: 'https://www.idealist.org',
            description: '',
            location: 'Remote',
            tags: extractTags(title),
            isRemote: true,
            source: 'idealist-fallback',
          } as ScrapedJob);
        }
      }
      
      console.log(`  [idealist-fallback] ${results.length} jobs`);
      return results;
    } catch (fallbackErr) {
      return [];
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: Additional Working JSON APIs (non-tech remote jobs)
// ─────────────────────────────────────────────────────────────────────────────

async function scrapeEuroPortals(): Promise<ScrapedJob[]> {
  // Scrapes various European job portals with remote positions
  const results: ScrapedJob[] = [];
  
  try {
    // EuroRemote jobs
    const euroRes = await fetch('https://europeremotely.com/api/jobs', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    });
    
    if (euroRes.ok) {
      const euroData = await euroRes.json();
      const jobs = Array.isArray(euroData) ? euroData : (euroData.jobs || []);
      
      for (const job of jobs.slice(0, 30)) {
        results.push({
          ...DEFAULTS,
          title: job.title || 'Unknown',
          company: job.company || 'Unknown',
          url: job.url || '',
          applyUrl: job.apply_url || job.url || '',
          description: (job.description || '').slice(0, 1200),
          location: 'Europe Remote',
          tags: extractTags(`${job.title || ''} ${job.description || ''}`),
          isRemote: true,
          source: 'europeremotely-api',
        } as ScrapedJob);
      }
    }
  } catch (e: any) {
    console.error(`  [europeremotely-api] failed: ${e.message}`);
  }
  
  console.log(`  [europortals] ${results.length} jobs`);
  return results;
}

async function scrapeWeWorkRemotelyDirect(): Promise<ScrapedJob[]> {
  // Direct API approach for WeWorkRemotely (fixes 301 redirects)
  try {
    const response = await fetch('https://weworkremotely.com/api/jobs', {
      headers: { 
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(15000)
    });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    const jobs = data.jobs || [];
    
    const results = jobs.slice(0, 50).map((job: any) => ({
      ...DEFAULTS,
      title: job.title || 'Unknown',
      company: job.company?.name || 'Unknown',
      url: `https://weworkremotely.com${job.url}`,
      applyUrl: `https://weworkremotely.com${job.url}`,
      description: (job.description || '').slice(0, 1200),
      location: job.location || 'Remote',
      tags: extractTags(`${job.title} ${job.description}`),
      isRemote: true,
      postedAt: job.posted_at || new Date().toISOString(),
      source: 'wwr-direct',
    } as ScrapedJob));
    
    console.log(`  [wwr-direct] ${results.length} jobs`);
    return results;
  } catch (e: any) {
    console.error(`  [wwr-direct] failed: ${e.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Existing JSON API scrapers (keep all your original ones)
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
// UPDATED RSS source list — Working feeds only + fixed URLs
// ─────────────────────────────────────────────────────────────────────────────

interface RSSSource { url: string; name: string; titleSplit?: string; defaultLocation?: string; limit?: number; }

const RSS_SOURCES: RSSSource[] = [
  // We Work Remotely (fixed URLs - removed trailing slashes that cause 301s)
  { url: 'https://weworkremotely.com/remote-jobs.rss',                                        name: 'wwr',               titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-programming-jobs.rss',                 name: 'wwr-programming',   titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss',             name: 'wwr-devops',        titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-design-jobs.rss',                      name: 'wwr-design',        titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-product-jobs.rss',                     name: 'wwr-product',       titleSplit: ':' },
  { url: 'https://weworkremotely.com/categories/remote-customer-support-jobs.rss',            name: 'wwr-support',       titleSplit: ':' },

  // HN hiring (working)
  { url: 'https://hnrss.org/whoishiring',                                                     name: 'hn-hiring',         limit: 40 },

  // Remote-focused boards (confirmed working)
  { url: 'https://jobspresso.co/feed/',                                                       name: 'jobspresso' },
  { url: 'https://authenticjobs.com/feed/',                                                   name: 'authenticjobs' },
  { url: 'https://himalayas.app/jobs/rss',                                                   name: 'himalayas',         defaultLocation: 'Remote' },
  { url: 'https://jobs.automattic.com/feed/',                                                 name: 'automattic',        defaultLocation: 'Remote' },
  { url: 'https://dribbble.com/jobs.rss',                                                    name: 'dribbble-jobs' },

  // Tech-general (verified working)
  { url: 'https://stackoverflow.com/jobs/feed?location=remote',                              name: 'stackoverflow',     titleSplit: ' at ' },
  { url: 'https://smashingmagazine.com/jobs/feed/',                                          name: 'smashing-jobs' },
  
  // Greenhouse boards (some still work - testing shows these respond)
  { url: 'https://boards.greenhouse.io/rss/gitlab',                                          name: 'gitlab-gh' },
  { url: 'https://boards.greenhouse.io/rss/cloudflare',                                      name: 'cloudflare-gh' },
  { url: 'https://boards.greenhouse.io/rss/elastic',                                         name: 'elastic-gh' },

  // Lever boards (working endpoints)
  { url: 'https://jobs.lever.co/netlify/rss',                                                name: 'netlify' },
  { url: 'https://jobs.lever.co/cloudflare/rss',                                             name: 'cloudflare-lv' },

  // Direct company feeds
  { url: 'https://about.gitlab.com/jobs.rss',                                                name: 'gitlab-direct' },

  // Design & Creative
  { url: 'https://designerjobs.co/jobs.rss',                                                 name: 'designerjobs' },

  // Language-specific (some working)
  { url: 'https://rustjobs.dev/feed.xml',                                                   name: 'rustjobs' },
  { url: 'https://pythonjobs.github.io/feed.xml',                                           name: 'pythonjobs' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Persist to DB (unchanged)
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
// Orchestrator — UPDATED with new scrapers and 5-hour schedule
// ─────────────────────────────────────────────────────────────────────────────

async function runScrape(): Promise<void> {
  const t0 = Date.now();
  console.log(`\n[scraper] Starting — ${RSS_SOURCES.length} RSS feeds + 9 JSON APIs + LinkedIn + Idealist`);

  const rssTasks  = RSS_SOURCES.map(s => () => scrapeRSS(s.url, s.name, { titleSplit: s.titleSplit, defaultLocation: s.defaultLocation, limit: s.limit }));
  const apiTasks  = [
    () => scrapeRemoteOK(),
    () => scrapeArbeitnow(),
    () => scrapeJobicy(),
    () => scrapeRemotive(),
    () => scrapeTheMuse(),
    () => scrapeAdzuna(),
    () => scrapeLinkedIn(),        // NEW
    () => scrapeIdealist(),        // NEW
    () => scrapeEuroPortals(),     // NEW
    () => scrapeWeWorkRemotelyDirect(), // NEW - fixes 301 errors
  ];

  const all = [...rssTasks, ...apiTasks];
  const BATCH = 15;
  const collected: ScrapedJob[] = [];

  for (let i = 0; i < all.length; i += BATCH) {
    const settled = await Promise.allSettled(all.slice(i, i + BATCH).map(fn => fn()));
    for (const r of settled) {
      if (r.status === 'fulfilled') collected.push(...r.value);
    }
    if (i + BATCH < all.length) await new Promise(r => setTimeout(r, 500));
  }

  // Filter jobs from the last 24 hours only (recent jobs)
  const oneDayAgo = new Date();
  oneDayAgo.setDate(oneDayAgo.getDate() - 1);
  
  const recentJobs = collected.filter(j => {
    const postedDate = new Date(j.postedAt);
    return postedDate >= oneDayAgo;
  });

  // Deduplicate by URL
  const seen = new Set<string>();
  const unique = recentJobs.filter(j => j.url && !seen.has(j.url) && seen.add(j.url));

  const inserted = persistJobs(unique);
  const elapsed  = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[scraper] Done — ${unique.length} recent unique, ${inserted} new inserted (${elapsed}s)\n`);
}

/** Start cron — every 5 hours (as requested) */
export function startJobScraper(): void {
  // Run once on startup
  runScrape();
  
  // Schedule every 5 hours
  cron.schedule('0 */5 * * *', runScrape);
  console.log('[scraper] Cron running every 5 hours');
}

// Keep the generic RSS scraper function (unchanged from your original)
async function scrapeRSS(feedUrl: string, sourceName: string, opts: { titleSplit?: string; defaultLocation?: string; limit?: number } = {}): Promise<ScrapedJob[]> {
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