import { config } from '../config.js';
import { fetchJson } from '../lib/http.js';
import { limiters } from './limiters.js';

/**
 * Jupiter Tokens API v2 ranked lists (up to 100 tokens each). The keyless lite-api host is
 * slated for deprecation (no date set as of Oct 2026); set JUPITER_API_KEY (free at portal.jup.ag)
 * to use api.jup.ag instead. Paths are identical on both hosts.
 */
const CATEGORIES = ['toptrending', 'toptraded', 'toporganicscore'] as const;
const WINDOWS = ['1h', '6h', '24h'] as const;

interface JupToken {
  id: string;
  mcap?: number;
  liquidity?: number;
}

function base(): { url: string; headers: Record<string, string> } {
  const key = config.jupiterApiKey;
  return key
    ? { url: 'https://api.jup.ag/tokens/v2', headers: { 'x-api-key': key } }
    : { url: 'https://lite-api.jup.ag/tokens/v2', headers: {} };
}

export const jupiter = {
  /** Union of all ranked lists, pre-filtered on Jupiter's own MC/liquidity to save enrichment calls. */
  async rankedTokens(minMcap: number, minLiquidity: number): Promise<string[]> {
    const { url, headers } = base();
    const out = new Set<string>();
    let failures = 0;
    for (const cat of CATEGORIES) {
      for (const w of WINDOWS) {
        try {
          const rows = await fetchJson<JupToken[]>(`${url}/${cat}/${w}?limit=100`, {
            limiter: limiters.jupiter,
            headers,
            cacheTtlMs: 5 * 60_000,
            retries: 2,
          });
          for (const t of Array.isArray(rows) ? rows : []) {
            if ((t.mcap ?? 0) >= minMcap && (t.liquidity ?? 0) >= minLiquidity) out.add(t.id);
          }
        } catch {
          failures++;
        }
      }
    }
    if (failures === CATEGORIES.length * WINDOWS.length) throw new Error('all Jupiter lists failed');
    return [...out];
  },
};
