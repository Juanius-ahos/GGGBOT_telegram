import { fetchJson } from '../lib/http.js';
import type { Candle } from '../patterns/types.js';
import { limiters } from './limiters.js';

const BASE = 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'solana';

interface PoolsResponse {
  data?: { relationships?: { base_token?: { data?: { id?: string } } } }[];
}

interface OhlcvResponse {
  data?: { attributes?: { ohlcv_list?: [number, number, number, number, number, number][] } };
}

function baseTokenAddresses(res: PoolsResponse): string[] {
  const prefix = `${NETWORK}_`;
  return (res.data ?? [])
    .map((p) => p.relationships?.base_token?.data?.id ?? '')
    .filter((id) => id.startsWith(prefix))
    .map((id) => id.slice(prefix.length));
}

export const geckoterminal = {
  async trendingTokens(): Promise<string[]> {
    const res = await fetchJson<PoolsResponse>(`${BASE}/networks/${NETWORK}/trending_pools?page=1`, {
      limiter: limiters.gecko,
      cacheTtlMs: 5 * 60_000,
    });
    return baseTokenAddresses(res);
  },

  async topVolumeTokens(): Promise<string[]> {
    const res = await fetchJson<PoolsResponse>(`${BASE}/networks/${NETWORK}/pools?page=1&sort=h24_volume_usd_desc`, {
      limiter: limiters.gecko,
      cacheTtlMs: 5 * 60_000,
    });
    return baseTokenAddresses(res);
  },

  /**
   * Candles for `tokenAddress` in `pool`, oldest first, USD-priced.
   * Pass `before` (unix seconds) to page backwards.
   */
  async ohlcv(
    pool: string,
    tokenAddress: string,
    opts: { timeframe: 'minute' | 'hour' | 'day'; aggregate: number; limit: number; before?: number },
  ): Promise<Candle[]> {
    const qs = new URLSearchParams({
      aggregate: String(opts.aggregate),
      limit: String(opts.limit),
      currency: 'usd',
      token: tokenAddress,
    });
    if (opts.before) qs.set('before_timestamp', String(opts.before));
    const res = await fetchJson<OhlcvResponse>(`${BASE}/networks/${NETWORK}/pools/${pool}/ohlcv/${opts.timeframe}?${qs}`, {
      limiter: limiters.gecko,
      cacheTtlMs: 60_000, // upstream itself refreshes about once a minute
    });
    const list = res.data?.attributes?.ohlcv_list ?? [];
    return list
      .map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))
      .filter((c) => [c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite))
      .sort((a, b) => a.time - b.time);
  },
};

/** Drops the still-forming candle so detection only sees closed candles. */
export function closedCandles(candles: Candle[], candleSeconds: number, nowSec = Date.now() / 1000): Candle[] {
  return candles.filter((c) => c.time + candleSeconds <= nowSec);
}
