import { fetchJson } from '../lib/http.js';
import { limiters } from './limiters.js';

export interface RugcheckHolder {
  address: string;
  owner: string;
  pct: number;
}

export interface RugcheckReport {
  mint: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  score?: number;
  score_normalised?: number;
  rugged?: boolean;
  risks?: { name: string; description?: string; level?: string; score?: number }[];
  topHolders?: RugcheckHolder[] | null;
  knownAccounts?: Record<string, { name: string; type: string }> | null;
  lockers?: Record<string, { tokenAccount?: string; owner?: string }> | null;
  markets?: {
    pubkey: string;
    liquidityAAccount?: { owner?: string };
    liquidityBAccount?: { owner?: string };
    liquidityA?: string;
    liquidityB?: string;
  }[] | null;
}

export const rugcheck = {
  report(mint: string): Promise<RugcheckReport> {
    return fetchJson<RugcheckReport>(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {
      limiter: limiters.rugcheck,
      timeoutMs: 30_000,
      retries: 3,
    });
  },
};
