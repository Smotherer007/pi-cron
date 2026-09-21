/**
 * Pure job operations: build, validate and update job records.
 * No I/O here; callers persist the result with store.mutateJobs.
 */

import { randomBytes } from "node:crypto";
import { firstRun, formatLocal, parseInstant, parseSchedule } from "./schedule.ts";
import type { CronJob, DeliveryTarget, RunWindow } from "./types.ts";

export const DELIVERY_TARGETS: readonly DeliveryTarget[] = ["notify", "telegram", "webhook"];

export interface JobInput {
  readonly name: string;
  readonly prompt: string;
  readonly schedule: string;
  readonly tools?: readonly string[] | null;
  readonly skills?: readonly string[];
  readonly model?: string | null;
  readonly cwd: string;
  readonly deliver?: readonly DeliveryTarget[];
  readonly enabled?: boolean;
  readonly catchUp?: boolean;
  readonly timeoutMinutes?: number;
  /** Do not run before this local time ("2026-10-01" or "2026-10-01 09:00"); `null` = no limit. */
  readonly startAt?: string | null;
  /** Do not run after this local time; the job ends there. `null` = no limit. */
  readonly endAt?: string | null;
}

export type JobPatch = Partial<Omit<JobInput, "cwd">> & { readonly cwd?: string };

export function newJobId(): string {
  return randomBytes(4).toString("hex");
}

function cleanList(list: readonly string[] | null | undefined): string[] | null {
  if (list === null || list === undefined) return null;
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))];
}

function checkDeliver(deliver: readonly string[]): DeliveryTarget[] {
  for (const d of deliver) {
    if (!DELIVERY_TARGETS.includes(d as DeliveryTarget)) {
      throw new Error(`Unknown delivery target "${d}". Use: ${DELIVERY_TARGETS.join(", ")}`);
    }
  }
  return [...new Set(deliver)] as DeliveryTarget[];
}

function checkName(name: string, others: readonly CronJob[]): string {
  const n = name.trim();
  if (!n) throw new Error("Job name is required");
  if (others.some((j) => j.name.toLowerCase() === n.toLowerCase())) {
    throw new Error(`A job named "${n}" already exists`);
  }
  return n;
}

/**
 * Validate a job's window and normalise it to ISO timestamps. `given` says
 * which end the caller actually supplied, so editing one end of a long-gone
 * window does not fail on the other, stored one.
 */
function checkWindow(
  rawStart: string | null | undefined,
  rawEnd: string | null | undefined,
  now: Date,
  given: { start: boolean; end: boolean } = { start: true, end: true },
): RunWindow {
  const start = parseInstant(rawStart, now);
  const end = parseInstant(rawEnd, now);
  if (given.start && rawStart && !start) throw new Error(`Cannot understand startAt "${rawStart}"; use "2026-10-01" or "2026-10-01 09:00"`);
  if (given.end && rawEnd && !end) throw new Error(`Cannot understand endAt "${rawEnd}"; use "2026-10-01" or "2026-10-01 09:00"`);
  if (start && end && end.getTime() <= start.getTime()) {
    throw new Error(`endAt (${formatLocal(end)}) must be after startAt (${formatLocal(start)})`);
  }
  if (given.end && end && end.getTime() <= now.getTime()) throw new Error(`endAt (${formatLocal(end)}) is in the past`);
  return { startAt: start ? start.toISOString() : null, endAt: end ? end.toISOString() : null };
}

export function buildJob(
  input: JobInput,
  existing: readonly CronJob[],
  now: Date,
  defaults: { deliver: readonly DeliveryTarget[] },
): CronJob {
  if (!input.prompt.trim()) throw new Error("Prompt is required");
  const schedule = parseSchedule(input.schedule, now);
  const window = checkWindow(input.startAt, input.endAt, now);
  const next = firstRun(schedule, now, window);
  const iso = now.toISOString();
  return {
    id: newJobId(),
    name: checkName(input.name, existing),
    prompt: input.prompt.trim(),
    schedule,
    tools: input.tools === undefined ? null : cleanList(input.tools),
    skills: cleanList(input.skills) ?? [],
    model: input.model?.trim() || null,
    cwd: input.cwd,
    deliver: checkDeliver(input.deliver ?? defaults.deliver),
    enabled: input.enabled ?? true,
    catchUp: input.catchUp ?? true,
    timeoutMinutes: clampTimeout(input.timeoutMinutes ?? 30),
    startAt: window.startAt,
    endAt: window.endAt,
    createdAt: iso,
    updatedAt: iso,
    nextRunAt: next ? next.toISOString() : null,
    lastRunAt: null,
    lastStatus: null,
    lastOutputPath: null,
    runCount: 0,
    running: null,
  };
}

function clampTimeout(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("timeoutMinutes must be > 0");
  return Math.min(Math.round(minutes), 24 * 60);
}

export function applyPatch(job: CronJob, patch: JobPatch, others: readonly CronJob[], now: Date): CronJob {
  let next: CronJob = { ...job, updatedAt: now.toISOString() };
  if (patch.name !== undefined && patch.name.trim() !== job.name) {
    next = { ...next, name: checkName(patch.name, others.filter((j) => j.id !== job.id)) };
  }
  if (patch.prompt !== undefined) {
    if (!patch.prompt.trim()) throw new Error("Prompt is required");
    next = { ...next, prompt: patch.prompt.trim() };
  }
  if (patch.tools !== undefined) next = { ...next, tools: cleanList(patch.tools) };
  if (patch.skills !== undefined) next = { ...next, skills: cleanList(patch.skills) ?? [] };
  if (patch.model !== undefined) next = { ...next, model: patch.model?.trim() || null };
  if (patch.cwd !== undefined) next = { ...next, cwd: patch.cwd };
  if (patch.deliver !== undefined) next = { ...next, deliver: checkDeliver(patch.deliver) };
  if (patch.catchUp !== undefined) next = { ...next, catchUp: patch.catchUp };
  if (patch.timeoutMinutes !== undefined) next = { ...next, timeoutMinutes: clampTimeout(patch.timeoutMinutes) };
  if (patch.startAt !== undefined || patch.endAt !== undefined) {
    const window = checkWindow(
      patch.startAt !== undefined ? patch.startAt : next.startAt,
      patch.endAt !== undefined ? patch.endAt : next.endAt,
      now,
      { start: patch.startAt !== undefined, end: patch.endAt !== undefined },
    );
    next = { ...next, ...window };
  }

  const scheduleChanged = patch.schedule !== undefined;
  const windowChanged = patch.startAt !== undefined || patch.endAt !== undefined;
  if (scheduleChanged) {
    const schedule = parseSchedule(patch.schedule as string, now);
    next = { ...next, schedule };
  }
  if (patch.enabled !== undefined) next = { ...next, enabled: patch.enabled };

  // Re-arm the clock when the schedule or the window changed or a paused job is
  // resumed, so resuming never fires a backlog of slots that passed while paused.
  const resumed = patch.enabled === true && !job.enabled;
  if (scheduleChanged || windowChanged || resumed || (next.enabled && next.nextRunAt === null && next.schedule.kind !== "once")) {
    const first = firstRun(next.schedule, now, next);
    next = { ...next, nextRunAt: first ? first.toISOString() : null };
  }
  return next;
}
