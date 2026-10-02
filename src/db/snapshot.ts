import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import pg from 'pg';
import { errMsg } from '../lib/http.js';
import { logger } from '../logger.js';
import type { Db } from './index.js';

const log = logger.child({ mod: 'snapshot' });

/**
 * Off-box persistence for hosts with an ephemeral disk (e.g. Render free): the whole SQLite file is
 * gzipped (~100 KB) and stored as one row in a free Postgres (e.g. Neon). Restored on boot when the
 * local file is missing. Each save opens a short connection so a scale-to-zero database can sleep.
 */
// Name kept from the original project name: renaming it would orphan existing snapshots.
const TABLE = 'soleye_snapshots';
const KEEP = 3;

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 30_000, ssl: url.includes('localhost') ? undefined : { rejectUnauthorized: true } });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), data BYTEA NOT NULL)`);
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Before opening the DB: if there is no local file, pull the newest snapshot. */
export async function restoreIfMissing(dbPath: string, url: string): Promise<'restored' | 'kept-local' | 'none'> {
  if (dbPath === ':memory:' || fs.existsSync(dbPath)) return 'kept-local';
  const row = await withClient(url, async (c) => (await c.query(`SELECT data, created_at FROM ${TABLE} ORDER BY id DESC LIMIT 1`)).rows[0]);
  if (!row) return 'none';
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  fs.writeFileSync(dbPath, zlib.gunzipSync(row.data as Buffer));
  log.info({ from: row.created_at }, 'database restored from snapshot');
  return 'restored';
}

/** Saves a snapshot when the DB changed since the last one, at most every `intervalMs`. */
export class SnapshotSaver {
  private timer: NodeJS.Timeout | null = null;
  private lastChanges = -1;
  private saving: Promise<void> | null = null;

  constructor(private db: Db, private url: string, private intervalMs: number) {}

  start(): void {
    this.timer = setInterval(() => void this.save(), this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.saving;
    await this.save(true); // final snapshot on shutdown/redeploy
  }

  private changes(): number {
    return (this.db.raw.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  }

  save(force = false): Promise<void> {
    if (this.saving) return this.saving;
    const changes = this.changes();
    if (!force && changes === this.lastChanges) return Promise.resolve();
    this.saving = (async () => {
      try {
        const data = zlib.gzipSync(this.db.raw.serialize());
        await withClient(this.url, async (c) => {
          await c.query(`INSERT INTO ${TABLE} (data) VALUES ($1)`, [data]);
          await c.query(`DELETE FROM ${TABLE} WHERE id NOT IN (SELECT id FROM ${TABLE} ORDER BY id DESC LIMIT ${KEEP})`);
        });
        this.lastChanges = changes;
        log.info({ bytes: data.length }, 'snapshot saved');
      } catch (err) {
        log.warn({ err: errMsg(err) }, 'snapshot failed; will retry next interval');
      } finally {
        this.saving = null;
      }
    })();
    return this.saving;
  }
}
