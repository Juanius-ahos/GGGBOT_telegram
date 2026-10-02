import { errMsg, RateLimiter } from '../lib/http.js';
import { logger } from '../logger.js';

export interface TgMessage {
  message_id: number;
  chat: { id: number; type: string; username?: string; title?: string };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
}

export interface TgCallbackQuery {
  id: string;
  from: { id: number; username?: string };
  message?: { message_id: number; chat: { id: number } };
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export type InlineButton = { text: string; url: string } | { text: string; callback_data: string };
export type InlineKeyboard = InlineButton[][];
export interface ReplyKeyboard {
  keyboard: { text: string }[][];
  resize_keyboard: true;
  is_persistent?: boolean;
}

export interface SendOptions {
  keyboard?: InlineKeyboard;
  replyKeyboard?: ReplyKeyboard;
  replyTo?: number;
}

export interface SendResult {
  status: 'ok' | 'blocked' | 'error';
  messageId?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Minimal Bot API client (no SDK dependency). Telegram allows ~30 msgs/s globally; we stay at 20. */
export class TelegramClient {
  private readonly base: string;
  private readonly sendLimiter = new RateLimiter('telegram-send', 20 * 60);

  constructor(token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal, timeoutMs = 20_000): Promise<TgResponse<T>> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    return (await res.json()) as TgResponse<T>;
  }

  private async callMultipart<T>(method: string, form: FormData, timeoutMs = 30_000): Promise<TgResponse<T>> {
    const res = await fetch(`${this.base}/${method}`, { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
    return (await res.json()) as TgResponse<T>;
  }

  async getMe(): Promise<{ username: string }> {
    const r = await this.call<{ username: string }>('getMe');
    if (!r.ok || !r.result) throw new Error(`Telegram getMe failed: ${r.description ?? 'unknown error'}`);
    return r.result;
  }

  async getUpdates(offset: number, timeoutSec: number, signal: AbortSignal): Promise<TgUpdate[]> {
    const r = await this.call<TgUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] },
      signal,
      (timeoutSec + 15) * 1000,
    );
    if (!r.ok) {
      if (r.parameters?.retry_after) await sleep(r.parameters.retry_after * 1000);
      throw new Error(`getUpdates: ${r.error_code} ${r.description}`);
    }
    return r.result ?? [];
  }

  async setCommands(commands: { command: string; description: string }[]): Promise<void> {
    const r = await this.call('setMyCommands', { commands });
    if (!r.ok) logger.warn({ desc: r.description }, 'setMyCommands failed');
  }

  async answerCallback(id: string, text: string, showAlert = false): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: id, text: text.slice(0, 200), show_alert: showAlert }).catch(() => undefined);
  }

  private replyMarkup(o: SendOptions): unknown {
    if (o.keyboard) return { inline_keyboard: o.keyboard };
    if (o.replyKeyboard) return o.replyKeyboard;
    return undefined;
  }

  /** HTML text message. Retries on 429; 'blocked' when the user blocked the bot or the chat is gone. */
  send(chatId: number, html: string, o: SendOptions = {}): Promise<SendResult> {
    return this.withRetry(chatId, () =>
      this.call<{ message_id: number }>('sendMessage', {
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: this.replyMarkup(o),
        ...(o.replyTo ? { reply_parameters: { message_id: o.replyTo, allow_sending_without_reply: true } } : {}),
      }),
    );
  }

  /** Replace a message's text + inline keyboard in place (used by toggle panels). */
  async editMessage(chatId: number, messageId: number, html: string, keyboard?: InlineKeyboard): Promise<void> {
    const r = await this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    }).catch(() => null);
    // "message is not modified" is harmless (same state tapped twice).
    if (r && !r.ok && !/not modified/i.test(r.description ?? '')) logger.warn({ desc: r.description }, 'editMessageText failed');
  }

  /** PNG photo with an HTML caption (max 1024 chars). */
  sendPhoto(chatId: number, png: Buffer, captionHtml: string, o: SendOptions = {}): Promise<SendResult> {
    return this.withRetry(chatId, () => {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('photo', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'chart.png');
      form.append('caption', captionHtml);
      form.append('parse_mode', 'HTML');
      const markup = this.replyMarkup(o);
      if (markup) form.append('reply_markup', JSON.stringify(markup));
      return this.callMultipart<{ message_id: number }>('sendPhoto', form);
    });
  }

  private async withRetry(chatId: number, fn: () => Promise<TgResponse<{ message_id: number }>>): Promise<SendResult> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await this.sendLimiter.schedule(fn);
        if (r.ok) return { status: 'ok', messageId: r.result?.message_id };
        if (r.error_code === 429) {
          await sleep(((r.parameters?.retry_after ?? 2) + 1) * 1000);
          continue;
        }
        if (r.error_code === 403 || (r.error_code === 400 && /chat not found/i.test(r.description ?? ''))) return { status: 'blocked' };
        logger.warn({ chatId, code: r.error_code, desc: r.description }, 'telegram send failed');
        return { status: 'error' };
      } catch (err) {
        logger.warn({ chatId, err: errMsg(err), attempt }, 'telegram send network error');
        await sleep(2000 * 2 ** attempt);
      }
    }
    return { status: 'error' };
  }
}
