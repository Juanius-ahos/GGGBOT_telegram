import WebSocket from 'ws';
import { errMsg } from '../lib/http.js';
import { logger } from '../logger.js';

const URL = 'wss://pumpportal.fun/api/data';
const log = logger.child({ src: 'pumpportal' });

/**
 * PumpPortal free websocket (no key): pump.fun graduations ("migrations") to PumpSwap.
 * Every token that leaves the bonding curve shows up here once, which feeds the candidate pool.
 */
export class PumpPortalStream {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry = 0;
  private timer: NodeJS.Timeout | null = null;
  migrations = 0;

  constructor(private onMigration: (mint: string) => void) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(URL);
    this.ws = ws;
    ws.on('open', () => {
      this.retry = 0;
      ws.send(JSON.stringify({ method: 'subscribeMigration' }));
      log.info('connected (migrations)');
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { mint?: string; txType?: string; message?: string };
        if (msg.mint && !msg.message) {
          this.migrations++;
          this.onMigration(msg.mint);
        }
      } catch {
        // ignore malformed frames
      }
    });
    ws.on('error', (err) => log.debug({ err: errMsg(err) }, 'ws error'));
    ws.on('close', () => {
      if (this.stopped) return;
      const wait = Math.min(60_000, 2000 * 2 ** this.retry++);
      log.warn({ retryInMs: wait }, 'disconnected; reconnecting');
      this.timer = setTimeout(() => this.connect(), wait);
    });
  }
}
