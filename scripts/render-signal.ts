/**
 * Renders the chart + caption the bot would send for a REAL historical signal, for visual QA.
 *   npx tsx scripts/render-signal.ts <SYMBOL> <pattern: double_bottom|hammer> <tf: 15m|1h|4h> [outDir]
 * The token must be in the watchlist DB. Uses one GeckoTerminal call; nothing is sent or stored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { renderChartPng } from '../src/bot/chart.js';
import { alertCaption } from '../src/bot/format.js';
import { config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { fetchAllTimeframesFull } from './lib.js';
import { findSignals, type PatternKind, type Signal } from '../src/patterns/signals.js';
import type { Timeframe } from '../src/patterns/timeframes.js';

const [symbol, pattern, tf, outDir = './data/previews'] = process.argv.slice(2) as [string, PatternKind, Timeframe, string?];
const db = openDb(config.dbPath);
const t = db.raw.prepare(`SELECT * FROM watchlist WHERE symbol = ? ORDER BY volume_24h DESC LIMIT 1`).get(symbol) as
  | { address: string; pair_address: string; symbol: string; name: string; market_cap: number; liquidity_usd: number }
  | undefined;
db.close();
if (!t) throw new Error(`${symbol} not in watchlist`);

const all = (await fetchAllTimeframesFull(t)).get(tf)!;
let hit: { s: Signal; candles: typeof all } | null = null;
for (let end = all.length; end > 30 && !hit; end--) {
  const window = all.slice(Math.max(0, end - config.detectCandles[tf]), end);
  const s = findSignals(window, tf, 1, config).find((x) => x.pattern === pattern);
  if (s) hit = { s, candles: window };
}
if (!hit) {
  console.log(`no ${pattern} ${tf} signal in ${symbol}'s last ~10 days`);
  process.exit(0);
}
const { s, candles } = hit;
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `real-${t.symbol}-${pattern}-${tf}.png`);
fs.writeFileSync(file, renderChartPng(candles, s, { symbol: t.symbol, name: t.name, priceNow: s.entry }));
const row = {
  token_address: t.address, symbol: t.symbol, name: t.name, pair_address: t.pair_address, price_at_alert: s.entry,
  market_cap: t.market_cap, liquidity_usd: t.liquidity_usd, first_low: s.firstLow, second_low: s.secondLow,
  neckline: s.neckline, breakout_price: s.entry, invalidation: s.invalidation, target: s.target,
};
console.log(`signal candle ${new Date(s.triggerTime * 1000).toISOString()} -> ${file}\n\n${alertCaption(row, s)}`);
