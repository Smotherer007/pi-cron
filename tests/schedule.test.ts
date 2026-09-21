import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeSchedule, firstRun, formatDuration, nextRunAfter, parseSchedule } from "../src/core/schedule.ts";
import { local } from "./helpers.ts";

const now = local(2026, 9, 21, 12, 0); // Monday

describe("parseSchedule", () => {
  it("accepts cron expressions", () => {
    assert.deepEqual(parseSchedule("0 8 * * 1-5", now), { kind: "cron", expr: "0 8 * * 1-5", input: "0 8 * * 1-5" });
    assert.equal(parseSchedule("@hourly", now).kind, "cron");
  });

  it("accepts intervals", () => {
    assert.deepEqual(parseSchedule("every 15m", now), { kind: "every", everyMs: 15 * 60_000, input: "every 15m" });
    assert.equal((parseSchedule("every 2 hours", now) as { everyMs: number }).everyMs, 2 * 3_600_000);
    assert.equal((parseSchedule("every hour", now) as { everyMs: number }).everyMs, 3_600_000);
    assert.throws(() => parseSchedule("every 30s", now), /shorter than 1 minute/);
  });

  it("accepts relative and absolute one-shots", () => {
    const rel = parseSchedule("in 30m", now);
    assert.equal(rel.kind, "once");
    assert.equal(new Date((rel as { at: string }).at).getTime(), now.getTime() + 30 * 60_000);

    const abs = parseSchedule("2026-10-01 09:00", now);
    assert.deepEqual(new Date((abs as { at: string }).at), local(2026, 10, 1, 9, 0));
    assert.throws(() => parseSchedule("2020-01-01T00:00", now), /in the past/);
  });

  it("accepts day + time phrases", () => {
    const expr = (s: string) => (parseSchedule(s, now) as { expr: string }).expr;
    assert.equal(expr("daily 9:00"), "0 9 * * *");
    assert.equal(expr("every day at 7am"), "0 7 * * *");
    assert.equal(expr("weekdays 08:30"), "30 8 * * 1-5");
    assert.equal(expr("weekends 10:00"), "0 10 * * 0,6");
    assert.equal(expr("mon,wed,fri 18:15"), "15 18 * * 1,3,5");
    assert.equal(expr("monday at 9"), "0 9 * * 1");
    assert.equal(expr("sundays 12pm"), "0 12 * * 0");
    assert.equal(expr("friday 12am"), "0 0 * * 5");
  });

  it("explains what it does not understand", () => {
    assert.throws(() => parseSchedule("sometime soon", now), /Cannot understand schedule/);
    assert.throws(() => parseSchedule("", now), /empty/);
  });
});

describe("next run", () => {
  it("keeps the phase of intervals", () => {
    const s = parseSchedule("every 1h", now);
    const anchor = local(2026, 9, 21, 12, 0);
    assert.deepEqual(nextRunAfter(s, local(2026, 9, 21, 15, 20), anchor), local(2026, 9, 21, 16, 0));
    assert.deepEqual(nextRunAfter(s, local(2026, 9, 21, 12, 0), anchor), local(2026, 9, 21, 13, 0));
  });

  it("one-shots have no next run once passed", () => {
    const s = parseSchedule("in 10m", now);
    assert.equal(nextRunAfter(s, local(2026, 9, 21, 13, 0)), null);
  });

  it("firstRun per kind", () => {
    assert.deepEqual(firstRun(parseSchedule("every 30m", now), now), local(2026, 9, 21, 12, 30));
    assert.deepEqual(firstRun(parseSchedule("daily 9:00", now), now), local(2026, 9, 22, 9, 0));
  });

  it("describes schedules", () => {
    assert.equal(describeSchedule(parseSchedule("weekdays 8:30", now)), "weekdays 8:30 (cron 30 8 * * 1-5)");
    assert.equal(describeSchedule(parseSchedule("every 90m", now)), "every 90m");
    assert.equal(formatDuration(2 * 3_600_000), "2h");
  });
});
