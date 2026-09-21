import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isCronExpression, nextCronRun, normalizeCron, parseCron } from "../src/core/cron-expr.ts";
import { local } from "./helpers.ts";

describe("parseCron", () => {
  it("parses lists, ranges, steps and names", () => {
    const f = parseCron("*/15 8-10 1,15 jan-mar mon-fri");
    assert.deepEqual([...f.minutes], [0, 15, 30, 45]);
    assert.deepEqual([...f.hours], [8, 9, 10]);
    assert.deepEqual([...f.daysOfMonth], [1, 15]);
    assert.deepEqual([...f.months], [1, 2, 3]);
    assert.deepEqual([...f.daysOfWeek], [1, 2, 3, 4, 5]);
  });

  it("treats 7 as Sunday", () => {
    assert.deepEqual([...parseCron("0 0 * * 7").daysOfWeek], [0]);
  });

  it("rejects bad input", () => {
    assert.throws(() => parseCron("60 * * * *"), /out of range/);
    assert.throws(() => parseCron("* * *"), /5 fields/);
    assert.throws(() => parseCron("*/0 * * * *"), /Invalid step/);
    assert.throws(() => parseCron("5-1 * * * *"), /Invalid range/);
    assert.equal(isCronExpression("every 5m"), false);
    assert.equal(isCronExpression("0 9 * * 1-5"), true);
  });

  it("expands macros", () => {
    assert.equal(normalizeCron("@daily"), "0 0 * * *");
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

  it("ORs day-of-month and day-of-week when both are set", () => {
    // 1st of the month OR Monday; after Tue 2026-09-22 the next is Mon 28th.
    assert.deepEqual(nextCronRun("0 0 1 * mon", local(2026, 9, 22)), local(2026, 9, 28));
    assert.deepEqual(nextCronRun("0 0 1 * mon", local(2026, 9, 29)), local(2026, 10, 1));
  });

  it("handles month rollover and leap days", () => {
    assert.deepEqual(nextCronRun("0 12 29 2 *", local(2026, 3, 1)), local(2028, 2, 29, 12, 0));
    assert.deepEqual(nextCronRun("*/20 * * * *", local(2026, 12, 31, 23, 50)), local(2027, 1, 1, 0, 0));
  });

  it("throws for expressions that never fire", () => {
    assert.throws(() => nextCronRun("0 0 31 2 *", local(2026, 1, 1)), /never fires/);
  });
});
