import { Router, Response } from 'express';
import { body } from 'express-validator';
import { getDB } from '../db/database';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { generateResume } from '../services/ai';

const router = Router();
router.use(requireAuth);

/**
 * GET /api/user/profile
 * Get current user profile with resume info
 */
router.get('/profile', (req: AuthRequest, res: Response) => {
  const user = getDB().prepare(
    'SELECT id, email, full_name, title, skills, experience, education, resume_text, created_at FROM users WHERE id = ?'
  ).get(req.userId) as any;

  if (!user) return res.status(404).json({ error: 'User not found' });

  return res.json({
    ...user,
    skills: JSON.parse(user.skills || '[]'),
    experience: JSON.parse(user.experience || '[]'),
    education: JSON.parse(user.education || '[]'),
  });
});

/**
 * PUT /api/user/profile
 * Update user profile
 */
router.put('/profile', [
  body('fullName').optional().trim().isLength({ min: 2 }),
  body('title').optional().trim(),
  body('skills').optional().isArray(),
], (req: AuthRequest, res: Response) => {
  const { fullName, title, skills, experience, education } = req.body;
  const db = getDB();

  db.prepare(`
    UPDATE users SET
      full_name = COALESCE(?, full_name),
      title = COALESCE(?, title),
      skills = COALESCE(?, skills),
      experience = COALESCE(?, experience),
      education = COALESCE(?, education),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    fullName || null,
    title || null,
    skills ? JSON.stringify(skills) : null,
    experience ? JSON.stringify(experience) : null,
    education ? JSON.stringify(education) : null,
    req.userId
  );

  return res.json({ ok: true });
});

/**
 * POST /api/user/resume/generate
 * AI-powered resume generation using Pollinations
 */
router.post('/resume/generate', [
  body('jobDescription').notEmpty().trim(),
], async (req: AuthRequest, res: Response) => {
  const db = getDB();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId) as any;
  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    const resume = await generateResume(user, req.body.jobDescription);
    db.prepare('UPDATE users SET resume_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(resume, req.userId);
    return res.json({ resume });
  } catch (e: any) {
    return res.status(503).json({ error: 'AI service unavailable', detail: e.message });
  }
});

/**
 * GET /api/user/applications
 * List user's applications with job details
 */
router.get('/applications', (req: AuthRequest, res: Response) => {
  const apps = getDB().prepare(`
    SELECT a.*, j.title, j.company, j.url, j.location
    FROM applications a
    JOIN jobs j ON a.job_id = j.id
    WHERE a.user_id = ?
    ORDER BY a.applied_at DESC
  `).all(req.userId);

  return res.json(apps);
});

export default router;
