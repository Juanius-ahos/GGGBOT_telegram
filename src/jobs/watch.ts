import type { Notifier } from '../bot/notifier.js';
import { config } from '../config.js';
import type { Db, WatchToken } from '../db/index.js';
import { errMsg } from '../lib/http.js';
import { logger } from '../logger.js';
import { QUOTE_MINTS } from '../onchain/market.js';
import { sweepMarket } from '../sources/dexpaprika.js';
import { dexscreener, type DexPair } from '../sources/dexscreener.js';
import { limiters } from '../sources/limiters.js';
import { wake } from './discovery.js';
import type { DumpDetector } from './dumps.js';
import { checkToken } from './patternScan.js';

const log = logger.child({ job: 'watch' });

/**
 * How much is happening on a coin right now, from DexScreener's rolling numbers. Breakouts and hammers both need
 * above-average volume, so a 5-minute volume spike (vs the 6h average pace) or a sharp move is what earns a chart
 * check. 0 = nothing notable.
 */
export function activityScore(pair: Pick<DexPair, 'volume' | 'priceChange'>, w = config.watch): number {
  const v = pair.volume ?? {};
  const avg5m = (v.h6 ?? 0) / 72;
  const volRatio = avg5m > 0 ? (v.m5 ?? 0) / avg5m : 0;
  const m5 = Math.abs(pair.priceChange?.m5 ?? 0);
  const h1 = Math.abs(pair.priceChange?.h1 ?? 0);
  const hot = volRatio >= w.volumeSpike || m5 >= w.moveM5Pct || h1 >= w.moveH1Pct;
  return hot ? volRatio / w.volumeSpike + m5 / w.moveM5Pct + h1 / w.moveH1Pct : 0;
}

/** The watchlist pair if DexScreener returned it, else the deepest one (keeps prices on one pool). */
function pairFor(t: WatchToken, pairs: DexPair[]): DexPair | undefined {
  const own = pairs.filter((p) => p.baseToken?.address === t.address);
  return own.find((p) => p.pairAddress === t.pair_address) ?? own.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}

/** Coins waiting for a chart check, most active first. */
export class ChartQueue {
  private waiting = new Map<string, { score: number; at: number }>();

  /** `staleMs`: a coin not flagged again for this long has calmed down and leaves the queue. */
  constructor(private staleMs = 5 * 60_000) {}

  /** Latest score wins: the watch re-flags still-active coins every minute. */
  add(address: string, score: number, now = Date.now()): void {
    this.waiting.set(address, { score, at: now });
  }

  /** Highest current score first; coins that stopped being active are dropped. */
  take(now = Date.now()): string | undefined {
    let best: string | undefined;
    let bestScore = -1;
    for (const [a, e] of this.waiting) {
      if (now - e.at > this.staleMs) this.waiting.delete(a);
      else if (e.score > bestScore) [best, bestScore] = [a, e.score];
    }
    if (best) this.waiting.delete(best);
    return best;
  }

  get size(): number {
    return this.waiting.size;
  }
}

/**
 * Every minute: one DexScreener look at every watched coin (30 per call). Feeds the sudden-drop detector and
 * queues a chart check for coins with a volume spike or a sharp move.
 */
export async function runWatch(db: Db, dumps: DumpDetector, queue: ChartQueue, notifier: Notifier, isStopped: () => boolean): Promise<void> {
  const tokens = db.scanQueue(100_000);
  dumps.retain(new Set(tokens.map((t) => t.address)));
  let hot = 0;
  for (let i = 0; i < tokens.length && !isStopped(); i += 30) {
    const chunk = tokens.slice(i, i + 30);
    let pairs: DexPair[];
    try {
      pairs = await dexscreener.tokensPairs(chunk.map((t) => t.address));
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'price sample failed');
      continue;
    }
    const now = Date.now();
    for (const t of chunk) {
      const pair = pairFor(t, pairs);
      const p = Number(pair?.priceUsd);
      if (!pair || !p) continue;
      const score = activityScore(pair);
      if (score > 0 && now - (t.last_scanned_at ?? 0) >= config.watch.recheckAfterMs) {
        queue.add(t.address, score);
        hot++;
      }
      for (const d of dumps.observe(t.address, now, p)) {
        const marketCap = pair.marketCap ?? pair.fdv ?? t.market_cap;
        const liquidityUsd = pair.liquidity?.usd ?? t.liquidity_usd;
        db.insertDump({ token_address: t.address, symbol: t.symbol, timeframe: d.timeframe, candle_time: d.candleTime, open_price: d.open, price: d.price, drop_pct: d.dropPct, market_cap: marketCap, liquidity_usd: liquidityUsd, created_at: now });
        const delivered = await notifier
          .dump({ token: t, pairAddress: pair.pairAddress ?? t.pair_address, marketCap, liquidityUsd, ...d })
          .catch((err) => (log.error({ token: t.symbol, err: errMsg(err) }, 'dump alert failed'), 0));
        log.info({ token: t.symbol, address: t.address, tf: d.timeframe, dropPct: +d.dropPct.toFixed(1), delivered }, 'DUMP alert sent');
      }
    }
  }
  db.setKv('job:watch:summary', `${tokens.length} coins watched, ${hot} active this minute, ${queue.size} waiting for a chart check`);
}

/**
 * Chart checks within the free candle budget: active coins first, then (when the candle APIs are idle) whichever
 * coin went longest without a check, so slower 1h/4h patterns are still found.
 */
export async function runChartChecks(db: Db, queue: ChartQueue, notifier: Notifier, isStopped: () => boolean): Promise<void> {
  const deadline = Date.now() + config.watch.chartRunMs;
  // Parallel workers keep both candle sources busy (DexPaprika paces at ~30 s per call, GeckoTerminal at ~12 s).
  await Promise.all(Array.from({ length: config.watch.chartWorkers }, () => chartWorker(db, queue, notifier, isStopped, deadline)));
  db.setKv('job:scan:last', String(Date.now()));
}

async function chartWorker(db: Db, queue: ChartQueue, notifier: Notifier, isStopped: () => boolean, deadline: number): Promise<void> {
  while (!isStopped() && Date.now() < deadline) {
    let address = queue.take();
    let via = 'active';
    if (!address) {
      // Baseline pass only while nothing is waiting on the candle APIs.
      if (limiters.gecko.queued > 0 || limiters.dexpaprika.queued > 0) break;
      const stalest = db.scanQueue(1)[0];
      if (!stalest || Date.now() - (stalest.last_scanned_at ?? 0) < config.watch.baselineEveryMs) break;
      address = stalest.address;
      via = 'baseline';
    }
    const t = db.getToken(address);
    if (!t || !t.active || t.rug_status !== 'pass') continue;
    const sinceLast = (Date.now() - (t.last_scanned_at ?? 0)) / 1000;
    db.markScanned(t.address); // claim it, so another worker doesn't pick the same coin
    try {
      const found = await checkToken(db, t, notifier, via, Math.min(sinceLast, 4 * 3600));
      log.debug({ token: t.symbol, via, found }, 'chart checked');
    } catch (err) {
      log.warn({ token: t.symbol, err: errMsg(err) }, 'chart check failed');
    }
  }
}

/** Hourly: every Solana coin above the volume and liquidity floors becomes a discovery candidate. */
export async function runSweep(db: Db): Promise<void> {
  const started = Date.now();
  const { mints, calls } = await sweepMarket(config.market.minVolume24hUsd, config.market.minLiquidityUsd, QUOTE_MINTS);
  db.addCandidates(mints, 'sweep');
  wake(mints);
  db.setKv('job:sweep:summary', `${mints.length} coins above the volume/liquidity floor (${calls} calls, ${new Date().toISOString().slice(11, 16)} UTC)`);
  log.info({ coins: mints.length, calls, ms: Date.now() - started }, 'market sweep done');
}
