import type { Notifier } from '../bot/notifier.js';
import { config } from '../config.js';
import type { Db, WatchToken } from '../db/index.js';
import { errMsg } from '../lib/http.js';
import { logger } from '../logger.js';
import { dexscreener, type DexPair } from '../sources/dexscreener.js';

const log = logger.child({ job: 'dumps' });

type DumpTf = (typeof config.dumps.timeframes)[number];
const TF_SEC: Record<DumpTf, number> = { '5m': 300, '15m': 900 };

export interface Dump {
  timeframe: DumpTf;
  /** Candle open time, ms (UTC-aligned, like GeckoTerminal candles). */
  candleTime: number;
  open: number;
  price: number;
  /** Positive percentage, e.g. 37.2 for a 37.2% fall. */
  dropPct: number;
  /** Fell more than `rugLabelAbovePct`: shown as a possible rug. */
  possibleRug: boolean;
}

interface Sample {
  t: number;
  p: number;
}

/**
 * Detects a single candle falling at least `minDropPct` from its open (deeper than `rugLabelAbovePct` = possible rug), on prices sampled every few seconds.
 * The open is the last price seen before the candle started (= previous close), so a drop that begins right at
 * the candle boundary still counts. One alert per token+timeframe+candle; a 15m alert is skipped when the same
 * fall was already reported on 5m in that 15m candle.
 */
export class DumpDetector {
  private samples = new Map<string, Sample[]>();
  private sent = new Map<string, number>();
  private last5m = new Map<string, number>();

  constructor(private cfg = config.dumps) {}

  observe(token: string, t: number, p: number): Dump[] {
    if (!(p > 0)) return [];
    const maxSec = Math.max(...this.cfg.timeframes.map((tf) => TF_SEC[tf]));
    const list = (this.samples.get(token) ?? []).filter((s) => s.t > t - 2 * maxSec * 1000);
    list.push({ t, p });
    this.samples.set(token, list);

    const out: Dump[] = [];
    for (const tf of this.cfg.timeframes) {
      const ms = TF_SEC[tf] * 1000;
      const start = Math.floor(t / ms) * ms;
      const before = list.filter((s) => s.t < start).at(-1);
      // Without a price from just before the candle, use its first sample (only if it isn't the current one).
      const open = before && start - before.t <= 2 * this.cfg.sampleIntervalMs ? before.p : list.find((s) => s.t >= start && s.t < t)?.p;
      if (!open) continue;
      const dropPct = ((open - p) / open) * 100;
      if (dropPct < this.cfg.minDropPct) continue;
      const key = `${token}:${tf}`;
      if (this.sent.get(key) === start) continue;
      this.sent.set(key, start);
      if (tf === '15m' && (this.last5m.get(token) ?? 0) >= start) continue;
      if (tf === '5m') this.last5m.set(token, t);
      out.push({ timeframe: tf, candleTime: start, open, price: p, dropPct, possibleRug: dropPct > this.cfg.rugLabelAbovePct });
    }
    return out;
  }

  /** Forget tokens that left the watchlist. */
  retain(tokens: Set<string>): void {
    for (const k of this.samples.keys()) if (!tokens.has(k)) this.samples.delete(k);
  }
}

/** The watchlist pair if DexScreener returned it, else the deepest one (keeps the price series on one pool). */
function pairFor(t: WatchToken, pairs: DexPair[]): DexPair | undefined {
  const own = pairs.filter((p) => p.baseToken?.address === t.address);
  return own.find((p) => p.pairAddress === t.pair_address) ?? own.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}

export async function runDumpWatcher(db: Db, detector: DumpDetector, notifier: Notifier, isStopped: () => boolean): Promise<void> {
  const tokens = db.scanQueue(100_000);
  detector.retain(new Set(tokens.map((t) => t.address)));
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
      for (const d of detector.observe(t.address, now, p)) {
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
}
