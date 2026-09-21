/**
 * Persistence for jobs.json and config.json.
 *
 * Writes are atomic (write temp file, rename) so a crash or a reboot in the
 * middle of a write never leaves a half-written file. Read-modify-write cycles
 * go through `mutateJobs`, which holds a directory lock: the extension (inside
 * pi) and the background runner may touch jobs.json at the same time.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cronHome, paths } from "./paths.ts";
import type { CronConfig, CronJob, JobsFile } from "./types.ts";

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;

export function ensureHome(): void {
  mkdirSync(cronHome(), { recursive: true });
}

export function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    // Never silently drop a user's jobs: keep the broken file for inspection.
    const backup = `${file}.corrupt-${Date.now()}`;
    renameSync(file, backup);
    throw new Error(`${file} is not valid JSON (moved to ${backup}): ${(err as Error).message}`);
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Directory-based mutex; mkdir is atomic on every filesystem we care about. */
export function withLock<T>(fn: () => T): T {
  ensureHome();
  const lock = paths.lock();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between mkdir and stat
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lock}`);
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function loadJobs(): CronJob[] {
  const file = readJson<JobsFile>(paths.jobs(), { version: 1, jobs: [] });
  return [...(file.jobs ?? [])];
}

export function saveJobs(jobs: readonly CronJob[]): void {
  const data: JobsFile = { version: 1, jobs };
  writeJsonAtomic(paths.jobs(), data);
}

/** Locked read-modify-write of jobs.json. */
export function mutateJobs<T>(fn: (jobs: CronJob[]) => { jobs: CronJob[]; result: T }): T {
  return withLock(() => {
    const { jobs, result } = fn(loadJobs());
    saveJobs(jobs);
    return result;
  });
}

export const DEFAULT_CONFIG: CronConfig = {
  piCommand: ["pi"],
  nodePath: "node",
  path: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  env: {},
  telegram: null,
  webhookUrl: null,
  defaultDeliver: ["notify"],
  keepRunsDays: 30,
};

export function loadConfig(): CronConfig {
  return { ...DEFAULT_CONFIG, ...readJson<Partial<CronConfig>>(paths.config(), {}) };
}

export function saveConfig(patch: Partial<CronConfig>): CronConfig {
  return withLock(() => {
    const next = { ...loadConfig(), ...patch };
    writeJsonAtomic(paths.config(), next);
    return next;
  });
}

/** Look a job up by id, exact name, or unique name prefix (case-insensitive). */
export function findJob(jobs: readonly CronJob[], ref: string): CronJob | undefined {
  const key = ref.trim().toLowerCase();
  const exact = jobs.find((j) => j.id === ref || j.name.toLowerCase() === key);
  if (exact) return exact;
  const prefixed = jobs.filter((j) => j.id.startsWith(ref) || j.name.toLowerCase().startsWith(key));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}
