import pino from 'pino';
import { config } from './config.js';

const pretty = process.env.NODE_ENV !== 'production' && process.stdout.isTTY;

export const logger = pino({
  level: config.logLevel,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  // Never let the bot token leak into logs via URLs.
  redact: { paths: ['url', '*.url'], censor: (v) => (typeof v === 'string' ? v.replace(/bot\d+:[\w-]+/g, 'bot<redacted>') : v) },
  ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } } : {}),
});

export type Logger = typeof logger;
