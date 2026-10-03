import { followUpRecap, followUpStop, followUpTarget } from '../bot/format.js';
import type { Notifier } from '../bot/notifier.js';
import { config } from '../config.js';
import type { AlertRow, Db, Outcome } from '../db/index.js';
import { errMsg } from '../lib/http.js';
import { logger } from '../logger.js';
import type { Candle } from '../patterns/types.js';
import { fetchBestPairs } from '../sources/dexscreener.js';
import { geckoterminal } from '../sources/geckoterminal.js';

const log = logger.child({ job: 'outcomes' });
const HOUR = 3_600_000;
const CHECKPOINTS = config.tracking.checkpointsHours;
type Checkpoint = (typeof CHECKPOINTS)[number];

/** Win/loss window for an alert: longer for higher timeframes (15m 24h, 1h 3d, 4h 7d by default). */
export function windowHours(a: Pick<AlertRow, 'timeframe'>): number {
  return config.resolutionHours[a.timeframe] ?? 24;
}

/** A live sample only counts for a checkpoint if taken shortly after it; later gaps are filled from candles. */
const graceMs = (h: number) => Math.max(30 * 60_000, h * HOUR * 0.1);

const pctChange = (from: number, to: number) => ((to - from) / from) * 100;

/**
 * Walks candles from the alert onward. A candle touching both levels counts as invalidation
 * (intra-candle order is unknown, so assume the worse case).
 */
export function resolveFromCandles(
  candles: Candle[],
  alert: Pick<AlertRow, 'created_at' | 'target' | 'invalidation'>,
  candleSec: number,
  windowH = 24,
): { outcome: Outcome; at: number | null } {
  const startSec = Math.floor(alert.created_at / 1000 / candleSec) * candleSec;
  const endSec = startSec + windowH * 3600;
  for (const c of candles) {
    if (c.time < startSec || c.time >= endSec) continue;
    const hitInval = c.low <= alert.invalidation;
    const hitTarget = c.high >= alert.target;
    if (hitInval) return { outcome: 'invalidation', at: c.time * 1000 };
    if (hitTarget) return { outcome: 'target', at: c.time * 1000 };
  }
  return { outcome: 'none', at: null };
}

/** Close of the candle containing `tsMs`, or the last candle before it. */
export function closeAt(candles: Candle[], tsMs: number): number | null {
  const ts = tsMs / 1000;
  let best: Candle | null = null;
  for (const c of candles) if (c.time <= ts && (!best || c.time > best.time)) best = c;
  return best?.close ?? null;
}

async function finalize(db: Db, a: AlertRow, livePrice: number | null, notifier: Notifier): Promise<void> {
  const windowH = windowHours(a);
  // Up to 24h: 15m candles. Longer windows: 1h candles (one call covers up to 1000h).
  const useHourly = windowH > 24;
  const candleSec = useHourly ? 3600 : config.scan.candleSeconds;
  const fields: Partial<AlertRow> = {};
  let candles: Candle[] | null = null;
  try {
    // Candles ending just after the window closes (works even if the bot was offline meanwhile).
    const before = Math.floor(a.created_at / 1000) + windowH * 3600 + candleSec;
    candles = await geckoterminal.ohlcv(a.pair_address, a.token_address, {
      timeframe: useHourly ? 'hour' : config.scan.timeframe,
      aggregate: useHourly ? 1 : config.scan.aggregate,
      limit: Math.min(1000, Math.ceil((windowH * 3600) / candleSec) + 4),
      before,
      priority: 'low',
    });
  } catch (err) {
    log.warn({ id: a.id, err: errMsg(err) }, 'candles for resolution unavailable; using sampled prices');
  }

  if (candles?.length) {
    const r = resolveFromCandles(candles, a, candleSec, windowH);
    fields.outcome = r.outcome;
    fields.outcome_at = r.at;
    for (const h of CHECKPOINTS) {
      if (a[`price_${h}h` as const] !== null) continue;
      const p = closeAt(candles, a.created_at + h * HOUR);
      if (p) Object.assign(fields, { [`price_${h}h`]: p, [`pct_${h}h`]: pctChange(a.price_at_alert, p) });
    }
  } else {
    fields.outcome = a.sampled_outcome === 'pending' ? 'none' : a.sampled_outcome;
    if (a.price_24h === null && livePrice) Object.assign(fields, { price_24h: livePrice, pct_24h: pctChange(a.price_at_alert, livePrice) });
  }
  db.updateAlert(a.id, fields);
  log.info({ id: a.id, token: a.symbol, pattern: a.pattern, tf: a.timeframe, outcome: fields.outcome }, 'alert resolved');
  const done = db.getAlert(a.id);
  if (done) await notifier.followUp(a.id, followUpRecap(done, windowH)).catch((err) => log.warn({ err: errMsg(err) }, 'recap send failed'));
}

export async function runOutcomeTracker(db: Db, notifier: Notifier, isStopped: () => boolean): Promise<void> {
  const pending = db.pendingAlerts();
  db.setKv('job:outcomes:last', String(Date.now()));
  if (pending.length === 0) return;

  let prices = new Map<string, number>();
  try {
    const best = await fetchBestPairs([...new Set(pending.map((a) => a.token_address))]);
    prices = new Map([...best].map(([k, p]) => [k, Number(p.priceUsd)]).filter(([, v]) => Number.isFinite(v) && (v as number) > 0) as [string, number][]);
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'price fetch failed; checkpoints may be filled from candles later');
  }

  const now = Date.now();
  for (const a of pending) {
    if (isStopped()) break;
    const p = prices.get(a.token_address) ?? null;
    const elapsed = now - a.created_at;
    const fields: Partial<AlertRow> = {};

    if (p !== null) {
      fields.sample_high = Math.max(a.sample_high ?? p, p);
      fields.sample_low = Math.min(a.sample_low ?? p, p);
      if (a.sampled_outcome === 'pending') {
        if (p <= a.invalidation) fields.sampled_outcome = 'invalidation';
        else if (p >= a.target) fields.sampled_outcome = 'target';
        // Tell subscribers right away, as a reply under the original alert.
        if (fields.sampled_outcome) {
          const html = fields.sampled_outcome === 'target' ? followUpTarget(a, p) : followUpStop(a, p);
          await notifier.followUp(a.id, html).catch((err) => log.warn({ err: errMsg(err) }, 'follow-up send failed'));
        }
      }
      for (const h of CHECKPOINTS as readonly Checkpoint[]) {
        const due = h * HOUR;
        if (a[`price_${h}h`] === null && elapsed >= due && elapsed <= due + graceMs(h)) {
          Object.assign(fields, { [`price_${h}h`]: p, [`pct_${h}h`]: pctChange(a.price_at_alert, p) });
        }
      }
    }
    db.updateAlert(a.id, fields);

    if (elapsed >= windowHours(a) * HOUR) {
      try {
        await finalize(db, db.getAlert(a.id)!, p, notifier);
      } catch (err) {
        log.error({ id: a.id, err: errMsg(err) }, 'finalize failed');
      }
    }
  }
}
