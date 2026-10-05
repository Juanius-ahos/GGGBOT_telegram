import { describe, expect, it } from 'vitest';
import { Bot } from '../src/bot/index.js';
import { myAlertsPanel } from '../src/bot/format.js';
import { openDb } from '../src/db/index.js';

/** Bot wired to an in-memory DB with Telegram calls captured instead of sent. */
function harness() {
  const db = openDb(':memory:');
  const bot = new Bot(db, 'TEST');
  const sent: { kind: string; chatId: number; text?: string; keyboard?: unknown }[] = [];
  const c = bot.client as unknown as Record<string, unknown>;
  c.send = async (chatId: number, text: string, o: { keyboard?: unknown } = {}) => (sent.push({ kind: 'send', chatId, text, keyboard: o.keyboard }), { status: 'ok', messageId: sent.length });
  c.sendPhoto = async (chatId: number) => (sent.push({ kind: 'photo', chatId }), { status: 'ok', messageId: sent.length });
  c.editMessage = async (chatId: number, _m: number, text: string, keyboard: unknown) => void sent.push({ kind: 'edit', chatId, text, keyboard });
  c.answerCallback = async (_id: string, text: string) => void sent.push({ kind: 'toast', chatId: 0, text });
  const b = bot as unknown as { handle(m: unknown): Promise<void>; handleCallback(q: unknown): Promise<void> };
  const tap = (chatId: number, data: string) => b.handleCallback({ id: 'q', from: { id: chatId }, message: { message_id: 1, chat: { id: chatId } }, data });
  const say = (chatId: number, text: string) => b.handle({ message_id: 1, chat: { id: chatId, type: 'private' }, text });
  return { db, bot, sent, tap, say };
}

const alertPayload = (pattern: 'double_bottom' | 'hammer', timeframe: '5m' | '15m' | '1h' | '4h') =>
  ({
    alertId: 1,
    row: { token_address: 'TOKEN', symbol: 'T', name: 'T', pair_address: 'PAIR', price_at_alert: 1, market_cap: 1, liquidity_usd: 1, first_low: 1, second_low: 1, neckline: 1, breakout_price: 1, invalidation: 0.9, target: 1.2, pattern, timeframe },
    signal: { pattern, timeframe, volumeRatio: 2, entry: 1, target: 1.2, invalidation: 0.9 },
    candles: [],
  }) as never;

describe('My alerts preferences', () => {
  it('defaults to breakouts + drops only, toggles in place, and filters alerts', async () => {
    const { db, bot, sent, tap, say } = harness();
    await say(1, '/start');
    await say(2, '/start');

    await say(1, '🔔 My alerts');
    const panel = sent.at(-1)!;
    expect(panel.text).toContain('<b>Patterns:</b> Double bottom, Sudden drop\n'); // hammers + early alerts are opt-in
    expect(panel.text).toContain('15m, 1h, 4h');

    await tap(1, 'tt:15m'); // chat 1: 15m off
    expect(sent.filter((s) => s.kind === 'edit').at(-1)!.text).toContain('<b>Patterns:</b> Double bottom, Sudden drop');
    expect(db.getPrefs(1)).toEqual({ patterns: ['double_bottom', 'dump'], timeframes: ['5m', '1h', '4h'] });

    sent.length = 0;
    await bot.alert(alertPayload('hammer', '1h'));
    expect(sent.filter((s) => s.kind !== 'toast').map((s) => s.chatId)).toEqual([]); // hammers are opt-in: nobody by default
    sent.length = 0;
    await bot.alert(alertPayload('double_bottom', '15m'));
    expect(sent.map((s) => s.chatId)).toEqual([2]); // chat 1 opted out of 15m
    sent.length = 0;
    await bot.alert(alertPayload('double_bottom', '4h'));
    expect(sent.map((s) => s.chatId).sort()).toEqual([1, 2]);

    await tap(1, 'all:on');
    expect(db.getPrefs(1)).toEqual({ patterns: ['double_bottom', 'hammer', 'db_forming', 'dump'], timeframes: ['5m', '15m', '1h', '4h'] });
  });

  it('warns when everything is switched off', async () => {
    const { sent, tap, say } = harness();
    await say(1, '/start');
    await tap(1, 'tp:double_bottom');
    await tap(1, 'tp:dump'); // hammers and early alerts are already off by default
    expect(sent.filter((s) => s.kind === 'edit').at(-1)!.text).toContain("You'll get no alerts");
  });

  it('lists mutes and unmutes from the panel', async () => {
    const { db, sent, tap, say } = harness();
    await say(1, '/start');
    db.mute(1, 'So1MuTeDtOkEnAddRess1111111111111111111111', Date.now() + 3_600_000);
    await say(1, '/alerts');
    expect(sent.at(-1)!.text).toContain('Muted');
    await tap(1, 'um:So1MuTeDtOkEnAddRess1111111111111111111111');
    expect(db.activeMutes(1)).toEqual([]);
  });

  it("keeps every callback_data within Telegram's 64-byte limit", () => {
    const { keyboard } = myAlertsPanel(
      { patterns: ['double_bottom'], timeframes: ['1h'], mutes: [{ token_address: 'A'.repeat(44), until: Date.now() + 1000, symbol: 'X' }] },
      ['15m', '1h', '4h'],
    );
    for (const row of keyboard) for (const b of row) if ('callback_data' in b) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  });

  it('old "Settings" keyboard button still works', async () => {
    const { sent, say } = harness();
    await say(1, '⚙️ Settings');
    expect(sent.at(-1)!.text).toContain('Settings');
  });
});

describe('update announcement', () => {
  it('goes to every active subscriber once, never again (even after a restart on the same database)', async () => {
    const { db, bot, sent, say } = harness();
    await say(1, '/start');
    await say(2, '/start');
    await say(3, '/start');
    await say(3, '/stop');
    sent.length = 0;
    expect(await bot.announceOnce()).toBe(2);
    expect(sent.map((s) => s.chatId).sort()).toEqual([1, 2]);
    expect(sent[0].text).toContain('Faster breakouts');
    expect(sent[0].text).toContain('No late alerts');
    sent.length = 0;
    expect(await new Bot(db, 'TEST').announceOnce()).toBeNull(); // a restarted bot sees it was already sent
    expect(await bot.announceOnce()).toBeNull();
    expect(sent).toHaveLength(0);
  });
});
