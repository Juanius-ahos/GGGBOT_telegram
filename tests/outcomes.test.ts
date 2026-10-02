import { describe, expect, it } from 'vitest';
import { closeAt, resolveFromCandles } from '../src/jobs/outcomes.js';
import type { Candle } from '../src/patterns/types.js';

const T0 = 1_790_000_100; // alert time (s), mid-candle
const start = Math.floor(T0 / 900) * 900;
const candle = (i: number, low: number, high: number, close = (low + high) / 2): Candle => ({
  time: start + i * 900, open: close, high, low, close, volume: 1,
});
const alert = { created_at: T0 * 1000, target: 1.2, invalidation: 0.9 };

describe('outcome resolution', () => {
  it('target first', () => {
    const c = [candle(0, 0.95, 1.05), candle(1, 1.0, 1.25), candle(2, 0.85, 1.0)];
    expect(resolveFromCandles(c, alert, 900)).toEqual({ outcome: 'target', at: (start + 900) * 1000 });
  });
  it('invalidation first', () => {
    const c = [candle(0, 0.95, 1.05), candle(1, 0.88, 1.0), candle(2, 1.0, 1.3)];
    expect(resolveFromCandles(c, alert, 900).outcome).toBe('invalidation');
  });
  it('same candle hits both -> invalidation (conservative)', () => {
    expect(resolveFromCandles([candle(0, 0.8, 1.3)], alert, 900).outcome).toBe('invalidation');
  });
  it('ignores candles before the alert and after 24h', () => {
    const c = [candle(-1, 0.5, 2), candle(0, 0.95, 1.05), candle(96, 0.5, 2)];
    expect(resolveFromCandles(c, alert, 900).outcome).toBe('none');
  });
  it('closeAt picks the candle containing the timestamp', () => {
    const c = [candle(0, 1, 1, 1.0), candle(4, 1, 1, 1.1), candle(5, 1, 1, 1.2)];
    expect(closeAt(c, (T0 + 3600) * 1000)).toBe(1.1);
  });
});
