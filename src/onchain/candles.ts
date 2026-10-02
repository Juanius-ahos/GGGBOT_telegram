import type { Candle } from '../patterns/types.js';

/**
 * Fixed-interval OHLCV series fed by live ticks, seeded from historical candles.
 * Buckets align to unix time (same as GeckoTerminal), so seeded and live candles line up.
 */
export class CandleSeries {
  private candles: Candle[] = [];

  constructor(readonly intervalSec: number, private readonly maxCandles = 1100) {}

  /** Replace history (oldest first). The last seeded candle may be the still-forming one. */
  seed(candles: Candle[]): void {
    this.candles = candles.map((c) => ({ ...c })).sort((a, b) => a.time - b.time).slice(-this.maxCandles);
  }

  /** Every candle including the still-forming one (oldest first). */
  all(): Candle[] {
    return this.candles;
  }

  get length(): number {
    return this.candles.length;
  }

  get last(): Candle | undefined {
    return this.candles[this.candles.length - 1];
  }

  /** Apply one observation: price in USD, and USD volume traded since the previous tick. */
  tick(tsSec: number, priceUsd: number, volumeUsd: number): void {
    if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) return;
    const bucket = Math.floor(tsSec / this.intervalSec) * this.intervalSec;
    const last = this.last;
    if (!last || bucket > last.time) {
      this.candles.push({ time: bucket, open: priceUsd, high: priceUsd, low: priceUsd, close: priceUsd, volume: volumeUsd });
      if (this.candles.length > this.maxCandles) this.candles.shift();
    } else if (bucket === last.time) {
      last.high = Math.max(last.high, priceUsd);
      last.low = Math.min(last.low, priceUsd);
      last.close = priceUsd;
      last.volume += volumeUsd;
    }
    // Ticks older than the newest candle (clock skew / late frames) are dropped.
  }

  /** Candles whose interval has fully elapsed. */
  closed(nowSec: number): Candle[] {
    return this.candles.filter((c) => c.time + this.intervalSec <= nowSec);
  }
}

export type SlotKind = 'swap' | 'liquidity' | 'none';

/**
 * Classifies the net vault changes of one slot. A swap moves the two vaults in opposite
 * directions; adding/removing liquidity or collecting fees moves them the same way.
 */
export function classifySlot(deltaA: bigint, deltaB: bigint): SlotKind {
  if (deltaA === 0n && deltaB === 0n) return 'none';
  if ((deltaA > 0n && deltaB < 0n) || (deltaA < 0n && deltaB > 0n)) return 'swap';
  return 'liquidity';
}
