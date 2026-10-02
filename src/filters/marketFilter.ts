import type { AppConfig } from '../config.js';
import type { DexPair } from '../sources/dexscreener.js';

export interface MarketSnapshot {
  marketCap: number;
  liquidityUsd: number;
  volume24h: number;
  pairCreatedAt: number;
  priceUsd: number;
}

export function snapshot(pair: DexPair): MarketSnapshot {
  return {
    // DexScreener omits marketCap for some tokens; FDV is the closest free proxy.
    marketCap: pair.marketCap ?? pair.fdv ?? 0,
    liquidityUsd: pair.liquidity?.usd ?? 0,
    volume24h: pair.volume?.h24 ?? 0,
    pairCreatedAt: pair.pairCreatedAt ?? 0,
    priceUsd: Number(pair.priceUsd ?? 0) || 0,
  };
}

/** Returns null when the pair passes, otherwise the first failing reason. */
export function marketRejection(s: MarketSnapshot, m: AppConfig['market'], now = Date.now()): string | null {
  if (s.marketCap < m.minMarketCapUsd) return `mc ${Math.round(s.marketCap)} < ${m.minMarketCapUsd}`;
  if (m.maxMarketCapUsd && s.marketCap > m.maxMarketCapUsd) return `mcmax ${Math.round(s.marketCap)} > ${m.maxMarketCapUsd}`;
  if (s.liquidityUsd < m.minLiquidityUsd) return `liq ${Math.round(s.liquidityUsd)} < ${m.minLiquidityUsd}`;
  if (s.volume24h < m.minVolume24hUsd) return `vol24h ${Math.round(s.volume24h)} < ${m.minVolume24hUsd}`;
  if (m.minPairAgeHours > 0) {
    if (!s.pairCreatedAt) return 'unknown pair age';
    const ageH = (now - s.pairCreatedAt) / 3_600_000;
    if (ageH < m.minPairAgeHours) return `pair age ${ageH.toFixed(1)}h < ${m.minPairAgeHours}h`;
  }
  return null;
}
