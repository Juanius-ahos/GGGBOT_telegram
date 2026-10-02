import type { Notifier } from '../bot/notifier.js';
import { config } from '../config.js';
import type { Db, NewAlert, WatchToken } from '../db/index.js';
import { errMsg, HttpError } from '../lib/http.js';
import { logger } from '../logger.js';
import { findSignals, type Signal } from '../patterns/signals.js';
import { baseIntervalFor, multiTimeframe, TIMEFRAME_SECONDS, type Timeframe } from '../patterns/timeframes.js';
import type { Candle } from '../patterns/types.js';
import { fetchBestPairs } from '../sources/dexscreener.js';
import { geckoterminal } from '../sources/geckoterminal.js';
import { armFromCandles } from './setups.js';

const log = logger.child({ job: 'scan' });

/** Fetch base candles for a token: 5m while young, 15m after (one GeckoTerminal call). */
export async function fetchBase(t: Pick<WatchToken, 'pair_address' | 'address' | 'pair_created_at'>): Promise<{ candles: Candle[]; sec: number }> {
  const b = baseIntervalFor(t.pair_created_at, config.youngTokenHours);
  const candles = await geckoterminal.ohlcv(t.pair_address, t.address, { timeframe: 'minute', aggregate: b.aggregate, limit: config.scan.candleLimit });
  return { candles, sec: b.sec };
}

/** One GeckoTerminal call, rolled up into every timeframe the token's history supports. */
export async function fetchAllTimeframes(t: Pick<WatchToken, 'pair_address' | 'address' | 'pair_created_at'>): Promise<Map<Timeframe, Candle[]>> {
  const { candles, sec } = await fetchBase(t);
  return multiTimeframe(candles, sec, config.timeframes, config.detectCandles);
}

/** Scan GeckoTerminal history that was fetched anyway (live-tracker seed / re-sync) on every timeframe. */
export async function scanFetchedHistory(db: Db, t: WatchToken, base: Candle[], baseSec: number, notifier: Notifier): Promise<number> {
  const byTf = multiTimeframe(base, baseSec, config.timeframes, config.detectCandles);
  let found = 0;
  for (const [tf, candles] of byTf) {
    for (const s of findSignals(candles, tf, config.scan.breakoutLookbackCandles, config)) {
      found++;
      await maybeAlert(db, t, s, candles, notifier, 'seed-scan');
    }
    await armFromCandles(db, t, tf, candles, notifier);
  }
  return found;
}

/** GeckoTerminal calls one scan may spend, leaving a reserve for discovery. */
export function scanBudget(): number {
  const perScan = Math.floor((config.rateLimits.geckoterminal * config.jobs.patternScanIntervalMs) / 60_000);
  return Math.max(1, perScan - config.jobs.gtReservedCallsPerScan);
}

/**
 * When the watchlist is bigger than one scan's budget, each token is revisited only every few cycles.
 * Stretch the lookback (in candles of `tf`) to cover that gap so signals between visits aren't missed.
 */
export function signalLookback(scannable: number, budget: number, tf: Timeframe = '15m'): number {
  const cycles = Math.max(1, Math.ceil(scannable / budget));
  const rotationMin = (cycles * config.jobs.patternScanIntervalMs) / 60_000;
  const needed = Math.ceil(rotationMin / (TIMEFRAME_SECONDS[tf] / 60)) + 1;
  return Math.min(config.scan.maxBreakoutLookbackCandles, Math.max(config.scan.breakoutLookbackCandles, needed));
}

/**
 * Sends an alert unless this token already alerted for the same pattern + timeframe within the cooldown.
 * Returns the new alert's id, or null if nothing was sent.
 */
export async function maybeAlert(db: Db, t: WatchToken, s: Signal, candles: Candle[], notifier: Notifier, via: string): Promise<number | null> {
  const last = db.lastAlertAt(t.address, s.pattern, s.timeframe);
  if (last && Date.now() - last < config.alerts.cooldownHours * 3_600_000) {
    log.debug({ token: t.symbol, pattern: s.pattern, tf: s.timeframe, via }, 'signal found but in cooldown');
    return null;
  }
  return alertToken(db, t, s, candles, notifier, via);
}

async function alertToken(db: Db, t: WatchToken, s: Signal, candles: Candle[], notifier: Notifier, via: string): Promise<number | null> {
  // Fresh price/MC at alert time; fall back to the signal candle's close if DexScreener is unavailable.
  let priceNow = s.entry;
  let mc = t.market_cap;
  let liq = t.liquidity_usd;
  try {
    const pair = (await fetchBestPairs([t.address])).get(t.address);
    if (pair) {
      priceNow = Number(pair.priceUsd) || priceNow;
      mc = pair.marketCap ?? pair.fdv ?? mc;
      liq = pair.liquidity?.usd ?? liq;
    }
  } catch (err) {
    log.warn({ token: t.symbol, err: errMsg(err) }, 'price refresh failed; using signal close');
  }
  if (mc < config.market.minMarketCapUsd) {
    log.info({ token: t.symbol, mc }, 'signal found but MC fell below minimum; skipped');
    return null;
  }
  if (priceNow <= s.invalidation) {
    log.info({ token: t.symbol, pattern: s.pattern, tf: s.timeframe }, 'signal found but price already below stop; skipped');
    return null;
  }

  const row: NewAlert & { confluence: string | null; trigger: 'close' | 'cross' | 'forming' } = {
    token_address: t.address,
    symbol: t.symbol,
    name: t.name,
    pair_address: t.pair_address,
    created_at: Date.now(),
    price_at_alert: priceNow,
    market_cap: mc,
    liquidity_usd: liq,
    first_low: s.firstLow,
    second_low: s.secondLow,
    neckline: s.neckline,
    breakout_price: s.entry,
    breakout_time: s.triggerTime,
    invalidation: s.invalidation,
    target: s.target,
    pattern: s.pattern,
    timeframe: s.timeframe,
    confluence: s.hammerAtSecondLow ? 'hammer at L2' : null,
    trigger: s.trigger ?? 'close',
  };
  const id = db.insertAlert(row);
  db.setKv('alert:last', String(row.created_at));
  const delivered = await notifier.alert({ alertId: id, row, signal: s, candles });
  log.info({ id, token: t.symbol, address: t.address, pattern: s.pattern, tf: s.timeframe, target: s.target, stop: s.invalidation, delivered, via }, 'ALERT sent');
  return id;
}

/**
 * GeckoTerminal rotation for tokens NOT covered by live on-chain tracking (unsupported pools,
 * or pools still waiting for their first seed). `isLive` excludes the rest.
 */
export async function runPatternScan(
  db: Db,
  notifier: Notifier,
  isStopped: () => boolean,
  isLive: (address: string) => boolean = () => false,
): Promise<void> {
  const started = Date.now();
  const budget = scanBudget();
  const fallback = db.scanQueue(100_000).filter((t) => !isLive(t.address));
  const scannable = fallback.length;
  const rotationMin = Math.max(1, Math.ceil(scannable / budget)) * (config.jobs.patternScanIntervalMs / 60_000);
  const queue = fallback.slice(0, budget);
  let scanned = 0;
  let found = 0;
  let failed = 0;

  for (const t of queue) {
    if (isStopped()) break;
    let byTf: Map<Timeframe, Candle[]>;
    try {
      byTf = await fetchAllTimeframes(t);
    } catch (err) {
      failed++;
      db.markScanned(t.address); // rotate past it either way
      log.warn({ token: t.symbol, err: errMsg(err) }, 'ohlcv failed');
      // Persistent 429 after retries: stop this cycle instead of hammering the API.
      if (err instanceof HttpError && err.status === 429) break;
      continue;
    }
    db.markScanned(t.address);
    scanned++;

    for (const [tf, candles] of byTf) {
      for (const s of findSignals(candles, tf, signalLookback(scannable, budget, tf), config)) {
        found++;
        try {
          await maybeAlert(db, t, s, candles, notifier, 'gt-rotation');
        } catch (err) {
          log.error({ token: t.symbol, err: errMsg(err) }, 'alert failed');
        }
      }
      await armFromCandles(db, t, tf, candles, notifier).catch((err) => log.error({ token: t.symbol, err: errMsg(err) }, 'arming failed'));
    }
  }

  const summary = `GT rotation: ${scanned} of ${scannable} non-live tokens this cycle, full pass every ~${rotationMin}m, ${found} signals${failed ? `, ${failed} failed` : ''}`;
  db.setKv('job:scan:last', String(Date.now()));
  db.setKv('job:scan:summary', summary);
  log.info({ scanned, queued: queue.length, scannable, rotationMin, found, failed, ms: Date.now() - started }, 'pattern scan done');
}
