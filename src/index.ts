import { Bot } from './bot/index.js';
import { config } from './config.js';
import { openDb } from './db/index.js';
import { errMsg } from './lib/http.js';
import { logger } from './logger.js';
import { runDiscovery } from './jobs/discovery.js';
import { runOutcomeTracker } from './jobs/outcomes.js';
import { runPatternScan, scanBudget } from './jobs/patternScan.js';
import { DryRunNotifier, type Notifier } from './bot/notifier.js';
import { Scheduler } from './jobs/scheduler.js';
import { PumpPortalStream } from './sources/pumpportal.js';
import { LiveTracker } from './onchain/tracker.js';
import { runLiveScan } from './jobs/liveScan.js';
import { restoreIfMissing, SnapshotSaver } from './db/snapshot.js';
import { startHealthServer, startSelfPing } from './health.js';
import { limiters } from './sources/limiters.js';

// Jobs catch their own API errors; a stray rejection is logged, not fatal.
process.on('unhandledRejection', (err) => logger.error({ err: errMsg(err) }, 'unhandled rejection'));
// A synchronous throw means unknown state: log and exit so pm2 restarts us cleanly.
process.on('uncaughtException', (err) => {
  logger.fatal({ err: errMsg(err), stack: err.stack }, 'uncaught exception');
  process.exit(1);
});

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === '1';
  if (!config.telegram.token && !dryRun) {
    logger.fatal('TELEGRAM_BOT_TOKEN is not set. Copy .env.example to .env and add your token (or set DRY_RUN=1).');
    process.exit(1);
  }

  // Ephemeral-disk hosts (Render free): pull the last snapshot from Postgres before opening the DB.
  if (config.hosting.databaseUrl) {
    try {
      const r = await restoreIfMissing(config.dbPath, config.hosting.databaseUrl);
      logger.info({ result: r }, 'snapshot restore check');
    } catch (err) {
      logger.error({ err: errMsg(err) }, 'snapshot restore failed; starting with a fresh database');
    }
  }
  const db = openDb(config.dbPath);
  const saver = config.hosting.databaseUrl ? new SnapshotSaver(db, config.hosting.databaseUrl, config.hosting.snapshotMinutes * 60_000) : null;
  saver?.start();
  logger.info({ db: config.dbPath, rpc: config.rpcUrl.replace(/api[-_]?key=[^&]+/i, 'api-key=***'), gtRpm: config.rateLimits.geckoterminal, scanBudget: scanBudget(), dryRun }, 'starting soleye');

  let bot: Bot | null = null;
  let notifier: Notifier;
  if (dryRun) {
    notifier = new DryRunNotifier();
  } else {
    bot = new Bot(db, config.telegram.token);
    // Telegram being briefly unreachable at boot shouldn't stop scanning; retry until it connects.
    for (let attempt = 1; ; attempt++) {
      try {
        await bot.start();
        break;
      } catch (err) {
        if (/401|Unauthorized|404/.test(errMsg(err))) {
          logger.fatal({ err: errMsg(err) }, 'Telegram rejected the bot token');
          process.exit(1);
        }
        const wait = Math.min(60_000, 2000 * 2 ** attempt);
        logger.warn({ err: errMsg(err), retryInMs: wait }, 'telegram connect failed');
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    notifier = bot;
  }

  // Free real-time feed of pump.fun graduations -> candidate pool (checked on the next discovery).
  const pumpportal = new PumpPortalStream((mint) => db.addCandidates([mint], 'pumpportal'));
  pumpportal.start();

  // On-chain candles for supported pools; GeckoTerminal rotation covers the rest.
  const tracker = config.live.enabled ? new LiveTracker() : null;
  const syncTracker = () => tracker?.sync(db.scanQueue(100_000));
  if (tracker) {
    tracker.start();
    syncTracker(); // tokens that already passed rug checks in a previous run
  }
  const isLive = (address: string) => tracker?.isLive(address) ?? false;
  bot?.setLiveStats(() => {
    if (!tracker) return null;
    const s = tracker.stats();
    return { live: s.live, gt: s.unsupported + s.settingUp + s.reseeding, settingUp: s.settingUp, reseeding: s.reseeding, wsUp: s.wsConnected, swaps: s.swaps };
  });

  const scheduler = new Scheduler();
  const stopped = () => scheduler.isStopped;
  const { discoveryIntervalMs, patternScanIntervalMs, outcomeIntervalMs } = config.jobs;
  scheduler.add('discovery', discoveryIntervalMs, async () => {
    await runDiscovery(db, stopped);
    syncTracker();
  }, 0);
  // Give the first discovery a head start so the scan has something to look at.
  scheduler.add('scan', patternScanIntervalMs, () => runPatternScan(db, notifier, stopped, isLive), 90_000);
  if (tracker) scheduler.add('live-scan', config.live.detectIntervalMs, () => runLiveScan(db, tracker, notifier, stopped), 60_000);
  scheduler.add('outcomes', outcomeIntervalMs, () => runOutcomeTracker(db, notifier, stopped), 30_000);

  // Web port + keep-awake for hosts that sleep idle web services (Render sets PORT and RENDER_EXTERNAL_URL).
  const server = config.hosting.port
    ? startHealthServer(config.hosting.port, () => ({
        uptimeSec: Math.round(process.uptime()),
        lastDiscovery: db.getKv('job:discovery:last') ? new Date(Number(db.getKv('job:discovery:last'))).toISOString() : null,
        live: tracker?.stats().live ?? 0,
        tracker: tracker?.stats() ?? null,
        watchlist: db.watchCounts(),
        scan: db.getKv('job:scan:summary') ?? null,
        lastAlert: db.getKv('alert:last') ? new Date(Number(db.getKv('alert:last'))).toISOString() : null,
        upstream: Object.fromEntries(
          Object.entries(limiters).map(([k, l]) => [k, { ok: l.completed, rateLimited: l.rateLimitHits, queued: l.queued, intervalMs: l.intervalMs }]),
        ),
        memMb: Math.round(process.memoryUsage().rss / 1e6),
      }))
    : null;
  const pinger = config.hosting.publicUrl ? startSelfPing(config.hosting.publicUrl, 10 * 60_000) : null;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('forced exit after timeout');
      process.exit(1);
    }, 30_000);
    force.unref();
    pumpportal.stop();
    tracker?.stop();
    if (pinger) clearInterval(pinger);
    server?.close();
    await scheduler.stop();
    await bot?.stop();
    await saver?.stop(); // final snapshot so a redeploy/restart loses nothing
    db.close();
    logger.info('bye');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err: errMsg(err), stack: (err as Error)?.stack }, 'startup failed');
  process.exit(1);
});
