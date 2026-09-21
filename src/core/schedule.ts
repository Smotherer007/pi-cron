/**
 * Turns what a user (or the model) types into a Schedule, and computes the
 * next run time. All times are local to the machine the runner lives on.
 *
 * Accepted input:
 *   - cron:        "0 9 * * 1-5", "@daily"
 *   - interval:    "every 15m", "every 2 hours", "every 1d"
 *   - relative:    "in 30m", "in 2 hours"                      (one-shot)
 *   - timestamp:   "2026-10-01T09:00", "2026-10-01 09:00"      (one-shot)
 *   - day + time:  "daily 9:00", "every day at 7am", "weekdays 08:30",
 *                  "weekends 10:00", "mon,wed,fri 18:15", "monday at 9"
 */

import { isCronExpression, nextCronRun, normalizeCron } from "./cron-expr.ts";
import type { Schedule } from "./types.ts";

const MINUTE = 60_000;

const UNIT_MS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE,
  h: 60 * MINUTE, hr: 60 * MINUTE, hrs: 60 * MINUTE, hour: 60 * MINUTE, hours: 60 * MINUTE,
  d: 24 * 60 * MINUTE, day: 24 * 60 * MINUTE, days: 24 * 60 * MINUTE,
  w: 7 * 24 * 60 * MINUTE, week: 7 * 24 * 60 * MINUTE, weeks: 7 * 24 * 60 * MINUTE,
};

const DAY_WORDS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};

function parseDuration(text: string): number | null {
  const m = /^(\d+)\s*([a-z]+)$/.exec(text.trim().toLowerCase());
  if (!m) return null;
  const unit = UNIT_MS[m[2]];
  return unit ? Number(m[1]) * unit : null;
}

/** "9", "9:30", "09:30", "7am", "7:15pm" → [hour, minute] */
function parseTimeOfDay(text: string): [number, number] | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text.trim().toLowerCase());
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (m[3]) {
    if (hour < 1 || hour > 12) return null;
    if (m[3] === "am" && hour === 12) hour = 0;
    if (m[3] === "pm" && hour !== 12) hour += 12;
  }
  if (hour > 23 || minute > 59) return null;
  return [hour, minute];
}

/** "daily", "weekdays", "mon,wed", "monday" → cron weekday field */
function parseDays(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/^every\s+/, "");
  if (t === "daily" || t === "day" || t === "everyday") return "*";
  if (t === "weekdays" || t === "weekday") return "1-5";
  if (t === "weekends" || t === "weekend") return "0,6";
  const parts = t.split(/\s*(?:,|and)\s*|\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const n = DAY_WORDS[p.replace(/s$/, "")] ?? DAY_WORDS[p];
    if (n === undefined) return null;
    if (!nums.includes(n)) nums.push(n);
  }
  return nums.sort((a, b) => a - b).join(",");
}

function parseLocalTimestamp(text: string): Date | null {
  const t = text.trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?(Z|[+-]\d{2}:?\d{2})?$/.test(t)) return null;
  const d = new Date(t.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseSchedule(input: string, now: Date = new Date()): Schedule {
  const raw = input.trim();
  if (!raw) throw new Error("Schedule is empty");
  const lower = raw.toLowerCase();

  if (isCronExpression(raw)) {
    return { kind: "cron", expr: normalizeCron(raw), input: raw };
  }

  const every = /^every\s+(.+)$/.exec(lower);
  if (every) {
    const ms = parseDuration(every[1]) ?? parseDuration(`1 ${every[1]}`);
    if (ms !== null) {
      if (ms < MINUTE) throw new Error("Intervals shorter than 1 minute are not supported (the runner ticks once a minute)");
      return { kind: "every", everyMs: ms, input: raw };
    }
  }

  const rel = /^in\s+(.+)$/.exec(lower);
  if (rel) {
    const ms = parseDuration(rel[1]);
    if (ms === null) throw new Error(`Cannot understand duration "${rel[1]}"`);
    return { kind: "once", at: new Date(now.getTime() + ms).toISOString(), input: raw };
  }

  const ts = parseLocalTimestamp(raw);
  if (ts) {
    if (ts.getTime() <= now.getTime()) throw new Error(`Time ${raw} is in the past`);
    return { kind: "once", at: ts.toISOString(), input: raw };
  }

  // "<days> [at] <time>"
  const dayTime = /^(.+?)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/.exec(lower);
  if (dayTime) {
    const days = parseDays(dayTime[1]);
    const time = parseTimeOfDay(dayTime[2]);
    if (days !== null && time !== null) {
      return { kind: "cron", expr: `${time[1]} ${time[0]} * * ${days}`, input: raw };
    }
  }

  throw new Error(
    `Cannot understand schedule "${raw}". Use a cron expression ("0 9 * * 1-5"), ` +
      `"every 30m", "in 2h", "daily 9:00", "weekdays 8:30", "mon,fri 17:00" or an ISO time.`,
  );
}

/**
 * Next due time strictly after `after`.
 * Intervals keep their phase: the next slot is `anchor + k * every`.
 */
export function nextRunAfter(schedule: Schedule, after: Date, anchor?: Date): Date | null {
  switch (schedule.kind) {
    case "cron":
      return nextCronRun(schedule.expr, after);
    case "once": {
      const at = new Date(schedule.at);
      return at.getTime() > after.getTime() ? at : null;
    }
    case "every": {
      const base = anchor ?? after;
      if (base.getTime() > after.getTime()) return base;
      const steps = Math.floor((after.getTime() - base.getTime()) / schedule.everyMs) + 1;
      return new Date(base.getTime() + steps * schedule.everyMs);
    }
  }
}

/** First run time for a freshly created job. */
export function firstRun(schedule: Schedule, now: Date): Date | null {
  if (schedule.kind === "once") return new Date(schedule.at);
  if (schedule.kind === "every") return new Date(now.getTime() + schedule.everyMs);
  return nextCronRun(schedule.expr, now);
}

export function describeSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case "cron":
      return schedule.input === schedule.expr ? `cron ${schedule.expr}` : `${schedule.input} (cron ${schedule.expr})`;
    case "every":
      return `every ${formatDuration(schedule.everyMs)}`;
    case "once":
      return `once at ${formatLocal(new Date(schedule.at))}`;
  }
}

export function formatDuration(ms: number): string {
  const units: Array<[number, string]> = [[7 * 24 * 60 * MINUTE, "w"], [24 * 60 * MINUTE, "d"], [60 * MINUTE, "h"], [MINUTE, "m"], [1000, "s"]];
  for (const [size, label] of units) {
    if (ms >= size && ms % size === 0) return `${ms / size}${label}`;
  }
  return `${Math.round(ms / 1000)}s`;
}

/** "2026-09-22 09:00" in local time. */
export function formatLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
