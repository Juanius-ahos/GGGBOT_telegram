import type { DoubleBottomConfig } from '../config.js';
import type { Candle, DoubleBottomResult } from './types.js';

/**
 * A swing low beats every low within `k` candles on each side.
 * Strict on the left, non-strict on the right, so a flat bottom yields one swing (its first candle).
 * `lastIndex` caps the right-hand window (candles after it are ignored).
 */
export function isSwingLow(candles: Candle[], i: number, k: number, lastIndex = candles.length - 1): boolean {
  if (i - k < 0 || i + k > lastIndex) return false;
  const low = candles[i].low;
  for (let j = i - k; j < i; j++) if (candles[j].low <= low) return false;
  for (let j = i + 1; j <= i + k; j++) if (candles[j].low < low) return false;
  return true;
}

export function findSwingLows(candles: Candle[], k: number, lastIndex = candles.length - 1): number[] {
  const out: number[] = [];
  for (let i = k; i + k <= lastIndex; i++) if (isSwingLow(candles, i, k, lastIndex)) out.push(i);
  return out;
}

/**
 * OHLCV feeds have no buy/sell split, so "sell volume" at a low is approximated as the
 * volume of red candles (close < open) in the `window` candles ending at the low.
 */
export function sellVolumeAt(candles: Candle[], i: number, window: number): number {
  let sum = 0;
  for (let j = Math.max(0, i - window + 1); j <= i; j++) {
    const c = candles[j];
    if (c.close < c.open) sum += c.volume;
  }
  return sum;
}

function averageVolume(candles: Candle[], endExclusive: number, period: number): number | null {
  const start = endExclusive - period;
  if (start < 0) return null;
  let sum = 0;
  for (let j = start; j < endExclusive; j++) sum += candles[j].volume;
  return sum / period;
}

/**
 * Detects a double bottom whose breakout is the LAST candle of `candles`.
 * Pass closed candles only, oldest first. Returns null unless the last candle is a fresh,
 * volume-confirmed close above the neckline.
 */
export function detectDoubleBottom(candles: Candle[], cfg: DoubleBottomConfig): DoubleBottomResult | null {
  const k = cfg.swingLookback;
  const t = candles.length - 1;
  if (t < cfg.breakoutVolumeAvgPeriod || t < cfg.minCandlesBetweenLows + 2 * k + 1) return null;

  const breakoutCandle = candles[t];
  const avgVolume = averageVolume(candles, t, cfg.breakoutVolumeAvgPeriod);
  if (avgVolume === null || !(breakoutCandle.volume > avgVolume * cfg.breakoutVolumeMultiplier)) return null;

  // Swing lows must be confirmed by candles before the breakout candle.
  const swings = findSwingLows(candles, k, t - 1);

  // Most recent second low first: the freshest pattern wins.
  for (let bi = swings.length - 1; bi >= 0; bi--) {
    const b = swings[bi];
    if (t - b > cfg.maxCandlesAfterSecondLow) break;
    const lowB = candles[b].low;

    // Price must not have undercut the second low after it formed.
    let undercut = false;
    for (let j = b + 1; j <= t; j++) if (candles[j].low < lowB) { undercut = true; break; }
    if (undercut) continue;

    for (let ai = bi - 1; ai >= 0; ai--) {
      const a = swings[ai];
      const gap = b - a;
      if (gap < cfg.minCandlesBetweenLows) continue;
      if (gap > cfg.maxCandlesBetweenLows) break;

      const lowA = candles[a].low;
      const lower = Math.min(lowA, lowB);
      const higher = Math.max(lowA, lowB);
      if ((higher - lower) / lower > cfg.lowTolerancePct) continue;

      // Neither low may be undercut between them, and find the neckline (highest high between).
      let neckline = -Infinity;
      let necklineIndex = -1;
      let valid = true;
      for (let j = a + 1; j < b; j++) {
        if (candles[j].low < lower) { valid = false; break; }
        if (candles[j].high > neckline) { neckline = candles[j].high; necklineIndex = j; }
      }
      if (!valid || necklineIndex < 0) continue;
      if (neckline < higher * (1 + cfg.minBouncePct)) continue;

      // The breakout must be the FIRST close above the neckline since the second low.
      if (!(breakoutCandle.close > neckline)) continue;
      let earlierBreakout = false;
      for (let j = b + 1; j < t; j++) if (candles[j].close > neckline) { earlierBreakout = true; break; }
      if (earlierBreakout) continue;

      const sellA = sellVolumeAt(candles, a, cfg.sellVolumeWindow);
      const sellB = sellVolumeAt(candles, b, cfg.sellVolumeWindow);
      if (sellB > sellA * (1 + cfg.sellVolumeTolerancePct)) continue;

      const patternHeight = neckline - lower;
      return {
        firstLow: { index: a, time: candles[a].time, price: lowA },
        secondLow: { index: b, time: candles[b].time, price: lowB },
        neckline,
        necklineIndex,
        breakout: {
          index: t,
          time: breakoutCandle.time,
          price: breakoutCandle.close,
          volume: breakoutCandle.volume,
          avgVolume,
        },
        firstLowSellVolume: sellA,
        secondLowSellVolume: sellB,
        patternHeight,
        target: neckline + patternHeight,
        invalidation: lowB * (1 - cfg.invalidationBufferPct),
      };
    }
  }
  return null;
}
