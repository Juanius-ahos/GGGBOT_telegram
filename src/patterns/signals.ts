import type { DoubleBottomConfig, HammerConfig } from '../config.js';
import { detectDoubleBottom } from './doubleBottom.js';
import { detectHammer, isHammerShape, type HammerResult } from './hammer.js';
import type { Timeframe } from './timeframes.js';
import type { Candle, DoubleBottomResult } from './types.js';

export type PatternKind = 'double_bottom' | 'hammer';

export const PATTERN_LABEL: Record<PatternKind, string> = {
  double_bottom: 'Double bottom breakout',
  hammer: 'Hammer reversal',
};

/** One tradable signal, pattern-agnostic, so alerting/charting/tracking treat both patterns the same way. */
export interface Signal {
  pattern: PatternKind;
  timeframe: Timeframe;
  /** Candle that fired the signal (breakout candle / hammer confirmation candle). */
  triggerIndex: number;
  triggerTime: number;
  entry: number;
  /** Volume vs recent average on the candle that matters (breakout candle / hammer candle). */
  volumeRatio: number;
  target: number;
  invalidation: number;
  /** Stored with the alert. For hammers: low, low, high of the hammer candle. */
  firstLow: number;
  secondLow: number;
  neckline: number;
  doubleBottom?: DoubleBottomResult;
  hammer?: HammerResult;
  /** Double bottom whose second low printed a hammer-shaped candle (extra confluence). */
  hammerAtSecondLow?: boolean;
}

function fromDoubleBottom(r: DoubleBottomResult, candles: Candle[], tf: Timeframe, hCfg: HammerConfig): Signal {
  const l2 = r.secondLow.index;
  return {
    pattern: 'double_bottom',
    timeframe: tf,
    triggerIndex: r.breakout.index,
    triggerTime: r.breakout.time,
    entry: r.breakout.price,
    volumeRatio: r.breakout.avgVolume > 0 ? r.breakout.volume / r.breakout.avgVolume : 0,
    target: r.target,
    invalidation: r.invalidation,
    firstLow: r.firstLow.price,
    secondLow: r.secondLow.price,
    neckline: r.neckline,
    doubleBottom: r,
    hammerAtSecondLow: isHammerShape(candles[l2], hCfg),
  };
}

function fromHammer(r: HammerResult, tf: Timeframe): Signal {
  return {
    pattern: 'hammer',
    timeframe: tf,
    triggerIndex: r.triggerIndex,
    triggerTime: r.trigger.time,
    entry: r.trigger.close,
    volumeRatio: r.avgVolume > 0 ? r.volume / r.avgVolume : 0,
    target: r.target,
    invalidation: r.invalidation,
    firstLow: r.hammer.low,
    secondLow: r.hammer.low,
    neckline: r.hammer.high,
    hammer: r,
  };
}

/**
 * Signals fired on any of the last `lookback` closed candles (newest first, at most one per pattern).
 * Older signals only count while the latest close still holds the pattern's key level.
 */
export function findSignals(
  candles: Candle[],
  tf: Timeframe,
  lookback: number,
  cfg: { doubleBottom: DoubleBottomConfig; hammer: HammerConfig },
): Signal[] {
  const out: Signal[] = [];
  if (candles.length === 0) return out;
  const last = candles[candles.length - 1];
  let gotDb = false;
  let gotHammer = false;
  for (let back = 0; back < lookback && candles.length - back > 0; back++) {
    const slice = candles.slice(0, candles.length - back);
    if (!gotDb) {
      const r = detectDoubleBottom(slice, cfg.doubleBottom);
      if (r && last.close > r.neckline) {
        out.push(fromDoubleBottom(r, slice, tf, cfg.hammer));
        gotDb = true;
      }
    }
    if (!gotHammer) {
      const r = detectHammer(slice, cfg.hammer);
      if (r && last.close > r.hammer.high) {
        out.push(fromHammer(r, tf));
        gotHammer = true;
      }
    }
  }
  return out;
}
