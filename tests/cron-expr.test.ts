import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cronError, isCronExpression, nextCronRun, normalizeCron, parseCron } from "../src/core/cron-expr.ts";
import { local } from "./helpers.ts";

describe("parseCron (node-cron)", () => {
  it("parses lists, ranges, steps and names", () => {
    const f = parseCron("*/15 8-10 1,15 jan-mar mon-fri");
    assert.deepEqual(f.minute, [0, 15, 30, 45]);
    assert.deepEqual(f.hour, [8, 9, 10]);
    assert.deepEqual(f.dayOfMonth, [1, 15]);
    assert.deepEqual(f.month, [1, 2, 3]);
    assert.deepEqual(f.dayOfWeek, [1, 2, 3, 4, 5]);
  });

  it("treats 7 as Sunday", () => {
    assert.deepEqual(parseCron("0 0 * * 7").dayOfWeek, [0]);
  });

  it("rejects bad input with a reason", () => {
    assert.match(cronError("60 * * * *") ?? "", /minute/);
    assert.match(cronError("* * *") ?? "", /5 fields/);
    assert.match(cronError("0 0 0 * * *") ?? "", /5 fields/); // no seconds
    assert.match(cronError("0 0 31 2 *") ?? "", /impossible/);
    assert.equal(isCronExpression("every 5m"), false);
    assert.equal(isCronExpression("0 9 * * 1-5"), true);
    assert.equal(isCronExpression("@daily"), true);
  });

  it("normalises whitespace", () => {
    assert.equal(normalizeCron("  0   9 * *  *"), "0 9 * * *");
  });
});

describe("nextCronRun", () => {
  it("finds the next minute strictly after the given time", () => {
    assert.deepEqual(nextCronRun("0 9 * * *", local(2026, 9, 21, 9, 0)), local(2026, 9, 22, 9, 0));
    assert.deepEqual(nextCronRun("0 9 * * *", local(2026, 9, 21, 8, 59)), local(2026, 9, 21, 9, 0));
  });

  it("respects weekdays (2026-09-26 is a Saturday)", () => {
    assert.deepEqual(nextCronRun("30 8 * * 1-5", local(2026, 9, 25, 9, 0)), local(2026, 9, 28, 8, 30));
  });

  it("ORs day-of-month and day-of-week when both are set (classic cron)", () => {
    // The 1st of the month OR a Monday; after Tue 2026-09-22 the next is Mon 28th.
    assert.deepEqual(nextCronRun("0 0 1 * mon", local(2026, 9, 22)), local(2026, 9, 28));
    assert.deepEqual(nextCronRun("0 0 1 * mon", local(2026, 9, 29)), local(2026, 10, 1));
    // Also with node-cron's own day syntax: the last day OR a Monday.
    assert.deepEqual(nextCronRun("0 18 L * mon", local(2026, 9, 22)), local(2026, 9, 28, 18, 0));
    assert.deepEqual(nextCronRun("0 18 L * mon", local(2026, 9, 29)), local(2026, 9, 30, 18, 0));
  });

  it("ANDs the two day fields when one of them starts with a star (as in cronie)", () => {
    // "*/2" sets the star flag, so only the weekday decides: Mon 2026-10-05
    // (2026-09-28 is even and therefore not in 1,3,5,…,29).
    assert.deepEqual(nextCronRun("0 9 */2 * mon", local(2026, 9, 22)), local(2026, 10, 5, 9, 0));
  });

  it("supports node-cron extensions: last day, nth weekday", () => {
    assert.deepEqual(nextCronRun("0 18 L * *", local(2026, 9, 21)), local(2026, 9, 30, 18, 0));
    assert.deepEqual(nextCronRun("0 9 * * 1#1", local(2026, 9, 21)), local(2026, 10, 5, 9, 0));
    assert.deepEqual(nextCronRun("0 0 15W * *", local(2026, 9, 21)), local(2026, 10, 15, 0, 0));
  });

  it("macros", () => {
    assert.deepEqual(nextCronRun("@daily", local(2026, 9, 21, 12, 0)), local(2026, 9, 22, 0, 0));
  });

  it("handles month rollover and leap days", () => {
    assert.deepEqual(nextCronRun("0 12 29 2 *", local(2026, 3, 1)), local(2028, 2, 29, 12, 0));
    assert.deepEqual(nextCronRun("*/20 * * * *", local(2026, 12, 31, 23, 50)), local(2027, 1, 1, 0, 0));
  });

  it("throws for invalid expressions", () => {
    assert.throws(() => nextCronRun("0 0 31 2 *", local(2026, 1, 1)), /impossible/);
  });
});
