import type { AppConfig } from '../config.js';
import type { AlertRow } from '../db/index.js';
import type { Signal } from '../patterns/signals.js';
import type { InlineKeyboard, ReplyKeyboard } from './telegram.js';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '?';
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/** Token prices span many magnitudes; keep 4 significant digits without scientific notation. */
export function price(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '?';
  if (n === 0) return '$0';
  if (n >= 1) return `$${n.toFixed(4)}`;
  const decimals = Math.min(12, Math.ceil(-Math.log10(n)) + 3);
  return `$${n.toFixed(decimals)}`;
}

export function pct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(digits)}%`;
}

export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function ago(ms: number | null | undefined): string {
  return ms ? `${duration(Date.now() - ms)} ago` : 'never';
}

export const links = {
  dexscreener: (pair: string) => `https://dexscreener.com/solana/${pair}`,
  birdeye: (token: string) => `https://birdeye.so/token/${token}?chain=solana`,
  jupiter: (token: string) => `https://jup.ag/swap/SOL-${token}`,
  solscan: (token: string) => `https://solscan.io/token/${token}`,
};

type AlertCore = Pick<
  AlertRow,
  'token_address' | 'symbol' | 'name' | 'pair_address' | 'price_at_alert' | 'market_cap' | 'liquidity_usd' |
  'first_low' | 'second_low' | 'neckline' | 'breakout_price' | 'invalidation' | 'target'
>;

const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));

export const PATTERN_TITLE: Record<string, string> = {
  double_bottom: '🟢 <b>DOUBLE BOTTOM BREAKOUT</b>',
  hammer: '🔨 <b>HAMMER REVERSAL</b>',
  db_forming: '📍 <b>DOUBLE BOTTOM FORMING</b>',
};
const CROSS_TITLE: Record<string, string> = {
  double_bottom: '⚡ <b>DOUBLE BOTTOM BREAKOUT · LIVE</b>',
  hammer: '⚡ <b>HAMMER REVERSAL · LIVE</b>',
};
export const PATTERN_ICON: Record<string, string> = { double_bottom: 'Ⓦ', hammer: '🔨', db_forming: '📍', dump: '🩸' };
const PATTERN_SHORT: Record<string, string> = { double_bottom: 'Double bottom', hammer: 'Hammer', db_forming: 'DB forming' };

/** Photo caption for a new alert (Telegram caps captions at 1024 chars). */
export function alertCaption(a: AlertCore, s: Signal): string {
  const volRatio = s.volumeRatio;
  const ref = a.price_at_alert || a.breakout_price;
  const up = ((a.target - ref) / ref) * 100;
  const down = ((a.invalidation - ref) / ref) * 100;
  const rr = Math.abs(down) > 0 ? up / Math.abs(down) : 0;
  const trigger = s.trigger ?? 'close';
  const forming = trigger === 'forming';
  const toTrigger = ((a.neckline - ref) / ref) * 100;
  const table = [
    `${pad(forming ? 'Now' : 'Entry', 8)}${pad(price(ref), 16)}`,
    forming ? `${pad('Trigger', 8)}${pad(price(a.neckline), 16)}${pct(toTrigger)}` : null,
    `${pad('Target', 8)}${pad(price(a.target), 16)}${pct(up)}`,
    `${pad('Stop', 8)}${pad(price(a.invalidation), 16)}${pct(down)}`,
    `${pad('R:R', 8)}${rr.toFixed(2)}`,
  ]
    .filter((l) => l !== null)
    .join('\n');
  const hammerBits = s.hammer
    ? `hammer wick ${Number.isFinite(s.hammer.lowerWickToBody) ? s.hammer.lowerWickToBody.toFixed(1) + '×' : '∞×'} body · after ${pct(-s.hammer.priorDeclinePct * 100)} drop`
    : '';
  const detail =
    s.pattern === 'hammer'
      ? `<i>${s.timeframe} · ${hammerBits}${hammerBits ? ' · ' : ''}${trigger === 'cross' ? 'live break of the hammer high' : 'confirmed by next close'}</i>`
      : `<i>${s.timeframe} · L1 ${price(a.first_low)} · L2 ${price(a.second_low)} · Neck ${price(a.neckline)}</i>`;
  const status =
    trigger === 'cross'
      ? s.pattern === 'hammer'
        ? `⏱ <i>Price just broke the hammer's high (candle still open).</i>`
        : `⏱ <i>Price just crossed the neckline (candle still open).</i>`
      : forming
        ? `⏳ <i>Not confirmed yet: both lows are in. I'll send ⚡ the moment price breaks the neckline (${pct(toTrigger)} from here).</i>`
        : null;
  const volLine = forming
    ? `💰 MC <b>${usd(a.market_cap)}</b>   💧 Liq <b>${usd(a.liquidity_usd)}</b>`
    : `💰 MC <b>${usd(a.market_cap)}</b>   💧 Liq <b>${usd(a.liquidity_usd)}</b>   📊 Vol <b>${volRatio.toFixed(1)}×</b> ${trigger === 'cross' && s.pattern === 'double_bottom' ? 'avg pace' : 'avg'}`;
  const title = trigger === 'cross' ? CROSS_TITLE[s.pattern] ?? PATTERN_TITLE[s.pattern] : PATTERN_TITLE[s.pattern];
  return [
    `${title} · <b>${s.timeframe}</b>`,
    ``,
    `<b>$${esc(a.symbol)}</b> · ${esc(a.name.slice(0, 40))}`,
    `<code>${a.token_address}</code>`,
    ``,
    volLine,
    s.hammerAtSecondLow ? `🔨 <b>Second low printed a hammer</b> (extra confirmation)` : null,
    status,
    ``,
    `<pre>${esc(table)}</pre>`,
    detail,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

export function alertKeyboard(alertId: number, token: string, pair: string): InlineKeyboard {
  return [
    [
      { text: '📈 DexScreener', url: links.dexscreener(pair) },
      { text: '🦅 Birdeye', url: links.birdeye(token) },
    ],
    [
      { text: '⚡ Jupiter', url: links.jupiter(token) },
      { text: '🔎 Solscan', url: links.solscan(token) },
    ],
    [
      { text: '🔄 Price now', callback_data: `p:${alertId}` },
      { text: '🔕 Mute 24h', callback_data: `m:${alertId}` },
    ],
  ];
}

export const MENU = {
  status: '📡 Status',
  recent: '🕒 Recent',
  stats: '🏆 Stats',
  myAlerts: '🔔 My alerts',
  rules: '📐 Rules',
  help: '❓ Help',
  /** Label from older keyboards; still understood. */
  legacySettings: '⚙️ Settings',
} as const;

export const menuKeyboard: ReplyKeyboard = {
  keyboard: [
    [{ text: MENU.myAlerts }, { text: MENU.recent }],
    [{ text: MENU.status }, { text: MENU.rules }],
    [{ text: MENU.help }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

/** Sudden one-candle drop (jobs/dumps.ts). Text only: there is no pattern to chart. */
export function dumpMessage(d: { token: { symbol: string; name: string; address: string }; timeframe: string; open: number; price: number; dropPct: number; possibleRug: boolean; marketCap: number; liquidityUsd: number }): string {
  return [
    d.possibleRug ? `⚠️ <b>SUDDEN DROP · POSSIBLE RUG</b> · <b>${d.timeframe}</b>` : `🩸 <b>SUDDEN DROP</b> · <b>${d.timeframe}</b>`,
    ``,
    `<b>$${esc(d.token.symbol)}</b> · ${esc(d.token.name.slice(0, 40))}`,
    `<code>${d.token.address}</code>`,
    ``,
    `📉 <b>${pct(-d.dropPct)}</b> in one ${d.timeframe} candle (still open)`,
    `💰 MC <b>${usd(d.marketCap)}</b>   💧 Liq <b>${usd(d.liquidityUsd)}</b>`,
    ``,
    `<pre>${esc(`${pad('Open', 8)}${price(d.open)}\n${pad('Now', 8)}${price(d.price)}`)}</pre>`,
    d.possibleRug
      ? `<i>Fell more than half in one candle: often a rug pull or a big holder dumping. Check liquidity and holders first.</i>`
      : `<i>Could be a dip or the start of a rug: check liquidity and holders before buying.</i>`,
  ].join('\n');
}

export function linksKeyboard(token: string, pair: string): InlineKeyboard {
  return alertKeyboard(0, token, pair).slice(0, 2);
}

export const PATTERNS = ['double_bottom', 'hammer', 'db_forming', 'dump'] as const;
/** New chats start without the early "forming" heads-up: live data 1-3 Oct 2026 had 40 of 52 hit the stop first. */
export const DEFAULT_PATTERNS: readonly string[] = PATTERNS.filter((p) => p !== 'db_forming');
export const PATTERN_NAME: Record<string, string> = { double_bottom: 'Double bottom', hammer: 'Hammer', db_forming: 'Early: DB forming', dump: 'Sudden drop' };

/** One-time "what's new" message for existing subscribers (sent once per `ANNOUNCEMENT_ID`). */
export const ANNOUNCEMENT_ID = '2026-10-04-whole-market';
export function announcementMessage(cfg: AppConfig): string {
  return [
    `🆕 <b>GGG_BOT update</b>`,
    ``,
    `🌍 <b>Now scanning the whole Solana market.</b> Every 2 hours I list every Solana coin with enough volume and liquidity, on every DEX (about 500 coins), on top of the trending feeds and every pump.fun graduation. Coins inside the filters are checked every minute.`,
    `<i>Filters: MC ${usd(cfg.market.minMarketCapUsd)}–${usd(cfg.market.maxMarketCapUsd)} · liquidity ≥ ${usd(cfg.market.minLiquidityUsd)} · 24h volume ≥ ${usd(cfg.market.minVolume24hUsd)} · rug check</i>`,
    ``,
    `🩸 <b>New: Sudden drop alerts.</b> A coin falling ${cfg.dumps.minDropPct}%+ in one 5m or 15m candle. Over ${cfg.dumps.rugLabelAbovePct}% is marked ⚠️ POSSIBLE RUG.`,
    `🔨 <b>Hammers</b> now on 15m, 1h and 4h only.`,
    `⏭ <b>Late breakouts are skipped:</b> no alert when the target is already closer than the stop.`,
    `📍 <b>Early "forming" alerts are off by default.</b> Turn them on in ${MENU.myAlerts}.`,
    `🔕 <b>One alert per event:</b> no more 🎯 / 🛑 / recap follow-ups.`,
    ``,
    `Choose what you get in ${MENU.myAlerts}. Not financial advice.`,
  ].join('\n');
}

export function welcomeMessage(cfg: AppConfig): string {
  return [
    `👁 <b>Welcome to GGG_BOT</b>`,
    ``,
    `You're subscribed. I watch Solana tokens around the clock and alert you the moment a setup confirms:`,
    ``,
    `Ⓦ <b>Double bottom breakout</b> — two matching lows, then a break of the neckline on strong volume`,
    `🔨 <b>Hammer reversal</b> — a long-wick bottom candle after a drop, then a break of its high`,
    `📍 <b>Early heads-up</b> — both lows of a double bottom are in, before the breakout`,
    ``,
    `⚡ Breakouts are caught <b>live</b>: the alert fires the moment price crosses the level, not at the candle close.`,
    ``,
    `⏱ On <b>${cfg.timeframes.join(', ')}</b> charts.`,
    ``,
    `<b>Every token has passed:</b>`,
    `• MC ${usd(cfg.market.minMarketCapUsd)}–${usd(cfg.market.maxMarketCapUsd)}, liquidity ≥ ${usd(cfg.market.minLiquidityUsd)}, 24h vol ≥ ${usd(cfg.market.minVolume24hUsd)}`,
    `• Mint + freeze authority revoked, top-10 holders &lt; ${cfg.rug.maxTop10HolderPct}%, RugCheck clean`,
    ``,
    `Alerts come with a chart, entry / target / stop and quick buttons. I reply under each alert when its target or stop is hit.`,
    ``,
    `👉 Tap <b>${MENU.myAlerts}</b> to choose which patterns and timeframes you get.`,
  ].join('\n');
}

export function helpMessage(): string {
  return [
    `❓ <b>How GGG_BOT works</b>`,
    ``,
    `<b>Menu</b>`,
    `${MENU.myAlerts} — pick patterns + timeframes, manage muted tokens`,
    `${MENU.recent} — the latest alerts`,
    `${MENU.status} — is it running, how many tokens it watches`,
    `${MENU.rules} — exact filters and pattern rules`,
    ``,
    `<b>On each alert</b>`,
    `📈 DexScreener · 🦅 Birdeye · ⚡ Jupiter · 🔎 Solscan — open the token`,
    `🔄 Price now — live price and distance to target / stop`,
    `🔕 Mute 24h — stop alerts for that token`,
    ``,
    `<b>Reading an alert</b>`,
    `<b>Entry</b> is the price when the alert fired. <b>Stop</b> is where the setup is wrong. <b>Target</b> is the pattern's measured move. <b>R:R</b> = reward ÷ risk.`,
    ``,
    `/stop unsubscribes · /start resubscribes`,
    `<i>Not financial advice. Patterns fail — size positions so a stop-out is fine.</i>`,
  ].join('\n');
}

export interface PrefsView {
  patterns: string[];
  timeframes: string[];
  mutes: { token_address: string; until: number; symbol: string }[];
}

/** "My alerts" panel: tap to toggle; the message edits itself in place. */
export function myAlertsPanel(v: PrefsView, allTimeframes: readonly string[]): { html: string; keyboard: InlineKeyboard } {
  const on = (b: boolean) => (b ? '✅' : '⬜');
  const nothing = v.patterns.length === 0 || v.timeframes.length === 0;
  const html = [
    `🔔 <b>My alerts</b>`,
    ``,
    `Tap to switch on/off. Changes apply to the next alert.`,
    ``,
    `<b>Patterns:</b> ${v.patterns.map((p) => PATTERN_NAME[p] ?? p).join(', ') || '—'}`,
    `<b>Timeframes:</b> ${v.timeframes.join(', ') || '—'}`,
    nothing ? `\n⚠️ <b>You'll get no alerts</b> — turn on at least one pattern and one timeframe.` : '',
    v.mutes.length ? `\n🔕 <b>Muted:</b> ${v.mutes.map((m) => `$${esc(m.symbol)} (${duration(m.until - Date.now())} left)`).join(', ')}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
  const keyboard: InlineKeyboard = [
    ...PATTERNS.map((p) => [{ text: `${on(v.patterns.includes(p))} ${PATTERN_ICON[p]} ${PATTERN_NAME[p]}`, callback_data: `tp:${p}` }]),
    allTimeframes.map((tf) => ({ text: `${on(v.timeframes.includes(tf))} ${tf}`, callback_data: `tt:${tf}` })),
    ...v.mutes.slice(0, 6).map((m) => [{ text: `🔔 Unmute $${m.symbol}`, callback_data: `um:${m.token_address}` }]),
    [{ text: '✅ Everything on', callback_data: 'all:on' }],
  ];
  return { html, keyboard };
}

const outcomeIcon: Record<string, string> = { target: '🎯', invalidation: '🛑', none: '➖', pending: '⏳' };

/** Latest alerts. Without outcome tracking (`tracked` false) they're listed plainly, with no results. */
export function recentMessage(rows: AlertRow[], tracked = true): string {
  if (!rows.length) return `🕒 <b>Recent alerts</b>\n\nNo alerts yet — I'll ping you as soon as a breakout confirms.`;
  if (!tracked) {
    const plain = rows.map(
      (a) => `${PATTERN_ICON[a.pattern] ?? ''} <a href="${links.dexscreener(a.pair_address)}"><b>$${esc(a.symbol)}</b></a> ${a.timeframe} · ${PATTERN_SHORT[a.pattern] ?? a.pattern} · MC ${usd(a.market_cap)} · ${ago(a.created_at)}`,
    );
    return [`🕒 <b>Recent alerts</b>`, ``, ...plain].join('\n');
  }
  const lines = rows.map((a) => {
    const best = a.pct_24h ?? a.pct_4h ?? a.pct_1h;
    const when = best === a.pct_24h && best !== null ? '24h' : best === a.pct_4h && best !== null ? '4h' : best !== null ? '1h' : '';
    return (
      `${outcomeIcon[a.outcome] ?? '⏳'} <a href="${links.dexscreener(a.pair_address)}"><b>$${esc(a.symbol)}</b></a> ` +
      `${PATTERN_ICON[a.pattern] ?? ''} ${a.timeframe}  ` +
      `${best !== null ? `<b>${pct(best)}</b> <i>(${when})</i>` : '<i>tracking…</i>'}  · ${ago(a.created_at)}`
    );
  });
  return [`🕒 <b>Recent alerts</b>`, ``, ...lines, ``, `<i>Ⓦ double bottom · 🔨 hammer · 🎯 target hit · 🛑 stopped · ➖ neither · ⏳ open</i>`].join('\n');
}

function bar(fraction: number, width = 10): string {
  const f = Math.max(0, Math.min(1, fraction));
  const full = Math.round(f * width);
  return '█'.repeat(full) + '░'.repeat(width - full);
}

export function statsMessage(
  s: { total: number; wins: number | null; losses: number | null; neither: number | null; pending: number | null; avg1h: number | null; n1h: number; avg4h: number | null; n4h: number; avg24h: number | null; n24h: number },
  bw: { best: { symbol: string; ret: number }; worst: { symbol: string; ret: number } } | null,
  by: { pattern: string; timeframe: string; total: number; wins: number | null; losses: number | null; neither: number | null }[] = [],
): string {
  if (!s.total) return `🏆 <b>Performance</b>\n\nNo alerts yet, so nothing to score. Stats fill in as alerts play out over 24h.`;
  const wins = s.wins ?? 0;
  const losses = s.losses ?? 0;
  const neither = s.neither ?? 0;
  const resolved = wins + losses + neither;
  const wr = resolved ? wins / resolved : 0;
  return [
    `🏆 <b>Performance</b>`,
    ``,
    `Alerts <b>${s.total}</b> · resolved ${resolved} · open ${s.pending ?? 0}`,
    ``,
    `<b>Win rate</b>  <code>${bar(wr)}</code>  <b>${resolved ? (wr * 100).toFixed(0) + '%' : '—'}</b>`,
    `🎯 ${wins} target  ·  🛑 ${losses} stopped  ·  ➖ ${neither} neither`,
    ``,
    `<b>Average return</b>`,
    `<pre>${esc(
      [`1h   ${pct(s.avg1h, 2).padStart(8)}   n=${s.n1h}`, `4h   ${pct(s.avg4h, 2).padStart(8)}   n=${s.n4h}`, `24h  ${pct(s.avg24h, 2).padStart(8)}   n=${s.n24h}`].join('\n'),
    )}</pre>`,
    bw ? `🥇 Best <b>$${esc(bw.best.symbol)}</b> ${pct(bw.best.ret)}   🥶 Worst <b>$${esc(bw.worst.symbol)}</b> ${pct(bw.worst.ret)}` : '',
    by.length > 1 ? `\n<b>By setup</b>\n<pre>${esc(by.map((r) => {
      const res = (r.wins ?? 0) + (r.losses ?? 0) + (r.neither ?? 0);
      return `${(PATTERN_SHORT[r.pattern] ?? r.pattern).padEnd(14)}${r.timeframe.padEnd(4)}${String(r.total).padStart(3)} alerts  ${res ? `${(((r.wins ?? 0) / res) * 100).toFixed(0)}% win` : 'open'}`;
    }).join('\n'))}</pre>` : '',
    ``,
    `<i>Win = target hit before stop (15m: 24h window, 1h: 3 days, 4h: 7 days).</i>`,
  ]
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
    .join('\n');
}

export function settingsMessage(cfg: AppConfig): string {
  const d = cfg.doubleBottom;
  const m = cfg.market;
  const r = cfg.rug;
  const p = (x: number) => `${(x * 100).toFixed(0)}%`;
  return [
    `⚙️ <b>Settings</b>`,
    ``,
    `<b>💰 Market filter</b>`,
    `MC ${usd(m.minMarketCapUsd)}–${usd(m.maxMarketCapUsd)} · Liq ≥ ${usd(m.minLiquidityUsd)} · Vol 24h ≥ ${usd(m.minVolume24hUsd)} · ${m.minPairAgeHours > 0 ? `Age ≥ ${m.minPairAgeHours}h` : 'any age'}`,
    ``,
    `<b>🛡 Rug filter</b> <i>(re-checked every ${r.cacheHours}h)</i>`,
    `Mint + freeze revoked · Top-10 &lt; ${r.maxTop10HolderPct}% · RugCheck ≤ ${r.maxRugcheckScore} · no "${r.rejectRiskLevels.join('/')}" risks`,
    ``,
    `<b>⏱ Timeframes</b>`,
    `${cfg.timeframes.join(' · ')} — both patterns (5m only for tokens younger than ~${Math.round(cfg.youngTokenHours / 24)} days)`,
    ``,
    `<b>Ⓦ Double bottom</b>`,
    `• Lows within ${p(d.lowTolerancePct)}, ${d.minCandlesBetweenLows}–${d.maxCandlesBetweenLows} candles apart`,
    `• Bounce ≥ ${p(d.minBouncePct)} between them (neckline)`,
    `• 2nd low on equal or lower sell volume`,
    `• Close above neckline on volume &gt; ${d.breakoutVolumeAvgPeriod}-candle avg`,
    `• Stop ${p(d.invalidationBufferPct)} under 2nd low · Target = neckline + height`,
    ``,
    `<b>🔨 Hammer</b>`,
    `• Lower wick ≥ ${cfg.hammer.minLowerWickToBody}× body and ≥ ${p(cfg.hammer.minLowerWickPctOfRange)} of range, upper wick ≤ ${p(cfg.hammer.maxUpperWickPctOfRange)}`,
    `• After a ≥ ${p(cfg.hammer.minPriorDeclinePct)} drop, lowest low of ${cfg.hammer.lowLookback} candles, volume ≥ average`,
    `• ${cfg.hammer.requireConfirmation ? `Next candle must close above the hammer's ${cfg.hammer.confirmAbove === 'close' ? 'close' : 'high'} (live alert fires earlier if price breaks the hammer high)` : 'No confirmation candle required'}`,
    `• Stop ${p(cfg.hammer.invalidationBufferPct)} under hammer low · Target = ${cfg.hammer.rewardToRisk}× risk`,
    ``,
    `<b>🔔 Alerts</b>`,
    `Max 1 per token per pattern + timeframe per ${cfg.alerts.cooldownHours}h · confirmed on GeckoTerminal candles`,
    ``,
    `<i>Thresholds live in src/config.ts on the server.</i>`,
  ].join('\n');
}

export interface StatusData {
  subscribed: boolean;
  /** e.g. "Double bottom, Hammer · 15m, 1h, 4h" */
  myAlerts: string;
  subscribers: number;
  uptimeMs: number;
  pool: number;
  marketPass: number;
  rugPass: number;
  rugPending: number;
  live: { live: number; gt: number; settingUp: number; reseeding: number; wsUp: boolean; swaps: number } | null;
  lastDiscovery?: number;
  lastScan?: number;
  lastLive?: number;
  lastAlert?: number;
  alerts24h: number;
  accuracy?: string;
}

export function statusMessage(s: StatusData): string {
  const healthy = !!s.lastDiscovery && Date.now() - s.lastDiscovery < 25 * 60_000 && (!s.live || s.live.wsUp);
  return [
    `${healthy ? '🟢' : '🟠'} <b>GGG_BOT ${healthy ? 'is running' : 'needs attention'}</b> · up ${duration(s.uptimeMs)}`,
    `${s.subscribed ? '🔔 You are subscribed' : '🔕 You are not subscribed (/start)'} · ${s.subscribers} subscriber${s.subscribers === 1 ? '' : 's'}`,
    s.subscribed ? `Your alerts: ${esc(s.myAlerts)}` : '',
    ``,
    `<b>🔭 Coverage</b>`,
    `<code>${s.pool}</code> tokens seen → <code>${s.marketPass}</code> pass market → <code>${s.rugPass}</code> pass rug${s.rugPending ? ` (+${s.rugPending} checking)` : ''}`,
    s.live
      ? `⚡ <b>${s.live.live}</b> live on-chain <i>(every 1 min)</i> · 🦎 <b>${s.live.gt}</b> via GeckoTerminal <i>(every 5 min)</i>` +
        (s.live.settingUp || s.live.reseeding ? `\n⏳ ${s.live.settingUp} going live · ${s.live.reseeding} re-syncing` : '')
      : `🦎 All tokens via GeckoTerminal`,
    ``,
    `<b>📡 Activity</b>`,
    `Discovery ${ago(s.lastDiscovery)} · Scan ${ago(Math.max(s.lastScan ?? 0, s.lastLive ?? 0) || undefined)}`,
    s.live ? `Chain swaps processed: <b>${s.live.swaps.toLocaleString('en-US')}</b> · websocket ${s.live.wsUp ? '✅' : '⚠️ reconnecting'}` : '',
    `Alerts last 24h: <b>${s.alerts24h}</b> · last ${ago(s.lastAlert)}`,
    s.accuracy ? `\n<i>🎯 Live accuracy: ${esc(s.accuracy)}</i>` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export function followUpTarget(a: AlertRow, priceNow: number): string {
  return `🎯 <b>$${esc(a.symbol)} hit the target!</b>\n${price(a.price_at_alert)} → <b>${price(priceNow)}</b> (<b>${pct(((priceNow - a.price_at_alert) / a.price_at_alert) * 100)}</b>) in ${duration(Date.now() - a.created_at)}`;
}

export function followUpStop(a: AlertRow, priceNow: number): string {
  return `🛑 <b>$${esc(a.symbol)} hit the stop</b>\n${price(a.price_at_alert)} → ${price(priceNow)} (${pct(((priceNow - a.price_at_alert) / a.price_at_alert) * 100)}) after ${duration(Date.now() - a.created_at)}. Pattern invalidated.`;
}

export function followUpRecap(a: AlertRow, windowHours = 24): string {
  const verdict =
    a.outcome === 'target' ? '🎯 Target hit first' : a.outcome === 'invalidation' ? '🛑 Stop hit first' : '➖ Neither level hit';
  return [
    `📋 <b>${windowHours >= 48 ? `${Math.round(windowHours / 24)}-day` : `${windowHours}h`} recap · $${esc(a.symbol)}</b> <i>(${PATTERN_SHORT[a.pattern] ?? a.pattern} ${a.timeframe})</i>`,
    `<pre>${esc([`1h   ${pct(a.pct_1h)}`, `4h   ${pct(a.pct_4h)}`, `24h  ${pct(a.pct_24h)}`].join('\n'))}</pre>`,
    verdict,
  ].join('\n');
}
