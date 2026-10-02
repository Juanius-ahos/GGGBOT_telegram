import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { marketRejection } from '../src/filters/marketFilter.js';
import { excludedHolderAddresses, judgeRug, top10HolderPct } from '../src/filters/rugFilter.js';
import type { RugcheckReport } from '../src/sources/rugcheck.js';

const NOW = Date.UTC(2026, 9, 1);
const ok = { marketCap: 250_000, liquidityUsd: 60_000, volume24h: 150_000, pairCreatedAt: NOW - 48 * 3_600_000, priceUsd: 1 };

describe('market filter', () => {
  it('passes a token meeting every threshold', () => {
    expect(marketRejection(ok, config.market, NOW)).toBeNull();
  });
  it.each([
    ['mc', { marketCap: 199_999 }],
    ['liq', { liquidityUsd: 49_000 }],
    ['vol24h', { volume24h: 99_000 }],
    ['pair', { pairCreatedAt: NOW - 23 * 3_600_000 }],
    ['unknown', { pairCreatedAt: 0 }],
  ])('rejects on %s', (prefix, patch) => {
    expect(marketRejection({ ...ok, ...patch }, config.market, NOW)).toMatch(new RegExp(`^${prefix}`));
  });
});

const report = (patch: Partial<RugcheckReport> = {}): RugcheckReport => ({
  mint: 'MINT',
  mintAuthority: null,
  freezeAuthority: null,
  score_normalised: 5,
  rugged: false,
  risks: [],
  topHolders: [],
  knownAccounts: { POOL_AUTH: { name: 'Raydium', type: 'AMM' }, DEV: { name: 'Creator', type: 'CREATOR' } },
  markets: [{ pubkey: 'POOL', liquidityAAccount: { owner: 'POOL_OWNER' } }],
  lockers: { LOCK: { tokenAccount: 'LOCK_TA', owner: 'LOCK_OWNER' } },
  ...patch,
});

describe('top10 holder concentration', () => {
  const holders = [
    { address: 'VAULT', owner: 'POOL_AUTH', pct: 40 }, // AMM vault
    { address: 'LOCK_TA', owner: 'LOCK_OWNER', pct: 20 }, // locker
    { address: 'BURN', owner: '1nc1nerator11111111111111111111111111111111', pct: 15 },
    { address: 'DEV_TA', owner: 'DEV', pct: 6 }, // creator still counts
    ...Array.from({ length: 12 }, (_, i) => ({ address: `H${i}`, owner: `W${i}`, pct: 2 })),
  ];

  it('excludes LP, lockers and burns but counts the creator', () => {
    const ex = excludedHolderAddresses(report(), config.rug.burnAddresses, 'PAIR');
    expect(top10HolderPct(holders, ex)).toBeCloseTo(6 + 9 * 2);
  });

  it('counts everything when nothing is excluded', () => {
    expect(top10HolderPct(holders, new Set())).toBeCloseTo(40 + 20 + 15 + 6 + 6 * 2);
  });
});

describe('rug verdict', () => {
  const mint = { mintAuthority: null, freezeAuthority: null, supply: '1', decimals: 6, program: 'spl-token' };

  it('passes a clean token', () => {
    expect(judgeRug({ report: report(), mint, top10Pct: 20 }, config.rug).status).toBe('pass');
  });
  it('fails on live mint authority (RPC is authoritative over RugCheck)', () => {
    const v = judgeRug({ report: report(), mint: { ...mint, mintAuthority: 'X' }, top10Pct: 1 }, config.rug);
    expect(v).toMatchObject({ status: 'fail', reason: 'mint authority not revoked' });
  });
  it('falls back to RugCheck authorities when RPC is down', () => {
    const v = judgeRug({ report: report({ freezeAuthority: 'F' }), mint: null, top10Pct: 1 }, config.rug);
    expect(v.reason).toBe('freeze authority not revoked');
  });
  it('fails on concentrated holders, danger risks, high score and rugged flag', () => {
    expect(judgeRug({ report: report(), mint, top10Pct: 30 }, config.rug).status).toBe('fail');
    expect(judgeRug({ report: report({ risks: [{ name: 'Copycat', level: 'danger' }] }), mint, top10Pct: 1 }, config.rug).status).toBe('fail');
    expect(judgeRug({ report: report({ risks: [{ name: 'Mutable metadata', level: 'warn' }] }), mint, top10Pct: 1 }, config.rug).status).toBe('pass');
    expect(judgeRug({ report: report({ score_normalised: 80 }), mint, top10Pct: 1 }, config.rug).status).toBe('fail');
    expect(judgeRug({ report: report({ rugged: true }), mint, top10Pct: 1 }, config.rug).status).toBe('fail');
  });
  it('returns error (never pass) when data is missing', () => {
    expect(judgeRug({ report: null, mint: null, top10Pct: 1 }, config.rug).status).toBe('error');
    expect(judgeRug({ report: null, mint, top10Pct: 1 }, config.rug).status).toBe('error');
    expect(judgeRug({ report: report(), mint, top10Pct: null }, config.rug).status).toBe('error');
  });
});
