import type { AppConfig } from '../config.js';
import { errMsg } from '../lib/http.js';
import { logger } from '../logger.js';
import { rugcheck, type RugcheckHolder, type RugcheckReport } from '../sources/rugcheck.js';
import { solanaRpc, type MintInfo } from '../sources/solanaRpc.js';

export interface RugVerdict {
  status: 'pass' | 'fail' | 'error';
  reason: string;
  top10Pct?: number;
}

/** RugCheck knownAccounts types that hold liquidity or locked/burned supply, not tradable float. */
const NON_HOLDER_TYPES = new Set(['AMM', 'LOCKER', 'BURN']);

/** Addresses (token accounts or owners) that must not count as holders: LP vaults, pools, lockers, burns. */
export function excludedHolderAddresses(report: RugcheckReport | null, burnAddresses: string[], pairAddress?: string): Set<string> {
  const out = new Set<string>(burnAddresses);
  if (pairAddress) out.add(pairAddress);
  if (!report) return out;
  for (const [addr, info] of Object.entries(report.knownAccounts ?? {})) {
    if (NON_HOLDER_TYPES.has(info.type?.toUpperCase())) out.add(addr);
  }
  for (const m of report.markets ?? []) {
    out.add(m.pubkey);
    if (m.liquidityA) out.add(m.liquidityA);
    if (m.liquidityB) out.add(m.liquidityB);
    if (m.liquidityAAccount?.owner) out.add(m.liquidityAAccount.owner);
    if (m.liquidityBAccount?.owner) out.add(m.liquidityBAccount.owner);
  }
  for (const [addr, l] of Object.entries(report.lockers ?? {})) {
    out.add(addr);
    if (l.tokenAccount) out.add(l.tokenAccount);
    if (l.owner) out.add(l.owner);
  }
  return out;
}

/** Sum of the 10 largest holder percentages after removing excluded accounts. */
export function top10HolderPct(holders: RugcheckHolder[], excluded: Set<string>): number {
  return holders
    .filter((h) => !excluded.has(h.address) && !excluded.has(h.owner))
    .map((h) => h.pct)
    .sort((a, b) => b - a)
    .slice(0, 10)
    .reduce((s, p) => s + p, 0);
}

/** Pure decision given whatever data could be fetched. */
export function judgeRug(
  input: { report: RugcheckReport | null; mint: MintInfo | null; top10Pct: number | null },
  cfg: AppConfig['rug'],
): RugVerdict {
  const { report, mint, top10Pct } = input;
  const mintAuth = mint ? mint.mintAuthority : report?.mintAuthority;
  const freezeAuth = mint ? mint.freezeAuthority : report?.freezeAuthority;
  if (mintAuth === undefined || freezeAuth === undefined) return { status: 'error', reason: 'authorities unavailable' };
  if (mintAuth) return { status: 'fail', reason: 'mint authority not revoked' };
  if (freezeAuth) return { status: 'fail', reason: 'freeze authority not revoked' };

  if (!report) return { status: 'error', reason: 'RugCheck unavailable' };
  if (report.rugged) return { status: 'fail', reason: 'RugCheck: rugged' };
  const danger = (report.risks ?? []).filter((r) => r.level && cfg.rejectRiskLevels.includes(r.level));
  if (danger.length) return { status: 'fail', reason: `RugCheck risk: ${danger.map((r) => r.name).join(', ')}` };
  const score = report.score_normalised;
  if (typeof score === 'number' && score > cfg.maxRugcheckScore) {
    return { status: 'fail', reason: `RugCheck score ${score} > ${cfg.maxRugcheckScore}` };
  }

  if (top10Pct === null) return { status: 'error', reason: 'holder data unavailable' };
  if (top10Pct >= cfg.maxTop10HolderPct) {
    return { status: 'fail', reason: `top10 holders ${top10Pct.toFixed(1)}% >= ${cfg.maxTop10HolderPct}%`, top10Pct };
  }
  return { status: 'pass', reason: `top10 ${top10Pct.toFixed(1)}%, score ${score ?? '?'}`, top10Pct };
}

/** Fallback when RugCheck has no holder list: public RPC largest accounts. */
async function top10FromRpc(mintAddr: string, mint: MintInfo, excluded: Set<string>): Promise<number> {
  const accounts = await solanaRpc.largestAccounts(mintAddr);
  const owners = await solanaRpc.tokenAccountOwners(accounts.map((a) => a.address));
  const supply = Number(mint.supply);
  if (!supply) throw new Error('zero supply');
  const holders: RugcheckHolder[] = accounts.map((a) => ({
    address: a.address,
    owner: owners.get(a.address) ?? '',
    pct: (Number(a.amount) / supply) * 100,
  }));
  return top10HolderPct(holders, excluded);
}

export async function checkRug(mintAddr: string, pairAddress: string, cfg: AppConfig['rug']): Promise<RugVerdict> {
  const [reportRes, mintRes] = await Promise.allSettled([rugcheck.report(mintAddr), solanaRpc.mintInfo(mintAddr)]);
  const report = reportRes.status === 'fulfilled' ? reportRes.value : null;
  const mint = mintRes.status === 'fulfilled' ? mintRes.value : null;
  if (reportRes.status === 'rejected') logger.debug({ mint: mintAddr, err: errMsg(reportRes.reason) }, 'rugcheck failed');
  if (mintRes.status === 'rejected') logger.debug({ mint: mintAddr, err: errMsg(mintRes.reason) }, 'rpc mint info failed');

  // Decide on cheap data first so we don't spend scarce RPC calls on tokens that already fail.
  const prelim = judgeRug({ report, mint, top10Pct: 0 }, cfg);
  if (prelim.status !== 'pass') return prelim;

  const excluded = excludedHolderAddresses(report, cfg.burnAddresses, pairAddress);
  let top10: number | null = null;
  if (report?.topHolders?.length) {
    top10 = top10HolderPct(report.topHolders, excluded);
  } else if (mint) {
    try {
      top10 = await top10FromRpc(mintAddr, mint, excluded);
    } catch (err) {
      logger.debug({ mint: mintAddr, err: errMsg(err) }, 'rpc holder fallback failed');
    }
  }
  return judgeRug({ report, mint, top10Pct: top10 }, cfg);
}
