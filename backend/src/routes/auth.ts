import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../db/database';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret';

const cookieOpts = (rememberMe: boolean) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  maxAge: rememberMe ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000,
});

/**
 * POST /api/auth/register
 * Register a new user account
 */
router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  body('fullName').trim().isLength({ min: 2 }),
], async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password, fullName } = req.body;
  const db = getDB();

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const passwordHash = await bcrypt.hash(password, 12);
  const id = uuidv4();

  db.prepare(
    'INSERT INTO users (id, email, password_hash, full_name) VALUES (?, ?, ?, ?)'
  ).run(id, email, passwordHash, fullName);

  const token = jwt.sign({ userId: id }, JWT_SECRET, { expiresIn: '1d' });
  res.cookie('token', token, cookieOpts(false));
  return res.status(201).json({ id, email, fullName });
});

/**
 * POST /api/auth/login
 * Authenticate user and set JWT cookie
 */
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password, rememberMe } = req.body;
  const db = getDB();

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const expiresIn = rememberMe ? '7d' : '1d';
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn });
  res.cookie('token', token, cookieOpts(!!rememberMe));

  return res.json({ id: user.id, email: user.email, fullName: user.full_name });
});

/**
 * POST /api/auth/logout
 * Clear auth cookie
 */
router.post('/logout', (_req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

export default router;
