import { describe, expect, it } from 'vitest';
import { activityScore, ChartQueue } from '../src/jobs/watch.js';

// 6h volume 72,000 -> average pace 1,000 per 5 minutes.
const quiet = { volume: { m5: 900, h6: 72_000 }, priceChange: { m5: 1, h1: 2 } };

describe('activity score', () => {
  it('is 0 for a coin trading at its normal pace without big moves', () => {
    expect(activityScore(quiet)).toBe(0);
  });

  it('flags a 5-minute volume spike (breakouts and hammers need above-average volume)', () => {
    expect(activityScore({ ...quiet, volume: { m5: 2_500, h6: 72_000 } })).toBeGreaterThan(0);
  });

  it('flags a sharp move either way', () => {
    expect(activityScore({ ...quiet, priceChange: { m5: -6, h1: 0 } })).toBeGreaterThan(0);
    expect(activityScore({ ...quiet, priceChange: { m5: 0, h1: 12 } })).toBeGreaterThan(0);
  });

  it('handles missing numbers', () => {
    expect(activityScore({})).toBe(0);
  });
});

describe('chart queue', () => {
  it('hands out the most active coin first, each once, keeping its highest score', () => {
    const q = new ChartQueue();
    q.add('A', 1);
    q.add('B', 3);
    q.add('A', 5);
    expect([q.take(), q.take(), q.take()]).toEqual(['A', 'B', undefined]);
  });
});
