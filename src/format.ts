/**
 * Pure text rendering for tool results and /cron output.
 */

import { describeSchedule, formatLocal } from "./core/schedule.ts";
import type { CronJob, RunRecord } from "./core/types.ts";

export function toolsLabel(tools: readonly string[] | null): string {
  if (tools === null) return "pi defaults";
  return tools.length ? tools.join(", ") : "none";
}

function when(iso: string | null): string {
  return iso ? formatLocal(new Date(iso)) : "-";
}

/** "active", "paused", "running", or "done": enabled but nothing left to run. */
export type JobState = "running" | "paused" | "done" | "active";

export function jobState(job: CronJob): JobState {
  if (job.running) return "running";
  if (!job.enabled) return "paused";
  return job.nextRunAt ? "active" : "done";
}

/** "from 2026-10-01 00:00 until 2026-12-31 23:59", or null without a window. */
export function windowLabel(job: Pick<CronJob, "startAt" | "endAt">): string | null {
  const from = job.startAt ? `from ${when(job.startAt)}` : null;
  const until = job.endAt ? `until ${when(job.endAt)}` : null;
  const parts = [from ?? (until ? "from now" : null), until].filter((p): p is string => p !== null);
  return parts.length ? parts.join(" ") : null;
}

export function formatJobLine(job: CronJob): string {
  const window = windowLabel(job);
  return [
    `• ${job.name} [${job.id}] ${jobState(job)} · ${describeSchedule(job.schedule)}`,
    `next ${when(job.nextRunAt)}`,
    `last ${job.lastStatus ?? "-"}`,
    window,
  ]
    .filter((p): p is string => Boolean(p))
    .join(" · ");
}

export function formatJobs(jobs: readonly CronJob[]): string {
  if (jobs.length === 0) return "No cron jobs yet. Create one with cron_create or /cron add.";
  return jobs.map(formatJobLine).join("\n");
}

export function formatJobDetail(job: CronJob): string {
  return [
    `${job.name} [${job.id}]`,
    `  status:   ${jobState(job)}${job.running ? ` (pid ${job.running.pid})` : ""}`,
    `  schedule: ${describeSchedule(job.schedule)}`,
    windowLabel(job) ? `  window:   ${windowLabel(job)}` : null,
    `  next run: ${when(job.nextRunAt)}`,
    `  last run: ${when(job.lastRunAt)} (${job.lastStatus ?? "-"}), ${job.runCount} run(s)`,
    `  tools:    ${toolsLabel(job.tools)}`,
    job.skills.length ? `  skills:   ${job.skills.join(", ")}` : null,
    job.model ? `  model:    ${job.model}` : null,
    `  cwd:      ${job.cwd}`,
    `  deliver:  file${job.deliver.length ? `, ${job.deliver.join(", ")}` : ""}`,
    `  catch-up: ${job.catchUp ? "yes" : "no"} · timeout ${job.timeoutMinutes} min`,
    `  prompt:   ${job.prompt.replace(/\n/g, "\n            ")}`,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export function formatRunLine(r: RunRecord): string {
  const secs = Math.round(r.durationMs / 1000);
  return `• ${formatLocal(new Date(r.finishedAt))} ${r.jobName}: ${r.status}${secs ? ` (${secs}s)` : ""}${r.error ? ` – ${r.error}` : ""}`;
}
