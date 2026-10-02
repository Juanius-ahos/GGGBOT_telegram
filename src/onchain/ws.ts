import WebSocket from 'ws';
import { errMsg } from '../lib/http.js';
import { logger } from '../logger.js';

const log = logger.child({ mod: 'solana-ws' });

export interface AccountUpdate {
  slot: number;
  data: Buffer;
}

type Handler = (u: AccountUpdate) => void;

interface Sub {
  account: string;
  handler: Handler;
  subId?: number;
}

/** https RPC URL -> matching wss URL (works for the public endpoint and Helius-style ?api-key URLs). */
export function wsUrlFor(rpcUrl: string): string {
  return rpcUrl.replace(/^http/i, 'ws');
}

/**
 * accountSubscribe over one websocket, with automatic reconnect + resubscribe.
 * `onReconnect` fires after a dropped connection with the accounts that missed updates.
 */
class SolanaWs {
  private ws: WebSocket | null = null;
  private subs = new Map<string, Sub>(); // account -> sub
  private bySubId = new Map<number, Sub>();
  private pending = new Map<number, Sub>(); // request id -> sub
  private reqId = 0;
  private stopped = false;
  private retry = 0;
  private connectedOnce = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private openedAt = 0;
  /** Subscribe requests sent on the current socket (the server limit counts attempts). */
  attempts = 0;
  failedSubs = 0;

  constructor(private url: string, private onReconnect: (accounts: string[]) => void, readonly label: string) {}

  has(account: string): boolean {
    return this.subs.has(account);
  }

  get size(): number {
    return this.subs.size;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  subscribe(account: string, handler: Handler): void {
    if (this.subs.has(account)) return;
    const sub: Sub = { account, handler };
    this.subs.set(account, sub);
    if (this.connected) this.sendSubscribe(sub);
  }

  unsubscribe(account: string): void {
    const sub = this.subs.get(account);
    if (!sub) return;
    this.subs.delete(account);
    if (sub.subId !== undefined) {
      this.bySubId.delete(sub.subId);
      if (this.connected) this.send('accountUnsubscribe', [sub.subId]);
    }
  }

  private send(method: string, params: unknown[]): number {
    const id = ++this.reqId;
    this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return id;
  }

  private sendSubscribe(sub: Sub): void {
    this.attempts++;
    const id = this.send('accountSubscribe', [sub.account, { encoding: 'base64', commitment: 'confirmed' }]);
    this.pending.set(id, sub);
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on('open', () => {
      this.openedAt = Date.now();
      this.attempts = 0;
      this.bySubId.clear();
      this.pending.clear();
      for (const sub of this.subs.values()) {
        sub.subId = undefined;
        this.sendSubscribe(sub);
      }
      log.info({ conn: this.label, subscriptions: this.subs.size }, 'connected');
      if (this.connectedOnce) this.onReconnect([...this.subs.keys()]);
      this.connectedOnce = true;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.ping(), 30_000);
    });
    ws.on('message', (raw) => this.handle(raw.toString()));
    ws.on('error', (err) => log.debug({ err: errMsg(err) }, 'ws error'));
    ws.on('close', (code, reason) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.stopped) return;
      // Only a connection that stayed up a while resets the backoff, so a server that keeps
      // closing us right away gets exponentially fewer attempts instead of a tight loop.
      if (Date.now() - this.openedAt > 60_000) this.retry = 0;
      const wait = Math.min(60_000, 1000 * 2 ** this.retry++);
      log.warn({ conn: this.label, code, reason: reason.toString().slice(0, 120), retryInMs: wait }, 'disconnected; reconnecting');
      this.reconnectTimer = setTimeout(() => this.connect(), wait);
    });
  }

  private handle(raw: string): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message: string };
      method?: string;
      params?: { subscription: number; result: { context: { slot: number }; value: { data: [string, string] } | null } };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const sub = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (typeof msg.result === 'number' && this.subs.get(sub.account) === sub) {
        sub.subId = msg.result;
        this.bySubId.set(msg.result, sub);
      } else if (msg.error) {
        this.failedSubs++;
        log.warn({ account: sub.account, err: msg.error.message }, 'subscribe failed');
      }
      return;
    }
    if (msg.method !== 'accountNotification' || !msg.params) return;
    const sub = this.bySubId.get(msg.params.subscription);
    const value = msg.params.result?.value;
    if (!sub || !value?.data) return;
    try {
      sub.handler({ slot: msg.params.result.context.slot, data: Buffer.from(value.data[0], 'base64') });
    } catch (err) {
      log.debug({ err: errMsg(err) }, 'handler error');
    }
  }
}

/**
 * Spreads subscriptions over several connections. The public mainnet endpoint closes a socket at
 * 100 subscriptions ("Too many subscriptions attempted. Please open a new connection.", code 1013,
 * measured Oct 2026) and allows up to 40 connections per IP.
 */
export class SolanaWsPool {
  private conns: SolanaWs[] = [];
  private started = false;

  constructor(
    private url: string,
    private onReconnect: (accounts: string[]) => void,
    private perConnection = 90,
    private maxConnections = 30,
  ) {}

  get size(): number {
    return this.conns.reduce((n, c) => n + c.size, 0);
  }

  get connections(): number {
    return this.conns.length;
  }

  get connected(): boolean {
    return this.conns.length > 0 && this.conns.every((c) => c.connected);
  }

  start(): void {
    this.started = true;
    this.conns.forEach((c) => c.start());
  }

  stop(): void {
    this.started = false;
    this.conns.forEach((c) => c.stop());
  }

  /** Returns false when every connection is full (caller should fall back). */
  subscribe(account: string, handler: Handler): boolean {
    if (this.conns.some((c) => c.has(account))) return true;
    let conn = this.conns.find((c) => Math.max(c.size, c.attempts) < this.perConnection);
    if (!conn) {
      if (this.conns.length >= this.maxConnections) return false;
      conn = new SolanaWs(this.url, this.onReconnect, `ws${this.conns.length + 1}`);
      this.conns.push(conn);
      if (this.started) conn.start();
    }
    conn.subscribe(account, handler);
    return true;
  }

  unsubscribe(account: string): void {
    this.conns.find((c) => c.has(account))?.unsubscribe(account);
  }
}
