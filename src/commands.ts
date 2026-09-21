/**
 * /cron slash command for doing things by hand:
 *
 *   /cron                   list jobs
 *   /cron add               create a job step by step
 *   /cron show <job>        details
 *   /cron run <job>         run now in the background
 *   /cron pause|resume <job>
 *   /cron remove <job>
 *   /cron results [job]     recent runs (+ latest output for one job)
 *   /cron status            scheduler state and next run
 *   /cron telegram <botToken> <chatId> | /cron webhook <url>
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { applyPatch, buildJob } from "./core/jobs.ts";
import { isLeaseLive, readLease } from "./core/lease.ts";
import { listRuns, markSeen, readOutput } from "./core/runs.ts";
import { describeSchedule, formatLocal } from "./core/schedule.ts";
import { findJob, loadConfig, loadJobs, mutateJobs, saveConfig } from "./core/store.ts";
import type { CronJob } from "./core/types.ts";
import { formatJobDetail, formatJobs, formatRunLine } from "./format.ts";
import { currentScheduler } from "./setup.ts";
import { checkTools } from "./tools.ts";

export const SUBCOMMANDS = [
  "list", "add", "show", "run", "pause", "resume", "remove", "results", "status", "telegram", "webhook",
] as const;

function show(pi: ExtensionAPI, content: string): void {
  pi.sendMessage({ customType: "pi-cron", content, display: true, details: {} });
}

function jobOrThrow(ref: string | undefined): CronJob {
  if (!ref) throw new Error("Which job? Pass a name or id.");
  const job = findJob(loadJobs(), ref);
  if (!job) throw new Error(`No cron job "${ref}"`);
  return job;
}

function setEnabled(ref: string | undefined, enabled: boolean): CronJob {
  const target = jobOrThrow(ref);
  const now = new Date();
  return mutateJobs((jobs) => {
    const current = jobs.find((j) => j.id === target.id) as CronJob;
    const updated = applyPatch(current, { enabled }, jobs, now);
    return { jobs: jobs.map((j) => (j.id === updated.id ? updated : j)), result: updated };
  });
}

async function addInteractive(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const name = await ctx.ui.input("Job name", "morning-inbox");
  if (!name) return;
  const schedule = await ctx.ui.input("When? (cron, \"every 2h\", \"weekdays 8:00\", \"in 30m\")", "weekdays 8:00");
  if (!schedule) return;
  const prompt = await ctx.ui.editor("Prompt the agent runs at that time", "");
  if (!prompt?.trim()) return;
  const active = pi.getActiveTools().join(",");
  const toolText = await ctx.ui.input("Tools (comma-separated; empty = pi defaults, \"none\" = no tools)", active);
  if (toolText === undefined) return;
  const trimmed = toolText.trim();
  const tools = trimmed === "" ? null : trimmed === "none" ? [] : trimmed.split(",").map((t) => t.trim()).filter(Boolean);
  checkTools(pi, tools);

  const now = new Date();
  const job = mutateJobs((jobs) => {
    const job = buildJob({ name, prompt, schedule, tools, cwd: ctx.cwd }, jobs, now, { deliver: loadConfig().defaultDeliver });
    return { jobs: [...jobs, job], result: job };
  });
  ctx.ui.notify(
    `Created "${job.name}" – ${describeSchedule(job.schedule)}, first run ${job.nextRunAt ? formatLocal(new Date(job.nextRunAt)) : "-"}`,
    "info",
  );
}

export function statusText(now: Date = new Date()): string {
  const scheduler = currentScheduler();
  const lease = readLease();
  const who = !isLeaseLive(lease, now)
    ? "no pi is scheduling right now"
    : lease?.pid === process.pid
      ? "this pi is scheduling"
      : `another pi (pid ${lease?.pid}) is scheduling`;
  const jobs = loadJobs();
  const next = jobs
    .filter((j) => j.enabled && j.nextRunAt)
    .sort((a, b) => (a.nextRunAt as string).localeCompare(b.nextRunAt as string))[0];
  const running = jobs.filter((j) => j.running).map((j) => j.name);
  return [
    `Scheduler: ${scheduler ? "active" : "inactive"} in this pi · ${who}`,
    `Jobs: ${jobs.length} (${jobs.filter((j) => j.enabled).length} active)${running.length ? ` · running: ${running.join(", ")}` : ""}`,
    next ? `Next: ${next.name} at ${formatLocal(new Date(next.nextRunAt as string))}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function handleCron(pi: ExtensionAPI, rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
  const [sub = "list", ...rest] = rawArgs.trim().split(/\s+/).filter(Boolean);
  const arg = rest.join(" ") || undefined;

  switch (sub) {
    case "list":
      show(pi, formatJobs(loadJobs()));
      return;
    case "add":
      await addInteractive(pi, ctx);
      return;
    case "show":
      show(pi, formatJobDetail(jobOrThrow(arg)));
      return;
    case "run": {
      const job = jobOrThrow(arg);
      const scheduler = currentScheduler();
      if (!scheduler) throw new Error("The scheduler is not active in this pi");
      if (job.running || !scheduler.runNow(job)) {
        ctx.ui.notify(`"${job.name}" is already running`, "warning");
        return;
      }
      ctx.ui.notify(`Started "${job.name}" – you get a notice when it is done`, "info");
      return;
    }
    case "pause":
    case "resume": {
      const job = setEnabled(arg, sub === "resume");
      ctx.ui.notify(`${job.name}: ${job.enabled ? `active, next ${formatLocal(new Date(job.nextRunAt as string))}` : "paused"}`, "info");
      return;
    }
    case "remove":
    case "delete": {
      const job = jobOrThrow(arg);
      const ok = await ctx.ui.confirm("Delete cron job?", `${job.name}: ${describeSchedule(job.schedule)}`);
      if (!ok) return;
      mutateJobs((jobs) => ({ jobs: jobs.filter((j) => j.id !== job.id), result: undefined }));
      ctx.ui.notify(`Deleted "${job.name}"`, "info");
      return;
    }
    case "results": {
      const job = arg ? jobOrThrow(arg) : undefined;
      const runs = listRuns(job?.id, 15);
      markSeen();
      if (runs.length === 0) {
        show(pi, "No runs yet.");
        return;
      }
      const latest = job ? runs.find((r) => r.outputPath) : undefined;
      show(pi, runs.map(formatRunLine).join("\n") + (latest ? `\n\n${readOutput(latest)}` : ""));
      return;
    }
    case "status":
      show(pi, statusText());
      return;
    case "telegram": {
      const [botToken, chatId] = rest;
      if (!botToken || !chatId) throw new Error("Usage: /cron telegram <botToken> <chatId>");
      saveConfig({ telegram: { botToken, chatId } });
      ctx.ui.notify("Telegram delivery configured. Add \"telegram\" to a job's deliver list.", "info");
      return;
    }
    case "webhook": {
      if (!arg) throw new Error("Usage: /cron webhook <url>");
      saveConfig({ webhookUrl: arg });
      ctx.ui.notify("Webhook configured. Add \"webhook\" to a job's deliver list.", "info");
      return;
    }
    default:
      throw new Error(`Unknown subcommand "${sub}". Try: ${SUBCOMMANDS.join(", ")}`);
  }
}
