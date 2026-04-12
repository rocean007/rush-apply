-- Auto Job Agent Database Schema

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  title TEXT,
  skills TEXT DEFAULT '[]',
  experience TEXT DEFAULT '[]',
  education TEXT DEFAULT '[]',
  resume_text TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT DEFAULT 'Remote',
  description TEXT,
  url TEXT UNIQUE NOT NULL,
  apply_url TEXT,
  source TEXT NOT NULL,
  salary_min INTEGER,
  salary_max INTEGER,
  salary_currency TEXT DEFAULT 'USD',
  tags TEXT DEFAULT '[]',
  is_remote INTEGER DEFAULT 1,
  scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME
);

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  status TEXT DEFAULT 'pending',
  cover_letter TEXT,
  tailored_resume TEXT,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  notes TEXT,
  UNIQUE(user_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_source   ON jobs(source);
CREATE INDEX IF NOT EXISTS idx_jobs_scraped  ON jobs(scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_location ON jobs(location);
CREATE INDEX IF NOT EXISTS idx_jobs_remote   ON jobs(is_remote);
CREATE INDEX IF NOT EXISTS idx_apps_user     ON applications(user_id);
CREATE INDEX IF NOT EXISTS idx_apps_status   ON applications(status);
