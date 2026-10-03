/**
 * Read-only: download the newest live snapshot from DATABASE_URL into a local SQLite file for analysis.
 * Never writes to the snapshot store.
 *   npx tsx scripts/pull-snapshot.ts [out=data/live-copy.db]
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL first');
const out = process.argv[2] ?? 'data/live-copy.db';
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: true } });
await client.connect();
try {
  const row = (await client.query('SELECT id, created_at, data FROM soleye_snapshots ORDER BY id DESC LIMIT 1')).rows[0];
  if (!row) throw new Error('no snapshot found');
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, zlib.gunzipSync(row.data as Buffer));
  console.log('snapshot', row.id, 'from', row.created_at.toISOString(), '->', out);
} finally {
  await client.end();
}
