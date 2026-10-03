import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { dexpaprika, scaleVolume } from '../src/sources/dexpaprika.js';
import { limiters } from '../src/sources/limiters.js';

const TOKEN = 'TokenMint1111111111111111111111111111111111';

function mockFetch(firstToken: string) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(url);
    const body = url.includes('/ohlcv')
      ? [
          { time_open: '2026-10-03T08:45:00Z', open: 2, high: 3, low: 1, close: 2.5, volume: 10 },
          { time_open: '2026-10-03T08:30:00Z', open: 1, high: 2, low: 1, close: 2, volume: 5 },
        ]
      : { tokens: [{ id: firstToken }, { id: 'Other' }] };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return urls;
}

beforeEach(() => {
  // Ignore a real key from .env, and skip the 2/min spacing so tests run instantly.
  config.dexpaprikaApiKey = '';
  Object.assign(limiters.dexpaprika, { currentIntervalMs: 0, nextSlot: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  config.dexpaprikaApiKey = '';
});

describe('dexpaprika', () => {
  it('is only used with a key and for 15m and longer candles', () => {
    expect(dexpaprika.supports(900)).toBe(false);
    config.dexpaprikaApiKey = 'k';
    expect(dexpaprika.supports(900)).toBe(true);
    expect(dexpaprika.supports(3600)).toBe(true);
    expect(dexpaprika.supports(300)).toBe(false);
  });

  it('asks for inverted prices when the token is the second in the pool, and sorts candles oldest first', async () => {
    config.dexpaprikaApiKey = 'k';
    const urls = mockFetch('Other');
    const candles = await dexpaprika.ohlcv('PoolInv', TOKEN, { intervalSec: 900 });
    expect(urls.find((u) => u.includes('/ohlcv'))).toContain('inversed=true');
    expect(candles.map((c) => c.close)).toEqual([2, 2.5]);
    expect(candles[0].time).toBe(Date.parse('2026-10-03T08:30:00Z') / 1000);
  });

  it('keeps normal prices when the token is first', async () => {
    config.dexpaprikaApiKey = 'k';
    const urls = mockFetch(TOKEN);
    await dexpaprika.ohlcv('PoolNormal', TOKEN, { intervalSec: 900 });
    expect(urls.find((u) => u.includes('/ohlcv'))).not.toContain('inversed');
  });
});

describe('scaleVolume', () => {
  const now = 1_000_000;
  const candles = [
    { time: now - 90_000, open: 1, high: 1, low: 1, close: 1, volume: 999 }, // older than 24h: not counted
    { time: now - 3_600, open: 1, high: 1, low: 1, close: 1, volume: 40 },
    { time: now - 900, open: 1, high: 1, low: 1, close: 1, volume: 60 },
  ];

  it("scales so the last 24h match DexScreener's 24h volume", () => {
    const out = scaleVolume(candles, 250, now);
    expect(out.map((c) => c.volume)).toEqual([999 * 2.5, 100, 150]);
  });

  it('leaves candles unchanged without a reference volume', () => {
    expect(scaleVolume(candles, 0, now)).toEqual(candles);
  });
});
