import http from 'node:http';
import { errMsg } from './lib/http.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'health' });

/**
 * Tiny HTTP endpoint for hosts that require a web port (e.g. Render free web services) and for
 * uptime pingers. GET /health -> 200 with a JSON status; anything else -> 404.
 */
export function startHealthServer(port: number, status: () => Record<string, unknown>): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...status() }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, () => log.info({ port }, 'health endpoint listening'));
  return server;
}

/**
 * Hits our own public URL so the host sees inbound traffic and doesn't spin the service down.
 * An external pinger (e.g. cron-job.org) is still recommended: it can wake the service if it ever sleeps.
 */
export function startSelfPing(publicUrl: string, everyMs: number): NodeJS.Timeout {
  const url = `${publicUrl.replace(/\/$/, '')}/health`;
  return setInterval(() => {
    fetch(url, { signal: AbortSignal.timeout(20_000) }).catch((err) => log.debug({ err: errMsg(err) }, 'self-ping failed'));
  }, everyMs);
}
