import { describe, expect, it } from 'vitest';
import { CandleSeries, classifySlot } from '../src/onchain/candles.js';
import { hasUiScaling } from '../src/onchain/tracker.js';

const T = 1_790_000_100; // inside bucket 1789999200 + ...

describe('CandleSeries', () => {
  it('builds OHLCV within one bucket and opens a new candle at the boundary', () => {
    const s = new CandleSeries(900);
    const b = Math.floor(T / 900) * 900;
    s.tick(b + 1, 1.0, 10);
    s.tick(b + 100, 1.3, 5);
    s.tick(b + 200, 0.9, 0);
    s.tick(b + 899, 1.1, 2);
    s.tick(b + 900, 1.2, 7);
    const [c0, c1] = s.closed(b + 1800);
    expect(c0).toEqual({ time: b, open: 1.0, high: 1.3, low: 0.9, close: 1.1, volume: 17 });
    expect(c1).toEqual({ time: b + 900, open: 1.2, high: 1.2, low: 1.2, close: 1.2, volume: 7 });
  });

  it('continues the forming seeded candle instead of duplicating it', () => {
    const s = new CandleSeries(900);
    const b = Math.floor(T / 900) * 900;
    s.seed([
      { time: b - 900, open: 1, high: 1, low: 1, close: 1, volume: 100 },
      { time: b, open: 1, high: 1.05, low: 0.98, close: 1.02, volume: 40 },
    ]);
    s.tick(b + 500, 1.2, 15);
    expect(s.length).toBe(2);
    expect(s.last).toMatchObject({ high: 1.2, low: 0.98, close: 1.2, volume: 55 });
  });

  it('only returns fully elapsed candles and drops stale ticks', () => {
    const s = new CandleSeries(900);
    const b = Math.floor(T / 900) * 900;
    s.tick(b + 10, 1, 1);
    s.tick(b + 910, 2, 1);
    s.tick(b + 5, 50, 999); // late frame for an older bucket
    expect(s.closed(b + 1000)).toHaveLength(1);
    expect(s.closed(b + 1000)[0].high).toBe(1);
  });

  it('ignores invalid prices', () => {
    const s = new CandleSeries(900);
    s.tick(T, 0, 5);
    s.tick(T, NaN, 5);
    expect(s.length).toBe(0);
  });
});

describe('classifySlot', () => {
  it('opposite vault moves are swaps', () => {
    expect(classifySlot(100n, -50n)).toBe('swap');
    expect(classifySlot(-100n, 50n)).toBe('swap');
  });
  it('same-direction moves are liquidity events, not volume', () => {
    expect(classifySlot(100n, 50n)).toBe('liquidity');
    expect(classifySlot(-100n, -50n)).toBe('liquidity');
    expect(classifySlot(0n, -5n)).toBe('liquidity');
  });
  it('no change is none', () => {
    expect(classifySlot(0n, 0n)).toBe('none');
  });
});

describe('hasUiScaling (Token-2022 extension scan)', () => {
  const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  const mint = (exts: [number, number][]) => {
    const tlv = Buffer.concat(exts.map(([type, len]) => {
      const b = Buffer.alloc(4 + len);
      b.writeUInt16LE(type, 0);
      b.writeUInt16LE(len, 2);
      return b;
    }));
    return Buffer.concat([Buffer.alloc(166), tlv]);
  };
  it('flags ScaledUiAmount and InterestBearing', () => {
    expect(hasUiScaling(T22, mint([[18, 64], [25, 56]]))).toBe(true);
    expect(hasUiScaling(T22, mint([[10, 52]]))).toBe(true);
  });
  it('passes metadata-only Token-2022 mints and classic SPL mints', () => {
    expect(hasUiScaling(T22, mint([[18, 64], [19, 120]]))).toBe(false);
    expect(hasUiScaling('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', Buffer.alloc(82))).toBe(false);
  });
});
