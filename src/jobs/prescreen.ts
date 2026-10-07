import { config, type DoubleBottomConfig, type HammerConfig } from '../config.js';
import { CandleSeries } from '../onchain/candles.js';
import { detectDoubleBottomSetup, detectHammerSetup } from '../patterns/setups.js';
import { multiTimeframe, TIMEFRAME_SECONDS, type Timeframe } from '../patterns/timeframes.js';
import type { Candle } from '../patterns/types.js';

/**
 * Cheap early warning for every watched coin, with no candle downloads: real chart history from the last chart
 * check, extended every minute with the DexScreener price the watch job already fetches. When a double bottom's
 * second low (or a hammer) shows up, the coin jumps to the front of the chart queue; the real chart then confirms it
 * and arms the setup, so the real-time price feed is already watching when the neckline breaks.
 *
 * Minute samples miss short wicks and carry no volume, so this only decides WHICH coin to check next. Nothing is
 * armed or alerted from sampled candles.
 */
export interface PrescreenHit {
  token: string;
  timeframe: Timeframe;
  kind: 'double_bottom' | 'hammer';
}

/** Volume rules off: sampled candles have no volume. The real-chart check applies every rule. */
function prescreenConfig(): { doubleBottom: DoubleBottomConfig; hammer: HammerConfig } {
  return {
    doubleBottom: { ...config.doubleBottom, sellVolumeTolerancePct: Number.POSITIVE_INFINITY },
    hammer: { ...config.hammer, minVolumeVsAvg: 0 },
  };
}

export class SampledCandles {
  private series = new Map<string, CandleSeries>();
  /** Setups already flagged (token:tf:kind:key time) -> when, so each one jumps the queue once. */
  private flagged = new Map<string, number>();
  hitsLastHour: number[] = [];

  /** Replace a coin's history with real candles from a chart check. */
  seed(token: string, candles: Candle[], baseSec: number): void {
    if (!candles.length) return;
    const s = new CandleSeries(baseSec, 600);
    s.seed(candles);
    this.series.set(token, s);
  }

  /** One live price sample; extends the coin's candles (ignored until its first chart check). */
  observe(token: string, tSec: number, price: number): void {
    if (price > 0) this.series.get(token)?.tick(tSec, price, 0);
  }

  retain(tokens: Set<string>): void {
    for (const k of this.series.keys()) if (!tokens.has(k)) this.series.delete(k);
  }

  get size(): number {
    return this.series.size;
  }

  /** New setups since the last call (each reported once). */
  scan(nowSec = Date.now() / 1000): PrescreenHit[] {
    const cfg = prescreenConfig();
    const out: PrescreenHit[] = [];
    const tfs = config.timeframes.filter((tf) => tf !== '4h'); // 4h has too few candles to sample usefully
    for (const [token, s] of this.series) {
      const byTf = multiTimeframe(s.all(), s.intervalSec, tfs, config.detectCandles, nowSec);
      for (const [tf, candles] of byTf) {
        const db = detectDoubleBottomSetup(candles, cfg.doubleBottom);
        if (db) this.flag(out, token, tf, 'double_bottom', db.secondLow.time, nowSec);
        if (config.hammer.timeframes.includes(tf)) {
          const h = detectHammerSetup(candles, cfg.hammer);
          if (h) this.flag(out, token, tf, 'hammer', h.hammer.time, nowSec);
        }
      }
    }
    // Forget old flags (a setup's life is bounded by maxCandlesAfterSecondLow on the slowest scanned timeframe).
    const keepSec = config.doubleBottom.maxCandlesAfterSecondLow * TIMEFRAME_SECONDS['1h'];
    for (const [k, at] of this.flagged) if (nowSec - at > keepSec) this.flagged.delete(k);
    this.hitsLastHour = this.hitsLastHour.filter((t) => nowSec - t < 3600);
    return out;
  }

  private flag(out: PrescreenHit[], token: string, timeframe: Timeframe, kind: PrescreenHit['kind'], keyTime: number, nowSec: number): void {
    const key = `${token}:${timeframe}:${kind}:${keyTime}`;
    if (this.flagged.has(key)) return;
    this.flagged.set(key, nowSec);
    this.hitsLastHour.push(nowSec);
    out.push({ token, timeframe, kind });
  }
}

/** Shared by the watch job (samples + scan) and chart checks (seeding with real candles). */
export const sampled = new SampledCandles();
