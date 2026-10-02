/**
 * One-off: upload the local database to the snapshot store (DATABASE_URL), so a fresh cloud
 * deploy starts with your existing subscribers, settings and alert history.
 *   DATABASE_URL=postgres://... npx tsx scripts/push-snapshot.ts
 */
import { config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { SnapshotSaver } from '../src/db/snapshot.js';

if (!config.hosting.databaseUrl) throw new Error('Set DATABASE_URL first');
// Explicit, manual upload: this REPLACES the live bot's state on its next restart. Only run it on purpose.
const db = openDb(config.dbPath);
await new SnapshotSaver(db, config.hosting.databaseUrl, 60_000).save(true);
db.close();
console.log('uploaded', config.dbPath);
