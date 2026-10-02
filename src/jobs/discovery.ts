import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { marketRejection, snapshot } from '../filters/marketFilter.js';
import { checkRug } from '../filters/rugFilter.js';
import { errMsg } from '../lib/http.js';
import { logger } from '../logger.js';
import { bestPairByToken, dexscreener, type DexPair } from '../sources/dexscreener.js';
import { geckoterminal } from '../sources/geckoterminal.js';
import { jupiter } from '../sources/jupiter.js';

const log = logger.child({ job: 'discovery' });

const SOURCES: [string, () => Promise<string[]>][] = [
  ['ds:topBoosts', dexscreener.topBoosts],
  ['ds:latestBoosts', dexscreener.latestBoosts],
  ['ds:latestProfiles', dexscreener.latestProfiles],
  ['ds:takeovers', dexscreener.communityTakeovers],
  ['gt:trending', geckoterminal.trendingTokens],
  ['gt:topVolume', geckoterminal.topVolumeTokens],
  // Broadest free feed: top trending/traded/organic over 1h/6h/24h, ~150-200 tokens above the MC/liq floor.
  ['jup:ranked', () => jupiter.rankedTokens(config.market.minMarketCapUsd, config.market.minLiquidityUsd)],
];

export async function runDiscovery(db: Db, isStopped: () => boolean): Promise<void> {
  const started = Date.now();
  const excluded = new Set(config.market.excludedMints);

  // 1. Candidate addresses from every free feed, plus everything already on the watchlist (to refresh/expire it).
  const results = await Promise.allSettled(SOURCES.map(([, fn]) => fn()));
  const candidates = new Set<string>();
  const perSource: Record<string, number | string> = {};
  results.forEach((r, i) => {
    const name = SOURCES[i][0];
    if (r.status === 'fulfilled') {
      perSource[name] = r.value.length;
      r.value.forEach((a) => candidates.add(a));
    } else perSource[name] = `error: ${errMsg(r.reason)}`;
  });
  const fromFeeds = candidates.size;
  db.addCandidates([...candidates], 'feeds');
  // Everything surfaced in the pool window (feeds + pump.fun graduations), plus the current watchlist.
  const poolSince = Date.now() - config.jobs.candidatePoolDays * 86_400_000;
  const pruned = db.pruneCandidates(poolSince);
  db.candidateAddresses(poolSince).forEach((a) => candidates.add(a));
  db.activeAddresses().forEach((a) => candidates.add(a));
  for (const m of excluded) candidates.delete(m);

  // 2. Enrich in batches of 30. Only addresses whose batch succeeded may be expired.
  const addrs = [...candidates];
  const pairs: DexPair[] = [];
  const queried = new Set<string>();
  for (let i = 0; i < addrs.length && !isStopped(); i += 30) {
    const batch = addrs.slice(i, i + 30);
    try {
      pairs.push(...(await dexscreener.tokensPairs(batch)));
      batch.forEach((a) => queried.add(a));
    } catch (err) {
      log.warn({ err: errMsg(err), batch: batch.length }, 'enrich batch failed');
    }
  }
  const best = bestPairByToken(pairs);

  // 3. Market filter -> watchlist.
  let kept = 0;
  let dropped = 0;
  const reasons: Record<string, number> = {};
  for (const addr of queried) {
    const pair = best.get(addr);
    const reason = pair ? marketRejection(snapshot(pair), config.market) : 'no solana pair';
    if (reason || !pair) {
      if (db.getToken(addr)?.active) db.deactivate(addr);
      dropped++;
      const key = reason!.split(' ')[0];
      reasons[key] = (reasons[key] ?? 0) + 1;
      continue;
    }
    const s = snapshot(pair);
    db.upsertToken({
      address: addr,
      symbol: pair.baseToken.symbol ?? '?',
      name: pair.baseToken.name ?? '?',
      pair_address: pair.pairAddress,
      dex_id: pair.dexId,
      price_usd: s.priceUsd,
      market_cap: s.marketCap,
      liquidity_usd: s.liquidityUsd,
      volume_24h: s.volume24h,
      pair_created_at: s.pairCreatedAt,
    });
    kept++;
  }
  log.info({ sources: perSource, fromFeeds, pool: db.candidateCount(), pruned, checked: queried.size, kept, dropped, reasons }, 'watchlist refreshed');

  // 4. Rug filter, once per token per cache window.
  const now = Date.now();
  const toCheck = db.tokensNeedingRugCheck(
    now - config.rug.cacheHours * 3_600_000,
    now - config.rug.errorRetryMinutes * 60_000,
    config.jobs.maxRugChecksPerCycle,
  );
  const tally = { pass: 0, fail: 0, error: 0 };
  for (const t of toCheck) {
    if (isStopped()) break;
    try {
      const v = await checkRug(t.address, t.pair_address, config.rug);
      db.setRug(t.address, v.status, v.reason);
      tally[v.status]++;
      log.debug({ token: t.symbol, address: t.address, ...v }, 'rug check');
    } catch (err) {
      db.setRug(t.address, 'error', errMsg(err));
      tally.error++;
    }
  }
  if (toCheck.length) log.info({ checked: toCheck.length, ...tally }, 'rug checks done');

  db.setKv('job:discovery:last', String(Date.now()));
  log.info({ ms: Date.now() - started }, 'discovery done');
}
