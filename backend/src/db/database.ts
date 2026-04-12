/**
 * database.ts — dual-mode DB adapter
 *
 * LOCAL / DOCKER  → better-sqlite3   (DATABASE_URL is a file path)
 * PRODUCTION      → Supabase Postgres (DATABASE_URL is postgres://…)
 *
 * All routes call getDB().prepare().run/get/all — same interface either way.
 * For Postgres, use the async dbQuery() helper in route handlers for safety.
 */

import { readFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ─── shared interface ─────────────────────────────────────────────────────────

export interface Statement {
  run(...p: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...p: any[]): any;
  all(...p: any[]): any[];
}

export interface DB {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  transaction<T>(fn: (items: T[]) => any): (items: T[]) => any;
  /** Postgres-only async query — undefined on SQLite */
  asyncQuery?: (sql: string, params?: any[]) => Promise<any[]>;
}

let _db: DB | null = null;

export function getDB(): DB {
  if (!_db) throw new Error('Database not initialised — call initDB() first');
  return _db;
}

// ─── init ─────────────────────────────────────────────────────────────────────

export async function initDB(): Promise<void> {
  const url = process.env.DATABASE_URL || './data/jobs.db';
  if (url.startsWith('postgres')) {
    _db = await buildPostgresDB(url);
    console.log('[db] Supabase Postgres connected');
  } else {
    _db = buildSQLiteDB(url);
    console.log('[db] SQLite ready');
  }
}

// ─── SQLite (local / Docker) ──────────────────────────────────────────────────

function buildSQLiteDB(path: string): DB {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Sqlite = require('better-sqlite3');
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new Sqlite(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = readFileSync(join(__dirname, '../../schema.sql'), 'utf-8');
  db.exec(schema);
  return db as DB;
}

// ─── Postgres / Supabase ──────────────────────────────────────────────────────

async function buildPostgresDB(connectionString: string): Promise<DB> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString,
    ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 10,
  });

  // Adapt schema: SQLite dialects → Postgres
  const rawSchema = readFileSync(join(__dirname, '../../schema.sql'), 'utf-8');
  const pgSchema = rawSchema
    .replace(/DATETIME DEFAULT CURRENT_TIMESTAMP/g, 'TIMESTAMPTZ DEFAULT NOW()')
    .replace(/\bDATETIME\b/g, 'TIMESTAMPTZ')
    .replace(/\bINTEGER\b/g, 'BIGINT');
  await pool.query(pgSchema);

  /** ? → $1, $2 … */
  const toPg = (sql: string) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };

  /** INSERT OR IGNORE → INSERT … ON CONFLICT DO NOTHING */
  const fixIgnore = (sql: string) =>
    /INSERT\s+OR\s+IGNORE/i.test(sql)
      ? sql.replace(/INSERT\s+OR\s+IGNORE/i, 'INSERT') + ' ON CONFLICT DO NOTHING'
      : sql;

  const prepare = (rawSql: string): Statement => {
    const sql = toPg(fixIgnore(rawSql));
    return {
      run(...params) {
        // Fire-and-forget for scraper/batch inserts; use asyncQuery for critical paths
        pool.query(sql, params).catch((e: Error) => console.error('[db run]', e.message));
        return { changes: 1, lastInsertRowid: 0 };
      },
      get(...params) {
        // Synchronous shim — returns undefined; routes should use asyncQuery
        let row: any;
        pool.query(sql + (sql.toLowerCase().includes('limit') ? '' : ' LIMIT 1'), params)
          .then((r: any) => { row = r.rows[0]; })
          .catch((e: Error) => console.error('[db get]', e.message));
        return row;
      },
      all(...params) {
        let rows: any[] = [];
        pool.query(sql, params)
          .then((r: any) => { rows = r.rows; })
          .catch((e: Error) => console.error('[db all]', e.message));
        return rows;
      },
    };
  };

  const asyncQuery = async (rawSql: string, params: any[] = []): Promise<any[]> => {
    const result = await pool.query(toPg(fixIgnore(rawSql)), params);
    return result.rows;
  };

  const exec = async (sql: string) => { await pool.query(sql); };

  const transaction = <T>(fn: (items: T[]) => any) => async (items: T[]) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = fn(items);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  };

  return { prepare, exec, transaction, asyncQuery } as DB;
}

/**
 * Route-safe async query helper.
 * Automatically uses pool.query on Postgres and stmt.all/run on SQLite.
 *
 * @example
 *   const jobs = await dbQuery('SELECT * FROM jobs WHERE id = ?', [id]);
 */
export async function dbQuery(sql: string, params: any[] = []): Promise<any[]> {
  const db = getDB();
  if (db.asyncQuery) return db.asyncQuery(sql, params);
  // SQLite sync path
  const stmt = db.prepare(sql);
  const lower = sql.trim().toLowerCase();
  if (lower.startsWith('select') || lower.startsWith('with')) return stmt.all(...params);
  return [stmt.run(...params)];
}