import cron from 'node-cron';
import Parser from 'rss-parser';
import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../db/database';

const parser = new Parser();

interface ScrapedJob {
  title: string;
  company: string;
  url: string;
  description?: string;
  tags: string[];
  source: string;
}

/** Scrape WeWorkRemotely RSS feeds */
async function scrapeWWR(): Promise<ScrapedJob[]> {
  try {
    const categories = [
      'https://weworkremotely.com/remote-jobs.rss',
      'https://weworkremotely.com/categories/remote-programming-jobs.rss',
    ];

    const results: ScrapedJob[] = [];
    for (const url of categories) {
      const feed = await parser.parseURL(url);
      for (const item of feed.items.slice(0, 20)) {
        if (!item.link || !item.title) continue;
        const [company, ...titleParts] = (item.title || '').split(': ');
        results.push({
          title: titleParts.join(': ') || item.title || 'Unknown',
          company: company || 'Unknown',
          url: item.link,
          description: item.contentSnippet?.slice(0, 1000),
          tags: extractTags(item.title || ''),
          source: 'weworkremotely',
        });
      }
    }
    return results;
  } catch (e) {
    console.error('WWR scrape failed:', e);
    return [];
  }
}

/** Scrape RemoteOK API */
async function scrapeRemoteOK(): Promise<ScrapedJob[]> {
  try {
    const response = await fetch('https://remoteok.com/api', {
      headers: { 'User-Agent': 'AutoJobAgent/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json() as any[];
    return data.slice(1, 30)
      .filter(j => j.position && j.company && j.url)
      .map(j => ({
        title: j.position,
        company: j.company,
        url: j.url,
        description: j.description?.slice(0, 1000),
        tags: j.tags || [],
        source: 'remoteok',
      }));
  } catch (e) {
    console.error('RemoteOK scrape failed:', e);
    return [];
  }
}

/** Extract tech tags from job title */
function extractTags(title: string): string[] {
  const keywords = ['javascript', 'typescript', 'python', 'react', 'node', 'java', 'go', 'rust',
    'aws', 'docker', 'kubernetes', 'ml', 'ai', 'fullstack', 'backend', 'frontend', 'devops'];
  return keywords.filter(k => title.toLowerCase().includes(k));
}

/** Persist scraped jobs to database (upsert by URL) */
function persistJobs(jobs: ScrapedJob[]): void {
  const db = getDB();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO jobs (id, title, company, url, description, tags, source, is_remote)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `);

  const insertMany = db.transaction((items: ScrapedJob[]) => {
    for (const job of items) {
      stmt.run(uuidv4(), job.title, job.company, job.url,
        job.description, JSON.stringify(job.tags), job.source);
    }
  });

  insertMany(jobs);
  console.log(`Persisted ${jobs.length} jobs`);
}

/** Run one scrape cycle */
async function runScrape(): Promise<void> {
  console.log('Running job scrape...');
  const [wwrJobs, remoteOKJobs] = await Promise.allSettled([scrapeWWR(), scrapeRemoteOK()]);
  const allJobs = [
    ...(wwrJobs.status === 'fulfilled' ? wwrJobs.value : []),
    ...(remoteOKJobs.status === 'fulfilled' ? remoteOKJobs.value : []),
  ];
  persistJobs(allJobs);
}

/** Start scraper cron - every 30 minutes */
export function startJobScraper(): void {
  runScrape(); // Run immediately on startup
  cron.schedule('*/30 * * * *', runScrape);
  console.log('Job scraper started (every 30 minutes)');
}
