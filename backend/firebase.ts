/**
 * firebase.ts
 * Wraps the Express app as a Firebase Cloud Function (HTTPS).
 * The backend/src/index.ts app is imported directly — no duplication.
 *
 * Deploy:  cd backend/functions && npm run deploy
 * Emulate: cd backend/functions && npm run serve
 */

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

// Initialise Firebase Admin once
if (!admin.apps.length) {
  admin.initializeApp();
}

// Set env vars from Firebase Functions config before importing the app.
// These mirror the variables in backend/.env — set them via:
//   firebase functions:config:set app.jwt_secret="…" app.database_url="postgres://…"
const cfg = functions.config();
if (cfg.app) {
  process.env.JWT_SECRET       = cfg.app.jwt_secret       || process.env.JWT_SECRET;
  process.env.DATABASE_URL     = cfg.app.database_url     || process.env.DATABASE_URL;
  process.env.ALLOWED_ORIGINS  = cfg.app.allowed_origins  || process.env.ALLOWED_ORIGINS;
  process.env.INTERNAL_API_KEY = cfg.app.internal_api_key || process.env.INTERNAL_API_KEY;
  process.env.GROQ_API_KEY     = cfg.app.groq_api_key     || process.env.GROQ_API_KEY;
}

// Import the Express app (database init happens inside)
// We use a dynamic require so env vars above are applied first.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { default: app } = require('../../dist/index');

/**
 * api — all Express routes exposed at /api/*
 * Firebase rewrites (firebase.json) map /** → this function.
 */
export const api = functions
  .runWith({ memory: '512MB', timeoutSeconds: 60 })
  .https.onRequest(app);