import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'fs';
import { join } from 'path';

let db: Database.Database;

/** Initialize SQLite database and run schema migrations */
export function initDB(): Promise<void> {
  return new Promise((resolve) => {
    const dbPath = process.env.DATABASE_URL || './data/jobs.db';
    mkdirSync(join(dbPath, '..'), { recursive: true });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    const schema = readFileSync(join(__dirname, '../../schema.sql'), 'utf-8');
    db.exec(schema);
    console.log('Database initialized');
    resolve();
  });
}

export function getDB(): Database.Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}
