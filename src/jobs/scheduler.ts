import { errMsg } from '../lib/http.js';
import { logger } from '../logger.js';

interface Job {
  name: string;
  intervalMs: number;
  fn: () => Promise<void>;
  timer?: NodeJS.Timeout;
  running?: Promise<void>;
}

/**
 * Runs each job on a fixed cadence without overlap: the next run is scheduled only after the
 * previous one finishes. Errors are logged, never thrown, so one bad API response can't kill the process.
 */
export class Scheduler {
  private jobs: Job[] = [];
  private stopped = false;

  add(name: string, intervalMs: number, fn: () => Promise<void>, initialDelayMs = 0): void {
    const job: Job = { name, intervalMs, fn };
    this.jobs.push(job);
    job.timer = setTimeout(() => this.tick(job), initialDelayMs);
  }

  private tick(job: Job): void {
    if (this.stopped) return;
    const started = Date.now();
    job.running = job
      .fn()
      .then(() => logger.debug({ job: job.name, ms: Date.now() - started }, 'job done'))
      .catch((err) => logger.error({ job: job.name, err: errMsg(err), stack: (err as Error)?.stack }, 'job failed'))
      .finally(() => {
        job.running = undefined;
        if (this.stopped) return;
        const delay = Math.max(1000, job.intervalMs - (Date.now() - started));
        job.timer = setTimeout(() => this.tick(job), delay);
      });
  }

  /** Stops scheduling and waits (up to `timeoutMs`) for in-flight jobs to finish. */
  async stop(timeoutMs = 20_000): Promise<void> {
    this.stopped = true;
    for (const j of this.jobs) clearTimeout(j.timer);
    const inflight = this.jobs.map((j) => j.running).filter(Boolean);
    if (inflight.length === 0) return;
    logger.info({ jobs: inflight.length }, 'waiting for running jobs');
    await Promise.race([Promise.allSettled(inflight), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  get isStopped(): boolean {
    return this.stopped;
  }
}
