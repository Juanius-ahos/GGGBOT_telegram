import { describe, expect, it } from 'vitest';
import { SampledCandles } from '../src/jobs/prescreen.js';
import type { Candle } from '../src/patterns/types.js';

/** Real-looking 15m W: decline to L1, bounce to the neckline, back down to L2 (seeded "real" history). */
function seedW(): Candle[] {
  const out: Candle[] = [];
  let p = 1;
  let t = 1_790_000_100 - (1_790_000_100 % 900) - 60 * 900;
  const legs: [number, number][] = [[0.7, 30], [0.8, 10], [0.705, 10]];
  for (const [to, bars] of legs) {
    const from = p;
    for (let i = 1; i <= bars; i++) {
      const close = from + ((to - from) * i) / bars;
      out.push({ time: t, open: p, close, high: Math.max(p, close) * 1.002, low: Math.min(p, close) * 0.998, volume: 100 });
      p = close;
      t += 900;
    }
  }
  return out;
}

describe('SampledCandles pre-screen', () => {
  it('flags a double bottom once the second low is confirmed by live minute samples, exactly once', () => {
    const s = new SampledCandles();
    const seed = seedW();
    s.seed('TOK', seed, 900);
    const last = seed[seed.length - 1];
    // Live minute prices rising off the second low: needs 3 more 15m candles to confirm it as a swing low.
    let price = last.close;
    let hits = 0;
    for (let m = 1; m <= 75; m++) {
      price *= 1.001;
      const now = last.time + 900 + m * 60;
      s.observe('TOK', now, price);
      hits += s.scan(now).filter((h) => h.kind === 'double_bottom' && h.timeframe === '15m').length;
    }
    expect(hits).toBe(1);
  });

  it('starts watching a coin from minute samples before its first real chart', () => {
    const s = new SampledCandles();
    s.observe('NEW', 1_790_000_000, 1);
    expect(s.size).toBe(1);
    expect(s.isSeeded('NEW')).toBe(false); // still needs a real chart for older history
    s.seed('NEW', seedW(), 900);
    expect(s.isSeeded('NEW')).toBe(true);
  });

  it('survives a restart: dump at shutdown, load at start', () => {
    const a = new SampledCandles();
    a.seed('TOK', seedW(), 900);
    a.observe('NEW', 1_790_000_000, 1);
    const saved = JSON.parse(JSON.stringify(a.dump())); // through JSON, like the database
    const b = new SampledCandles();
    expect(b.load(saved)).toBe(2);
    expect(b.isSeeded('TOK')).toBe(true);
    expect(b.isSeeded('NEW')).toBe(false);
    expect(b.dump().find((r) => r.token === 'TOK')!.candles.length).toBe(seedW().length);
  });

  it('drops coins that left the watchlist', () => {
    const s = new SampledCandles();
    s.seed('A', seedW(), 900);
    s.seed('B', seedW(), 900);
    s.retain(new Set(['B']));
    expect(s.size).toBe(1);
  });
});
