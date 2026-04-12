import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { initDB } from './db/database';
import { startJobScraper } from './services/scraper';
import authRoutes from './routes/auth';
import jobRoutes from './routes/jobs';
import userRoutes from './routes/user';

const app = express();
const PORT = process.env.PORT || 8080;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',');

/** Security headers */
app.use(helmet({ contentSecurityPolicy: false }));

/** CORS - whitelist only */
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

/** Rate limiting - 100 req / 15 min per IP */
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
}));

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

/** Routes */
app.use('/api/auth', authRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/user', userRoutes);

/** Health check */
app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

/** Global error handler */
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.message);
  res.status(500).json({ error: 'Internal server error' });
});

(async () => {
  await initDB();
  startJobScraper();
  app.listen(PORT, () => console.log(`Backend running on :${PORT}`));
})();

export default app;
