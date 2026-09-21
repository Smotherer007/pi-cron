/**
 * The decision half of a tick, kept pure so it is testable without clocks,
 * processes or files: given all jobs and "now", which jobs start, which
 * missed slots are skipped, and which runs died without reporting back.
 *
 * Missed runs (machine asleep, rebooted, logged out): a recurring job whose
 * slot passed more than GRACE_MS ago runs ONCE if `catchUp` is set, never once
 * per missed slot, and is otherwise skipped to its next slot.
 */

import { nextRunAfter } from "./schedule.ts";
import type { CronJob, RunningInfo } from "./types.ts";

export const GRACE_MS = 2 * 60_000;

export interface TickPlan {
  readonly jobs: CronJob[];
  readonly due: CronJob[];
  readonly skipped: CronJob[];
  readonly crashed: CronJob[];
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function advance(job: CronJob, now: Date): string | null {
  const anchor = job.nextRunAt ? new Date(job.nextRunAt) : undefined;
  const next = nextRunAfter(job.schedule, now, anchor);
  return next ? next.toISOString() : null;
}

export function planTick(
  jobs: readonly CronJob[],
  now: Date,
  alive: (pid: number) => boolean = isProcessAlive,
  startMarker: RunningInfo = { pid: 0, startedAt: now.toISOString() },
): TickPlan {
  const out: CronJob[] = [];
  const due: CronJob[] = [];
  const skipped: CronJob[] = [];
  const crashed: CronJob[] = [];

  for (const original of jobs) {
    let job = original;

    if (job.running) {
      if (alive(job.running.pid)) {
        out.push(job);
        continue;
      }
      job = { ...job, running: null, lastStatus: "crashed" };
      crashed.push(job);
    }

    if (!job.enabled || !job.nextRunAt || new Date(job.nextRunAt).getTime() > now.getTime()) {
      out.push(job);
      continue;
    }

    const lateBy = now.getTime() - new Date(job.nextRunAt).getTime();
    const nextRunAt = advance(job, now);

    if (lateBy > GRACE_MS && !job.catchUp && job.schedule.kind !== "once") {
      job = { ...job, nextRunAt, lastStatus: "skipped" };
      skipped.push(job);
      out.push(job);
      continue;
    }

    job = { ...job, nextRunAt, running: startMarker };
    due.push(job);
    out.push(job);
  }

  return { jobs: out, due, skipped, crashed };
}
