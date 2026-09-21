/**
 * Runs one job: starts a headless pi (`pi -p`) with the job's prompt, tool
 * allowlist, skills and model, stores the answer, delivers it, and records
 * the result on the job.
 *
 * Each run is its own pi session (saved under sessions/<job>/), so runs never
 * share context with each other or with an interactive session.
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deliver } from "./delivery.ts";
import { paths, stamp } from "./paths.ts";
import { formatLocal } from "./schedule.ts";
import { isProcessAlive } from "./scheduler.ts";
import { findJob, loadConfig, mutateJobs, writeJsonAtomic } from "./store.ts";
import type { CronConfig, CronJob, RunRecord, RunStatus } from "./types.ts";

export function systemNote(job: CronJob, now: Date): string {
  return [
    `You are running unattended as the scheduled pi-cron job "${job.name}" (id ${job.id}), started ${formatLocal(now)}.`,
    "No user is present: do not ask questions or wait for confirmation; make reasonable assumptions and state them.",
    "Finish with a concise final answer. It is saved and delivered to the user as the result of this run.",
  ].join("\n");
}

/** argv for pi, without the command itself. Pure for testing. */
export function buildPiArgs(job: CronJob, now: Date): string[] {
  const args = ["-p", "--session-dir", paths.sessionsDir(job.id)];
  if (job.tools !== null) {
    if (job.tools.length === 0) args.push("--no-tools");
    else args.push("--tools", job.tools.join(","));
  }
  for (const skill of job.skills) args.push("--skill", skill);
  if (job.model) args.push("--model", job.model);
  args.push("--append-system-prompt", systemNote(job, now));
  args.push(job.prompt);
  return args;
}

export function buildEnv(config: CronConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // launchd/cron start with a bare PATH; use the one captured at install.
    PATH: config.path || process.env.PATH,
    ...config.env,
    PI_CRON: "1",
  };
}

interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly timedOut: boolean;
  readonly spawnError: string | null;
}

function runProcess(
  command: readonly string[],
  args: readonly string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; logFile: string },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const log = createWriteStream(opts.logFile, { flags: "a" });
    const chunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const finish = (r: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Resolve once stderr is flushed, so the log can be quoted in the output.
      log.end(() => resolve(r));
    };

    const child = spawn(command[0], [...command.slice(1), ...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => log.write(c));
    child.on("error", (err) => finish({ exitCode: null, stdout: "", timedOut: false, spawnError: err.message }));
    child.on("close", (code) =>
      finish({ exitCode: code, stdout: Buffer.concat(chunks).toString("utf8"), timedOut, spawnError: null }),
    );

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, opts.timeoutMs);
  });
}

function renderOutput(job: CronJob, status: RunStatus, started: Date, durationMs: number, body: string): string {
  const meta = [
    `# ${job.name}`,
    "",
    `- **Run:** ${formatLocal(started)} · ${status} · ${Math.round(durationMs / 1000)}s`,
    `- **Tools:** ${job.tools === null ? "pi defaults" : job.tools.length ? job.tools.join(", ") : "none"}`,
    `- **Job:** ${job.id}`,
    "",
    "---",
    "",
  ];
  return meta.join("\n") + (body.trim() || "_(no output)_") + "\n";
}

function stderrTail(logFile: string, lines = 20): string {
  if (!existsSync(logFile)) return "";
  const tail = readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  return tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : "";
}

export interface ExecuteResult {
  readonly record: RunRecord | null;
  readonly message: string;
}

export async function executeJob(jobRef: string, opts: { now?: () => Date } = {}): Promise<ExecuteResult> {
  const clock = opts.now ?? (() => new Date());
  const started = clock();

  // Claim the job. The tick already wrote our pid; a manual run claims here.
  const claimed = mutateJobs<CronJob | string>((jobs) => {
    const job = findJob(jobs, jobRef);
    if (!job) return { jobs, result: `No job "${jobRef}"` };
    if (job.running && job.running.pid !== process.pid && isProcessAlive(job.running.pid)) {
      return { jobs, result: `Job "${job.name}" is already running (pid ${job.running.pid})` };
    }
    const updated: CronJob = { ...job, running: { pid: process.pid, startedAt: started.toISOString() } };
    return { jobs: jobs.map((j) => (j.id === job.id ? updated : j)), result: updated };
  });
  if (typeof claimed === "string") return { record: null, message: claimed };
  const job = claimed;

  const config = loadConfig();
  const id = stamp(started);
  for (const dir of [paths.outputDir(job.id), paths.runsDir(job.id), paths.logsDir(job.id), paths.sessionsDir(job.id)]) {
    mkdirSync(dir, { recursive: true });
  }
  const logFile = join(paths.logsDir(job.id), `${id}.log`);
  const outputPath = join(paths.outputDir(job.id), `${id}.md`);

  let result: ProcessResult;
  if (!existsSync(job.cwd)) {
    result = { exitCode: null, stdout: "", timedOut: false, spawnError: `Working directory ${job.cwd} does not exist` };
  } else {
    result = await runProcess(config.piCommand, buildPiArgs(job, started), {
      cwd: job.cwd,
      env: buildEnv(config),
      timeoutMs: job.timeoutMinutes * 60_000,
      logFile,
    });
  }

  const finished = clock();
  const durationMs = finished.getTime() - started.getTime();
  const status: RunStatus = result.timedOut ? "timeout" : result.exitCode === 0 ? "ok" : "error";
  const error =
    result.spawnError ??
    (result.timedOut ? `Timed out after ${job.timeoutMinutes} min` : status === "error" ? `pi exited with code ${result.exitCode}; see ${logFile}` : null);

  const body = status === "ok" ? result.stdout : `${result.stdout}\n\n**Error:** ${error}${stderrTail(logFile)}`;
  writeFileSync(outputPath, renderOutput(job, status, started, durationMs, body));

  const delivery = await deliver(job, config, { status, body: result.stdout.trim() || (error ?? ""), outputPath, error });

  const record: RunRecord = {
    jobId: job.id,
    jobName: job.name,
    status,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs,
    exitCode: result.exitCode,
    outputPath,
    error,
    delivery,
  };
  writeJsonAtomic(join(paths.runsDir(job.id), `${id}.json`), record);

  mutateJobs((jobs) => ({
    jobs: jobs.map((j) =>
      j.id !== job.id
        ? j
        : {
            ...j,
            running: null,
            lastRunAt: started.toISOString(),
            lastStatus: status,
            lastOutputPath: outputPath,
            runCount: j.runCount + 1,
            // A one-shot job is done after it ran; keep it (paused) for its history.
            enabled: j.schedule.kind === "once" && j.nextRunAt === null ? false : j.enabled,
          },
    ),
    result: undefined,
  }));

  return { record, message: `${job.name}: ${status}` };
}
