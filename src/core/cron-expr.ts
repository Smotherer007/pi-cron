/**
 * Cron expressions via node-cron (pure JavaScript, no OS scheduler involved).
 *
 * node-cron parses and matches the expression: ranges, steps, lists, names,
 * macros (@daily …) and its extensions (L, L-n, 15W, LW, 2#3, 5L).
 *
 * Day-of-month and day-of-week keep classic cron semantics: when both are
 * restricted, a day matches if EITHER matches. node-cron itself ANDs them,
 * which would silently turn "0 8 1 * mon" from every-Monday-plus-the-1st into
 * "the 1st, if it happens to be a Monday"; that one case is decided here by
 * asking the two fields separately.
 *
 * pi-cron works per minute, so only 5-field expressions are accepted (no
 * seconds). What node-cron does not offer is "next run after an arbitrary
 * date", which pi-cron needs to persist nextRunAt and to catch up missed
 * slots; nextCronRun walks forward using node-cron's parsed fields to skip
 * whole months/days/hours and node-cron's own matcher for the final say.
 */

import cron from "node-cron";
import type { ScheduledTask } from "node-cron";

export function normalizeCron(expr: string): string {
  return expr.trim().replace(/\s+/g, " ");
}

function fieldCount(expr: string): number {
  return expr.startsWith("@") ? 5 : expr.split(" ").length;
}

/** Why an expression is not usable, or null if it is. */
export function cronError(expr: string): string | null {
  const norm = normalizeCron(expr);
  if (fieldCount(norm) !== 5) {
    return `Cron expression needs 5 fields (minute hour day month weekday), got ${norm.split(" ").length}: "${expr}"`;
  }
  const detail = cron.validateDetailed(norm);
  if (!detail.valid) return detail.errors.map((e) => e.message).join("; ") || `Invalid cron expression "${expr}"`;
  return null;
}

export function isCronExpression(expr: string): boolean {
  return cronError(expr) === null;
}

export function parseCron(expr: string): ReturnType<typeof cron.parse> {
  const error = cronError(expr);
  if (error) throw new Error(error);
  return cron.parse(normalizeCron(expr));
}

// Matchers are never started (no timers); cached because they are reused every tick.
const matchers = new Map<string, ScheduledTask>();

function matcher(expr: string): ScheduledTask {
  let task = matchers.get(expr);
  if (!task) {
    if (matchers.size > 200) {
      for (const t of matchers.values()) void t.destroy();
      matchers.clear();
    }
    task = cron.createTask(expr, () => {}, { name: `pi-cron-matcher:${expr}` });
    matchers.set(expr, task);
  }
  return task;
}

/**
 * How a day matches. node-cron ANDs day-of-month and day-of-week; classic cron
 * ORs them when both fields are restricted (a field that starts with `*`
 * counts as unrestricted, as in Vixie cron). Only that case needs the two
 * fields asked separately; everything else - including L, W and # - stays with
 * node-cron's own matcher. Macros never restrict both fields and fall through.
 */
function dayMatcher(norm: string, task: ScheduledTask): (day: Date) => boolean {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = norm.split(" ");
  if (!hour || !dayOfMonth || !dayOfWeek || dayOfMonth.startsWith("*") || dayOfWeek.startsWith("*")) {
    return (day) => task.match(day);
  }
  const byDayOfMonth = matcher(`${minute} ${hour} ${dayOfMonth} ${month} *`);
  const byDayOfWeek = matcher(`${minute} ${hour} * ${month} ${dayOfWeek}`);
  return (day) => byDayOfMonth.match(day) || byDayOfWeek.match(day);
}

/**
 * First matching minute strictly after `after` (local time). Skips months,
 * days and hours that cannot match, so even sparse expressions resolve fast.
 */
export function nextCronRun(expr: string, after: Date): Date {
  const norm = normalizeCron(expr);
  const fields = parseCron(norm);
  const task = matcher(norm);
  const matchesDay = dayMatcher(norm, task);
  const months = new Set(fields.month);
  const hours = new Set(fields.hour);
  const minutes = new Set(fields.minute);
  const firstHour = Math.min(...fields.hour);
  const firstMinute = Math.min(...fields.minute);

  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  const limit = after.getTime() + 5 * 366 * 24 * 60 * 60 * 1000;
  while (d.getTime() <= limit) {
    if (!months.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    // Let node-cron decide whether the day fits (L, W, #), with the classic
    // OR between day-of-month and day-of-week when both are restricted.
    const probe = new Date(d.getFullYear(), d.getMonth(), d.getDate(), firstHour, firstMinute, 0, 0);
    if (!matchesDay(probe)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!hours.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!minutes.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    if (matchesDay(d)) return d;
    d.setMinutes(d.getMinutes() + 1, 0, 0);
  }
  throw new Error(`Cron expression "${expr}" never fires within 5 years`);
}
