import type { Notifier } from '../bot/notifier.js';
import { price as fmtPrice, pct } from '../bot/format.js';
import { config } from '../config.js';
import type { Db, SetupRow, WatchToken } from '../db/index.js';
import { errMsg } from '../lib/http.js';
import { logger } from '../logger.js';
import type { LiveTracker } from '../onchain/tracker.js';
import type { HammerResult } from '../patterns/hammer.js';
import { detectDoubleBottomSetup, detectHammerSetup, type DoubleBottomSetup } from '../patterns/setups.js';
import type { Signal } from '../patterns/signals.js';
import { aggregate, closedOnly, TIMEFRAME_SECONDS, type Timeframe } from '../patterns/timeframes.js';
import type { Candle } from '../patterns/types.js';
import { fetchBestPairs, type DexPair } from '../sources/dexscreener.js';
import { maybeAlert } from './patternScan.js';

const log = logger.child({ job: 'setups' });

/** Candles + structure captured when a setup was armed, so the trigger alert can draw its chart. */
const armedCharts = new Map<number, { candles: Candle[]; db?: DoubleBottomSetup; hammer?: HammerResult }>();

export function dbSignal(s: DoubleBottomSetup, candles: Candle[], tf: Timeframe, pattern: 'double_bottom' | 'db_forming', trigger: 'cross' | 'forming', entry: number, volumeRatio: number): Signal {
  const last = candles.length - 1;
  return {
    pattern,
    timeframe: tf,
    trigger,
    triggerIndex: last,
    triggerTime: candles[last].time,
    entry,
    volumeRatio,
    target: s.target,
    invalidation: s.invalidation,
    firstLow: s.firstLow.price,
    secondLow: s.secondLow.price,
    neckline: s.neckline,
    doubleBottom: {
      firstLow: s.firstLow,
      secondLow: s.secondLow,
      neckline: s.neckline,
      necklineIndex: s.necklineIndex,
      breakout: { index: last, time: candles[last].time, price: entry, volume: candles[last].volume, avgVolume: s.avgVolume },
      firstLowSellVolume: s.firstLowSellVolume,
      secondLowSellVolume: s.secondLowSellVolume,
      patternHeight: s.target - s.neckline,
      target: s.target,
      invalidation: s.invalidation,
    },
  };
}

/**
 * Arms real-time triggers from candles a scan already has (no extra API calls):
 *  - double bottom with both lows in place and neckline not broken -> watch for a neckline cross
 *    (+ an early "forming" alert while the second low is fresh)
 *  - hammer on the last closed candle -> watch for a break of its high during the next candle
 */
export async function armFromCandles(db: Db, token: WatchToken, tf: Timeframe, candles: Candle[], notifier: Notifier): Promise<void> {
  if (candles.length < 30) return;
  const now = Date.now();
  const tfSec = TIMEFRAME_SECONDS[tf];
  const last = candles[candles.length - 1];

  const s = detectDoubleBottomSetup(candles, config.doubleBottom);
  if (s) {
    const id = db.insertSetup({
      token_address: token.address,
      pattern: 'double_bottom',
      timeframe: tf,
      key_time: s.secondLow.time,
      trigger_level: s.neckline,
      invalidation: s.invalidation,
      target: s.target,
      first_low: s.firstLow.price,
      second_low: s.secondLow.price,
      neckline: s.neckline,
      avg_volume: s.avgVolume,
      armed_at: now,
      expires_at: (s.secondLow.time + (config.doubleBottom.maxCandlesAfterSecondLow + 1) * tfSec) * 1000,
    });
    if (id === null) {
      // Already armed: refresh its chart candles so a later trigger alert shows the latest price action.
      const existing = db.armedSetups().find((x) => x.token_address === token.address && x.pattern === 'double_bottom' && x.timeframe === tf && x.key_time === s.secondLow.time);
      if (existing) armedCharts.set(existing.id, { candles, db: s });
    } else {
      armedCharts.set(id, { candles, db: s });
      log.info({ token: token.symbol, tf, neckline: s.neckline, l2: s.secondLow.price }, 'double-bottom setup armed');
      // Early heads-up only while the second low is fresh (not for old setups found after a restart).
      const sinceL2 = candles.length - 1 - s.secondLow.index;
      if (sinceL2 <= config.doubleBottom.swingLookback + config.setups.earlyMaxCandlesAfterConfirm) {
        const sig = dbSignal(s, candles, tf, 'db_forming', 'forming', last.close, s.avgVolume > 0 ? last.volume / s.avgVolume : 0);
        const alertId = await maybeAlert(db, token, sig, candles, notifier, 'forming');
        if (alertId) db.setSetupEarlyAlert(id, alertId);
      }
    }
  }

  const h = config.hammer.timeframes.includes(tf) ? detectHammerSetup(candles, config.hammer) : null;
  if (h) {
    const id = db.insertSetup({
      token_address: token.address,
      pattern: 'hammer',
      timeframe: tf,
      key_time: h.hammer.time,
      trigger_level: h.hammer.high,
      invalidation: h.invalidation,
      target: h.target,
      first_low: h.hammer.low,
      second_low: h.hammer.low,
      neckline: h.hammer.high,
      avg_volume: h.avgVolume,
      armed_at: now,
      // Valid during the candle after the hammer only.
      expires_at: (h.hammer.time + 2 * tfSec) * 1000,
    });
    if (id !== null) {
      armedCharts.set(id, { candles, hammer: h });
      log.info({ token: token.symbol, tf, high: h.hammer.high }, 'hammer setup armed');
    }
  }
}

/** Forming-candle volume pace vs the setup's average volume, plus the threshold that applies. */
function volumePace(s: SetupRow, tracker: LiveTracker | null, pair: DexPair | undefined, nowSec: number): { pace: number; need: number } | null {
  const tfSec = TIMEFRAME_SECONDS[s.timeframe];
  if (!(s.avg_volume > 0)) return null;
  const series = tracker?.seriesFor(s.token_address);
  if (series) {
    const base = series.all();
    if (tfSec < series.intervalSec) return null;
    const tfCandles = tfSec === series.intervalSec ? base : aggregate(base, tfSec);
    const forming = tfCandles[tfCandles.length - 1];
    if (forming && forming.time + tfSec > nowSec) {
      const elapsed = Math.max(0.25, (nowSec - forming.time) / tfSec);
      return { pace: forming.volume / elapsed / s.avg_volume, need: config.setups.minVolumePace * config.setups.onchainPaceFactor };
    }
  }
  const v = pair?.volume;
  if (!v) return null;
  // DexScreener rolling windows scaled to one candle of this timeframe.
  const perCandle =
    s.timeframe === '5m' ? v.m5 ?? 0 : s.timeframe === '15m' ? (v.m5 ?? 0) * 3 : s.timeframe === '1h' ? v.h1 ?? 0 : ((v.h6 ?? 0) * 4) / 6;
  return { pace: perCandle / s.avg_volume, need: config.setups.minVolumePace };
}

/** Candles for the trigger alert's chart: what was captured at arming, else the live series. */
function chartData(s: SetupRow, tracker: LiveTracker | null, nowSec: number): { candles: Candle[]; db?: DoubleBottomSetup; hammer?: HammerResult } {
  const cached = armedCharts.get(s.id);
  if (cached) return cached;
  const series = tracker?.seriesFor(s.token_address);
  if (!series) return { candles: [] };
  const tfSec = TIMEFRAME_SECONDS[s.timeframe];
  const base = series.all();
  if (tfSec < series.intervalSec) return { candles: [] };
  const candles = closedOnly(tfSec === series.intervalSec ? base : aggregate(base, tfSec), tfSec, nowSec).slice(-config.detectCandles[s.timeframe]);
  const dbs = s.pattern === 'double_bottom' ? detectDoubleBottomSetup(candles, config.doubleBottom) : null;
  return { candles, db: dbs && dbs.secondLow.time === s.key_time ? dbs : undefined };
}

/**
 * Every few seconds: check armed setups against the live price (on-chain for live pools, DexScreener otherwise).
 * Fires the breakout alert the moment price clears the neckline / hammer high.
 */
/** Setups being acted on right now (the websocket path and the poll can see the same cross). */
const inFlight = new Set<number>();
/** Setups whose early "forming" alert was already tried once. */
const formingTried = new Set<number>();

/**
 * Checks one armed setup against a price: invalidation, early-zone heads-up, and the trigger cross.
 * `pair` (DexScreener) supplies volume pace; when absent (websocket path) it's fetched only if the level is crossed.
 */
async function evaluateSetup(db: Db, s: SetupRow, price: number, pair: DexPair | undefined, tracker: LiveTracker | null, notifier: Notifier, nowSec: number): Promise<void> {
  if (inFlight.has(s.id)) return;
  const token = db.getToken(s.token_address);
  if (!token || !token.active) {
    db.setSetupStatus(s.id, 'expired');
    return;
  }
  if (price <= s.invalidation) {
    db.setSetupStatus(s.id, 'invalidated');
    armedCharts.delete(s.id);
    log.info({ token: token.symbol, pattern: s.pattern, tf: s.timeframe }, 'setup invalidated before trigger');
    return;
  }

  inFlight.add(s.id);
  try {
    // Early heads-up once price is in the zone just under the neckline (one attempt per setup).
    if (s.pattern === 'double_bottom' && s.early_alert_id == null && !formingTried.has(s.id)) {
      const below = ((s.trigger_level - price) / s.trigger_level) * 100;
      const z = config.setups.formingZone;
      if (below >= z.minBelowPct && below <= z.maxBelowPct) {
        formingTried.add(s.id);
        const data = chartData(s, tracker, nowSec);
        if (data.db && data.candles.length) {
          const sig = dbSignal(data.db, data.candles, s.timeframe, 'db_forming', 'forming', price, 0);
          const alertId = await maybeAlert(db, token, sig, data.candles, notifier, 'forming-zone');
          if (alertId) db.setSetupEarlyAlert(s.id, alertId);
        }
      }
    }

    if (price < s.trigger_level * (1 + config.setups.crossBufferPct)) return;

    let volumeRatio = 0;
    if (s.pattern === 'double_bottom') {
      if (!pair) pair = (await fetchBestPairs([s.token_address], 5_000).catch(() => new Map<string, DexPair>())).get(s.token_address);
      const v = volumePace(s, tracker, pair, nowSec);
      if (v) {
        volumeRatio = v.pace;
        if (v.pace < v.need) {
          log.debug({ token: token.symbol, tf: s.timeframe, pace: v.pace }, 'neckline crossed but volume pace too low; still armed');
          return;
        }
      }
    }

    const data = chartData(s, tracker, nowSec);
    let signal: Signal;
    if (s.pattern === 'double_bottom' && data.db && data.candles.length) {
      signal = dbSignal(data.db, data.candles, s.timeframe, 'double_bottom', 'cross', price, volumeRatio);
    } else if (s.pattern === 'hammer' && data.hammer && data.candles.length) {
      const h = data.hammer;
      signal = {
        pattern: 'hammer', timeframe: s.timeframe, trigger: 'cross', triggerIndex: h.hammerIndex, triggerTime: h.hammer.time,
        entry: price, volumeRatio: h.avgVolume > 0 ? h.volume / h.avgVolume : 0,
        target: price + config.hammer.rewardToRisk * (price - h.invalidation), invalidation: h.invalidation,
        firstLow: h.hammer.low, secondLow: h.hammer.low, neckline: h.hammer.high, hammer: h,
      };
    } else {
      // No candles to draw (e.g. restarted since arming): text-only alert.
      signal = {
        pattern: s.pattern, timeframe: s.timeframe, trigger: 'cross', triggerIndex: 0, triggerTime: Math.floor(nowSec),
        entry: price, volumeRatio,
        target: s.pattern === 'hammer' ? price + config.hammer.rewardToRisk * (price - s.invalidation) : s.target,
        invalidation: s.invalidation, firstLow: s.first_low, secondLow: s.second_low, neckline: s.neckline,
      };
    }

    db.setSetupStatus(s.id, 'fired');
    armedCharts.delete(s.id);
    try {
      const alertId = await maybeAlert(db, token, signal, data.candles, notifier, 'cross');
      log.info({ token: token.symbol, pattern: s.pattern, tf: s.timeframe, price, level: s.trigger_level, alertId }, 'setup triggered');
      if (alertId && s.early_alert_id) {
        const early = db.getAlert(s.early_alert_id);
        const since = early ? ` (${pct(((price - early.price_at_alert) / early.price_at_alert) * 100)} since this alert)` : '';
        await notifier.followUp(s.early_alert_id, `⚡ <b>Neckline broken</b> at ${fmtPrice(price)}${since}. Breakout alert sent.`);
      }
    } catch (err) {
      log.error({ token: token.symbol, err: errMsg(err) }, 'trigger alert failed');
    }
  } finally {
    inFlight.delete(s.id);
  }
}

/** Websocket path: a fresh on-chain price for `token` -> check its armed setups immediately. */
export async function onLivePrice(db: Db, tracker: LiveTracker | null, notifier: Notifier, token: string, price: number): Promise<void> {
  const nowMs = Date.now();
  for (const s of db.armedSetups()) {
    if (s.token_address !== token || s.expires_at < nowMs) continue;
    await evaluateSetup(db, s, price, undefined, tracker, notifier, nowMs / 1000);
  }
}

/** token -> pair address for every armed setup (what the real-time price feed should cover). */
export function armedPairs(db: Db): Map<string, string> {
  const out = new Map<string, string>();
  const now = Date.now();
  for (const s of db.armedSetups()) {
    if (s.expires_at < now) continue;
    const t = db.getToken(s.token_address);
    if (t?.active) out.set(t.address, t.pair_address);
  }
  return out;
}

/**
 * Every few seconds: check armed setups against the price (on-chain for live pools, DexScreener otherwise).
 * Coins with a real-time feed are also checked on every on-chain update via onLivePrice.
 */
export async function runSetupWatcher(db: Db, tracker: LiveTracker | null, notifier: Notifier, isStopped: () => boolean): Promise<void> {
  const now = Date.now();
  const nowSec = now / 1000;
  const armed = db.armedSetups();
  if (armed.length === 0) return;

  const active: SetupRow[] = [];
  for (const s of armed) {
    if (s.expires_at < now) {
      db.setSetupStatus(s.id, 'expired');
      armedCharts.delete(s.id);
      formingTried.delete(s.id);
    } else active.push(s);
  }
  if (!active.length) return;

  const needDs = [...new Set(active.map((s) => s.token_address))].filter((a) => tracker?.priceNow(a) == null);
  let ds = new Map<string, DexPair>();
  if (needDs.length) {
    try {
      ds = await fetchBestPairs(needDs, 10_000);
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'price check failed');
    }
  }

  for (const s of active) {
    if (isStopped()) break;
    const pair = ds.get(s.token_address);
    const price = tracker?.priceNow(s.token_address) ?? (pair ? Number(pair.priceUsd) || null : null);
    if (!price) continue;
    await evaluateSetup(db, s, price, pair, tracker, notifier, nowSec);
  }
}
