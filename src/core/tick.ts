/**
 * One scheduler tick, started every minute by launchd (macOS) or cron (Linux).
 *
 * Under the lock it decides what is due (scheduler.planTick), starts one
 * detached `runner.ts exec <id>` process per due job and records its pid, then
 * returns. The tick itself never waits for a run, so a slow job never delays
 * the others or the next tick.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths, stamp } from "./paths.ts";
import { planTick } from "./scheduler.ts";
import { loadConfig, loadJobs, saveJobs, withLock, writeJsonAtomic } from "./store.ts";
import type { CronJob, RunRecord, RunStatus } from "./types.ts";

export type Launcher = (job: CronJob) => number;

export function runnerScript(): string {
  return fileURLToPath(new URL("./runner.ts", import.meta.url));
}

/** Start `runner.ts exec <id>` detached; returns its pid. */
export const launchDetached: Launcher = (job) => {
  mkdirSync(paths.logsDir(job.id), { recursive: true });
  const out = openSync(join(paths.logsDir(job.id), "runner.log"), "a");
  const child = spawn(process.execPath, [runnerScript(), "exec", job.id], {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  if (!child.pid) throw new Error(`Could not start run for ${job.name}`);
  return child.pid;
};

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

export interface TickResult {
  readonly started: string[];
  readonly skipped: string[];
  readonly crashed: string[];
}

export function tick(now: Date = new Date(), launch: Launcher = launchDetached): TickResult {
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
  for (const job of plan.crashed) recordNonRun(job, "crashed", now, "Run process ended without reporting a result");

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
        if (file === "runner.log") continue;
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
