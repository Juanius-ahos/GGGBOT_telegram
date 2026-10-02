import { describe, expect, it } from 'vitest';
import { config, type DoubleBottomConfig } from '../src/config.js';
import { detectDoubleBottom, findSwingLows, sellVolumeAt } from '../src/patterns/doubleBottom.js';
import type { Candle } from '../src/patterns/types.js';

const cfg: DoubleBottomConfig = { ...config.doubleBottom };

interface Leg {
  /** Close price at the end of the leg. */
  to: number;
  bars: number;
  volume: number;
}

/** Deterministic PRNG so noisy tests are reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

/**
 * Builds candles whose closes move linearly along each leg. Wicks are 0.2% beyond the body.
 * Direction sets candle colour, so a falling leg's volume counts as "sell volume".
 */
function build(start: number, legs: Leg[], opts: { noise?: number; seed?: number } = {}): Candle[] {
  const rand = rng(opts.seed ?? 1);
  const wick = 0.002;
  const candles: Candle[] = [];
  let prev = start;
  let time = 1_700_000_000;
  for (const leg of legs) {
    const from = prev;
    for (let i = 1; i <= leg.bars; i++) {
      let close = from + ((leg.to - from) * i) / leg.bars;
      if (opts.noise && i < leg.bars) close *= 1 + (rand() * 2 - 1) * opts.noise;
      const open = prev;
      candles.push({
        time,
        open,
        close,
        high: Math.max(open, close) * (1 + wick),
        low: Math.min(open, close) * (1 - wick),
        volume: leg.volume,
      });
      prev = close;
      time += 900;
    }
  }
  return candles;
}

// Decline into low A (0.70), bounce to 0.80, retest at 0.705 on lighter volume, drift up under neckline.
const base: Leg[] = [
  { to: 0.7, bars: 30, volume: 100 },
  { to: 0.8, bars: 10, volume: 80 },
  { to: 0.705, bars: 10, volume: 60 },
  { to: 0.79, bars: 8, volume: 70 },
];
const breakout = (close = 0.83, volume = 300): Leg => ({ to: close, bars: 1, volume });

describe('swing lows', () => {
  it('finds the two troughs of a W', () => {
    const c = build(1, [...base, breakout()]);
    expect(findSwingLows(c, cfg.swingLookback)).toEqual([29, 49]);
  });

  it('marks only the first candle of a flat bottom', () => {
    const flat: Candle[] = [5, 4, 3, 2, 2, 2, 3, 4, 5].map((l, i) => ({
      time: i, open: l + 1, high: l + 2, low: l, close: l + 1, volume: 1,
    }));
    expect(findSwingLows(flat, 2)).toEqual([3]);
  });

  it('measures sell volume from red candles only', () => {
    const c = build(1, [{ to: 0.9, bars: 3, volume: 10 }, { to: 1, bars: 3, volume: 99 }]);
    expect(sellVolumeAt(c, 2, 3)).toBe(30);
    expect(sellVolumeAt(c, 5, 3)).toBe(0);
  });
});

describe('detectDoubleBottom: true positives', () => {
  it('detects a textbook double bottom on the breakout candle', () => {
    const c = build(1, [...base, breakout()]);
    const r = detectDoubleBottom(c, cfg);
    expect(r).not.toBeNull();
    expect(r!.firstLow.index).toBe(29);
    expect(r!.secondLow.index).toBe(49);
    expect(r!.breakout.index).toBe(c.length - 1);
    expect(r!.breakout.price).toBeCloseTo(0.83);
    expect(r!.neckline).toBeCloseTo(0.8 * 1.002, 6);
  });

  it('computes target and invalidation from the pattern geometry', () => {
    const c = build(1, [...base, breakout()]);
    const r = detectDoubleBottom(c, cfg)!;
    const lower = Math.min(r.firstLow.price, r.secondLow.price);
    expect(r.patternHeight).toBeCloseTo(r.neckline - lower, 10);
    expect(r.target).toBeCloseTo(r.neckline + (r.neckline - lower), 10);
    expect(r.invalidation).toBeCloseTo(r.secondLow.price * (1 - cfg.invalidationBufferPct), 10);
    expect(r.invalidation).toBeLessThan(r.secondLow.price);
    expect(r.target).toBeGreaterThan(r.breakout.price);
  });

  it('accepts a second low slightly BELOW the first (within tolerance)', () => {
    const legs = [...base];
    legs[2] = { to: 0.69, bars: 10, volume: 60 }; // ~1.4% under low A
    expect(detectDoubleBottom(build(1, [...legs, breakout()]), cfg)).not.toBeNull();
  });

  it('accepts equal sell volume at both lows', () => {
    const legs = [...base];
    legs[2] = { to: 0.705, bars: 10, volume: 100 };
    expect(detectDoubleBottom(build(1, [...legs, breakout()]), cfg)).not.toBeNull();
  });

  it('survives mild price noise', () => {
    for (const seed of [3, 7, 11, 42]) {
      const c = build(1, [...base, breakout(0.84)], { noise: 0.002, seed });
      expect(detectDoubleBottom(c, cfg), `seed ${seed}`).not.toBeNull();
    }
  });
});

// Each rejection is paired with a control: relaxing only the targeted threshold must flip it to a detection,
// proving the case fails for the intended reason and not by accident.
describe('detectDoubleBottom: false positives', () => {
  it('rejects a breakout on below-average volume', () => {
    const c = build(1, [...base, breakout(0.83, 50)]);
    expect(detectDoubleBottom(c, cfg)).toBeNull();
    expect(detectDoubleBottom(c, { ...cfg, breakoutVolumeMultiplier: 0.5 })).not.toBeNull();
  });

  it('rejects when the candle has not closed above the neckline', () => {
    expect(detectDoubleBottom(build(1, [...base, breakout(0.795, 300)]), cfg)).toBeNull();
  });

  it('rejects lows more than 3% apart', () => {
    const legs: Leg[] = [
      { to: 0.7, bars: 30, volume: 100 },
      { to: 0.9, bars: 10, volume: 80 },
      { to: 0.745, bars: 10, volume: 60 }, // 6.4% above low A
      { to: 0.88, bars: 8, volume: 70 },
    ];
    const c = build(1, [...legs, breakout(0.93)]);
    expect(detectDoubleBottom(c, cfg)).toBeNull();
    expect(detectDoubleBottom(c, { ...cfg, lowTolerancePct: 0.08 })).not.toBeNull();
  });

  it('rejects lows fewer than 8 candles apart', () => {
    const legs: Leg[] = [
      { to: 0.7, bars: 30, volume: 100 },
      { to: 0.8, bars: 3, volume: 80 },
      { to: 0.705, bars: 3, volume: 60 }, // 6 candles apart
      { to: 0.79, bars: 8, volume: 70 },
    ];
    const c = build(1, [...legs, breakout()]);
    expect(detectDoubleBottom(c, cfg)).toBeNull();
    expect(detectDoubleBottom(c, { ...cfg, minCandlesBetweenLows: 5 })).not.toBeNull();
  });

  it('rejects a bounce smaller than 8%', () => {
    const legs: Leg[] = [
      { to: 0.7, bars: 30, volume: 100 },
      { to: 0.74, bars: 10, volume: 80 }, // ~5% bounce
      { to: 0.705, bars: 10, volume: 60 },
      { to: 0.735, bars: 8, volume: 70 },
    ];
    const c = build(1, [...legs, breakout(0.76)]);
    expect(detectDoubleBottom(c, cfg)).toBeNull();
    expect(detectDoubleBottom(c, { ...cfg, minBouncePct: 0.04 })).not.toBeNull();
  });

  it('rejects a second low on heavier sell volume', () => {
    const legs = [...base];
    legs[2] = { to: 0.705, bars: 10, volume: 150 };
    const c = build(1, [...legs, breakout(0.83, 600)]);
    expect(detectDoubleBottom(c, cfg)).toBeNull();
    expect(detectDoubleBottom(c, { ...cfg, sellVolumeTolerancePct: 1 })).not.toBeNull();
  });

  it('does not re-fire after the breakout has already happened', () => {
    const c = build(1, [...base, breakout(), { to: 0.86, bars: 3, volume: 400 }]);
    expect(detectDoubleBottom(c.slice(0, -3), cfg)).not.toBeNull();
    expect(detectDoubleBottom(c, cfg)).toBeNull();
  });

  it('rejects when price broke down below the lows before breaking out', () => {
    const legs: Leg[] = [
      ...base.slice(0, 3),
      { to: 0.6, bars: 6, volume: 120 }, // breakdown far below both lows
      { to: 0.79, bars: 10, volume: 70 },
    ];
    expect(detectDoubleBottom(build(1, [...legs, breakout()]), cfg)).toBeNull();
  });

  it('rejects a plain downtrend and a plain uptrend', () => {
    expect(detectDoubleBottom(build(1, [{ to: 0.4, bars: 80, volume: 100 }, breakout(0.39)]), cfg)).toBeNull();
    expect(detectDoubleBottom(build(1, [{ to: 2, bars: 80, volume: 100 }, breakout(2.1)]), cfg)).toBeNull();
  });

  it('rejects when the second low formed too long before the breakout', () => {
    const legs = [...base];
    legs[3] = { to: 0.79, bars: 45, volume: 70 };
    const c = build(1, [...legs, breakout()]);
    expect(detectDoubleBottom(c, cfg)).toBeNull();
    expect(detectDoubleBottom(c, { ...cfg, maxCandlesAfterSecondLow: 60 })).not.toBeNull();
  });

  it('returns null on too little data', () => {
    expect(detectDoubleBottom(build(1, [{ to: 0.9, bars: 10, volume: 1 }]), cfg)).toBeNull();
    expect(detectDoubleBottom([], cfg)).toBeNull();
  });

  it('honours configurable thresholds', () => {
    const c = build(1, [...base, breakout()]);
    expect(detectDoubleBottom(c, { ...cfg, minBouncePct: 0.2 })).toBeNull();
    expect(detectDoubleBottom(c, { ...cfg, minCandlesBetweenLows: 25 })).toBeNull();
    expect(detectDoubleBottom(c, { ...cfg, breakoutVolumeMultiplier: 10 })).toBeNull();
    expect(detectDoubleBottom(c, { ...cfg, lowTolerancePct: 0.001 })).toBeNull();
  });
});
