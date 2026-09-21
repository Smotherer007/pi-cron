/**
 * The scheduler, living inside an interactive pi process.
 *
 * - Starts with pi, stops with pi. Nothing runs while pi is closed.
 * - First pass right at start (catch-up of missed slots, re-runs of runs that
 *   were cut off), then one pass every minute, triggered by a node-cron task
 *   ("* * * * *": an in-process timer, no OS scheduler).
 * - Only the pi holding the lease schedules (lease.ts); others stay idle and
 *   take over if that pi quits.
 * - Runs are child processes of this pi. On quit they are aborted, recorded
 *   as "aborted" and become due again, so they run at the next start.
 */

import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { executeJob } from "./executor.ts";
import type { ExecuteResult } from "./executor.ts";
import { acquireLease, releaseLease } from "./lease.ts";
import { tick } from "./tick.ts";
import type { TickResult } from "./tick.ts";
import type { CronJob } from "./types.ts";

export interface SchedulerOptions {
  /** How to start a headless pi (usually the same pi that runs this code). */
  readonly piCommand: readonly string[];
  /** Called after every finished run (for an in-pi notification). */
  readonly onRunFinished?: (result: ExecuteResult) => void;
  readonly onError?: (err: unknown) => void;
  readonly now?: () => Date;
  readonly pid?: number;
}

export class CronScheduler {
  private readonly opts: SchedulerOptions;
  private readonly pid: number;
  private readonly clock: () => Date;
  private readonly aborter = new AbortController();
  private readonly active = new Map<string, Promise<ExecuteResult | null>>();
  private ticker: ScheduledTask | null = null;
  private stopped = false;
  private leader = false;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
    this.pid = opts.pid ?? process.pid;
    this.clock = opts.now ?? (() => new Date());
  }

  get isLeader(): boolean {
    return this.leader;
  }

  get runningJobIds(): string[] {
    return [...this.active.keys()];
  }

  start(): void {
    if (this.ticker || this.stopped) return;
    this.ticker = cron.schedule("* * * * *", () => this.safeTick(), {
      name: `pi-cron-${this.pid}`,
      noOverlap: true,
      // Never keep pi alive just for the scheduler.
      unref: true,
      // After sleep the missed minutes are caught up by our own logic.
      suppressMissedWarning: true,
    });
    // Catch up right away instead of waiting for the next full minute.
    setImmediate(() => this.safeTick());
  }

  private safeTick(): void {
    try {
      this.tickOnce();
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  /** One pass: take/renew the lease, then start whatever is due. */
  tickOnce(): TickResult | null {
    if (this.stopped) return null;
    this.leader = acquireLease(this.pid, this.clock());
    if (!this.leader) return null;
    return tick(this.clock(), (job) => {
      this.launch(job);
      return this.pid;
    });
  }

  /** Run a job now, regardless of its schedule. False if it is already running here. */
  runNow(job: CronJob): boolean {
    if (this.stopped || this.active.has(job.id)) return false;
    this.launch(job);
    return true;
  }

  private launch(job: CronJob): void {
    if (this.active.has(job.id)) return;
    // Deferred: tick() calls us while holding the jobs lock, and executeJob
    // takes that lock again synchronously.
    const run = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => executeJob(job.id, { piCommand: this.opts.piCommand, signal: this.aborter.signal }))
      .then((result) => {
        if (result.record) this.opts.onRunFinished?.(result);
        return result;
      })
      .catch((err: unknown) => {
        this.opts.onError?.(err);
        return null;
      })
      .finally(() => {
        this.active.delete(job.id);
      });
    this.active.set(job.id, run);
  }

  /** Stop scheduling, abort running jobs (they re-run next start), release the lease. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.ticker?.destroy();
    this.ticker = null;
    this.aborter.abort();
    await Promise.allSettled([...this.active.values()]);
    try {
      releaseLease(this.pid);
    } catch (err) {
      this.opts.onError?.(err);
    }
  }
}
