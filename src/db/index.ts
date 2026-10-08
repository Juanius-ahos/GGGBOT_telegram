import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type RugStatus = 'pending' | 'pass' | 'fail' | 'error';
export type Outcome = 'pending' | 'target' | 'invalidation' | 'none';

export interface WatchToken {
  address: string;
  symbol: string;
  name: string;
  pair_address: string;
  dex_id: string;
  price_usd: number;
  market_cap: number;
  liquidity_usd: number;
  volume_24h: number;
  pair_created_at: number;
  active: number;
  rug_status: RugStatus;
  rug_reason: string | null;
  rug_checked_at: number | null;
  last_scanned_at: number | null;
  first_seen_at: number;
  updated_at: number;
}

export interface AlertRow {
  id: number;
  token_address: string;
  symbol: string;
  name: string;
  pair_address: string;
  created_at: number;
  price_at_alert: number;
  market_cap: number;
  liquidity_usd: number;
  first_low: number;
  second_low: number;
  neckline: number;
  breakout_price: number;
  breakout_time: number;
  invalidation: number;
  target: number;
  price_1h: number | null;
  pct_1h: number | null;
  price_4h: number | null;
  pct_4h: number | null;
  price_24h: number | null;
  pct_24h: number | null;
  /** Running max/min of sampled prices since the alert (fallback for outcome resolution). */
  sample_high: number | null;
  sample_low: number | null;
  sampled_outcome: Outcome;
  outcome: Outcome;
  outcome_at: number | null;
  pattern: 'double_bottom' | 'hammer' | 'db_forming';
  timeframe: '5m' | '15m' | '1h' | '4h';
  /** Extra confirmation found alongside the pattern (e.g. "hammer at L2"). */
  confluence: string | null;
  /** close = candle close confirmed, cross = live price crossed the level, forming = early heads-up. */
  trigger: 'close' | 'cross' | 'forming';
}

export interface SetupRow {
  id: number;
  token_address: string;
  pattern: 'double_bottom' | 'hammer';
  timeframe: '5m' | '15m' | '1h' | '4h';
  /** L2 candle time (double bottom) or hammer candle time, unix seconds. */
  key_time: number;
  /** Neckline (double bottom) or hammer high. */
  trigger_level: number;
  invalidation: number;
  target: number;
  first_low: number;
  second_low: number;
  neckline: number;
  avg_volume: number;
  armed_at: number;
  expires_at: number;
  status: 'armed' | 'fired' | 'expired' | 'invalidated';
  early_alert_id: number | null;
}

export type NewAlert = Pick<
  AlertRow,
  'token_address' | 'symbol' | 'name' | 'pair_address' | 'created_at' | 'price_at_alert' | 'market_cap' | 'liquidity_usd' |
  'first_low' | 'second_low' | 'neckline' | 'breakout_price' | 'breakout_time' | 'invalidation' | 'target' | 'pattern' | 'timeframe'
> & { confluence?: string | null; trigger?: AlertRow['trigger'] };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS watchlist (
  address         TEXT PRIMARY KEY,
  symbol          TEXT NOT NULL,
  name            TEXT NOT NULL,
  pair_address    TEXT NOT NULL,
  dex_id          TEXT NOT NULL,
  price_usd       REAL NOT NULL DEFAULT 0,
  market_cap      REAL NOT NULL,
  liquidity_usd   REAL NOT NULL,
  volume_24h      REAL NOT NULL,
  pair_created_at INTEGER NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1,
  rug_status      TEXT NOT NULL DEFAULT 'pending',
  rug_reason      TEXT,
  rug_checked_at  INTEGER,
  last_scanned_at INTEGER,
  first_seen_at   INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watch_scan ON watchlist(active, rug_status, last_scanned_at);

CREATE TABLE IF NOT EXISTS subscribers (
  chat_id       INTEGER PRIMARY KEY,
  username      TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  subscribed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address   TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  name            TEXT NOT NULL,
  pair_address    TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  price_at_alert  REAL NOT NULL,
  market_cap      REAL NOT NULL,
  liquidity_usd   REAL NOT NULL,
  first_low       REAL NOT NULL,
  second_low      REAL NOT NULL,
  neckline        REAL NOT NULL,
  breakout_price  REAL NOT NULL,
  breakout_time   INTEGER NOT NULL,
  invalidation    REAL NOT NULL,
  target          REAL NOT NULL,
  price_1h REAL, pct_1h REAL,
  price_4h REAL, pct_4h REAL,
  price_24h REAL, pct_24h REAL,
  sample_high     REAL,
  sample_low      REAL,
  sampled_outcome TEXT NOT NULL DEFAULT 'pending',
  outcome         TEXT NOT NULL DEFAULT 'pending',
  outcome_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_token ON alerts(token_address, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_outcome ON alerts(outcome);

-- Every address any feed has ever surfaced. Re-checked each discovery so tokens that fail today
-- (too young, MC too low) join the watchlist automatically once they qualify.
CREATE TABLE IF NOT EXISTS candidates (
  address       TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

-- Telegram message ids per alert, so outcome updates can reply under the original alert.
CREATE TABLE IF NOT EXISTS alert_messages (
  alert_id   INTEGER NOT NULL,
  chat_id    INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  PRIMARY KEY (alert_id, chat_id)
);

-- Armed setups waiting for a real-time trigger (price crossing a double-bottom neckline / hammer high).
CREATE TABLE IF NOT EXISTS setups (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address  TEXT NOT NULL,
  pattern        TEXT NOT NULL,
  timeframe      TEXT NOT NULL,
  key_time       INTEGER NOT NULL,
  trigger_level  REAL NOT NULL,
  invalidation   REAL NOT NULL,
  target         REAL NOT NULL,
  first_low      REAL NOT NULL,
  second_low     REAL NOT NULL,
  neckline       REAL NOT NULL,
  avg_volume     REAL NOT NULL,
  armed_at       INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'armed',
  early_alert_id INTEGER,
  UNIQUE (token_address, pattern, timeframe, key_time)
);
CREATE INDEX IF NOT EXISTS idx_setups_status ON setups(status, expires_at);

-- Per-chat alert preferences (which patterns / timeframes to receive). Missing row = everything on.
CREATE TABLE IF NOT EXISTS prefs (
  chat_id    INTEGER PRIMARY KEY,
  patterns   TEXT NOT NULL,
  timeframes TEXT NOT NULL
);

-- Per-chat token mutes from the alert's "Mute" button.
CREATE TABLE IF NOT EXISTS mutes (
  chat_id       INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  until         INTEGER NOT NULL,
  PRIMARY KEY (chat_id, token_address)
);

-- Sudden single-candle drops that were alerted (see jobs/dumps.ts).
CREATE TABLE IF NOT EXISTS dumps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  timeframe     TEXT NOT NULL,
  candle_time   INTEGER NOT NULL,
  open_price    REAL NOT NULL,
  price         REAL NOT NULL,
  drop_pct      REAL NOT NULL,
  market_cap    REAL NOT NULL,
  liquidity_usd REAL NOT NULL,
  created_at    INTEGER NOT NULL
);

-- Pre-screen candles saved at shutdown and loaded at start, so a redeploy doesn't reset early detection.
CREATE TABLE IF NOT EXISTS prescreen_candles (
  token_address TEXT PRIMARY KEY,
  interval_sec  INTEGER NOT NULL,
  seeded        INTEGER NOT NULL DEFAULT 0,
  candles       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface DumpRow {
  token_address: string;
  symbol: string;
  timeframe: string;
  candle_time: number;
  open_price: number;
  price: number;
  drop_pct: number;
  market_cap: number;
  liquidity_usd: number;
  created_at: number;
}

export type Db = ReturnType<typeof openDb>;

export function openDb(file: string) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  // Migrations for databases created before multi-pattern / multi-timeframe support (existing rows = 15m double bottoms).
  const alertCols = new Set((db.prepare(`PRAGMA table_info(alerts)`).all() as { name: string }[]).map((c) => c.name));
  if (!alertCols.has('pattern')) db.exec(`ALTER TABLE alerts ADD COLUMN pattern TEXT NOT NULL DEFAULT 'double_bottom'`);
  if (!alertCols.has('timeframe')) db.exec(`ALTER TABLE alerts ADD COLUMN timeframe TEXT NOT NULL DEFAULT '15m'`);
  if (!alertCols.has('confluence')) db.exec(`ALTER TABLE alerts ADD COLUMN confluence TEXT`);
  if (!alertCols.has('trigger')) db.exec(`ALTER TABLE alerts ADD COLUMN trigger TEXT NOT NULL DEFAULT 'close'`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_alerts_key ON alerts(token_address, pattern, timeframe, created_at)`);

  const now = () => Date.now();

  const stmts = {
    upsertToken: db.prepare(`
      INSERT INTO watchlist (address, symbol, name, pair_address, dex_id, price_usd, market_cap, liquidity_usd,
                             volume_24h, pair_created_at, active, first_seen_at, updated_at)
      VALUES (@address, @symbol, @name, @pair_address, @dex_id, @price_usd, @market_cap, @liquidity_usd,
              @volume_24h, @pair_created_at, 1, @now, @now)
      ON CONFLICT(address) DO UPDATE SET
        symbol = excluded.symbol, name = excluded.name, pair_address = excluded.pair_address,
        dex_id = excluded.dex_id, price_usd = excluded.price_usd, market_cap = excluded.market_cap,
        liquidity_usd = excluded.liquidity_usd, volume_24h = excluded.volume_24h,
        pair_created_at = excluded.pair_created_at, active = 1, updated_at = excluded.updated_at`),
    deactivate: db.prepare(`UPDATE watchlist SET active = 0, updated_at = ? WHERE address = ?`),
    activeAddresses: db.prepare(`SELECT address FROM watchlist WHERE active = 1`),
    getToken: db.prepare(`SELECT * FROM watchlist WHERE address = ?`),
    needsRugCheck: db.prepare(`
      SELECT * FROM watchlist WHERE active = 1 AND (
        rug_status = 'pending'
        OR (rug_status IN ('pass', 'fail') AND rug_checked_at < @freshAfter)
        OR (rug_status = 'error' AND rug_checked_at < @errorRetryAfter))
      ORDER BY (rug_status = 'pending') DESC, volume_24h DESC LIMIT @limit`),
    setRug: db.prepare(`UPDATE watchlist SET rug_status = ?, rug_reason = ?, rug_checked_at = ? WHERE address = ?`),
    scanQueue: db.prepare(`
      SELECT * FROM watchlist WHERE active = 1 AND rug_status = 'pass'
      ORDER BY COALESCE(last_scanned_at, 0) ASC LIMIT ?`),
    markScanned: db.prepare(`UPDATE watchlist SET last_scanned_at = ? WHERE address = ?`),
    scannableCount: db.prepare(`SELECT COUNT(*) AS n FROM watchlist WHERE active = 1 AND rug_status = 'pass'`),
    watchCounts: db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(active) AS active,
             SUM(CASE WHEN active = 1 AND rug_status = 'pass' THEN 1 ELSE 0 END) AS passed,
             SUM(CASE WHEN active = 1 AND rug_status = 'fail' THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN active = 1 AND rug_status IN ('pending', 'error') THEN 1 ELSE 0 END) AS pending
      FROM watchlist`),

    subscribe: db.prepare(`
      INSERT INTO subscribers (chat_id, username, active, subscribed_at) VALUES (?, ?, 1, ?)
      ON CONFLICT(chat_id) DO UPDATE SET active = 1, username = excluded.username`),
    unsubscribe: db.prepare(`UPDATE subscribers SET active = 0 WHERE chat_id = ?`),
    activeSubscribers: db.prepare(`SELECT chat_id FROM subscribers WHERE active = 1`),
    isSubscribed: db.prepare(`SELECT active FROM subscribers WHERE chat_id = ?`),

    insertAlert: db.prepare(`
      INSERT INTO alerts (token_address, symbol, name, pair_address, created_at, price_at_alert, market_cap,
                          liquidity_usd, first_low, second_low, neckline, breakout_price, breakout_time,
                          invalidation, target, sample_high, sample_low, pattern, timeframe, confluence, trigger)
      VALUES (@token_address, @symbol, @name, @pair_address, @created_at, @price_at_alert, @market_cap,
              @liquidity_usd, @first_low, @second_low, @neckline, @breakout_price, @breakout_time,
              @invalidation, @target, @price_at_alert, @price_at_alert, @pattern, @timeframe, @confluence, @trigger)`),
    insertDump: db.prepare(`
      INSERT INTO dumps (token_address, symbol, timeframe, candle_time, open_price, price, drop_pct, market_cap, liquidity_usd, created_at)
      VALUES (@token_address, @symbol, @timeframe, @candle_time, @open_price, @price, @drop_pct, @market_cap, @liquidity_usd, @created_at)`),
    insertSetup: db.prepare(`
      INSERT OR IGNORE INTO setups (token_address, pattern, timeframe, key_time, trigger_level, invalidation, target,
                                    first_low, second_low, neckline, avg_volume, armed_at, expires_at)
      VALUES (@token_address, @pattern, @timeframe, @key_time, @trigger_level, @invalidation, @target,
              @first_low, @second_low, @neckline, @avg_volume, @armed_at, @expires_at)`),
    armedSetups: db.prepare(`SELECT * FROM setups WHERE status = 'armed' ORDER BY armed_at`),
    setSetupStatus: db.prepare(`UPDATE setups SET status = ? WHERE id = ?`),
    setSetupEarlyAlert: db.prepare(`UPDATE setups SET early_alert_id = ? WHERE id = ?`),
    pruneSetups: db.prepare(`DELETE FROM setups WHERE status != 'armed' AND armed_at < ?`),
    lastAlertFor: db.prepare(`SELECT MAX(created_at) AS t FROM alerts WHERE token_address = ? AND pattern = ? AND timeframe = ?`),
    statsBy: db.prepare(`
      SELECT pattern, timeframe, COUNT(*) AS total,
             SUM(outcome = 'target') AS wins, SUM(outcome = 'invalidation') AS losses,
             SUM(outcome = 'none') AS neither, AVG(pct_24h) AS avg24h
      FROM alerts GROUP BY pattern, timeframe ORDER BY pattern, timeframe`),
    recentAlerts: db.prepare(`SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?`),
    pendingAlerts: db.prepare(`SELECT * FROM alerts WHERE outcome = 'pending' ORDER BY created_at ASC`),
    getAlert: db.prepare(`SELECT * FROM alerts WHERE id = ?`),

    addCandidate: db.prepare(`
      INSERT INTO candidates (address, source, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET last_seen_at = excluded.last_seen_at`),
    candidateAddresses: db.prepare(`SELECT address FROM candidates WHERE last_seen_at >= ?`),
    pruneCandidates: db.prepare(`DELETE FROM candidates WHERE last_seen_at < ?`),
    candidateCount: db.prepare(`SELECT COUNT(*) AS n FROM candidates`),
    addAlertMessage: db.prepare(`INSERT OR REPLACE INTO alert_messages (alert_id, chat_id, message_id) VALUES (?, ?, ?)`),
    alertMessages: db.prepare(`SELECT chat_id, message_id FROM alert_messages WHERE alert_id = ?`),
    mute: db.prepare(`INSERT OR REPLACE INTO mutes (chat_id, token_address, until) VALUES (?, ?, ?)`),
    isMuted: db.prepare(`SELECT 1 FROM mutes WHERE chat_id = ? AND token_address = ? AND until > ?`),
    alertsSince: db.prepare(`SELECT COUNT(*) AS n FROM alerts WHERE created_at >= ?`),
    getPrefs: db.prepare(`SELECT patterns, timeframes FROM prefs WHERE chat_id = ?`),
    setPrefs: db.prepare(`INSERT OR REPLACE INTO prefs (chat_id, patterns, timeframes) VALUES (?, ?, ?)`),
    activeMutes: db.prepare(`
      SELECT m.token_address, m.until, COALESCE(w.symbol, substr(m.token_address, 1, 6)) AS symbol
      FROM mutes m LEFT JOIN watchlist w ON w.address = m.token_address
      WHERE m.chat_id = ? AND m.until > ? ORDER BY m.until`),
    unmute: db.prepare(`DELETE FROM mutes WHERE chat_id = ? AND token_address = ?`),
    bestWorst: db.prepare(`
      SELECT symbol, COALESCE(pct_24h, pct_4h, pct_1h) AS ret FROM alerts
      WHERE COALESCE(pct_24h, pct_4h, pct_1h) IS NOT NULL ORDER BY ret DESC`),
    getKv: db.prepare(`SELECT value FROM kv WHERE key = ?`),
    setKv: db.prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  };

  return {
    raw: db,
    close: () => db.close(),

    upsertToken(t: Omit<WatchToken, 'active' | 'rug_status' | 'rug_reason' | 'rug_checked_at' | 'last_scanned_at' | 'first_seen_at' | 'updated_at'>) {
      stmts.upsertToken.run({ ...t, now: now() });
    },
    deactivate: (address: string) => stmts.deactivate.run(now(), address),
    activeAddresses: () => (stmts.activeAddresses.all() as { address: string }[]).map((r) => r.address),
    getToken: (address: string) => stmts.getToken.get(address) as WatchToken | undefined,
    tokensNeedingRugCheck(freshAfter: number, errorRetryAfter: number, limit: number) {
      return stmts.needsRugCheck.all({ freshAfter, errorRetryAfter, limit }) as WatchToken[];
    },
    setRug: (address: string, status: RugStatus, reason: string | null) => stmts.setRug.run(status, reason, now(), address),
    scanQueue: (limit: number) => stmts.scanQueue.all(limit) as WatchToken[],
    markScanned: (address: string) => stmts.markScanned.run(now(), address),
    scannableCount: () => (stmts.scannableCount.get() as { n: number }).n,
    watchCounts: () =>
      stmts.watchCounts.get() as { total: number; active: number | null; passed: number | null; failed: number | null; pending: number | null },

    subscribe: (chatId: number, username: string | null) => stmts.subscribe.run(chatId, username, now()),
    unsubscribe: (chatId: number) => stmts.unsubscribe.run(chatId),
    activeSubscribers: () => (stmts.activeSubscribers.all() as { chat_id: number }[]).map((r) => r.chat_id),
    isSubscribed: (chatId: number) => (stmts.isSubscribed.get(chatId) as { active: number } | undefined)?.active === 1,

    insertAlert(a: NewAlert): number {
      return Number(stmts.insertAlert.run({ confluence: null, trigger: 'close', ...a }).lastInsertRowid);
    },
    /** Returns the new setup's id, or null if this exact setup was already armed before. */
    insertSetup(s: Omit<SetupRow, 'id' | 'status' | 'early_alert_id'>): number | null {
      const r = stmts.insertSetup.run(s);
      return r.changes ? Number(r.lastInsertRowid) : null;
    },
    armedSetups: () => stmts.armedSetups.all() as SetupRow[],
    setSetupStatus: (id: number, status: SetupRow['status']) => stmts.setSetupStatus.run(status, id),
    setSetupEarlyAlert: (id: number, alertId: number) => stmts.setSetupEarlyAlert.run(alertId, id),
    pruneSetups: (before: number) => stmts.pruneSetups.run(before).changes,
    lastAlertAt: (address: string, pattern: string, timeframe: string) =>
      (stmts.lastAlertFor.get(address, pattern, timeframe) as { t: number | null }).t,
    statsBy: () =>
      stmts.statsBy.all() as { pattern: string; timeframe: string; total: number; wins: number | null; losses: number | null; neither: number | null; avg24h: number | null }[],
    recentAlerts: (n: number) => stmts.recentAlerts.all(n) as AlertRow[],
    pendingAlerts: () => stmts.pendingAlerts.all() as AlertRow[],
    getAlert: (id: number) => stmts.getAlert.get(id) as AlertRow | undefined,
    updateAlert(id: number, fields: Partial<Omit<AlertRow, 'id'>>) {
      const keys = Object.keys(fields);
      if (keys.length === 0) return;
      // Keys come from our own typed callers, never from user input.
      db.prepare(`UPDATE alerts SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
    },
    stats() {
      return db
        .prepare(`
          SELECT COUNT(*) AS total,
                 SUM(outcome = 'target') AS wins,
                 SUM(outcome = 'invalidation') AS losses,
                 SUM(outcome = 'none') AS neither,
                 SUM(outcome = 'pending') AS pending,
                 AVG(pct_1h) AS avg1h, COUNT(pct_1h) AS n1h,
                 AVG(pct_4h) AS avg4h, COUNT(pct_4h) AS n4h,
                 AVG(pct_24h) AS avg24h, COUNT(pct_24h) AS n24h
          FROM alerts`)
        .get() as {
        total: number; wins: number | null; losses: number | null; neither: number | null; pending: number | null;
        avg1h: number | null; n1h: number; avg4h: number | null; n4h: number; avg24h: number | null; n24h: number;
      };
    },

    addCandidates(addresses: string[], source: string) {
      const t = now();
      db.transaction(() => addresses.forEach((a) => stmts.addCandidate.run(a, source, t, t)))();
    },
    candidateAddresses: (since: number) => (stmts.candidateAddresses.all(since) as { address: string }[]).map((r) => r.address),
    pruneCandidates: (before: number) => stmts.pruneCandidates.run(before).changes,
    candidateCount: () => (stmts.candidateCount.get() as { n: number }).n,

    addAlertMessage: (alertId: number, chatId: number, messageId: number) => stmts.addAlertMessage.run(alertId, chatId, messageId),
    alertMessages: (alertId: number) => stmts.alertMessages.all(alertId) as { chat_id: number; message_id: number }[],
    mute: (chatId: number, token: string, until: number) => stmts.mute.run(chatId, token, until),
    insertDump: (d: DumpRow) => stmts.insertDump.run(d),
    isMuted: (chatId: number, token: string) => !!stmts.isMuted.get(chatId, token, now()),
    alertsSince: (t: number) => (stmts.alertsSince.get(t) as { n: number }).n,
    /** Which patterns/timeframes a chat wants; null fields mean "all". */
    getPrefs(chatId: number): { patterns: string[] | null; timeframes: string[] | null } {
      const r = stmts.getPrefs.get(chatId) as { patterns: string; timeframes: string } | undefined;
      return r ? { patterns: JSON.parse(r.patterns), timeframes: JSON.parse(r.timeframes) } : { patterns: null, timeframes: null };
    },
    setPrefs: (chatId: number, patterns: string[], timeframes: string[]) =>
      stmts.setPrefs.run(chatId, JSON.stringify(patterns), JSON.stringify(timeframes)),
    activeMutes: (chatId: number) => stmts.activeMutes.all(chatId, now()) as { token_address: string; until: number; symbol: string }[],
    unmute: (chatId: number, token: string) => stmts.unmute.run(chatId, token),
    bestWorst() {
      const rows = stmts.bestWorst.all() as { symbol: string; ret: number }[];
      return rows.length ? { best: rows[0], worst: rows[rows.length - 1] } : null;
    },

    savePrescreen(rows: { token: string; intervalSec: number; candles: unknown[]; seeded: boolean }[]) {
      const ins = db.prepare(`INSERT INTO prescreen_candles (token_address, interval_sec, seeded, candles) VALUES (?, ?, ?, ?)`);
      db.transaction(() => {
        db.prepare(`DELETE FROM prescreen_candles`).run();
        for (const r of rows) ins.run(r.token, r.intervalSec, r.seeded ? 1 : 0, JSON.stringify(r.candles));
      })();
    },
    /** Reads and clears the saved pre-screen candles (they are only needed once, at start). */
    takePrescreen(): { token: string; intervalSec: number; candles: any[]; seeded: boolean }[] {
      const rows = db.prepare(`SELECT token_address, interval_sec, seeded, candles FROM prescreen_candles`).all() as { token_address: string; interval_sec: number; seeded: number; candles: string }[];
      db.prepare(`DELETE FROM prescreen_candles`).run();
      return rows.map((r) => ({ token: r.token_address, intervalSec: r.interval_sec, seeded: r.seeded === 1, candles: JSON.parse(r.candles) }));
    },

    getKv: (key: string) => (stmts.getKv.get(key) as { value: string } | undefined)?.value,
    setKv: (key: string, value: string) => stmts.setKv.run(key, value),
  };
}
