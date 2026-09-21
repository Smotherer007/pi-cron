/**
 * LLM-callable tools. They let the agent turn "every weekday at 8, check my
 * inbox with email_fetch and summarise it" into a stored job:
 *
 *   cron_create   save prompt + schedule + tool allowlist
 *   cron_list     show jobs (or one job in detail)
 *   cron_update   change any field, pause/resume via `enabled`
 *   cron_delete   remove a job (its history stays on disk)
 *   cron_run      run a job now, in the background
 *   cron_results  recent runs and their output
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { DELIVERY_TARGETS, applyPatch, buildJob } from "./core/jobs.ts";
import type { JobPatch } from "./core/jobs.ts";
import { listRuns, readOutput } from "./core/runs.ts";
import { describeSchedule, formatLocal } from "./core/schedule.ts";
import { findJob, loadConfig, loadJobs, mutateJobs } from "./core/store.ts";
import type { CronJob, DeliveryTarget } from "./core/types.ts";
import { formatJobDetail, formatJobs, formatRunLine, toolsLabel } from "./format.ts";
import { ensureService, startRunNow } from "./setup.ts";

type Pi = Pick<ExtensionAPI, "getAllTools">;

function text(t: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: t }], details };
}

/** Unknown tool names would make every run fail; reject them up front. */
export function checkTools(pi: Pi, tools: readonly string[] | null | undefined): void {
  if (!tools || tools.length === 0) return;
  const known = new Set(pi.getAllTools().map((t) => t.name));
  const unknown = tools.filter((t) => !known.has(t));
  if (unknown.length) {
    throw new Error(`Unknown tool(s): ${unknown.join(", ")}. Available: ${[...known].sort().join(", ")}`);
  }
}

function requireJob(jobs: readonly CronJob[], ref: string): CronJob {
  const job = findJob(jobs, ref);
  if (!job) throw new Error(`No cron job "${ref}". Existing: ${jobs.map((j) => j.name).join(", ") || "none"}`);
  return job;
}

const scheduleHelp =
  'When to run, in the user\'s local time. Cron ("0 8 * * 1-5"), interval ("every 30m", "every 2h"), ' +
  'one-shot ("in 20m", "2026-10-01T09:00") or "daily 9:00", "weekdays 8:30", "mon,fri 17:00".';

const toolsParam = Type.Optional(
  Type.Array(Type.String(), {
    description:
      "Tool allowlist for the run, e.g. [\"read\",\"bash\",\"email_fetch\"]. Omit for pi's default tools; [] for no tools. " +
      "Only list tools the task needs.",
  }),
);

const deliverParam = Type.Optional(
  Type.Array(StringEnum(DELIVERY_TARGETS as DeliveryTarget[]), {
    description: "Extra delivery besides the saved Markdown file: notify (desktop), telegram, webhook.",
  }),
);

export interface ToolDeps {
  readonly ensureService: typeof ensureService;
  readonly startRunNow: typeof startRunNow;
}

export function createCronTools(pi: Pi, deps: ToolDeps = { ensureService, startRunNow }) {
  const cronCreate = {
    name: "cron_create",
    label: "Create Cron Job",
    description:
      "Save a prompt as a scheduled job. At each due time a fresh, unattended pi session runs the prompt with only the listed tools; " +
      "the answer is saved and delivered. Jobs persist across restarts and run even when pi is closed.",
    promptSnippet: "Schedule a prompt with a tool allowlist as a recurring or one-shot cron job",
    promptGuidelines: [
      "Use cron_create when the user wants something done later or repeatedly (\"every morning\", \"each Friday\", \"in 2 hours\").",
      "Write the cron_create prompt as a complete, self-contained instruction: the run has no memory of this conversation.",
      "Give cron_create the smallest tool list the task needs, and check with cron_list before creating a duplicate.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Short unique name, e.g. \"morning-inbox\"" }),
      prompt: Type.String({ description: "Self-contained instruction the agent receives at run time" }),
      schedule: Type.String({ description: scheduleHelp }),
      tools: toolsParam,
      skills: Type.Optional(Type.Array(Type.String(), { description: "Skill paths to load for the run" })),
      model: Type.Optional(Type.String({ description: "Model pattern for the run, e.g. \"sonnet\"; default is pi's default" })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the run; defaults to the current one" })),
      deliver: deliverParam,
      catchUp: Type.Optional(Type.Boolean({ description: "Run a missed slot once after sleep/reboot (default true)" })),
      timeoutMinutes: Type.Optional(Type.Number({ description: "Abort a run after this many minutes (default 30)" })),
    }),
    async execute(
      _id: string,
      params: {
        name: string;
        prompt: string;
        schedule: string;
        tools?: string[];
        skills?: string[];
        model?: string;
        cwd?: string;
        deliver?: DeliveryTarget[];
        catchUp?: boolean;
        timeoutMinutes?: number;
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      checkTools(pi, params.tools);
      const now = new Date();
      const defaults = { deliver: loadConfig().defaultDeliver };
      const job = mutateJobs((jobs) => {
        const job = buildJob({ ...params, cwd: params.cwd ?? ctx.cwd }, jobs, now, defaults);
        return { jobs: [...jobs, job], result: job };
      });
      let note = "";
      try {
        const service = deps.ensureService();
        if (service.installedNow) note = `\nBackground service installed (${service.status.detail}).`;
      } catch (err) {
        note = `\nWARNING: the job is saved but the background service could not be installed: ${(err as Error).message}`;
      }
      return text(
        `Created "${job.name}" – ${describeSchedule(job.schedule)}, first run ${job.nextRunAt ? formatLocal(new Date(job.nextRunAt)) : "-"}, tools: ${toolsLabel(job.tools)}.${note}`,
        { job },
      );
    },
  };

  const cronList = {
    name: "cron_list",
    label: "List Cron Jobs",
    description: "List all scheduled jobs, or show one job in full (prompt, tools, schedule, next run).",
    parameters: Type.Object({
      job: Type.Optional(Type.String({ description: "Job name or id for details" })),
    }),
    async execute(_id: string, params: { job?: string }) {
      const jobs = loadJobs();
      if (params.job) {
        const job = requireJob(jobs, params.job);
        return text(formatJobDetail(job), { jobs: [job] });
      }
      return text(formatJobs(jobs), { jobs });
    },
  };

  const cronUpdate = {
    name: "cron_update",
    label: "Update Cron Job",
    description: "Change a job's prompt, schedule, tools, model, delivery or name. Set enabled=false to pause, true to resume.",
    parameters: Type.Object({
      job: Type.String({ description: "Job name or id" }),
      name: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
      schedule: Type.Optional(Type.String({ description: scheduleHelp })),
      tools: Type.Optional(
        Type.Union([Type.Array(Type.String()), Type.Null()], { description: "New allowlist; null restores pi's defaults" }),
      ),
      skills: Type.Optional(Type.Array(Type.String())),
      model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      cwd: Type.Optional(Type.String()),
      deliver: deliverParam,
      enabled: Type.Optional(Type.Boolean({ description: "false pauses, true resumes" })),
      catchUp: Type.Optional(Type.Boolean()),
      timeoutMinutes: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: { job: string } & JobPatch) {
      const { job: ref, ...patch } = params;
      if (patch.tools) checkTools(pi, patch.tools);
      const now = new Date();
      const job = mutateJobs((jobs) => {
        const current = requireJob(jobs, ref);
        const updated = applyPatch(current, patch, jobs, now);
        return { jobs: jobs.map((j) => (j.id === current.id ? updated : j)), result: updated };
      });
      return text(`Updated.\n${formatJobDetail(job)}`, { job });
    },
  };

  const cronDelete = {
    name: "cron_delete",
    label: "Delete Cron Job",
    description: "Delete a scheduled job. Past outputs stay on disk.",
    parameters: Type.Object({ job: Type.String({ description: "Job name or id" }) }),
    async execute(_id: string, params: { job: string }) {
      const job = mutateJobs((jobs) => {
        const job = requireJob(jobs, params.job);
        return { jobs: jobs.filter((j) => j.id !== job.id), result: job };
      });
      return text(`Deleted "${job.name}".`, { job });
    },
  };

  const cronRun = {
    name: "cron_run",
    label: "Run Cron Job Now",
    description: "Run a job immediately in the background, without changing its schedule. Check cron_results afterwards.",
    parameters: Type.Object({ job: Type.String({ description: "Job name or id" }) }),
    async execute(_id: string, params: { job: string }) {
      const job = requireJob(loadJobs(), params.job);
      if (job.running) return text(`"${job.name}" is already running (pid ${job.running.pid}).`, { job });
      deps.ensureService();
      const pid = deps.startRunNow(job);
      return text(`Started "${job.name}" in the background (pid ${pid}). Use cron_results to see the output.`, { job, pid });
    },
  };

  const cronResults = {
    name: "cron_results",
    label: "Cron Results",
    description: "Show recent runs (status, duration, errors) and the output of the latest run of a job.",
    parameters: Type.Object({
      job: Type.Optional(Type.String({ description: "Job name or id; omit for all jobs" })),
      limit: Type.Optional(Type.Number({ description: "How many runs to list (default 10)" })),
    }),
    async execute(_id: string, params: { job?: string; limit?: number }) {
      const job = params.job ? requireJob(loadJobs(), params.job) : undefined;
      const runs = listRuns(job?.id, params.limit ?? 10);
      if (runs.length === 0) return text(job ? `"${job.name}" has not run yet.` : "No runs yet.", { runs });
      const list = runs.map(formatRunLine).join("\n");
      const latest = runs.find((r) => r.outputPath);
      const body = job && latest ? `${list}\n\nLatest output:\n\n${readOutput(latest)}` : list;
      return text(body, { runs });
    },
  };

  return { cronCreate, cronList, cronUpdate, cronDelete, cronRun, cronResults };
}
