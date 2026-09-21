import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planTick } from "../src/core/scheduler.ts";
import { local, makeJob } from "./helpers.ts";

const alive = () => true;
const dead = () => false;

describe("planTick", () => {
  it("leaves jobs that are not due", () => {
    const job = makeJob(); // next 13:00
    const plan = planTick([job], local(2026, 9, 21, 12, 30), alive);
    assert.equal(plan.due.length, 0);
    assert.deepEqual(plan.jobs, [job]);
  });

  it("starts due jobs and advances nextRunAt", () => {
    const job = makeJob();
    const plan = planTick([job], local(2026, 9, 21, 13, 0), alive);
    assert.equal(plan.due.length, 1);
    assert.equal(plan.jobs[0].nextRunAt, local(2026, 9, 21, 14, 0).toISOString());
    assert.ok(plan.jobs[0].running);
  });

  it("catches up a long outage with ONE run", () => {
    const job = makeJob();
    const plan = planTick([job], local(2026, 9, 22, 8, 17), alive); // asleep all night
    assert.equal(plan.due.length, 1);
    assert.equal(plan.jobs[0].nextRunAt, local(2026, 9, 22, 9, 0).toISOString());
  });

  it("skips missed slots when catchUp is off", () => {
    const job = makeJob({ catchUp: false });
    const plan = planTick([job], local(2026, 9, 22, 8, 17), alive);
    assert.equal(plan.due.length, 0);
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.jobs[0].lastStatus, "skipped");
    assert.equal(plan.jobs[0].nextRunAt, local(2026, 9, 22, 9, 0).toISOString());
  });

  it("still runs a slightly late slot when catchUp is off", () => {
    const job = makeJob({ catchUp: false });
    const plan = planTick([job], local(2026, 9, 21, 13, 1), alive);
    assert.equal(plan.due.length, 1);
  });

  it("never skips a one-shot", () => {
    const job = makeJob({ schedule: "in 5m", catchUp: false });
    const plan = planTick([job], local(2026, 9, 22, 9, 0), alive);
    assert.equal(plan.due.length, 1);
    assert.equal(plan.jobs[0].nextRunAt, null);
  });

  it("does not start a job that is still running", () => {
    const job = makeJob({}, undefined, { running: { pid: 4242, startedAt: "x" } });
    const plan = planTick([job], local(2026, 9, 21, 13, 0), alive);
    assert.equal(plan.due.length, 0);
  });

  it("detects crashed runs and reschedules them", () => {
    const job = makeJob({}, undefined, { running: { pid: 4242, startedAt: "x" } });
    const plan = planTick([job], local(2026, 9, 21, 13, 0), dead);
    assert.equal(plan.crashed.length, 1);
    assert.equal(plan.due.length, 1);
  });

  it("ignores paused jobs", () => {
    const job = makeJob({ enabled: false });
    assert.equal(planTick([job], local(2026, 9, 22), alive).due.length, 0);
  });
});

describe("run window", () => {
  it("holds a job back until startAt and moves the slot into the window", () => {
    const job = makeJob({ startAt: "2026-10-01" }, undefined, { nextRunAt: local(2026, 9, 21, 13, 0).toISOString() });
    const plan = planTick([job], local(2026, 9, 21, 13, 0), alive);
    assert.equal(plan.due.length, 0);
    assert.equal(plan.jobs[0].nextRunAt, local(2026, 10, 1).toISOString());
  });

  it("gives up once the next slot lies past endAt", () => {
    const job = makeJob({ schedule: "daily 9:00", endAt: "2026-09-22 23:00" }, undefined, {
      nextRunAt: local(2026, 9, 23, 9, 0).toISOString(),
    });
    const plan = planTick([job], local(2026, 9, 21, 12, 30), alive);
    assert.equal(plan.due.length, 0);
    assert.equal(plan.jobs[0].nextRunAt, null);
  });

  it("runs the last slot in the window and clears the next run", () => {
    const job = makeJob({ schedule: "daily 9:00", startAt: "2026-09-01", endAt: "2026-09-22 23:00" }, undefined, {
      nextRunAt: local(2026, 9, 22, 9, 0).toISOString(),
    });
    const plan = planTick([job], local(2026, 9, 22, 9, 0), alive);
    assert.equal(plan.due.length, 1);
    assert.equal(plan.jobs[0].nextRunAt, null);
  });

  it("does not catch up a slot after the window closed", () => {
    const job = makeJob({ endAt: "2026-09-21 23:00" }, undefined, { nextRunAt: local(2026, 9, 21, 13, 0).toISOString() });
    const plan = planTick([job], local(2026, 9, 25, 10, 0), alive); // pi was off over the end
    assert.equal(plan.due.length, 0);
    assert.equal(plan.jobs[0].nextRunAt, null);
  });

  it("still fires a slot at endAt when the tick is a minute late", () => {
    const job = makeJob({ endAt: "2026-09-21 13:00" }, undefined, { nextRunAt: local(2026, 9, 21, 13, 0).toISOString() });
    assert.equal(planTick([job], local(2026, 9, 21, 13, 1), alive).due.length, 1);
  });

  it("does not repeat an interrupted run once the window closed", () => {
    const job = makeJob({ endAt: "2026-09-21 13:00" }, undefined, {
      running: { pid: 4242, startedAt: "x" },
      nextRunAt: local(2026, 9, 21, 13, 0).toISOString(),
    });
    const plan = planTick([job], local(2026, 9, 25, 10, 0), dead);
    assert.equal(plan.crashed.length, 1);
    assert.equal(plan.due.length, 0);
    assert.equal(plan.jobs[0].nextRunAt, null);
  });
});

describe("orphans", () => {
  it("reports the child of a crashed run so it can be stopped", () => {
    const job = makeJob({}, undefined, { running: { pid: 1, startedAt: "x", childPid: 777 } });
    const plan = planTick([job], local(2026, 9, 21, 12, 30), () => false);
    assert.deepEqual(plan.orphanPids, [777]);
  });
});
