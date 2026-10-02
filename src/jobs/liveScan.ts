import type { Notifier } from '../bot/notifier.js';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { errMsg } from '../lib/http.js';
import { logger } from '../logger.js';
import type { LiveTracker } from '../onchain/tracker.js';
import { findSignals } from '../patterns/signals.js';
import { multiTimeframe, TIMEFRAME_SECONDS } from '../patterns/timeframes.js';
import { fetchAllTimeframes, maybeAlert } from './patternScan.js';

const log = logger.child({ job: 'live-scan' });

/** Signal candle already handled, per token+pattern+timeframe (prevents repeat confirmations). */
const handled = new Map<string, number>();
/** Confirmation attempts per signal, so a lagging GeckoTerminal gets a few retries. */
const attempts = new Map<string, number>();

/** Pre-screen thresholds: volume rules relaxed because same-slot swaps that net out are invisible on-chain. */
function preScreenConfig() {
  const f = config.live.preScreenVolumeFactor;
  return {
    doubleBottom: { ...config.doubleBottom, breakoutVolumeMultiplier: config.doubleBottom.breakoutVolumeMultiplier * f },
    hammer: { ...config.hammer, minVolumeVsAvg: config.hammer.minVolumeVsAvg * f },
  };
}

/**
 * Every minute: run both detectors on every timeframe of each live pool's on-chain candles (cheap, local).
 * A hit is only a pre-screen; it is confirmed on GeckoTerminal candles with the exact rules before alerting.
 */
export async function runLiveScan(db: Db, tracker: LiveTracker, notifier: Notifier, isStopped: () => boolean): Promise<void> {
  const now = Date.now() / 1000;
  const preCfg = preScreenConfig();
  const pools = tracker.livePools();
  let preHits = 0;
  let confirmed = 0;

  for (const { token, series } of pools) {
    if (isStopped()) break;
    const byTf = multiTimeframe(series.all(), config.timeframes, config.detectCandles, now);
    for (const tf of config.timeframes) {
      for (const pre of findSignals(byTf.get(tf)!, tf, config.scan.breakoutLookbackCandles, preCfg)) {
        const key = `${token.address}:${pre.pattern}:${tf}`;
        if (handled.get(key) === pre.triggerTime) continue;
        // Give GeckoTerminal time to close the same candle on its side.
        if (now < pre.triggerTime + TIMEFRAME_SECONDS[tf] + config.live.confirmDelaySec) continue;
        preHits++;

        const attemptKey = `${key}:${pre.triggerTime}`;
        const n = (attempts.get(attemptKey) ?? 0) + 1;
        attempts.set(attemptKey, n);
        try {
          const gt = (await fetchAllTimeframes(token)).get(tf)!;
          const lagging = !gt.length || gt[gt.length - 1].time < pre.triggerTime;
          if (lagging && n < 4) continue; // GT hasn't published that candle yet; retry next minute
          handled.set(key, pre.triggerTime);
          attempts.delete(attemptKey);
          const real = lagging ? undefined : findSignals(gt, tf, config.scan.breakoutLookbackCandles, config).find((s) => s.pattern === pre.pattern);
          if (!real) {
            log.info({ token: token.symbol, pattern: pre.pattern, tf, candle: new Date(pre.triggerTime * 1000).toISOString() }, 'live pre-screen hit not confirmed by GeckoTerminal');
            continue;
          }
          confirmed++;
          await maybeAlert(db, token, real, gt, notifier, 'live+gt-confirmed');
        } catch (err) {
          log.warn({ token: token.symbol, err: errMsg(err) }, 'confirmation failed');
        }
      }
    }
  }

  const s = tracker.stats();
  db.setKv('job:live:last', String(Date.now()));
  db.setKv(
    'job:live:summary',
    `${s.live} pools live on-chain (${s.subscriptions} subscriptions over ${s.connections} sockets, ${s.wsConnected ? 'all up' : 'some reconnecting'}), ` +
      `${s.settingUp} setting up, ${s.reseeding} re-seeding, ${s.unsupported} on GT rotation, ${s.swaps} swaps seen`,
  );
  const d = tracker.drift;
  if (d.candles) {
    db.setKv(
      'job:live:accuracy',
      `${d.candles} live 15m candles checked vs GT: close err avg ${(d.closeErrPctSum / d.candles).toFixed(2)}%, ` +
        `high ${(d.highErrPctSum / d.candles).toFixed(2)}%, low ${(d.lowErrPctSum / d.candles).toFixed(2)}%, ` +
        `volume captured ${d.gtVolume ? ((d.liveVolume / d.gtVolume) * 100).toFixed(0) : '?'}% of GT`,
    );
  }
  if (preHits) log.info({ pools: pools.length, preHits, confirmed }, 'live scan');
}
