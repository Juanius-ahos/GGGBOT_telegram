/**
 * Replays both detectors over REAL GeckoTerminal history (~10 days of 15m candles, rolled up to 1h/4h)
 * and scores each signal by what price actually did afterwards.
 *   npx tsx scripts/backtest.ts                 # rug-passed tokens from the watchlist DB (max BACKTEST_TOKENS, default 12)
 *   npx tsx scripts/backtest.ts <pool> <mint>   # one specific pool
 * Note: tokens currently on the watchlist are, by definition, ones that survived; treat results as a sanity check, not an edge.
 */
import { config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { findSignals, type Signal } from '../src/patterns/signals.js';
import { multiTimeframe, TIMEFRAME_SECONDS, type Timeframe } from '../src/patterns/timeframes.js';
import type { Candle } from '../src/patterns/types.js';
import { geckoterminal } from '../src/sources/geckoterminal.js';

type Outcome = 'target' | 'stop' | 'open';
const tally = new Map<string, Record<Outcome, number>>();

function score(s: Signal, candles: Candle[]): Outcome {
  const horizon = (config.resolutionHours[s.timeframe] * 3600) / TIMEFRAME_SECONDS[s.timeframe];
  for (const c of candles.slice(s.triggerIndex + 1, s.triggerIndex + 1 + horizon)) {
    if (c.low <= s.invalidation) return 'stop'; // same-candle hits count as a loss
    if (c.high >= s.target) return 'target';
  }
  return 'open';
}

async function run(pool: string, mint: string, label: string): Promise<void> {
  const base = await geckoterminal.ohlcv(pool, mint, { timeframe: 'minute', aggregate: 15, limit: 1000 });
  const byTf = multiTimeframe(base, config.timeframes, { '15m': 1000, '1h': 1000, '4h': 1000 });
  const lines: string[] = [];
  for (const tf of config.timeframes) {
    const all = byTf.get(tf)!;
    const seen = new Set<string>();
    for (let end = 30; end <= all.length; end++) {
      const window = all.slice(Math.max(0, end - config.detectCandles[tf]), end);
      const offset = Math.max(0, end - config.detectCandles[tf]);
      for (const s of findSignals(window, tf, 1, config)) {
        const key = `${s.pattern}:${s.triggerTime}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const out = score({ ...s, triggerIndex: s.triggerIndex + offset }, all);
        const k = `${s.pattern} ${tf}`;
        const t = tally.get(k) ?? { target: 0, stop: 0, open: 0 };
        t[out]++;
        tally.set(k, t);
        const when = new Date(s.triggerTime * 1000).toISOString().slice(5, 16).replace('T', ' ');
        const extra = s.hammerAtSecondLow ? ' [L2 is a hammer]' : '';
        lines.push(`  ${tf.padEnd(3)} ${s.pattern.padEnd(13)} ${when}  entry ${s.entry.toPrecision(4)}  stop ${s.invalidation.toPrecision(4)}  target ${s.target.toPrecision(4)}  -> ${out}${extra}`);
      }
    }
  }
  const days = base.length ? ((base[base.length - 1].time - base[0].time) / 86400).toFixed(1) : '0';
  console.log(`${label}: ${base.length} x 15m candles (${days}d), ${lines.length} signals`);
  lines.forEach((l) => console.log(l));
}

const [pool, mint] = process.argv.slice(2);
if (pool && mint) {
  await run(pool, mint, pool);
} else {
  const db = openDb(process.env.DB_PATH ?? config.dbPath);
  const max = Number(process.env.BACKTEST_TOKENS ?? 12);
  const tokens = db.raw
    .prepare(`SELECT * FROM watchlist WHERE active = 1 AND rug_status = 'pass' ORDER BY volume_24h DESC LIMIT ?`)
    .all(max) as { pair_address: string; address: string; symbol: string }[];
  db.close();
  if (!tokens.length) console.log('No rug-passed tokens in DB yet; run the bot first or pass <pool> <mint>.');
  for (const t of tokens) {
    try {
      await run(t.pair_address, t.address, t.symbol);
    } catch (err) {
      console.log(`${t.symbol}: ${(err as Error).message}`);
    }
  }
}

console.log('\nSummary (target/stop = which level price hit first within the timeframe\'s window; open = neither yet):');
for (const [k, t] of [...tally].sort()) {
  const decided = t.target + t.stop;
  console.log(`  ${k.padEnd(18)} signals ${t.target + t.stop + t.open}  target ${t.target}  stop ${t.stop}  open ${t.open}  ${decided ? `hit-target rate ${((t.target / decided) * 100).toFixed(0)}% of decided` : ''}`);
}
