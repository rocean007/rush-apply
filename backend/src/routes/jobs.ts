import { Router, Request, Response } from 'express';
import { query } from 'express-validator';
import { getDB } from '../db/database';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { v4 as uuidv4 } from 'uuid';
import { generateCoverLetter } from '../services/ai';

const router = Router();

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

/**
 * GET /api/jobs
 * Paginated, filterable job listings — returns location, salary, applyUrl
 */
router.get('/', [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 50 }),
  query('search').optional().trim().escape(),
  query('source').optional().trim(),
  query('location').optional().trim(),
  query('remote').optional().isBoolean(),
  query('salaryMin').optional().isInt(),
], (req: Request, res: Response) => {
  const db = getDB();
  const page      = parseInt(req.query.page    as string) || 1;
  const limit     = parseInt(req.query.limit   as string) || 20;
  const offset    = (page - 1) * limit;
  const search    = req.query.search    as string;
  const source    = req.query.source    as string;
  const location  = req.query.location  as string;
  const remoteOnly = req.query.remote === 'true';
  const salaryMin = req.query.salaryMin ? parseInt(req.query.salaryMin as string) : null;

  let where = 'WHERE 1=1';
  const params: any[] = [];

  if (search) {
    where += ' AND (title LIKE ? OR company LIKE ? OR tags LIKE ? OR description LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (source)    { where += ' AND source = ?';      params.push(source); }
  if (location)  { where += ' AND location LIKE ?'; params.push(`%${location}%`); }
  if (remoteOnly){ where += ' AND is_remote = 1'; }
  if (salaryMin) { where += ' AND salary_min >= ?'; params.push(salaryMin); }

  const total = (db.prepare(`SELECT COUNT(*) as cnt FROM jobs ${where}`).get(...params) as any).cnt;
  const rows  = db.prepare(
    `SELECT id, title, company, location, url, apply_url,
            salary_min, salary_max, salary_currency,
            tags, source, is_remote, scraped_at,
            posted_at, job_type, experience_level,
            apply_payload, description
     FROM jobs ${where}
     ORDER BY scraped_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as any[];

  // Parse JSON tags for each row
  const jobs = rows.map(j => ({
    ...j,
    tags:            (() => { try { return JSON.parse(j.tags || '[]');          } catch { return []; }  })(),
    applyPayload:    (() => { try { return JSON.parse(j.apply_payload || '{}'); } catch { return {}; }  })(),
    isRemote:        !!j.is_remote,
    applyUrl:        j.apply_url || j.url,
    salaryMin:       j.salary_min,
    salaryMax:       j.salary_max,
    salaryCurrency:  j.salary_currency || 'USD',
    postedAt:        j.posted_at,
    postedAgo:       timeAgo(j.posted_at),
    jobType:         j.job_type || 'full-time',
    experienceLevel: j.experience_level || '',
    scrapedAt:       j.scraped_at,
  }));

  return res.json({ jobs, total, page, pages: Math.ceil(total / limit) });
});

/**
 * GET /api/jobs/sources
 * Returns list of all unique sources for filter UI
 */
router.get('/sources', (_req: Request, res: Response) => {
  const db = getDB();
  const sources = db.prepare('SELECT DISTINCT source FROM jobs ORDER BY source').all() as any[];
  return res.json(sources.map((s: any) => s.source));
});

/**
 * POST /api/jobs/apply/:jobId
 * Auto-apply to a job (auth required) — generates cover letter via AI
 */
router.post('/apply/:jobId', requireAuth, async (req: AuthRequest, res: Response) => {
  const db = getDB();
  const { jobId } = req.params;
  const userId = req.userId!;

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const existing = db.prepare(
    'SELECT id FROM applications WHERE user_id = ? AND job_id = ?'
  ).get(userId, jobId);
  if (existing) return res.status(409).json({ error: 'Already applied' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;

  let coverLetter = '';
  try { coverLetter = await generateCoverLetter(user, job); }
  catch (e) { console.error('AI cover letter error:', e); }

  const appId = uuidv4();
  db.prepare(
    `INSERT INTO applications (id, user_id, job_id, status, cover_letter)
     VALUES (?, ?, ?, 'pending', ?)`
  ).run(appId, userId, jobId, coverLetter);

  return res.status(201).json({
    applicationId: appId,
    status: 'pending',
    coverLetter,
    applyUrl: job.apply_url || job.url,
  });
});

export default router;