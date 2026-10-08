import { Bot } from './bot/index.js';
import { config } from './config.js';
import { openDb } from './db/index.js';
import { errMsg } from './lib/http.js';
import { logger } from './logger.js';
import { runDiscovery } from './jobs/discovery.js';
import { runOutcomeTracker } from './jobs/outcomes.js';
import { runPatternScan, scanBudget, scanFetchedHistory } from './jobs/patternScan.js';
import { DryRunNotifier, type Notifier } from './bot/notifier.js';
import { Scheduler } from './jobs/scheduler.js';
import { PumpPortalStream } from './sources/pumpportal.js';
import { LiveTracker } from './onchain/tracker.js';
import { MarketStream, QUOTE_MINTS } from './onchain/market.js';
import { runLiveScan } from './jobs/liveScan.js';
import { armedPairs, onLivePrice, runSetupWatcher } from './jobs/setups.js';
import { SetupPriceFeed } from './onchain/priceFeed.js';
import { DumpDetector } from './jobs/dumps.js';
import { ChartQueue, runChartChecks, runSweep, runWatch } from './jobs/watch.js';
import { restoreIfMissing, SnapshotSaver } from './db/snapshot.js';
import { startHealthServer, startSelfPing } from './health.js';
import { limiters } from './sources/limiters.js';
import { sampled } from './jobs/prescreen.js';

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
  // Health endpoint first: hosts (Render) only retire the previous instance once this one answers.
  let healthStatus: () => Record<string, unknown> = () => ({ starting: true, uptimeSec: Math.round(process.uptime()) });
  const server = config.hosting.port ? startHealthServer(config.hosting.port, () => healthStatus()) : null;

  if (config.hosting.databaseUrl) {
    // Zero-downtime redeploys overlap old and new instance. Give the old one time to receive SIGTERM and
    // upload its final snapshot before this one restores, so nothing written in between is lost.
    if (config.hosting.handoffDelaySec > 0) {
      logger.info({ seconds: config.hosting.handoffDelaySec }, 'waiting for previous instance to hand over its snapshot');
      await new Promise((r) => setTimeout(r, config.hosting.handoffDelaySec * 1000));
    }
    try {
      const r = await restoreIfMissing(config.dbPath, config.hosting.databaseUrl);
      logger.info({ result: r }, 'snapshot restore check');
    } catch (err) {
      logger.error({ err: errMsg(err) }, 'snapshot restore failed; starting with a fresh database');
    }
  }
  const db = openDb(config.dbPath);
  // Only the hosted instance uploads; a dev copy with the same DATABASE_URL must never overwrite live state.
  const saver = config.hosting.databaseUrl && config.hosting.snapshotUpload ? new SnapshotSaver(db, config.hosting.databaseUrl, config.hosting.snapshotMinutes * 60_000) : null;
  saver?.start();
  // Pre-screen candles saved by the previous instance: early detection continues across the restart.
  try {
    const restored = sampled.load(db.takePrescreen());
    if (restored) logger.info({ coins: restored }, 'pre-screen candles restored');
  } catch (err) {
    logger.warn({ err: errMsg(err) }, 'pre-screen restore failed');
  }
  logger.info({ db: config.dbPath, rpc: config.rpcUrl.replace(/api[-_]?key=[^&]+/i, 'api-key=***'), gtRpm: config.rateLimits.geckoterminal, scanBudget: scanBudget(), dryRun }, 'starting GGG_BOT');

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
    // One-time "what's new" to subscribers; snapshot right away so the next deploy knows it was sent.
    const announced = await bot.announceOnce().catch((err) => (logger.warn({ err: errMsg(err) }, 'announcement failed'), null));
    if (announced !== null) void saver?.save(true);
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
  // Whole market: every swap on PumpSwap / Raydium CPMM+CLMM / Orca. Coins in the filter range become discovery
  // candidates (exact DexScreener + rug checks still apply), and their streamed candles replace history downloads.
  const market = tracker && config.stream.enabled ? new MarketStream((mint) => tracker.quotes.get(mint)) : null;
  if (tracker && market) {
    for (const q of QUOTE_MINTS) void tracker.quotes.ensure(q);
    market.onCandidate = (mint) => db.addCandidates([mint], 'stream');
    tracker.historyFor = (t, baseSec) => market.history(t.pair_address, baseSec, t.pair_created_at);
    market.start();
  }
  // Live pools are scanned every minute from chain candles; everything else (including tokens still waiting for
  // live setup) is scanned by the GT rotation, whose fetch also sets the token up for live tracking.
  const isLive = (address: string) => tracker?.isLive(address) ?? false;
  const adopt = (t: Parameters<NonNullable<typeof tracker>['adoptFetched']>[0], candles: Parameters<NonNullable<typeof tracker>['adoptFetched']>[1], sec: number) =>
    tracker ? tracker.adoptFetched(t, candles, sec) : Promise.resolve();
  if (tracker) {
    tracker.onSeed = (token, base, baseSec) =>
      void scanFetchedHistory(db, token, base, baseSec, notifier).catch((err) => logger.error({ token: token.symbol, err: errMsg(err) }, 'seed scan failed'));
  }
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
  // Chart checks: with live tracking, the old GeckoTerminal rotation; otherwise (default, free hosting) only coins
  // the watch job flags as active, plus a slow baseline pass over the quiet ones.
  const charts = new ChartQueue();
  if (tracker) scheduler.add('scan', patternScanIntervalMs, () => runPatternScan(db, notifier, stopped, isLive, adopt), 90_000);
  else scheduler.add('charts', 30_000, () => runChartChecks(db, charts, notifier, stopped), 90_000);
  if (tracker) scheduler.add('live-scan', config.live.detectIntervalMs, () => runLiveScan(db, tracker, notifier, stopped), 60_000);
  if (config.tracking.enabled) scheduler.add('outcomes', outcomeIntervalMs, () => runOutcomeTracker(db, notifier, stopped), 30_000);
  // Real-time triggers: neckline / hammer-high crosses alert immediately instead of at candle close.
  // Real-time on-chain prices for coins with an armed setup: a cross is acted on within seconds.
  const priceFeed = config.setups.priceFeed.enabled
    ? new SetupPriceFeed((token, price) => void onLivePrice(db, tracker, notifier, token, price).catch((err) => logger.warn({ err: errMsg(err) }, 'live price check failed')))
    : null;
  priceFeed?.start();
  scheduler.add('setups', config.setups.watchIntervalMs, async () => {
    await runSetupWatcher(db, tracker, notifier, stopped);
    priceFeed?.sync(armedPairs(db));
    db.pruneSetups(Date.now() - 7 * 86_400_000);
  }, 20_000);

  // Sudden one-candle drops (5m / 15m) on every watched token, from DexScreener prices.
  const dumps = new DumpDetector();
  // Once a minute: every watched coin's price/volume (sudden drops + activity that earns a chart check).
  scheduler.add('watch', config.watch.intervalMs, () => runWatch(db, dumps, charts, notifier, stopped), 30_000);
  // Hourly: every Solana coin above the volume/liquidity floor joins the discovery pool (needs a DexPaprika key).
  if (config.dexpaprikaApiKey) scheduler.add('sweep', config.watch.sweepEveryMs, () => runSweep(db), 60_000);

  // Web port + keep-awake for hosts that sleep idle web services (Render sets PORT and RENDER_EXTERNAL_URL).
  healthStatus = () => ({
        uptimeSec: Math.round(process.uptime()),
        lastDiscovery: db.getKv('job:discovery:last') ? new Date(Number(db.getKv('job:discovery:last'))).toISOString() : null,
        live: tracker?.stats().live ?? 0,
        tracker: tracker?.stats() ?? null,
        market: market?.stats() ?? null,
        watchlist: db.watchCounts(),
        scan: db.getKv('job:scan:summary') ?? null,
        watch: db.getKv('job:watch:summary') ?? null,
        sweep: db.getKv('job:sweep:summary') ?? null,
        lastAlert: db.getKv('alert:last') ? new Date(Number(db.getKv('alert:last'))).toISOString() : null,
        upstream: Object.fromEntries(
          Object.entries(limiters).map(([k, l]) => [k, { ok: l.completed, rateLimited: l.rateLimitHits, queued: l.queued, intervalMs: l.intervalMs }]),
        ),
        armedSetups: db.armedSetups().length,
        realtimeFeeds: priceFeed?.size ?? 0,
        memMb: Math.round(process.memoryUsage().rss / 1e6),
      });
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
    // Snapshot FIRST: hosts like Render kill the process ~30s after SIGTERM, and waiting for jobs can take that long.
    // Pre-screen candles go into it so the next instance doesn't start blind.
    try {
      db.savePrescreen(sampled.dump());
    } catch (err) {
      logger.warn({ err: errMsg(err) }, 'saving pre-screen candles failed');
    }
    const finalSave = saver?.stop();
    pumpportal.stop();
    tracker?.stop();
    priceFeed?.stop();
    market?.stop();
    if (pinger) clearInterval(pinger);
    server?.close();
    await finalSave;
    await scheduler.stop(15_000);
    await bot?.stop();
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
