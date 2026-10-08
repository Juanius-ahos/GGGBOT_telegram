import { describe, expect, it } from 'vitest';
import { config, type HammerConfig } from '../src/config.js';
import { detectHammer, isHammerShape, isInvertedHammerShape } from '../src/patterns/hammer.js';
import { findSignals } from '../src/patterns/signals.js';
import { aggregate, multiTimeframe } from '../src/patterns/timeframes.js';
import type { Candle } from '../src/patterns/types.js';

const cfg: HammerConfig = { ...config.hammer };

/** 30 falling candles (-1% each, so 6 candles = ~6% decline), range ~2.5%, volume 100. */
function downtrend(n = 30, start = 1): Candle[] {
  const out: Candle[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const open = p;
    const close = p * 0.99;
    out.push({ time: i * 900, open, close, high: open * 1.005, low: close * 0.99, volume: 100 });
    p = close;
  }
  return out;
}

/** Hammer at the end of `prior`: body near the top, lower wick `wick`x body, tiny upper wick. */
function hammerAfter(prior: Candle[], o: { wick?: number; upper?: number; vol?: number; body?: number } = {}): Candle {
  const prev = prior[prior.length - 1];
  const open = prev.close;
  const body = (o.body ?? 0.006) * open;
  const close = open + body; // green hammer
  const lowerWick = body * (o.wick ?? 4);
  return { time: prev.time + 900, open, close, high: close + (o.upper ?? 0.0005) * open, low: open - lowerWick, volume: o.vol ?? 180 };
}

const confirm = (h: Candle, aboveHigh = true): Candle => ({
  time: h.time + 900, open: h.close, close: aboveHigh ? h.high * 1.01 : h.close * 0.999, high: h.high * 1.015, low: h.close * 0.995, volume: 150,
});

describe('hammer shape', () => {
  it('accepts long lower wick + small body at the top', () => {
    expect(isHammerShape({ time: 0, open: 1, close: 1.01, high: 1.011, low: 0.95, volume: 1 }, cfg)).toBe(true);
  });
  it('rejects inverted hammer / shooting star (long upper wick)', () => {
    expect(isHammerShape({ time: 0, open: 1, close: 1.01, high: 1.06, low: 0.995, volume: 1 }, cfg)).toBe(false);
  });
  it('accepts the inverted hammer only with the inverted check (long upper wick, body at the bottom)', () => {
    const inv = { time: 0, open: 1, close: 1.01, high: 1.06, low: 0.998, volume: 1 };
    expect(isInvertedHammerShape(inv, cfg)).toBe(true);
    expect(isInvertedHammerShape({ time: 0, open: 1, close: 1.01, high: 1.011, low: 0.95, volume: 1 }, cfg)).toBe(false); // regular hammer
  });
  it('rejects big-bodied candles and zero-range candles', () => {
    expect(isHammerShape({ time: 0, open: 1, close: 1.05, high: 1.051, low: 0.98, volume: 1 }, cfg)).toBe(false);
    expect(isHammerShape({ time: 0, open: 1, close: 1, high: 1, low: 1, volume: 1 }, cfg)).toBe(false);
  });
});

describe('detectHammer', () => {
  it('fires on the confirmation candle after a hammer at a bottom', () => {
    const prior = downtrend();
    const h = hammerAfter(prior);
    const r = detectHammer([...prior, h, confirm(h)], cfg);
    expect(r).not.toBeNull();
    expect(r!.hammerIndex).toBe(30);
    expect(r!.triggerIndex).toBe(31);
    expect(r!.invalidation).toBeCloseTo(h.low * (1 - cfg.invalidationBufferPct), 12);
    const entry = r!.trigger.close;
    expect(r!.target).toBeCloseTo(entry + cfg.rewardToRisk * (entry - r!.invalidation), 12);
  });

  it('does not fire without confirmation (next close not above hammer high)', () => {
    const prior = downtrend();
    const h = hammerAfter(prior);
    expect(detectHammer([...prior, h, confirm(h, false)], cfg)).toBeNull();
    expect(detectHammer([...prior, h, confirm(h, false)], { ...cfg, requireConfirmation: false })).toBeNull(); // last candle isn't a hammer
  });

  it('confirms on a close above the hammer close even if it stays under the high (ARTHUR, 2 Oct)', () => {
    const prior = downtrend();
    // Red hammer like ARTHUR 15m 07:00 (O 615K = H 615K, C 602K): body top equals the high.
    const g = hammerAfter(prior);
    const h = { ...g, open: g.close, close: g.open };
    // Next candle closes above the hammer's close but below its high, like ARTHUR 15m 07:15 (613K vs 615K high).
    const next = { time: h.time + 900, open: h.close, close: (h.close + h.high) / 2, high: h.high, low: h.close * 0.999, volume: 150 };
    expect(detectHammer([...prior, h, next], { ...cfg, confirmAbove: 'close' })).not.toBeNull(); // textbook rule
    expect(detectHammer([...prior, h, next], { ...cfg, confirmAbove: 'high' })).toBeNull(); // strict rule (default)
  });

  it('rejects a hammer that is not after a decline', () => {
    const flat: Candle[] = Array.from({ length: 30 }, (_, i) => ({ time: i * 900, open: 1, close: 1.001, high: 1.01, low: 0.99, volume: 100 }));
    const h = { time: 30 * 900, open: 1, close: 1.006, high: 1.0065, low: 0.976, volume: 180 };
    const c = [...flat, h, confirm(h)];
    expect(detectHammer(c, cfg)).toBeNull();
    expect(detectHammer(c, { ...cfg, minPriorDeclinePct: -1 })).not.toBeNull(); // control: only the trend rule blocked it
  });

  it('rejects a hammer that is not the lowest low of the lookback', () => {
    const prior = downtrend();
    // A deeper wick 18 candles earlier: inside the 20-candle low lookback, outside the 14-candle range average.
    prior[12] = { ...prior[12], low: prior[12].low * 0.7 };
    const h = hammerAfter(prior);
    const c = [...prior, h, confirm(h)];
    expect(detectHammer(c, cfg)).toBeNull();
    expect(detectHammer(c, { ...cfg, lowLookback: 10 })).not.toBeNull();
  });

  it('rejects below-average volume and undersized candles', () => {
    const prior = downtrend();
    const lowVol = hammerAfter(prior, { vol: 50 });
    expect(detectHammer([...prior, lowVol, confirm(lowVol)], cfg)).toBeNull();
    expect(detectHammer([...prior, lowVol, confirm(lowVol)], { ...cfg, minVolumeVsAvg: 0.4 })).not.toBeNull();
    const tiny = hammerAfter(prior, { body: 0.0008, wick: 4, upper: 0.0001 });
    expect(detectHammer([...prior, tiny, confirm(tiny)], cfg)).toBeNull();
    // A tiny candle can't undercut the previous candles' 1% wicks either, so its control relaxes both rules.
    expect(detectHammer([...prior, tiny, confirm(tiny)], { ...cfg, minRangeVsAvg: 0.1, lowLookback: 1 })).not.toBeNull();
  });

  it('fires on an inverted hammer at a bottom once the next candle closes above its high', () => {
    const prior = downtrend();
    const prev = prior[prior.length - 1];
    const open = prev.close * 0.985; // gaps under the previous low, so it prints the lowest low
    const close = open * 1.006;
    const h = { time: prev.time + 900, open, close, high: close + (close - open) * 4, low: open * 0.9995, volume: 180 };
    const on = { ...cfg, inverted: true };
    const r = detectHammer([...prior, h, confirm(h)], on);
    expect(r).not.toBeNull();
    expect(r!.inverted).toBe(true);
    expect(r!.wickToBody).toBeCloseTo(4, 6);
    expect(detectHammer([...prior, h, confirm(h)], cfg)).toBeNull(); // off by default (no edge in the backtest)
    expect(detectHammer([...prior, hammerAfter(prior), confirm(hammerAfter(prior))], on)!.inverted).toBe(false);
  });

  it('rejects a short lower wick', () => {
    const prior = downtrend();
    const h = hammerAfter(prior, { wick: 1.2 });
    expect(detectHammer([...prior, h, confirm(h)], cfg)).toBeNull();
  });
});

describe('hammer timeframes', () => {
  it('alerts hammers on 15m, 1h and 4h but not 5m', () => {
    const prior = downtrend();
    const h = hammerAfter(prior);
    const candles = [...prior, h, confirm(h)];
    const hammers = (tf: '5m' | '15m' | '1h' | '4h') => findSignals(candles, tf, 1, config).filter((s) => s.pattern === 'hammer');
    expect(hammers('5m')).toHaveLength(0);
    for (const tf of ['15m', '1h', '4h'] as const) expect(hammers(tf)).toHaveLength(1);
  });
});

describe('timeframe aggregation', () => {
  const base: Candle[] = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ time: 3600 * 10 + i * 900, open: 10 + i, close: 11 + i, high: 12 + i, low: 9 + i, volume: 1 + i }));
  it('rolls 15m into UTC-aligned 1h candles', () => {
    expect(aggregate(base, 3600)).toEqual([
      { time: 36000, open: 10, close: 14, high: 15, low: 9, volume: 10 },
      { time: 39600, open: 14, close: 18, high: 19, low: 13, volume: 26 },
    ]);
  });
  it('drops a partial first bucket and unfinished buckets', () => {
    const m = multiTimeframe(base.slice(1), 900, ['5m', '15m', '1h'], { '5m': 200, '15m': 200, '1h': 200, '4h': 200 }, 39600 + 3599);
    expect(m.has('5m')).toBe(false); // finer than the 15m base: not available
    expect(m.get('1h')).toEqual([]); // 10:00 bucket partial (starts mid-hour), 11:00 bucket not closed yet
    expect(m.get('15m')!.length).toBe(6);
  });
});
