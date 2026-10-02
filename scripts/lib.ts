import { config } from '../src/config.js';
import { multiTimeframe, type Timeframe } from '../src/patterns/timeframes.js';
import type { Candle } from '../src/patterns/types.js';
import { geckoterminal } from '../src/sources/geckoterminal.js';

/** Like the bot's fetchAllTimeframes, but keeps the full ~10 days per timeframe (for replays). */
export async function fetchAllTimeframesFull(t: { pair_address: string; address: string }): Promise<Map<Timeframe, Candle[]>> {
  const base = await geckoterminal.ohlcv(t.pair_address, t.address, { timeframe: 'minute', aggregate: 15, limit: 1000 });
  return multiTimeframe(base, config.timeframes, { '15m': 1000, '1h': 1000, '4h': 1000 });
}
