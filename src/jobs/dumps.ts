import { config } from '../config.js';


type DumpTf = (typeof config.dumps.timeframes)[number];
const TF_SEC: Record<DumpTf, number> = { '5m': 300, '15m': 900 };

export interface Dump {
  timeframe: DumpTf;
  /** Candle open time, ms (UTC-aligned, like GeckoTerminal candles). */
  candleTime: number;
  open: number;
  price: number;
  /** Positive percentage, e.g. 37.2 for a 37.2% fall. */
  dropPct: number;
  /** Fell more than `rugLabelAbovePct`: shown as a possible rug. */
  possibleRug: boolean;
}

interface Sample {
  t: number;
  p: number;
}

/**
 * Detects a single candle falling at least `minDropPct` from its open (deeper than `rugLabelAbovePct` = possible rug), on prices sampled every few seconds.
 * The open is the last price seen before the candle started (= previous close), so a drop that begins right at
 * the candle boundary still counts. One alert per token+timeframe+candle; a 15m alert is skipped when the same
 * fall was already reported on 5m in that 15m candle.
 */
export class DumpDetector {
  private samples = new Map<string, Sample[]>();
  private sent = new Map<string, number>();
  private last5m = new Map<string, number>();

  constructor(private cfg = config.dumps) {}

  observe(token: string, t: number, p: number): Dump[] {
    if (!(p > 0)) return [];
    const maxSec = Math.max(...this.cfg.timeframes.map((tf) => TF_SEC[tf]));
    const list = (this.samples.get(token) ?? []).filter((s) => s.t > t - 2 * maxSec * 1000);
    list.push({ t, p });
    this.samples.set(token, list);

    const out: Dump[] = [];
    for (const tf of this.cfg.timeframes) {
      const ms = TF_SEC[tf] * 1000;
      const start = Math.floor(t / ms) * ms;
      const before = list.filter((s) => s.t < start).at(-1);
      // Without a price from just before the candle, use its first sample (only if it isn't the current one).
      const open = before && start - before.t <= 2 * this.cfg.sampleIntervalMs ? before.p : list.find((s) => s.t >= start && s.t < t)?.p;
      if (!open) continue;
      const dropPct = ((open - p) / open) * 100;
      if (dropPct < this.cfg.minDropPct) continue;
      const key = `${token}:${tf}`;
      if (this.sent.get(key) === start) continue;
      this.sent.set(key, start);
      if (tf === '15m' && (this.last5m.get(token) ?? 0) >= start) continue;
      if (tf === '5m') this.last5m.set(token, t);
      out.push({ timeframe: tf, candleTime: start, open, price: p, dropPct, possibleRug: dropPct > this.cfg.rugLabelAbovePct });
    }
    return out;
  }

  /** Forget tokens that left the watchlist. */
  retain(tokens: Set<string>): void {
    for (const k of this.samples.keys()) if (!tokens.has(k)) this.samples.delete(k);
  }
}
