/**
 * Glue between pi and the scheduler: how to start a headless pi for a run,
 * and the one scheduler instance per pi process.
 *
 * The instance is kept on globalThis so it survives /reload and session
 * switches (/new, /resume, /fork) without aborting runs; it is stopped only
 * when pi quits.
 */

import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { CronScheduler } from "./core/loop.ts";
import type { SchedulerOptions } from "./core/loop.ts";

function isExecutable(file: string): boolean {
  try {
    accessSync(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Minimal cross-platform `which` (honours PATHEXT on Windows). */
export function which(
  name: string,
  pathEnv: string = process.env.PATH ?? process.env.Path ?? "",
  platform: NodeJS.Platform = process.platform,
): string | null {
  const exts =
    platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase())] : [""];
  for (const dir of pathEnv.split(platform === "win32" ? ";" : delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, name + ext);
      if (existsSync(full) && isExecutable(full)) return full;
    }
  }
  return null;
}

export function isNodeBinary(execPath: string): boolean {
  // Both separators: a Windows execPath is also recognised when the check runs
  // on macOS or Linux, where node:path would not split on a backslash.
  return /^node(\d+)?(\.exe)?$/i.test(basename(execPath.replaceAll("\\", "/")));
}

/**
 * How to start a headless pi: the very pi that is running, i.e. this Node and
 * this CLI script. That works on every OS and needs no `pi` shim on PATH
 * (pi.cmd on Windows, nvm/fnm shims). A compiled pi binary is its own
 * interpreter.
 */
export function detectPiCommand(execPath = process.execPath, argv1 = process.argv[1]): string[] {
  if (isNodeBinary(execPath) && argv1 && existsSync(argv1)) return [execPath, realpathSync(argv1)];
  if (!isNodeBinary(execPath)) return [execPath];
  const pi = which("pi");
  return pi ? [pi] : ["pi"];
}

const KEY = Symbol.for("pi-cron.scheduler");
const NOTIFY = Symbol.for("pi-cron.notify");
type Notify = (message: string, level: "info" | "warning" | "error") => void;
type Holder = { [KEY]?: CronScheduler; [NOTIFY]?: Notify };

/**
 * Where finished-run notices go: the UI of the current session. Updated on
 * every session start, so it follows /new and /resume.
 */
export function setNotifier(fn: Notify | undefined): void {
  (globalThis as Holder)[NOTIFY] = fn;
}

export function notify(message: string, level: "info" | "warning" | "error" = "info"): void {
  try {
    (globalThis as Holder)[NOTIFY]?.(message, level);
  } catch {
    // a stale UI must never break the scheduler
  }
}

export function currentScheduler(): CronScheduler | null {
  return (globalThis as Holder)[KEY] ?? null;
}

/** Start the scheduler for this pi process (idempotent). */
export function startScheduler(opts: Omit<SchedulerOptions, "piCommand"> & { piCommand?: readonly string[] }): CronScheduler {
  const existing = currentScheduler();
  if (existing) return existing;
  const scheduler = new CronScheduler({ ...opts, piCommand: opts.piCommand ?? detectPiCommand() });
  (globalThis as Holder)[KEY] = scheduler;
  scheduler.start();
  return scheduler;
}

/** Stop it when pi quits: aborts runs (they re-run next start), releases the lease. */
export async function stopScheduler(): Promise<void> {
  const scheduler = currentScheduler();
  if (!scheduler) return;
  delete (globalThis as Holder)[KEY];
  await scheduler.stop();
}
