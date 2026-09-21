/**
 * The decision half of a tick, kept pure so it is testable without clocks,
 * processes or files: given all jobs and "now", which jobs start, which
 * missed slots are skipped, and which runs died without reporting back.
 *
 * Missed slots (pi was closed, machine asleep): a recurring job whose slot
 * passed more than GRACE_MS ago runs ONCE if `catchUp` is set, never once per
 * missed slot, and is otherwise skipped to its next slot.
 *
 * Interrupted runs: a job still marked running by a process that no longer
 * exists (pi was killed mid-run) is recorded as crashed and runs again now.
 *
 * Windows (`startAt`/`endAt`): a slot outside them never becomes due, and a
 * run never starts after `endAt` — not even the repeat of an interrupted one.
 * Once nothing is left inside the window, the job keeps no next run and only
 * stays for its history.
 */

import { firstRun, nextRunAfter } from "./schedule.ts";
import type { CronJob, RunningInfo } from "./types.ts";

export const GRACE_MS = 2 * 60_000;

export interface TickPlan {
  readonly jobs: CronJob[];
  readonly due: CronJob[];
  readonly skipped: CronJob[];
  readonly crashed: CronJob[];
  /** Children of crashed runs that may still be alive as orphans. */
  readonly orphanPids: number[];
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
  const next = nextRunAfter(job.schedule, now, anchor, job);
  return next ? next.toISOString() : null;
}

/**
 * A window that opened or closed around the stored slot (a stale slot after an
 * outage, a hand-edited jobs.json, the repeat of an interrupted run): move the
 * slot into the window, or drop it when the window is gone. `null` means the
 * slot is fine.
 */
function fitWindow(job: CronJob, now: Date): CronJob | null {
  if (!job.enabled || !job.nextRunAt) return null;
  const at = new Date(job.nextRunAt).getTime();
  const start = job.startAt ? new Date(job.startAt).getTime() : null;
  const end = job.endAt ? new Date(job.endAt).getTime() : null;
  if (start !== null && at < start) {
    const first = firstRun(job.schedule, now, job);
    return { ...job, nextRunAt: first ? first.toISOString() : null };
  }
  // The slot lies past the window, or the window closed while it waited. The
  // last slot may start up to the grace period late, so a slot exactly at
  // `endAt` still fires.
  if (end !== null && (at > end || now.getTime() > end + GRACE_MS)) return { ...job, nextRunAt: null };
  return null;
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
  const orphanPids: number[] = [];

  for (const original of jobs) {
    let job = original;

    if (job.running) {
      if (alive(job.running.pid)) {
        out.push(job);
        continue;
      }
      if (job.running.childPid) orphanPids.push(job.running.childPid);
      // Run it again right away; a one-shot gets its slot back.
      const dueNow = !job.nextRunAt || new Date(job.nextRunAt).getTime() > now.getTime();
      job = { ...job, running: null, lastStatus: "crashed", nextRunAt: dueNow ? now.toISOString() : job.nextRunAt };
      crashed.push(job);
    }

    // Also holds back a repeat whose window has closed meanwhile.
    const fitted = fitWindow(job, now);
    if (fitted) {
      out.push(fitted);
      continue;
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

  return { jobs: out, due, skipped, crashed, orphanPids };
}
