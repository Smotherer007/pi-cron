import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildJob } from "../src/core/jobs.ts";
import type { JobInput } from "../src/core/jobs.ts";
import type { CronJob } from "../src/core/types.ts";

/** Point PI_CRON_HOME at a fresh temp dir; returns a cleanup function. */
export function useTempHome(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-cron-test-"));
  process.env.PI_CRON_HOME = dir;
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Local-time date, independent of the machine's time zone. */
export function local(y: number, mo: number, d: number, h = 0, mi = 0): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

export function makeJob(overrides: Partial<JobInput> = {}, now = local(2026, 9, 21, 12, 0), extra: Partial<CronJob> = {}): CronJob {
  const job = buildJob(
    { name: "test-job", prompt: "Say hi", schedule: "every 1h", cwd: tmpdir(), ...overrides },
    [],
    now,
    { deliver: [] },
  );
  return { ...job, ...extra };
}
