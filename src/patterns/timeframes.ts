import type { Candle } from './types.js';

export type Timeframe = '15m' | '1h' | '4h';

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = { '15m': 900, '1h': 3600, '4h': 14_400 };

/**
 * Rolls base candles (oldest first) up into a larger UTC-aligned interval, e.g. 15m -> 1h / 4h.
 * Buckets with no trades simply don't exist, as on GeckoTerminal.
 */
export function aggregate(candles: Candle[], intervalSec: number): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const bucket = Math.floor(c.time / intervalSec) * intervalSec;
    const last = out[out.length - 1];
    if (last && last.time === bucket) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else {
      out.push({ time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    }
  }
  return out;
}

/** Candles whose interval has fully elapsed. */
export function closedOnly(candles: Candle[], intervalSec: number, nowSec = Date.now() / 1000): Candle[] {
  return candles.filter((c) => c.time + intervalSec <= nowSec);
}

/**
 * 15m base candles -> closed candles per timeframe, newest `maxCandles[tf]` kept.
 * A higher-timeframe bucket is dropped if the base history doesn't cover its start (partial first candle).
 */
export function multiTimeframe(
  base15m: Candle[],
  timeframes: readonly Timeframe[],
  maxCandles: Record<Timeframe, number>,
  nowSec = Date.now() / 1000,
): Map<Timeframe, Candle[]> {
  const out = new Map<Timeframe, Candle[]>();
  const firstBase = base15m[0]?.time ?? 0;
  for (const tf of timeframes) {
    const sec = TIMEFRAME_SECONDS[tf];
    let series = tf === '15m' ? base15m : aggregate(base15m, sec);
    if (tf !== '15m' && series.length && series[0].time < firstBase) series = series.slice(1);
    out.set(tf, closedOnly(series, sec, nowSec).slice(-maxCandles[tf]));
  }
  return out;
}
