/**
 * The in-pi scheduler: lease between pi windows, running due jobs as child
 * processes, and aborting them when pi quits.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { acquireLease, isLeaseLive, readLease, releaseLease } from "../src/core/lease.ts";
import { CronScheduler, msToNextMinute } from "../src/core/loop.ts";
import { mutateJobs, loadJobs, saveConfig, saveJobs } from "../src/core/store.ts";
import type { ExecuteResult } from "../src/core/executor.ts";
import type { CronJob } from "../src/core/types.ts";
import { local, makeJob, useTempHome } from "./helpers.ts";
import { rmSync } from "node:fs";
import { paths } from "../src/core/paths.ts";

const fakePi = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
let home: ReturnType<typeof useTempHome>;
before(() => {
  home = useTempHome();
});
after(() => home.cleanup());
beforeEach(() => {
  saveJobs([]);
  rmSync(paths.lease(), { force: true });
  saveConfig({ piCommand: [], defaultDeliver: [] });
});

const addJob = (job: CronJob) => mutateJobs((jobs) => ({ jobs: [...jobs, job], result: undefined }));
const due = (overrides = {}) => makeJob(overrides, undefined, { nextRunAt: new Date(Date.now() - 1000).toISOString() });

function scheduler(onRunFinished?: (r: ExecuteResult) => void, pid = process.pid) {
  return new CronScheduler({ piCommand: [process.execPath, fakePi], onRunFinished, pid });
}

describe("lease", () => {
  it("lets exactly one live pi schedule", () => {
    const now = new Date();
    assert.equal(acquireLease(process.pid, now), true);
    assert.equal(acquireLease(process.ppid, now), false); // another live process
    assert.equal(acquireLease(process.pid, now), true); // renew
    releaseLease(process.pid);
    assert.equal(readLease(), null);
    assert.equal(acquireLease(process.ppid, now), true);
  });

  it("takes over from a dead or silent holder", () => {
    const now = new Date();
    assert.equal(acquireLease(2 ** 22 + 999, now, () => true), true);
    assert.equal(acquireLease(process.pid, now, () => false), true); // holder dead
    const later = new Date(now.getTime() + 10 * 60_000);
    assert.equal(isLeaseLive(readLease(), later, () => true), false); // heartbeat stale
  });
});

describe("CronScheduler", () => {
  it("wakes just after each minute boundary", () => {
    assert.equal(msToNextMinute(local(2026, 9, 21, 12, 0)), 61_000);
    assert.equal(msToNextMinute(new Date(local(2026, 9, 21, 12, 0).getTime() + 59_500)), 1_500);
  });

  it("runs due jobs as child pi processes and reports back", async () => {
    addJob(due({ name: "hello" }));
    const finished = new Promise<ExecuteResult>((resolve) => {
      const s = scheduler(resolve);
      const r = s.tickOnce();
      assert.deepEqual(r?.started, ["hello"]);
      assert.equal(s.isLeader, true);
    });
    const result = await finished;
    assert.equal(result.record?.status, "ok");
    assert.equal(loadJobs()[0].lastStatus, "ok");
    assert.equal(loadJobs()[0].running, null);
  });

  it("does nothing while another pi holds the lease", () => {
    addJob(due({ name: "hello" }));
    acquireLease(process.ppid);
    const s = scheduler();
    assert.equal(s.tickOnce(), null);
    assert.equal(s.isLeader, false);
    assert.equal(loadJobs()[0].running, null);
  });

  it("runNow refuses a second concurrent run of the same job", async () => {
    addJob(makeJob({ name: "slow", prompt: "hang" }));
    const s = scheduler();
    const job = loadJobs()[0];
    assert.equal(s.runNow(job), true);
    assert.equal(s.runNow(job), false);
    await s.stop();
  });

  it("stop() aborts running jobs, makes them due again and releases the lease", async () => {
    addJob(due({ name: "long", prompt: "hang" }));
    const s = scheduler();
    s.tickOnce();
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(s.runningJobIds, [loadJobs()[0].id]);
    await s.stop();
    const job = loadJobs()[0];
    assert.equal(job.lastStatus, "aborted");
    assert.equal(job.running, null);
    assert.ok(new Date(job.nextRunAt!).getTime() <= Date.now());
    assert.equal(readLease(), null);
    assert.equal(s.tickOnce(), null); // stopped for good

    // The next pi start picks it up again.
    const next = new Promise<ExecuteResult>((resolve) => {
      saveJobs(loadJobs().map((j) => ({ ...j, prompt: "Say hi" })));
      scheduler(resolve).tickOnce();
    });
    assert.equal((await next).record?.status, "ok");
  });
});
