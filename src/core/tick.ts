/**
 * One scheduling pass, run every minute by the scheduler loop inside pi.
 *
 * Under the lock it decides what is due (scheduler.planTick), hands each due
 * job to `launch` (which starts the run without awaiting it) and records the
 * owning pid, then returns. A slow job never delays the others or the next tick.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths, stamp } from "./paths.ts";
import { isProcessAlive, planTick } from "./scheduler.ts";
import { loadConfig, loadJobs, saveJobs, withLock, writeJsonAtomic } from "./store.ts";
import type { CronJob, RunRecord, RunStatus } from "./types.ts";

/** Starts a run in the background and returns the pid that owns it. */
export type Launcher = (job: CronJob) => number;

function recordNonRun(job: CronJob, status: RunStatus, now: Date, error: string): void {
  const record: RunRecord = {
    jobId: job.id,
    jobName: job.name,
    status,
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    durationMs: 0,
    exitCode: null,
    outputPath: null,
    error,
    delivery: {},
  };
  writeJsonAtomic(join(paths.runsDir(job.id), `${stamp(now)}-${status}.json`), record);
}

function killQuietly(pid: number): void {
  try {
    if (isProcessAlive(pid)) process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

export interface TickResult {
  readonly started: string[];
  readonly skipped: string[];
  readonly crashed: string[];
}

export function tick(now: Date, launch: Launcher): TickResult {
  const plan = withLock(() => {
    const plan = planTick(loadJobs(), now);
    const pids = new Map<string, number>();
    const failed = new Map<string, string>();
    for (const job of plan.due) {
      try {
        pids.set(job.id, launch(job));
      } catch (err) {
        failed.set(job.id, (err as Error).message);
      }
    }
    saveJobs(
      plan.jobs.map((j) => {
        if (pids.has(j.id)) return { ...j, running: { pid: pids.get(j.id) as number, startedAt: now.toISOString() } };
        if (failed.has(j.id)) return { ...j, running: null, lastStatus: "error" as const };
        return j;
      }),
    );
    return plan;
  });

  for (const job of plan.skipped) recordNonRun(job, "skipped", now, "Missed while the machine was off or asleep (catchUp disabled)");
  for (const job of plan.crashed) recordNonRun(job, "crashed", now, "pi ended during the run; started again");
  // A pi killed hard cannot stop its child; do it now so nothing keeps
  // running without pi.
  for (const pid of plan.orphanPids) killQuietly(pid);

  if (now.getMinutes() === 0) pruneRuns(now, loadConfig().keepRunsDays);

  return {
    started: plan.due.map((j) => j.name),
    skipped: plan.skipped.map((j) => j.name),
    crashed: plan.crashed.map((j) => j.name),
  };
}

/** Delete outputs, logs and run records older than `days`. */
export function pruneRuns(now: Date, days: number): number {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const root of ["runs", "output", "logs", "sessions"]) {
    const base = join(paths.runsRoot(), "..", root);
    if (!existsSync(base)) continue;
    for (const jobDir of readdirSync(base)) {
      const dir = join(base, jobDir);
      if (!statSync(dir).isDirectory()) continue;
      for (const file of readdirSync(dir)) {
        const full = join(dir, file);
        if (statSync(full).mtimeMs < cutoff) {
          rmSync(full, { recursive: true, force: true });
          removed++;
        }
      }
    }
  }
  return removed;
}
