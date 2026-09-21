/**
 * Minimal 5-field cron expressions (minute hour day-of-month month day-of-week),
 * evaluated in the machine's local time zone.
 *
 * Supports `*`, lists (`1,15`), ranges (`1-5`), steps (`*\/15`, `10-50/10`),
 * month and weekday names (`jan`, `mon-fri`), `7` as Sunday, and the macros
 * `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`.
 *
 * Day-of-month and day-of-week follow classic cron semantics: when both are
 * restricted, a day matches if EITHER matches.
 */

export interface CronFields {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
  readonly nameOffset?: number;
}

const FIELDS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES, nameOffset: 1 },
  { name: "day-of-week", min: 0, max: 7, names: DAY_NAMES, nameOffset: 0 },
];

function parseValue(raw: string, spec: FieldSpec): number {
  const lower = raw.toLowerCase();
  if (spec.names) {
    const idx = spec.names.indexOf(lower.slice(0, 3));
    if (idx >= 0 && /^[a-z]+$/.test(lower)) return idx + (spec.nameOffset ?? 0);
  }
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid ${spec.name} value "${raw}"`);
  const n = Number(raw);
  if (n < spec.min || n > spec.max) {
    throw new Error(`${spec.name} value ${n} out of range ${spec.min}-${spec.max}`);
  }
  return n;
}

function parseField(raw: string, spec: FieldSpec): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    if (part === "") throw new Error(`Empty list item in ${spec.name} field`);
    const [rangePart, stepPart] = part.split("/");
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) === 0) {
        throw new Error(`Invalid step "${stepPart}" in ${spec.name} field`);
      }
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = spec.min;
      hi = spec.name === "day-of-week" ? 6 : spec.max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = parseValue(a, spec);
      hi = parseValue(b, spec);
      if (lo > hi) throw new Error(`Invalid range "${rangePart}" in ${spec.name} field`);
    } else {
      lo = parseValue(rangePart, spec);
      hi = stepPart !== undefined ? (spec.name === "day-of-week" ? 6 : spec.max) : lo;
    }
    for (let v = lo; v <= hi; v += step) {
      out.add(spec.name === "day-of-week" && v === 7 ? 0 : v);
    }
  }
  return out;
}

export function normalizeCron(expr: string): string {
  const trimmed = expr.trim().replace(/\s+/g, " ");
  return MACROS[trimmed.toLowerCase()] ?? trimmed;
}

export function isCronExpression(expr: string): boolean {
  const norm = normalizeCron(expr);
  if (norm.split(" ").length !== 5) return false;
  try {
    parseCron(norm);
    return true;
  } catch {
    return false;
  }
}

export function parseCron(expr: string): CronFields {
  const parts = normalizeCron(expr).split(" ");
  if (parts.length !== 5) {
    throw new Error(`Cron expression needs 5 fields (minute hour day month weekday), got ${parts.length}: "${expr}"`);
  }
  const [mi, h, dom, mo, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  return {
    minutes: mi,
    hours: h,
    daysOfMonth: dom,
    months: mo,
    daysOfWeek: dow,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

function dayMatches(f: CronFields, d: Date): boolean {
  const domOk = f.daysOfMonth.has(d.getDate());
  const dowOk = f.daysOfWeek.has(d.getDay());
  if (f.domRestricted && f.dowRestricted) return domOk || dowOk;
  if (f.domRestricted) return domOk;
  if (f.dowRestricted) return dowOk;
  return true;
}

/**
 * First matching minute strictly after `after`. Walks days, then hours, then
 * minutes, so even sparse expressions resolve in a few thousand steps.
 */
export function nextCronRun(expr: string, after: Date): Date {
  const f = parseCron(expr);
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  const limit = after.getTime() + 5 * 366 * 24 * 60 * 60 * 1000;
  while (d.getTime() <= limit) {
    if (!f.months.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(f, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!f.hours.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!f.minutes.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  throw new Error(`Cron expression "${expr}" never fires within 5 years`);
}
