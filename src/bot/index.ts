import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { errMsg } from '../lib/http.js';
import { logger } from '../logger.js';
import { fetchBestPairs } from '../sources/dexscreener.js';
import {
  alertCaption, alertKeyboard, DEFAULT_PATTERNS, dumpMessage, helpMessage, linksKeyboard, MENU, menuKeyboard, myAlertsPanel, PATTERN_NAME, PATTERNS, pct, price,
  recentMessage, settingsMessage, statsMessage, statusMessage, welcomeMessage, type StatusData,
} from './format.js';
import { tryRenderChart, type AlertPayload, type DumpPayload, type Notifier } from './notifier.js';
import { TelegramClient, type SendResult, type TgCallbackQuery, type TgMessage } from './telegram.js';

const log = logger.child({ mod: 'bot' });

const COMMANDS = [
  { command: 'start', description: 'Subscribe + show menu' },
  { command: 'alerts', description: 'Choose patterns + timeframes, manage mutes' },
  { command: 'help', description: 'How it works' },
  { command: 'status', description: 'Is it running, what is it watching' },
  { command: 'recent', description: 'Latest alerts and how they did' },
  { command: 'stats', description: 'Win rate and average returns' },
  { command: 'settings', description: 'Filters and pattern rules' },
  { command: 'stop', description: 'Unsubscribe' },
];

export type LiveStats = () => StatusData['live'];

export class Bot implements Notifier {
  readonly client: TelegramClient;
  private offset = 0;
  private abort = new AbortController();
  private loop: Promise<void> | null = null;
  private readonly startedAt = Date.now();
  private liveStats: LiveStats = () => null;

  constructor(private db: Db, token: string) {
    this.client = new TelegramClient(token);
  }

  setLiveStats(fn: LiveStats): void {
    this.liveStats = fn;
  }

  async start(): Promise<void> {
    const me = await this.client.getMe();
    log.info({ username: me.username }, 'telegram bot connected');
    await this.client.setCommands(COMMANDS);
    this.loop = this.pollLoop();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop?.catch(() => undefined);
  }

  private handleBlocked(chatId: number, r: SendResult): void {
    if (r.status === 'blocked') {
      this.db.unsubscribe(chatId);
      log.info({ chatId }, 'chat blocked bot; unsubscribed');
    }
  }

  /** Chart photo + caption + buttons to every subscriber who hasn't muted this token. */
  async alert(p: AlertPayload): Promise<number> {
    const png = tryRenderChart(p);
    const caption = alertCaption(p.row, p.signal);
    const keyboard = alertKeyboard(p.alertId, p.row.token_address, p.row.pair_address);
    let delivered = 0;
    for (const chatId of this.db.activeSubscribers()) {
      if (this.db.isMuted(chatId, p.row.token_address)) continue;
      if (!this.wants(chatId, p.signal.pattern, p.signal.timeframe)) continue;
      let r = png ? await this.client.sendPhoto(chatId, png, caption, { keyboard }) : { status: 'error' as const };
      if (r.status === 'error') r = await this.client.send(chatId, caption, { keyboard }); // photo failed -> text
      if (r.status === 'ok') {
        delivered++;
        if (r.messageId) this.db.addAlertMessage(p.alertId, chatId, r.messageId);
      }
      this.handleBlocked(chatId, r);
    }
    return delivered;
  }

  /** Sudden-drop text alert to every subscriber who wants it on this timeframe and hasn't muted the token. */
  async dump(d: DumpPayload): Promise<number> {
    const html = dumpMessage(d);
    const keyboard = linksKeyboard(d.token.address, d.pairAddress);
    let delivered = 0;
    for (const chatId of this.db.activeSubscribers()) {
      if (this.db.isMuted(chatId, d.token.address)) continue;
      if (!this.wants(chatId, 'dump', d.timeframe)) continue;
      const r = await this.client.send(chatId, html, { keyboard });
      if (r.status === 'ok') delivered++;
      this.handleBlocked(chatId, r);
    }
    return delivered;
  }

  /** Replies under the original alert in every chat that received it. */
  async followUp(alertId: number, html: string): Promise<void> {
    for (const { chat_id, message_id } of this.db.alertMessages(alertId)) {
      const r = await this.client.send(chat_id, html, { replyTo: message_id });
      this.handleBlocked(chat_id, r);
    }
  }

  /** Effective preferences (missing = defaults: everything except the early "forming" heads-up). */
  private prefs(chatId: number): { patterns: string[]; timeframes: string[] } {
    const p = this.db.getPrefs(chatId);
    return { patterns: p.patterns ?? [...DEFAULT_PATTERNS], timeframes: p.timeframes ?? [...config.timeframes] };
  }

  private wants(chatId: number, pattern: string, timeframe: string): boolean {
    const p = this.prefs(chatId);
    return p.patterns.includes(pattern) && p.timeframes.includes(timeframe);
  }

  private panel(chatId: number) {
    return myAlertsPanel({ ...this.prefs(chatId), mutes: this.db.activeMutes(chatId) }, config.timeframes);
  }

  private async pollLoop(): Promise<void> {
    let failures = 0;
    while (!this.abort.signal.aborted) {
      try {
        const updates = await this.client.getUpdates(this.offset, config.telegram.pollTimeoutSec, this.abort.signal);
        failures = 0;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          const work = u.callback_query ? this.handleCallback(u.callback_query) : u.message?.text ? this.handle(u.message) : null;
          await work?.catch((err) => log.error({ err: errMsg(err) }, 'update handling failed'));
        }
      } catch (err) {
        if (this.abort.signal.aborted) break;
        failures++;
        const wait = Math.min(60_000, 1000 * 2 ** failures);
        log.warn({ err: errMsg(err), retryInMs: wait }, 'telegram polling error');
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  private async handle(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const text = msg.text!.trim();
    // "/cmd@BotName args" -> "/cmd"; menu buttons map to the same commands.
    const menuCmd: Record<string, string> = {
      [MENU.status]: '/status', [MENU.recent]: '/recent', [MENU.stats]: '/stats', [MENU.rules]: '/settings',
      [MENU.legacySettings]: '/settings', [MENU.myAlerts]: '/alerts', [MENU.help]: '/help',
    };
    const cmd = menuCmd[text] ?? text.split(/\s+/)[0].split('@')[0].toLowerCase();
    const reply = (html: string) => this.client.send(chatId, html, { replyKeyboard: menuKeyboard });

    switch (cmd) {
      case '/start':
        this.db.subscribe(chatId, msg.from?.username ?? msg.chat.username ?? null);
        log.info({ chatId }, 'subscribed');
        await reply(welcomeMessage(config));
        return;
      case '/stop':
        this.db.unsubscribe(chatId);
        log.info({ chatId }, 'unsubscribed');
        await this.client.send(chatId, '🔕 <b>Unsubscribed.</b> You won\'t get alerts anymore.\nSend /start any time to come back.');
        return;
      case '/status':
        await reply(statusMessage(this.statusData(chatId)));
        return;
      case '/settings':
      case '/rules':
        await reply(settingsMessage(config));
        return;
      case '/alerts': {
        const { html, keyboard } = this.panel(chatId);
        await this.client.send(chatId, html, { keyboard });
        return;
      }
      case '/help':
        await reply(helpMessage());
        return;
      case '/recent':
        await reply(recentMessage(this.db.recentAlerts(config.alerts.recentCount)));
        return;
      case '/stats':
        await reply(statsMessage(this.db.stats(), this.db.bestWorst(), this.db.statsBy()));
        return;
      default:
        await reply('Use the menu below 👇 or /start, /status, /recent, /stats, /settings, /stop.');
    }
  }

  private async handleCallback(q: TgCallbackQuery): Promise<void> {
    const [action, idStr] = (q.data ?? '').split(':');
    const chatId = q.message?.chat.id ?? q.from.id;

    // "My alerts" panel toggles: update prefs, then redraw the panel in place.
    if (action === 'tp' || action === 'tt' || action === 'all' || action === 'um') {
      const cur = this.prefs(chatId);
      const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
      let toast = '';
      if (action === 'tp' && (PATTERNS as readonly string[]).includes(idStr)) {
        const next = toggle(cur.patterns, idStr);
        this.db.setPrefs(chatId, PATTERNS.filter((p) => next.includes(p)), cur.timeframes);
        toast = `${PATTERN_NAME[idStr]} ${next.includes(idStr) ? 'on' : 'off'}`;
      } else if (action === 'tt' && (config.timeframes as readonly string[]).includes(idStr)) {
        const next = toggle(cur.timeframes, idStr);
        this.db.setPrefs(chatId, cur.patterns, config.timeframes.filter((t) => next.includes(t)));
        toast = `${idStr} ${next.includes(idStr) ? 'on' : 'off'}`;
      } else if (action === 'all') {
        this.db.setPrefs(chatId, [...PATTERNS], [...config.timeframes]);
        toast = 'All alerts on';
      } else if (action === 'um') {
        this.db.unmute(chatId, idStr);
        toast = 'Unmuted';
      }
      await this.client.answerCallback(q.id, toast);
      if (q.message) {
        const { html, keyboard } = this.panel(chatId);
        await this.client.editMessage(chatId, q.message.message_id, html, keyboard);
      }
      return;
    }

    const alert = this.db.getAlert(Number(idStr));
    if (!alert) {
      await this.client.answerCallback(q.id, 'That alert is no longer available.');
      return;
    }
    if (action === 'm') {
      this.db.mute(chatId, alert.token_address, Date.now() + 24 * 3_600_000);
      await this.client.answerCallback(q.id, `🔕 $${alert.symbol} muted for 24h. Undo in ${MENU.myAlerts}.`);
      return;
    }
    if (action === 'p') {
      let now: number | null = null;
      try {
        const pair = (await fetchBestPairs([alert.token_address], 15_000)).get(alert.token_address);
        now = pair ? Number(pair.priceUsd) || null : null;
      } catch {
        // fall through to error toast
      }
      if (!now) {
        await this.client.answerCallback(q.id, 'Price unavailable right now, try again in a minute.');
        return;
      }
      const chg = ((now - alert.price_at_alert) / alert.price_at_alert) * 100;
      const toT = ((alert.target - now) / now) * 100;
      const toS = ((alert.invalidation - now) / now) * 100;
      await this.client.answerCallback(
        q.id,
        `$${alert.symbol} now ${price(now)}\n${pct(chg)} since alert\n\n🎯 Target ${price(alert.target)} (${pct(toT)})\n🛑 Stop ${price(alert.invalidation)} (${pct(toS)})`,
        true,
      );
    }
  }

  private statusData(chatId: number): StatusData {
    const w = this.db.watchCounts();
    const kv = (k: string) => Number(this.db.getKv(k)) || undefined;
    const pr = this.prefs(chatId);
    return {
      subscribed: this.db.isSubscribed(chatId),
      myAlerts: `${pr.patterns.map((p) => PATTERN_NAME[p]).join(', ') || 'no patterns'} · ${pr.timeframes.join(', ') || 'no timeframes'}`,
      subscribers: this.db.activeSubscribers().length,
      uptimeMs: Date.now() - this.startedAt,
      pool: this.db.candidateCount(),
      marketPass: w.active ?? 0,
      rugPass: w.passed ?? 0,
      rugPending: w.pending ?? 0,
      live: this.liveStats(),
      lastDiscovery: kv('job:discovery:last'),
      lastScan: kv('job:scan:last'),
      lastLive: kv('job:live:last'),
      lastAlert: kv('alert:last'),
      alerts24h: this.db.alertsSince(Date.now() - 24 * 3_600_000),
      accuracy: this.db.getKv('job:live:accuracy'),
    };
  }
}
