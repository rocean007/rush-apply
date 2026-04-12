import { Router, Request, Response } from 'express';
import { query } from 'express-validator';
import { getDB } from '../db/database';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { v4 as uuidv4 } from 'uuid';
import { generateCoverLetter } from '../services/ai';

const router = Router();

/**
 * GET /api/jobs
 * Paginated, filterable job listings
 */
router.get('/', [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 50 }),
  query('search').optional().trim().escape(),
  query('source').optional().trim(),
  query('remote').optional().isBoolean(),
], (req: Request, res: Response) => {
  const db = getDB();
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const offset = (page - 1) * limit;
  const search = req.query.search as string;
  const source = req.query.source as string;

  let where = 'WHERE 1=1';
  const params: any[] = [];

  if (search) {
    where += ' AND (title LIKE ? OR company LIKE ? OR tags LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (source) {
    where += ' AND source = ?';
    params.push(source);
  }

  const total = (db.prepare(`SELECT COUNT(*) as cnt FROM jobs ${where}`).get(...params) as any).cnt;
  const jobs = db.prepare(
    `SELECT * FROM jobs ${where} ORDER BY scraped_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  res.json({ jobs, total, page, pages: Math.ceil(total / limit) });
});

/**
 * POST /api/jobs/apply/:jobId
 * Auto-apply to a job (auth required)
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

  // Generate cover letter via AI
  let coverLetter = '';
  try {
    coverLetter = await generateCoverLetter(user, job);
  } catch (e) {
    console.error('AI cover letter failed, proceeding without:', e);
  }

  const appId = uuidv4();
  db.prepare(
    `INSERT INTO applications (id, user_id, job_id, status, cover_letter)
     VALUES (?, ?, ?, 'pending', ?)`
  ).run(appId, userId, jobId, coverLetter);

  return res.status(201).json({ applicationId: appId, status: 'pending', coverLetter });
});

export default router;
