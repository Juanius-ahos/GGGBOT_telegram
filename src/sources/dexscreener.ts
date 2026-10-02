import { fetchJson } from '../lib/http.js';
import { limiters } from './limiters.js';

const BASE = 'https://api.dexscreener.com';
const CHAIN = 'solana';

export interface DexPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

interface TokenRef {
  chainId: string;
  tokenAddress: string;
}

const MIN = 60_000;

async function tokenRefs(path: string): Promise<string[]> {
  const rows = await fetchJson<TokenRef[]>(`${BASE}${path}`, { limiter: limiters.dexSlow, cacheTtlMs: 5 * MIN });
  return Array.isArray(rows) ? rows.filter((r) => r.chainId === CHAIN).map((r) => r.tokenAddress) : [];
}

export const dexscreener = {
  topBoosts: () => tokenRefs('/token-boosts/top/v1'),
  latestBoosts: () => tokenRefs('/token-boosts/latest/v1'),
  latestProfiles: () => tokenRefs('/token-profiles/latest/v1'),
  communityTakeovers: () => tokenRefs('/community-takeovers/latest/v1'),

  /** Pairs for up to 30 token addresses in one call. */
  async tokensPairs(addresses: string[], cacheTtlMs = 0): Promise<DexPair[]> {
    if (addresses.length === 0) return [];
    if (addresses.length > 30) throw new Error('dexscreener tokens/v1 accepts at most 30 addresses');
    const rows = await fetchJson<DexPair[]>(`${BASE}/tokens/v1/${CHAIN}/${addresses.join(',')}`, {
      limiter: limiters.dexFast,
      cacheTtlMs,
    });
    return Array.isArray(rows) ? rows : [];
  },
};

/** For each token, the deepest-liquidity pair where it is the base token. */
export function bestPairByToken(pairs: DexPair[]): Map<string, DexPair> {
  const best = new Map<string, DexPair>();
  for (const p of pairs) {
    if (p.chainId !== CHAIN) continue;
    const addr = p.baseToken?.address;
    if (!addr) continue;
    const cur = best.get(addr);
    if (!cur || (p.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) best.set(addr, p);
  }
  return best;
}

export async function fetchBestPairs(addresses: string[], cacheTtlMs = 0): Promise<Map<string, DexPair>> {
  const all: DexPair[] = [];
  for (let i = 0; i < addresses.length; i += 30) {
    all.push(...(await dexscreener.tokensPairs(addresses.slice(i, i + 30), cacheTtlMs)));
  }
  return bestPairByToken(all);
}
