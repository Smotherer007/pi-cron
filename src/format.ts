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

export function formatJobLine(job: CronJob): string {
  const state = job.running ? "running" : job.enabled ? "active" : "paused";
  return `• ${job.name} [${job.id}] ${state} · ${describeSchedule(job.schedule)} · next ${when(job.nextRunAt)} · last ${job.lastStatus ?? "-"}`;
}

export function formatJobs(jobs: readonly CronJob[]): string {
  if (jobs.length === 0) return "No cron jobs yet. Create one with cron_create or /cron add.";
  return jobs.map(formatJobLine).join("\n");
}

export function formatJobDetail(job: CronJob): string {
  return [
    `${job.name} [${job.id}]`,
    `  status:   ${job.running ? `running (pid ${job.running.pid})` : job.enabled ? "active" : "paused"}`,
    `  schedule: ${describeSchedule(job.schedule)}`,
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
