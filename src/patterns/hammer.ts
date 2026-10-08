import type { HammerConfig } from '../config.js';
import type { Candle } from './types.js';

export interface HammerResult {
  /** The hammer candle. */
  hammerIndex: number;
  hammer: Candle;
  /** Inverted hammer: long upper wick, small body at the bottom of the candle. */
  inverted: boolean;
  /** The candle that fired the signal: the confirmation candle (or the hammer itself if confirmation is off). */
  triggerIndex: number;
  trigger: Candle;
  /** Long wick (lower for a hammer, upper for an inverted hammer) as a multiple of the body. */
  wickToBody: number;
  priorDeclinePct: number;
  volume: number;
  avgVolume: number;
  invalidation: number;
  target: number;
}

export interface CandleShape {
  range: number;
  body: number;
  lowerWick: number;
  upperWick: number;
}

export function shape(c: Candle): CandleShape {
  return {
    range: c.high - c.low,
    body: Math.abs(c.close - c.open),
    lowerWick: Math.min(c.open, c.close) - c.low,
    upperWick: c.high - Math.max(c.open, c.close),
  };
}

/** Candle geometry only: long lower wick, small body near the top, little or no upper wick. */
export function isHammerShape(c: Candle, cfg: HammerConfig): boolean {
  const s = shape(c);
  if (!(s.range > 0)) return false;
  return (
    s.lowerWick >= cfg.minLowerWickToBody * s.body &&
    s.lowerWick >= cfg.minLowerWickPctOfRange * s.range &&
    s.upperWick <= cfg.maxUpperWickPctOfRange * s.range
  );
}

/** Mirror image: long upper wick, small body near the bottom, little or no lower wick. */
export function isInvertedHammerShape(c: Candle, cfg: HammerConfig): boolean {
  const s = shape(c);
  if (!(s.range > 0)) return false;
  return (
    s.upperWick >= cfg.minLowerWickToBody * s.body &&
    s.upperWick >= cfg.minLowerWickPctOfRange * s.range &&
    s.lowerWick <= cfg.maxUpperWickPctOfRange * s.range
  );
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * A "proper" hammer whose signal candle is the LAST candle of `candles` (closed candles, oldest first):
 *  - hammer geometry (isHammerShape), or an inverted hammer (isInvertedHammerShape) when `cfg.inverted` is on
 *  - follows a decline and prints the lowest low of the lookback (it is at a bottom, not mid-range)
 *  - meaningful size (range vs recent average) and at least average volume
 *  - confirmed: the next candle closes above the hammer's high (when confirmation is enabled)
 */
export function detectHammer(candles: Candle[], cfg: HammerConfig): HammerResult | null {
  const t = candles.length - 1;
  const h = cfg.requireConfirmation ? t - 1 : t;
  const need = Math.max(cfg.priorTrendCandles + 1, cfg.lowLookback, cfg.rangeAvgPeriod, cfg.volumeAvgPeriod);
  if (h < need) return null;

  const hc = candles[h];
  const inverted = !isHammerShape(hc, cfg);
  if (inverted && !(cfg.inverted && isInvertedHammerShape(hc, cfg))) return null;
  const s = shape(hc);
  const wick = inverted ? s.upperWick : s.lowerWick;

  const from = candles[h - 1 - cfg.priorTrendCandles].close;
  const to = candles[h - 1].close;
  const decline = (from - to) / from;
  if (decline < cfg.minPriorDeclinePct) return null;
  for (let j = h - cfg.lowLookback + 1; j < h; j++) if (candles[j].low < hc.low) return null;

  const avgRange = avg(candles.slice(h - cfg.rangeAvgPeriod, h).map((c) => c.high - c.low));
  if (s.range < cfg.minRangeVsAvg * avgRange) return null;
  const avgVolume = avg(candles.slice(h - cfg.volumeAvgPeriod, h).map((c) => c.volume));
  if (hc.volume < cfg.minVolumeVsAvg * avgVolume) return null;

  const trigger = candles[t];
  // 'close' = textbook confirmation: the next candle closes above the hammer's closing price.
  const confirmLevel = cfg.confirmAbove === 'close' ? hc.close : hc.high;
  if (cfg.requireConfirmation && !(trigger.close > confirmLevel)) return null;

  const invalidation = hc.low * (1 - cfg.invalidationBufferPct);
  const entry = trigger.close;
  if (!(entry > invalidation)) return null;
  return {
    hammerIndex: h,
    hammer: hc,
    inverted,
    triggerIndex: t,
    trigger,
    wickToBody: s.body > 0 ? wick / s.body : Infinity,
    priorDeclinePct: decline,
    volume: hc.volume,
    avgVolume,
    invalidation,
    target: entry + cfg.rewardToRisk * (entry - invalidation),
  };
}
