import type { DoubleBottomConfig, HammerConfig } from '../config.js';
import { findSwingLows, sellVolumeAt } from './doubleBottom.js';
import { detectHammer, type HammerResult } from './hammer.js';
import type { Candle, PatternPoint } from './types.js';

/**
 * A double bottom whose two lows are in place but whose neckline has NOT been broken yet.
 * Same structural rules as detectDoubleBottom (lows within tolerance, bounce, sell volume); the
 * breakout itself is then caught in real time by the setup watcher.
 */
export interface DoubleBottomSetup {
  firstLow: PatternPoint;
  secondLow: PatternPoint;
  neckline: number;
  necklineIndex: number;
  invalidation: number;
  target: number;
  firstLowSellVolume: number;
  secondLowSellVolume: number;
  /** Average volume of the breakoutVolumeAvgPeriod candles before the last one (for the breakout volume check). */
  avgVolume: number;
}

export function detectDoubleBottomSetup(candles: Candle[], cfg: DoubleBottomConfig): DoubleBottomSetup | null {
  const k = cfg.swingLookback;
  const t = candles.length - 1;
  if (t < cfg.breakoutVolumeAvgPeriod || t < cfg.minCandlesBetweenLows + 2 * k + 1) return null;
  const last = candles[t];
  const swings = findSwingLows(candles, k, t);

  for (let bi = swings.length - 1; bi >= 0; bi--) {
    const b = swings[bi];
    if (t - b > cfg.maxCandlesAfterSecondLow) break;
    const lowB = candles[b].low;
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

      let neckline = -Infinity;
      let necklineIndex = -1;
      let valid = true;
      for (let j = a + 1; j < b; j++) {
        if (candles[j].low < lower) { valid = false; break; }
        if (candles[j].high > neckline) { neckline = candles[j].high; necklineIndex = j; }
      }
      if (!valid || necklineIndex < 0) continue;
      if (neckline < higher * (1 + cfg.minBouncePct)) continue;

      // Not broken out yet: no close above the neckline since the second low.
      let broken = false;
      for (let j = b + 1; j <= t; j++) if (candles[j].close > neckline) { broken = true; break; }
      if (broken || !(last.close < neckline)) continue;

      const sellA = sellVolumeAt(candles, a, cfg.sellVolumeWindow);
      const sellB = sellVolumeAt(candles, b, cfg.sellVolumeWindow);
      if (sellB > sellA * (1 + cfg.sellVolumeTolerancePct)) continue;

      let vol = 0;
      for (let j = t + 1 - cfg.breakoutVolumeAvgPeriod; j <= t; j++) vol += candles[j].volume;
      return {
        firstLow: { index: a, time: candles[a].time, price: lowA },
        secondLow: { index: b, time: candles[b].time, price: lowB },
        neckline,
        necklineIndex,
        invalidation: lowB * (1 - cfg.invalidationBufferPct),
        target: neckline + (neckline - lower),
        firstLowSellVolume: sellA,
        secondLowSellVolume: sellB,
        avgVolume: vol / cfg.breakoutVolumeAvgPeriod,
      };
    }
  }
  return null;
}

/**
 * The LAST candle is a hammer at a bottom (all hammer rules except confirmation). The trigger is a
 * break of its high, caught in real time instead of waiting for the next candle to close.
 */
export function detectHammerSetup(candles: Candle[], cfg: HammerConfig): HammerResult | null {
  return detectHammer(candles, { ...cfg, requireConfirmation: false });
}
