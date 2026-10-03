import { config } from '../config.js';
import { fetchJson, type Priority } from '../lib/http.js';
import type { Candle } from '../patterns/types.js';
import { limiters } from './limiters.js';

const BASE = 'https://api.dexpaprika.com';
const NETWORK = 'solana';
/** Free key: pool candles reach back 7 days; stay just inside it. */
const MAX_HISTORY_SEC = 6.9 * 86_400;
const INTERVAL: Record<number, string> = { 900: '15m', 3600: '1h', 14_400: '4h' };

interface PoolResponse {
  tokens?: { id?: string }[];
}

interface OhlcvRow {
  time_open: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Whether the pool lists `token` second, in which case prices must be requested inverted. Never changes per pool. */
const inverted = new Map<string, boolean>();

function headers(): Record<string, string> {
  return { authorization: `Bearer ${config.dexpaprikaApiKey}` };
}

async function isInverted(pool: string, token: string, priority: Priority): Promise<boolean> {
  const known = inverted.get(pool);
  if (known !== undefined) return known;
  const res = await fetchJson<PoolResponse>(`${BASE}/networks/${NETWORK}/pools/${pool}`, { limiter: limiters.dexpaprika, headers: headers(), priority });
  const first = res.tokens?.[0]?.id;
  if (!first) throw new Error('dexpaprika: pool has no token list');
  const inv = first !== token;
  inverted.set(pool, inv);
  return inv;
}

export const dexpaprika = {
  /** True when a key is set and DexPaprika serves this candle size (free key: 10m and up). */
  supports(intervalSec: number): boolean {
    return !!config.dexpaprikaApiKey && intervalSec in INTERVAL;
  },

  /** Oldest start time the free key accepts, unix seconds. */
  earliest(nowSec = Date.now() / 1000): number {
    return Math.ceil(nowSec - MAX_HISTORY_SEC);
  },

  /**
   * Candles for `token` in `pool`, oldest first, USD-priced, starting at `startSec` (clamped to the 7-day window).
   * Volume is DexPaprika's own measure and runs lower than GeckoTerminal's; see `scaleVolume`.
   */
  async ohlcv(pool: string, token: string, opts: { intervalSec: number; startSec?: number; limit?: number; priority?: Priority }): Promise<Candle[]> {
    const interval = INTERVAL[opts.intervalSec];
    if (!interval) throw new Error(`dexpaprika: unsupported interval ${opts.intervalSec}s`);
    const priority = opts.priority ?? 'high';
    const inv = await isInverted(pool, token, priority);
    const start = Math.max(opts.startSec ?? 0, this.earliest());
    const qs = new URLSearchParams({ start: new Date(start * 1000).toISOString().slice(0, 19) + 'Z', interval, limit: String(opts.limit ?? 1000) });
    if (inv) qs.set('inversed', 'true');
    const rows = await fetchJson<OhlcvRow[]>(`${BASE}/networks/${NETWORK}/pools/${pool}/ohlcv?${qs}`, {
      limiter: limiters.dexpaprika,
      headers: headers(),
      priority,
      cacheTtlMs: 60_000,
    });
    return (Array.isArray(rows) ? rows : [])
      .map((r) => ({ time: Math.floor(Date.parse(r.time_open) / 1000), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }))
      .filter((c) => Number.isFinite(c.time) && [c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite))
      .sort((a, b) => a.time - b.time);
  },
};

/**
 * Rescales candle volume so its last 24h add up to DexScreener's 24h volume. DexPaprika measured 2-70% of
 * GeckoTerminal's volume on PumpSwap pools (Oct 2026), while volume-pace checks compare candles against
 * DexScreener and on-chain volume, so all three must be on one scale. Unchanged if either side is missing.
 */
export function scaleVolume(candles: Candle[], dexVolume24h: number, nowSec = Date.now() / 1000): Candle[] {
  const sum = candles.filter((c) => c.time >= nowSec - 86_400).reduce((s, c) => s + c.volume, 0);
  if (!(sum > 0) || !(dexVolume24h > 0)) return candles;
  const f = Math.min(100, Math.max(0.01, dexVolume24h / sum));
  return candles.map((c) => ({ ...c, volume: c.volume * f }));
}

interface PoolSearchResponse {
  results?: { volume_usd_24h?: number; liquidity_usd?: number; tokens?: { id?: string }[] }[];
  has_next_page?: boolean;
  next_cursor?: string;
}

/**
 * Every Solana coin trading at least `minVolume24h` with at least `minLiquidity`: walks the whole market's pool list
 * sorted by 24h volume and stops where volume falls below the floor (~28 calls for $50K, Oct 2026). Returns the
 * non-quote token of each qualifying pool.
 */
export async function sweepMarket(minVolume24h: number, minLiquidity: number, quoteMints: Set<string>, maxPages = 60): Promise<{ mints: string[]; calls: number }> {
  const mints = new Set<string>();
  let cursor: string | undefined;
  let calls = 0;
  while (calls < maxPages) {
    const qs = new URLSearchParams({ order_by: 'volume_usd_24h', sort: 'desc', limit: '100' });
    if (cursor) qs.set('cursor', cursor);
    calls++;
    const res = await fetchJson<PoolSearchResponse>(`${BASE}/networks/${NETWORK}/pools/search?${qs}`, { limiter: limiters.dexpaprika, headers: headers() });
    let lowest = Infinity;
    for (const p of res.results ?? []) {
      const vol = p.volume_usd_24h ?? 0;
      lowest = Math.min(lowest, vol);
      if (vol < minVolume24h || (p.liquidity_usd ?? 0) < minLiquidity) continue;
      const token = p.tokens?.map((t) => t.id).find((id): id is string => !!id && !quoteMints.has(id));
      if (token) mints.add(token);
    }
    if (!res.has_next_page || !res.next_cursor || lowest < minVolume24h) break;
    cursor = res.next_cursor;
  }
  return { mints: [...mints], calls };
}
