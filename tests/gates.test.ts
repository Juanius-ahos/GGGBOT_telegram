import { describe, expect, it, vi } from 'vitest';

// Offline: no fresh DexScreener price, so the alert uses the signal's own entry price.
vi.mock('../src/sources/dexscreener.js', () => ({ fetchBestPairs: async () => new Map() }));

import type { AlertPayload, Notifier } from '../src/bot/notifier.js';
import { openDb } from '../src/db/index.js';
import { maybeAlert } from '../src/jobs/patternScan.js';
import type { Signal } from '../src/patterns/signals.js';

function setup() {
  const db = openDb(':memory:');
  db.upsertToken({
    address: 'TOK', symbol: 'TOK', name: 'Token', pair_address: 'PAIR', dex_id: 'pumpswap', price_usd: 1,
    market_cap: 500_000, liquidity_usd: 80_000, volume_24h: 200_000, pair_created_at: Date.now() - 5 * 86_400_000,
  });
  const sent: AlertPayload[] = [];
  const notifier = { alert: async (p: AlertPayload) => (sent.push(p), 1), followUp: async () => undefined, dump: async () => 0 } as unknown as Notifier;
  return { db, sent, notifier, token: db.getToken('TOK')! };
}

// Neckline 1.00, stop 0.85, target 1.30.
const sig = (pattern: Signal['pattern'], trigger: Signal['trigger'], entry: number, timeframe: Signal['timeframe'] = '15m'): Signal => ({
  pattern, timeframe, trigger, triggerIndex: 0, triggerTime: 1, entry, volumeRatio: 2,
  target: 1.3, invalidation: 0.85, firstLow: 0.86, secondLow: 0.87, neckline: 1.0,
});

describe('speed gates (from live results)', () => {
  it('sends a breakout caught close to the neckline', async () => {
    const { db, sent, notifier, token } = setup();
    expect(await maybeAlert(db, token, sig('double_bottom', 'cross', 1.03), [], notifier, 'test')).not.toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('skips a breakout once price is more than 5% past the neckline (too late)', async () => {
    const { db, sent, notifier, token } = setup();
    expect(await maybeAlert(db, token, sig('double_bottom', 'cross', 1.06), [], notifier, 'test')).toBeNull();
    expect(await maybeAlert(db, token, sig('double_bottom', 'close', 1.08, '1h'), [], notifier, 'test')).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('sends an early entry only with at least 25% room to the neckline (its take-profit)', async () => {
    const { db, sent, notifier, token } = setup();
    // Early entries sit right above the second low, so their stop is lower than the breakout fixture's.
    const early = (entry: number) => ({ ...sig('db_forming', 'forming', entry), invalidation: 0.7, firstLow: 0.72, secondLow: 0.71, target: 1.0 });
    expect(await maybeAlert(db, token, early(0.9), [], notifier, 'test')).toBeNull(); // 11% room: not worth it
    expect(await maybeAlert(db, token, early(0.75), [], notifier, 'test')).not.toBeNull(); // 33% room
    expect(sent).toHaveLength(1);
  });
});
