/**
 * End-to-end through the real files: store, tick, executor (spawning a fake
 * pi), outputs and run history.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { executeJob } from "../src/core/executor.ts";
import { paths } from "../src/core/paths.ts";
import { listRuns, markSeen, readOutput, unseenRuns } from "../src/core/runs.ts";
import { findJob, loadJobs, mutateJobs, readJson, saveConfig, saveJobs, withLock } from "../src/core/store.ts";
import { tick } from "../src/core/tick.ts";
import type { CronJob } from "../src/core/types.ts";
import { local, makeJob, useTempHome } from "./helpers.ts";

const fakePi = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
let home: ReturnType<typeof useTempHome>;

before(() => {
  home = useTempHome();
});
after(() => home.cleanup());
beforeEach(() => {
  saveJobs([]);
  saveConfig({ piCommand: [process.execPath, fakePi], defaultDeliver: [] });
});

function addJob(job: CronJob): void {
  mutateJobs((jobs) => ({ jobs: [...jobs, job], result: undefined }));
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("store", () => {
  it("round-trips jobs atomically and finds by name prefix", () => {
    addJob(makeJob({ name: "morning-inbox" }));
    addJob(makeJob({ name: "weekly-report" }));
    const jobs = loadJobs();
    assert.equal(jobs.length, 2);
    assert.equal(findJob(jobs, "MORNING")?.name, "morning-inbox");
    assert.equal(findJob(jobs, jobs[1].id)?.name, "weekly-report");
    assert.equal(findJob(jobs, "nope"), undefined);
  });

  it("quarantines a corrupt jobs.json instead of dropping it", () => {
    writeFileSync(paths.jobs(), "{ nope");
    assert.throws(() => loadJobs(), /not valid JSON/);
    assert.deepEqual(loadJobs(), []);
  });

  it("releases the lock and steals a stale one", () => {
    mkdirSync(paths.lock());
    const old = new Date(Date.now() - 60_000);
    utimesSync(paths.lock(), old, old);
    assert.equal(withLock(() => 42), 42);
    assert.equal(existsSync(paths.lock()), false);
  });

  it("fills the window in for a job written before it existed", () => {
    const { startAt, endAt, ...old } = makeJob({ name: "legacy" });
    saveJobs([old as CronJob]);
    const [job] = loadJobs();
    assert.equal(job.startAt, null);
    assert.equal(job.endAt, null);
  });
});

describe("executeJob", () => {
  it("runs pi with the job's tools, skills, model and cwd, and stores the answer", async () => {
    const cwd = tmpdir();
    addJob(makeJob({ name: "tools-job", tools: ["read", "email_fetch"], skills: ["/s/skill"], model: "sonnet", cwd }));

    const r = await executeJob("tools-job");
    assert.equal(r.record?.status, "ok");

    const out = readOutput(r.record!);
    const echoed = JSON.parse(out.slice(out.indexOf("{")));
    assert.deepEqual(echoed.args.slice(0, 1), ["-p"]);
    assert.ok(echoed.args.includes("--tools"));
    assert.equal(echoed.args[echoed.args.indexOf("--tools") + 1], "read,email_fetch");
    assert.equal(echoed.args[echoed.args.indexOf("--skill") + 1], "/s/skill");
    assert.equal(echoed.args[echoed.args.indexOf("--model") + 1], "sonnet");
    assert.match(echoed.args[echoed.args.indexOf("--append-system-prompt") + 1], /unattended/);
    assert.equal(echoed.args.at(-1), "Say hi");
    assert.equal(echoed.piCron, "1");

    const job = loadJobs()[0];
    assert.equal(job.running, null);
    assert.equal(job.lastStatus, "ok");
    assert.equal(job.runCount, 1);
    assert.equal(job.lastOutputPath, r.record?.outputPath);
  });

  it("passes --no-tools for an empty allowlist and nothing for pi defaults", async () => {
    addJob(makeJob({ name: "none", tools: [] }));
    addJob(makeJob({ name: "defaults" }));
    const none = readOutput((await executeJob("none")).record!);
    const defaults = readOutput((await executeJob("defaults")).record!);
    assert.match(none, /--no-tools/);
    assert.doesNotMatch(defaults, /--tools|--no-tools/);
  });

  it("records failures with the stderr log", async () => {
    addJob(makeJob({ name: "broken", prompt: "fail" }));
    const r = await executeJob("broken");
    assert.equal(r.record?.status, "error");
    assert.match(r.record?.error ?? "", /code 3/);
    const log = r.record!.error!.split("see ")[1];
    assert.match(readFileSync(log, "utf8"), /boom/);
    assert.match(readOutput(r.record!), /\*\*error:\*\*[\s\S]*boom/);
  });

  it("times out hanging runs", async () => {
    addJob(makeJob({ name: "slow", prompt: "hang", timeoutMinutes: 1 }, undefined, { timeoutMinutes: 0.02 }));
    const r = await executeJob("slow");
    assert.equal(r.record?.status, "timeout");
  });

  it("aborts when pi quits and makes the job due again", async () => {
    addJob(makeJob({ name: "cut", prompt: "hang" }));
    const ac = new AbortController();
    const run = executeJob("cut", { signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    const r = await run;
    assert.equal(r.record?.status, "aborted");
    assert.deepEqual(r.record?.delivery, {});
    const job = loadJobs()[0];
    assert.equal(job.running, null);
    assert.equal(job.runCount, 0);
    assert.ok(new Date(job.nextRunAt!).getTime() <= Date.now());
  });

  it("uses the given pi command when config has none", async () => {
    saveConfig({ piCommand: [] });
    addJob(makeJob({ name: "cmd" }));
    const r = await executeJob("cmd", { piCommand: [process.execPath, fakePi] });
    assert.equal(r.record?.status, "ok");
  });

  it("reports a missing working directory", async () => {
    addJob(makeJob({ name: "gone", cwd: "/does/not/exist" }));
    const r = await executeJob("gone");
    assert.equal(r.record?.status, "error");
    assert.match(r.record?.error ?? "", /does not exist/);
  });

  it("disables a one-shot job after it ran", async () => {
    addJob(makeJob({ name: "once", schedule: "in 1m" }, undefined, { nextRunAt: null }));
    await executeJob("once");
    assert.equal(loadJobs()[0].enabled, false);
  });

  it("refuses to run a job twice at once", async () => {
    addJob(makeJob({ name: "busy" }, undefined, { running: { pid: process.ppid, startedAt: "x" } }));
    const r = await executeJob("busy");
    assert.equal(r.record, null);
    assert.match(r.message, /already running/);
  });
});

describe("tick", () => {
  it("hands due jobs to the launcher and records the owning pid", () => {
    const created = local(2026, 9, 21, 12, 0);
    addJob(makeJob({ name: "due" }, created, { nextRunAt: new Date(Date.now() - 1000).toISOString() }));
    addJob(makeJob({ name: "later" }, created, { nextRunAt: new Date(Date.now() + 3_600_000).toISOString() }));

    const launched: string[] = [];
    const result = tick(new Date(), (job) => {
      launched.push(job.name);
      return 4242;
    });
    assert.deepEqual(result.started, ["due"]);
    assert.deepEqual(launched, ["due"]);
    assert.equal(loadJobs().find((j) => j.name === "due")?.running?.pid, 4242);
    assert.ok(new Date(loadJobs().find((j) => j.name === "due")!.nextRunAt!).getTime() > Date.now());
  });

  it("records launch failures", () => {
    addJob(makeJob({ name: "x" }, undefined, { nextRunAt: new Date(Date.now() - 1000).toISOString() }));
    tick(new Date(), () => {
      throw new Error("spawn failed");
    });
    const job = loadJobs()[0];
    assert.equal(job.running, null);
    assert.equal(job.lastStatus, "error");
  });

  it("re-runs a job whose pi died mid-run and records it as crashed", () => {
    const dead = 2 ** 22 + 12345; // no such pid
    addJob(makeJob({ name: "cut" }, undefined, { running: { pid: dead, startedAt: "x" } }));
    const result = tick(new Date(), () => 1);
    assert.deepEqual(result.crashed, ["cut"]);
    assert.deepEqual(result.started, ["cut"]);
    assert.equal(listRuns(loadJobs()[0].id)[0].status, "crashed");
  });
});

describe("runs", () => {
  it("lists newest first and tracks what was seen", async () => {
    addJob(makeJob({ name: "a" }));
    await executeJob("a");
    await executeJob("a");
    assert.ok(unseenRuns().length >= 2);
    markSeen(new Date(Date.now() + 1000));
    assert.equal(unseenRuns().length, 0);
    const runs = listRuns(loadJobs()[0].id);
    assert.equal(runs.length, 2);
    assert.ok(runs[0].finishedAt >= runs[1].finishedAt);
    assert.deepEqual(readJson(paths.state(), {}).constructor, Object);
  });
});
