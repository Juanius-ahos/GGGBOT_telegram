import { config } from '../config.js';
import { fetchJson, HttpError } from '../lib/http.js';
import { limiters } from './limiters.js';

interface RpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

async function call<T>(method: string, params: unknown[]): Promise<T> {
  // Public RPC sometimes answers 200 with a JSON-RPC 429 error; surface that as retryable.
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetchJson<RpcResponse<T>>(config.rpcUrl, {
      limiter: limiters.rpc,
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method, params },
    });
    if (!res.error) return res.result as T;
    if (res.error.code !== 429) throw new Error(`RPC ${method}: ${res.error.message}`);
    const backoff = 3000 * 2 ** attempt;
    limiters.rpc.cooldown(backoff);
    await new Promise((r) => setTimeout(r, backoff));
  }
  throw new HttpError(429, `RPC ${method}: rate limited`);
}

export interface MintInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: string;
  decimals: number;
  program: string;
}

export interface RawAccount {
  owner: string;
  data: Buffer;
}

export const solanaRpc = {
  /** Raw accounts (base64-decoded), up to 100 per call; null for missing accounts. */
  async multipleAccounts(keys: string[]): Promise<(RawAccount | null)[]> {
    const out: (RawAccount | null)[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      const r = await call<{ value: ({ owner: string; data: [string, string] } | null)[] }>('getMultipleAccounts', [
        keys.slice(i, i + 100),
        { encoding: 'base64', commitment: 'confirmed' },
      ]);
      for (const v of r?.value ?? []) out.push(v ? { owner: v.owner, data: Buffer.from(v.data[0], 'base64') } : null);
    }
    return out;
  },

  async mintInfo(mint: string): Promise<MintInfo | null> {
    const r = await call<{ value: { data: { parsed?: { type: string; info: MintInfo }; program?: string } } | null }>(
      'getAccountInfo',
      [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    );
    const parsed = r?.value?.data?.parsed;
    if (!parsed || parsed.type !== 'mint') return null;
    return { ...parsed.info, program: r.value!.data.program ?? '' };
  },

  /** Top 20 token accounts. Heavily throttled on the public RPC: fallback only. */
  async largestAccounts(mint: string): Promise<{ address: string; amount: string }[]> {
    const r = await call<{ value: { address: string; amount: string }[] }>('getTokenLargestAccounts', [
      mint,
      { commitment: 'confirmed' },
    ]);
    return r?.value ?? [];
  },

  /** Owners of token accounts (to spot AMM vaults in the fallback holder check). */
  async tokenAccountOwners(accounts: string[]): Promise<Map<string, string>> {
    const r = await call<{ value: ({ data: { parsed?: { info?: { owner?: string } } } } | null)[] }>(
      'getMultipleAccounts',
      [accounts, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    );
    const out = new Map<string, string>();
    r?.value?.forEach((acc, i) => {
      const owner = acc?.data?.parsed?.info?.owner;
      if (owner) out.set(accounts[i], owner);
    });
    return out;
  },
};
