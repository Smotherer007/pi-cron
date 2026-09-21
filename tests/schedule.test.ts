import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  describeSchedule,
  firstRun,
  formatDuration,
  nextRunAfter,
  parseInstant,
  parseLocalTimestamp,
  parseSchedule,
} from "../src/core/schedule.ts";
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

describe("instants", () => {
  it("reads a bare date as local midnight, not UTC", () => {
    assert.deepEqual(parseLocalTimestamp("2026-10-01"), local(2026, 10, 1));
    assert.deepEqual(parseLocalTimestamp("2026-10-01 09:30"), local(2026, 10, 1, 9, 30));
    assert.deepEqual(parseLocalTimestamp("2026-10-01T09:30:15"), new Date(2026, 9, 1, 9, 30, 15));
    assert.deepEqual(parseSchedule("2026-10-01", now), { kind: "once", at: local(2026, 10, 1).toISOString(), input: "2026-10-01" });
    assert.deepEqual(parseInstant("in 2h", now), local(2026, 9, 21, 14, 0));
  });

  it("keeps an explicit zone, rejects nonsense and rollovers", () => {
    assert.deepEqual(parseLocalTimestamp("2026-10-01T09:00Z"), new Date("2026-10-01T09:00:00Z"));
    assert.deepEqual(parseLocalTimestamp("2026-10-01T09:00+0200"), new Date("2026-10-01T09:00:00+02:00"));
    assert.equal(parseLocalTimestamp("2026-02-31"), null);
    assert.equal(parseInstant("", now), null);
    assert.equal(parseInstant(null, now), null);
    assert.equal(parseInstant("sometime", now), null);
  });
});

describe("run window", () => {
  it("startAt delays the first run", () => {
    const s = parseSchedule("daily 9:00", now); // would be 22 Sep 09:00
    assert.deepEqual(firstRun(s, now), local(2026, 9, 22, 9, 0));
    assert.deepEqual(firstRun(s, now, { startAt: local(2026, 10, 1).toISOString(), endAt: null }), local(2026, 10, 1, 9, 0));
  });

  it("counts a slot exactly at startAt and keeps the phase after it", () => {
    const s = parseSchedule("every 1h", now);
    const w = { startAt: local(2026, 9, 21, 15, 0).toISOString(), endAt: null };
    assert.deepEqual(firstRun(s, now, w), local(2026, 9, 21, 15, 0));
    assert.deepEqual(nextRunAfter(s, local(2026, 9, 21, 15, 0), local(2026, 9, 21, 15, 0), w), local(2026, 9, 21, 16, 0));
  });

  it("re-anchors an interval to a later start", () => {
    const s = parseSchedule("every 2h", now); // would be 14:00, then 16:00
    const w = { startAt: local(2026, 9, 21, 15, 30).toISOString(), endAt: null };
    assert.deepEqual(firstRun(s, now, w), local(2026, 9, 21, 15, 30));
    assert.deepEqual(nextRunAfter(s, local(2026, 9, 21, 15, 30), local(2026, 9, 21, 15, 30), w), local(2026, 9, 21, 17, 30));
  });

  it("endAt ends the job", () => {
    const s = parseSchedule("daily 9:00", now);
    const w = { startAt: null, endAt: local(2026, 9, 22, 23, 0).toISOString() };
    assert.deepEqual(nextRunAfter(s, local(2026, 9, 21, 10, 0), undefined, w), local(2026, 9, 22, 9, 0));
    assert.equal(nextRunAfter(s, local(2026, 9, 22, 10, 0), undefined, w), null);
  });

  it("a one-shot outside its window never runs", () => {
    const s = parseSchedule("2026-10-01 09:00", now);
    assert.equal(firstRun(s, now, { startAt: local(2026, 10, 2).toISOString(), endAt: null }), null);
    assert.equal(firstRun(s, now, { startAt: null, endAt: local(2026, 10, 1, 8, 0).toISOString() }), null);
    assert.deepEqual(firstRun(s, now, { startAt: local(2026, 10, 1).toISOString(), endAt: null }), local(2026, 10, 1, 9, 0));
  });
});
