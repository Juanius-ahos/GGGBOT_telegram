import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { DumpDetector } from '../src/jobs/dumps.js';

const M5 = 300_000;
const T0 = 3_000 * M5; // a 5m and 15m candle boundary

/** Feeds prices every 30s starting at `from`; returns all dumps seen. */
function feed(d: DumpDetector, prices: number[], from = T0 - 60_000) {
  return prices.flatMap((p, i) => d.observe('TOKEN', from + i * 30_000, p));
}

describe('sudden drop detector', () => {
  it('alerts once when a 5m candle falls 30-50% from its open', () => {
    const d = new DumpDetector(config.dumps);
    // open = 1.0 (last price before the candle), then a fall to 0.65 inside the candle
    const out = feed(d, [1, 1, 0.95, 0.8, 0.65, 0.64, 0.66]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ timeframe: '5m', open: 1, price: 0.65 });
    expect(out[0].dropPct).toBeCloseTo(35);
  });

  it('ignores falls under 30% and labels falls over 50% as a possible rug', () => {
    expect(feed(new DumpDetector(config.dumps), [1, 1, 0.8, 0.75])).toHaveLength(0);
    const deep = feed(new DumpDetector(config.dumps), [1, 1, 0.4]);
    expect(deep).toHaveLength(1);
    expect(deep[0]).toMatchObject({ timeframe: '5m', possibleRug: true });
    expect(feed(new DumpDetector(config.dumps), [1, 1, 0.65])[0].possibleRug).toBe(false);
  });

  it('does not repeat the same fall as a 15m alert', () => {
    const d = new DumpDetector(config.dumps);
    expect(feed(d, [1, 1, 0.6]).map((x) => x.timeframe)).toEqual(['5m']);
    // Later in the same 15m candle: still down 40% from the 15m open, but already reported.
    expect(d.observe('TOKEN', T0 + 2 * M5 + 30_000, 0.6)).toHaveLength(0);
  });

  it('catches a slower 15m fall that no single 5m candle shows', () => {
    const d = new DumpDetector(config.dumps);
    const prices: number[] = [1, 1];
    for (let i = 1; i <= 28; i++) prices.push(1 - (0.35 * i) / 28); // -35% spread evenly over 14 minutes
    const out = feed(d, prices);
    expect(out.map((x) => x.timeframe)).toEqual(['15m']);
  });
});
