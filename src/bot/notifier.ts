import fs from 'node:fs';
import path from 'node:path';
import type { AlertRow } from '../db/index.js';
import { errMsg } from '../lib/http.js';
import { logger } from '../logger.js';
import type { Signal } from '../patterns/signals.js';
import type { Candle } from '../patterns/types.js';
import { renderChartPng } from './chart.js';
import { alertCaption } from './format.js';

export interface AlertPayload {
  alertId: number;
  row: Omit<AlertRow, 'id' | 'price_1h' | 'pct_1h' | 'price_4h' | 'pct_4h' | 'price_24h' | 'pct_24h' | 'sample_high' | 'sample_low' | 'sampled_outcome' | 'outcome' | 'outcome_at'>;
  signal: Signal;
  /** The candles (of the signal's timeframe) the detector confirmed on, closed, oldest first. */
  candles: Candle[];
}

/** Where alerts and outcome updates go: Telegram in production, files in DRY_RUN. */
export interface Notifier {
  alert(p: AlertPayload): Promise<number>;
  followUp(alertId: number, html: string): Promise<void>;
}

/** Renders the chart; returns null (text-only alert) if rendering fails for any reason. */
export function tryRenderChart(p: AlertPayload): Buffer | null {
  try {
    return renderChartPng(p.candles, p.signal, { symbol: p.row.symbol, name: p.row.name, priceNow: p.row.price_at_alert });
  } catch (err) {
    logger.warn({ token: p.row.symbol, err: errMsg(err) }, 'chart render failed; sending text alert');
    return null;
  }
}

/** DRY_RUN: writes each alert's chart + caption to data/previews so they can be inspected. */
export class DryRunNotifier implements Notifier {
  constructor(private dir = './data/previews') {}

  async alert(p: AlertPayload): Promise<number> {
    fs.mkdirSync(this.dir, { recursive: true });
    const base = path.join(this.dir, `${p.alertId}-${p.row.symbol.replace(/[^\w-]/g, '')}`);
    const png = tryRenderChart(p);
    if (png) fs.writeFileSync(`${base}.png`, png);
    fs.writeFileSync(`${base}.html.txt`, alertCaption(p.row, p.signal));
    logger.info({ file: `${base}.png` }, 'DRY_RUN alert written (not sent)');
    return 0;
  }

  async followUp(alertId: number, html: string): Promise<void> {
    logger.info({ alertId, message: html.replace(/<[^>]+>/g, '') }, 'DRY_RUN follow-up (not sent)');
  }
}
