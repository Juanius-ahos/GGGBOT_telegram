import { Resvg } from '@resvg/resvg-js';
import { PATTERN_LABEL, type Signal } from '../patterns/signals.js';
import type { Candle } from '../patterns/types.js';
import { price as fmtPrice } from './format.js';

const W = 1280;
const H = 720;
const PAD_L = 24;
const PLOT_R = 985; // right edge of candles
const TAG_X = 1000; // level tags column
const TAG_W = 168;
const AXIS_X = 1180; // price axis labels
const TOP = 96;
const PRICE_BOTTOM = 548;
const VOL_TOP = 572;
const VOL_BOTTOM = 668;

const C = {
  bg: '#0d1117',
  panel: '#11161d',
  grid: '#1f2630',
  axis: '#7d8590',
  text: '#e6edf3',
  muted: '#8b949e',
  up: '#26a69a',
  down: '#ef5350',
  neck: '#f5b942',
  target: '#3fb950',
  inval: '#f85149',
  w: '#58a6ff',
};

const FONT = `font-family="DejaVu Sans, Segoe UI, Helvetica, Arial, sans-serif"`;

const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ChartMeta {
  symbol: string;
  name: string;
  priceNow: number;
}

/**
 * Candlestick chart of a signal (double bottom or hammer) with entry context, target and stop.
 * `candles` must be the same (closed, oldest-first) array the detector ran on.
 */
export function buildChartSvg(candles: Candle[], s: Signal, meta: ChartMeta): string {
  const db = s.doubleBottom;
  const hm = s.hammer;
  // Frame the setup: lead-in before it starts, at least ~60 candles, at most ~140.
  const setupStart = db ? db.firstLow.index : hm ? hm.hammerIndex - HAMMER_LEAD : s.triggerIndex - 30;
  const width = candles.length - setupStart;
  const lead = Math.max(12, Math.round(width * 0.6));
  const start = Math.max(0, Math.min(setupStart - lead, candles.length - 60), candles.length - 140);
  const view = candles.slice(start);
  const n = view.length;
  const idx = (i: number) => i - start;

  // Price range covers candles plus target/stop so every line is on screen.
  let lo = Math.min(...view.map((c) => c.low), s.invalidation);
  let hi = Math.max(...view.map((c) => c.high), s.target);
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;
  const y = (p: number) => TOP + ((hi - p) / (hi - lo)) * (PRICE_BOTTOM - TOP);
  const step = (PLOT_R - PAD_L) / Math.max(n, 1);
  const x = (i: number) => PAD_L + step * (i + 0.5);
  const bodyW = Math.max(2, step * 0.62);
  const maxVol = Math.max(...view.map((c) => c.volume), 1);
  const vy = (v: number) => VOL_BOTTOM - (v / maxVol) * (VOL_BOTTOM - VOL_TOP);

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  out.push(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`);
  out.push(`<rect x="${PAD_L - 8}" y="${TOP - 12}" width="${PLOT_R - PAD_L + 16}" height="${VOL_BOTTOM - TOP + 24}" rx="10" fill="${C.panel}"/>`);
  out.push(`<text x="${PAD_L}" y="${VOL_TOP - 4}" ${FONT} font-size="12" fill="${C.axis}">VOLUME</text>`);

  // Header: symbol + timeframe badge, pattern, price and move vs the key level.
  const keyLevel = s.neckline; // neckline for double bottoms, hammer high for hammers
  const chg = ((meta.priceNow - keyLevel) / keyLevel) * 100;
  const symText = `$${meta.symbol}`;
  const badgeX = PAD_L + 12 + symText.length * 18.5;
  out.push(`<text x="${PAD_L}" y="44" ${FONT} font-size="30" font-weight="700" fill="${C.text}">${escXml(symText)}</text>`);
  out.push(`<rect x="${badgeX}" y="19" width="52" height="30" rx="7" fill="${C.w}"/>`);
  out.push(`<text x="${badgeX + 26}" y="40" ${FONT} font-size="17" font-weight="700" fill="#0d1117" text-anchor="middle">${s.timeframe}</text>`);
  out.push(`<text x="${PAD_L}" y="74" ${FONT} font-size="17" fill="${C.muted}">${escXml(meta.name.slice(0, 40))} · ${PATTERN_LABEL[s.pattern]}</text>`);
  out.push(`<text x="${W - 24}" y="44" ${FONT} font-size="30" font-weight="700" fill="${C.text}" text-anchor="end">${fmtPrice(meta.priceNow)}</text>`);
  out.push(`<text x="${W - 24}" y="72" ${FONT} font-size="17" fill="${chg >= 0 ? C.target : C.inval}" text-anchor="end">${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% vs ${db ? 'neckline' : 'hammer high'}</text>`);

  // Grid + price axis
  for (let g = 0; g <= 5; g++) {
    const p = lo + ((hi - lo) * g) / 5;
    const gy = y(p);
    out.push(`<line x1="${PAD_L}" x2="${PLOT_R}" y1="${gy}" y2="${gy}" stroke="${C.grid}" stroke-width="1"/>`);
    out.push(`<text x="${AXIS_X}" y="${gy + 5}" ${FONT} font-size="13" fill="${C.axis}">${fmtPrice(p)}</text>`);
  }

  // Trigger candle highlight (+ hammer candle highlight)
  const bx = x(idx(s.triggerIndex));
  out.push(`<rect x="${bx - step / 2}" y="${TOP - 8}" width="${step}" height="${VOL_BOTTOM - TOP + 8}" fill="${C.w}" opacity="0.10"/>`);
  if (hm) {
    const hx = x(idx(hm.hammerIndex));
    out.push(`<rect x="${hx - step / 2}" y="${TOP - 8}" width="${step}" height="${VOL_BOTTOM - TOP + 8}" fill="${C.neck}" opacity="0.14"/>`);
  }

  // Volume + candles
  view.forEach((c, i) => {
    const up = c.close >= c.open;
    const col = up ? C.up : C.down;
    const cx = x(i);
    out.push(`<rect x="${cx - bodyW / 2}" y="${vy(c.volume)}" width="${bodyW}" height="${VOL_BOTTOM - vy(c.volume)}" fill="${col}" opacity="0.45"/>`);
    out.push(`<line x1="${cx}" x2="${cx}" y1="${y(c.high)}" y2="${y(c.low)}" stroke="${col}" stroke-width="1.4"/>`);
    const top = y(Math.max(c.open, c.close));
    const h = Math.max(1.2, Math.abs(y(c.open) - y(c.close)));
    out.push(`<rect x="${cx - bodyW / 2}" y="${top}" width="${bodyW}" height="${h}" fill="${col}"/>`);
  });

  if (db) {
    // "W" outline: L1 -> neckline -> L2 -> breakout close
    const wPts = [
      [x(idx(db.firstLow.index)), y(db.firstLow.price)],
      [x(idx(db.necklineIndex)), y(db.neckline)],
      [x(idx(db.secondLow.index)), y(db.secondLow.price)],
      [bx, y(db.breakout.price)],
    ];
    out.push(`<polyline points="${wPts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${C.w}" stroke-width="2.5" stroke-dasharray="2 5" stroke-linecap="round" opacity="0.9"/>`);
  }

  // Levels with right-side tags, nudged apart so labels never overlap.
  const levelFrom = db ? idx(db.secondLow.index) : hm ? idx(hm.hammerIndex) : idx(s.triggerIndex);
  const levels = [
    { p: s.target, col: C.target, label: `Target ${fmtPrice(s.target)}`, from: levelFrom },
    db
      ? { p: db.neckline, col: C.neck, label: `Neckline ${fmtPrice(db.neckline)}`, from: idx(db.firstLow.index) }
      : { p: s.neckline, col: C.neck, label: `Hammer high ${fmtPrice(s.neckline)}`, from: levelFrom },
    { p: s.invalidation, col: C.inval, label: `Stop ${fmtPrice(s.invalidation)}`, from: levelFrom },
  ].sort((a, b) => y(a.p) - y(b.p));
  let lastTag = -Infinity;
  for (const l of levels) {
    const ly = y(l.p);
    const tagY = Math.max(ly, lastTag + 28); // tag centre, pushed down if it would overlap the one above
    lastTag = tagY;
    out.push(`<line x1="${x(Math.max(0, l.from))}" x2="${PLOT_R + 4}" y1="${ly}" y2="${ly}" stroke="${l.col}" stroke-width="2" stroke-dasharray="8 6"/>`);
    out.push(`<polyline points="${PLOT_R + 4},${ly} ${TAG_X},${tagY}" fill="none" stroke="${l.col}" stroke-width="2"/>`);
    out.push(`<rect x="${TAG_X}" y="${tagY - 12}" width="${TAG_W}" height="24" rx="6" fill="${l.col}"/>`);
    out.push(`<text x="${TAG_X + TAG_W / 2}" y="${tagY + 5}" ${FONT} font-size="13" font-weight="700" fill="#0d1117" text-anchor="middle">${escXml(l.label)}</text>`);
  }

  // Markers under lows: L1/L2 for double bottoms (amber L2 when it is a hammer), H for a hammer.
  const markers: { i: number; p: number; text: string; hammer: boolean }[] = db
    ? [
        { i: db.firstLow.index, p: db.firstLow.price, text: 'L1', hammer: false },
        { i: db.secondLow.index, p: db.secondLow.price, text: 'L2', hammer: !!s.hammerAtSecondLow },
      ]
    : hm
      ? [{ i: hm.hammerIndex, p: hm.hammer.low, text: 'H', hammer: true }]
      : [];
  for (const m of markers) {
    const lx = x(idx(m.i));
    const ly = y(m.p);
    out.push(`<circle cx="${lx}" cy="${ly + 14}" r="12" fill="${m.hammer ? C.neck : C.w}"/>`);
    out.push(`<text x="${lx}" y="${ly + 19}" ${FONT} font-size="12" font-weight="700" fill="#0d1117" text-anchor="middle">${m.text}</text>`);
    if (m.hammer) out.push(`<text x="${lx}" y="${ly + 44}" ${FONT} font-size="12" font-weight="700" fill="${C.neck}" text-anchor="middle">HAMMER</text>`);
  }
  // Trigger marker
  const by = y(candles[s.triggerIndex].high);
  const trig = s.trigger ?? 'close';
  const triggerLabel = trig === 'forming' ? 'NOW' : trig === 'cross' ? (db ? 'BREAKING NOW' : 'BREAKING HIGH') : db ? 'BREAKOUT' : 'CONFIRMED';
  out.push(`<text x="${bx}" y="${by - 26}" ${FONT} font-size="13" font-weight="700" fill="${C.w}" text-anchor="middle">${triggerLabel}</text>`);
  out.push(`<path d="M ${bx - 7} ${by - 20} L ${bx + 7} ${by - 20} L ${bx} ${by - 8} Z" fill="${C.w}"/>`);

  // Time axis: first and last candle times (UTC)
  const fmtT = (sec: number) => new Date(sec * 1000).toISOString().slice(5, 16).replace('T', ' ');
  out.push(`<text x="${PAD_L}" y="${VOL_BOTTOM + 24}" ${FONT} font-size="13" fill="${C.axis}">${fmtT(view[0].time)} UTC</text>`);
  out.push(`<text x="${PLOT_R}" y="${VOL_BOTTOM + 24}" ${FONT} font-size="13" fill="${C.axis}" text-anchor="end">${fmtT(view[n - 1].time)} UTC</text>`);
  out.push(`<text x="${W - 24}" y="${H - 14}" ${FONT} font-size="12" fill="${C.muted}" text-anchor="end">GGG_BOT · not financial advice</text>`);
  out.push(`</svg>`);
  return out.join('');
}

/** Candles shown before a hammer for context. */
const HAMMER_LEAD = 30;

export function renderChartPng(candles: Candle[], s: Signal, meta: ChartMeta): Buffer {
  const svg = buildChartSvg(candles, s, meta);
  return new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' }, fitTo: { mode: 'width', value: W } })
    .render()
    .asPng();
}
