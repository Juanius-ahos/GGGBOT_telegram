import { describe, expect, it, vi } from 'vitest';

// The watcher refreshes price/MC from DexScreener before alerting; keep tests offline.
vi.mock('../src/sources/dexscreener.js', () => ({ fetchBestPairs: async () => new Map() }));

import { config } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import { runSetupWatcher } from '../src/jobs/setups.js';
import { CandleSeries } from '../src/onchain/candles.js';
import { detectDoubleBottomSetup } from '../src/patterns/setups.js';
import type { Candle } from '../src/patterns/types.js';
import type { AlertPayload, Notifier } from '../src/bot/notifier.js';

interface Leg { to: number; bars: number; volume: number }
function build(start: number, legs: Leg[]): Candle[] {
  const out: Candle[] = [];
  let prev = start;
  let time = 1_700_000_000;
  for (const leg of legs) {
    const from = prev;
    for (let i = 1; i <= leg.bars; i++) {
      const close = from + ((leg.to - from) * i) / leg.bars;
      out.push({ time, open: prev, close, high: Math.max(prev, close) * 1.002, low: Math.min(prev, close) * 0.998, volume: leg.volume });
      prev = close;
      time += 900;
    }
  }
  return out;
}
const lows: Leg[] = [
  { to: 0.7, bars: 30, volume: 100 },
  { to: 0.8, bars: 10, volume: 80 },
  { to: 0.705, bars: 10, volume: 60 },
];

describe('detectDoubleBottomSetup', () => {
  it('arms once both lows are in and price is still under the neckline', () => {
    const s = detectDoubleBottomSetup(build(1, [...lows, { to: 0.75, bars: 5, volume: 70 }]), config.doubleBottom);
    expect(s).not.toBeNull();
    expect(s!.neckline).toBeCloseTo(0.8 * 1.002, 6);
    expect(s!.invalidation).toBeLessThan(s!.secondLow.price);
  });
  it('does not arm after the neckline has already been broken (that is a breakout, not a setup)', () => {
    expect(detectDoubleBottomSetup(build(1, [...lows, { to: 0.79, bars: 8, volume: 70 }, { to: 0.83, bars: 1, volume: 300 }]), config.doubleBottom)).toBeNull();
  });
  it('does not arm before the second low is confirmed by later candles', () => {
    expect(detectDoubleBottomSetup(build(1, lows), config.doubleBottom)).toBeNull();
  });
  it('does not arm when the second low was undercut', () => {
    expect(detectDoubleBottomSetup(build(1, [...lows, { to: 0.75, bars: 4, volume: 70 }, { to: 0.6, bars: 4, volume: 120 }]), config.doubleBottom)).toBeNull();
  });
});

function harness(price: number, formingVolume: number) {
  const db = openDb(':memory:');
  db.upsertToken({
    address: 'TOK', symbol: 'TOK', name: 'Token', pair_address: 'PAIR', dex_id: 'pumpswap', price_usd: price,
    market_cap: 500_000, liquidity_usd: 80_000, volume_24h: 200_000, pair_created_at: Date.now() - 5 * 86_400_000,
  });
  const sent: AlertPayload[] = [];
  const followUps: string[] = [];
  const notifier: Notifier = { alert: async (p) => (sent.push(p), 1), followUp: async (_id, html) => void followUps.push(html) };
  const nowSec = Math.floor(Date.now() / 1000);
  const series = new CandleSeries(900);
  const bucket = Math.floor(nowSec / 900) * 900;
  series.seed([{ time: bucket, open: price, high: price, low: price, close: price, volume: formingVolume }]);
  const tracker = { priceNow: () => price, seriesFor: () => series } as never;
  return { db, sent, followUps, notifier, tracker, nowSec };
}

function arm(db: Db, over: Partial<Parameters<Db['insertSetup']>[0]> = {}) {
  return db.insertSetup({
    token_address: 'TOK', pattern: 'double_bottom', timeframe: '15m', key_time: 1, trigger_level: 1.0, invalidation: 0.8,
    target: 1.3, first_low: 0.81, second_low: 0.82, neckline: 1.0, avg_volume: 100, armed_at: Date.now(), expires_at: Date.now() + 3_600_000,
    ...over,
  })!;
}

describe('setup watcher', () => {
  it('stays armed while price is under the trigger', async () => {
    const h = harness(0.95, 500);
    const id = arm(h.db);
    await runSetupWatcher(h.db, h.tracker, h.notifier, () => false);
    expect(h.sent).toHaveLength(0);
    expect(h.db.armedSetups().map((s) => s.id)).toEqual([id]);
  });

  it('fires a live breakout alert the moment price crosses the neckline with volume', async () => {
    const h = harness(1.02, 500); // well above the 1.0 neckline, strong forming-candle volume
    arm(h.db);
    await runSetupWatcher(h.db, h.tracker, h.notifier, () => false);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].signal).toMatchObject({ pattern: 'double_bottom', trigger: 'cross', timeframe: '15m' });
    expect(h.sent[0].row.price_at_alert).toBeCloseTo(1.02);
    expect(h.db.armedSetups()).toHaveLength(0);
    const alert = h.db.recentAlerts(1)[0];
    expect(alert.trigger).toBe('cross');
  });

  it('waits when the neckline is crossed on weak volume', async () => {
    const h = harness(1.02, 1); // forming candle has almost no volume
    arm(h.db);
    await runSetupWatcher(h.db, h.tracker, h.notifier, () => false);
    expect(h.sent).toHaveLength(0);
    expect(h.db.armedSetups()).toHaveLength(1);
  });

  it('drops setups that hit the stop first, and expired ones', async () => {
    const h = harness(0.79, 500);
    arm(h.db, { key_time: 1 });
    arm(h.db, { key_time: 2, expires_at: Date.now() - 1 });
    await runSetupWatcher(h.db, h.tracker, h.notifier, () => false);
    expect(h.sent).toHaveLength(0);
    expect(h.db.armedSetups()).toHaveLength(0);
    const statuses = (h.db.raw.prepare('select key_time, status from setups order by key_time').all() as { status: string }[]).map((r) => r.status);
    expect(statuses).toEqual(['invalidated', 'expired']);
  });

  it('replies under the early "forming" alert when its breakout fires', async () => {
    const h = harness(1.02, 500);
    const id = arm(h.db);
    const earlyId = h.db.insertAlert({
      token_address: 'TOK', symbol: 'TOK', name: 'Token', pair_address: 'PAIR', created_at: Date.now() - 3_600_000, price_at_alert: 0.9,
      market_cap: 450_000, liquidity_usd: 80_000, first_low: 0.81, second_low: 0.82, neckline: 1.0, breakout_price: 0.9,
      breakout_time: 1, invalidation: 0.8, target: 1.3, pattern: 'db_forming', timeframe: '15m', trigger: 'forming',
    });
    h.db.setSetupEarlyAlert(id, earlyId);
    await runSetupWatcher(h.db, h.tracker, h.notifier, () => false);
    expect(h.followUps.join()).toContain('Neckline broken');
    expect(h.followUps.join()).toContain('+13.3%');
  });

  it('arming the same setup twice is a no-op', () => {
    const db = openDb(':memory:');
    expect(arm(db)).toBeTypeOf('number');
    expect(db.insertSetup({
      token_address: 'TOK', pattern: 'double_bottom', timeframe: '15m', key_time: 1, trigger_level: 1, invalidation: 0.8, target: 1.3,
      first_low: 0.81, second_low: 0.82, neckline: 1, avg_volume: 100, armed_at: Date.now(), expires_at: Date.now() + 1000,
    })).toBeNull();
  });
});
