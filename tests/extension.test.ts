/**
 * The pi-facing layer: tool shapes, tool behaviour against a fake pi, and
 * registration through the extension entry point.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import extension from "../index.ts";
import { loadJobs, saveJobs } from "../src/core/store.ts";
import { createCronTools } from "../src/tools.ts";
import { useTempHome } from "./helpers.ts";

const fakePi = {
  getAllTools: () => ["read", "bash", "email_fetch", "email_send"].map((name) => ({ name })),
} as never;

let installs = 0;
let runs: string[] = [];
const deps = {
  ensureService: () => {
    installs++;
    return { status: { installed: true, platform: "linux" as const, detail: "fake" }, installedNow: installs === 1 };
  },
  startRunNow: (job: { name: string }) => {
    runs.push(job.name);
    return 123;
  },
};
const tools = createCronTools(fakePi, deps as never);
const ctx = { cwd: tmpdir() };
const call = (tool: { execute: Function }, params: object) => tool.execute("id", params, undefined, undefined, ctx);

let home: ReturnType<typeof useTempHome>;
before(() => {
  home = useTempHome();
});
after(() => home.cleanup());
beforeEach(() => {
  saveJobs([]);
  runs = [];
});

describe("tool shapes", () => {
  const all = Object.values(tools);
  it("has six uniquely named cron_ tools with the required fields", () => {
    assert.equal(all.length, 6);
    assert.equal(new Set(all.map((t) => t.name)).size, 6);
    for (const t of all) {
      assert.match(t.name, /^cron_/);
      assert.ok(t.label && t.description && t.parameters);
      assert.equal(typeof t.execute, "function");
    }
  });
});

describe("cron tools", () => {
  it("creates a job with prompt, schedule and tool allowlist", async () => {
    const r = await call(tools.cronCreate, {
      name: "inbox",
      prompt: "Summarise unread mail",
      schedule: "weekdays 8:00",
      tools: ["email_fetch"],
    });
    assert.match(r.content[0].text, /Created "inbox" – weekdays 8:00 \(cron 0 8 \* \* 1-5\)/);
    assert.match(r.content[0].text, /tools: email_fetch/);
    const [job] = loadJobs();
    assert.deepEqual(job.tools, ["email_fetch"]);
    assert.equal(job.cwd, ctx.cwd);
  });

  it("rejects tools pi does not know", async () => {
    await assert.rejects(
      call(tools.cronCreate, { name: "x", prompt: "p", schedule: "every 1h", tools: ["telepathy"] }),
      /Unknown tool\(s\): telepathy/,
    );
    assert.equal(loadJobs().length, 0);
  });

  it("lists, updates, pauses, runs and deletes", async () => {
    await call(tools.cronCreate, { name: "report", prompt: "p", schedule: "daily 9:00" });

    assert.match((await call(tools.cronList, {})).content[0].text, /report .* active · daily 9:00/);

    const upd = await call(tools.cronUpdate, { job: "report", enabled: false, tools: ["read", "bash"] });
    assert.match(upd.content[0].text, /paused/);
    assert.deepEqual(loadJobs()[0].tools, ["read", "bash"]);

    await call(tools.cronRun, { job: "rep" });
    assert.deepEqual(runs, ["report"]);

    assert.match((await call(tools.cronResults, { job: "report" })).content[0].text, /not run yet/);

    await call(tools.cronDelete, { job: "report" });
    assert.equal(loadJobs().length, 0);
    await assert.rejects(call(tools.cronDelete, { job: "report" }), /No cron job/);
  });
});

describe("extension entry point", () => {
  it("registers the tools, the /cron command and a session_start hook", () => {
    const registered: string[] = [];
    const commands: string[] = [];
    const events: string[] = [];
    extension({
      registerTool: (t: { name: string }) => registered.push(t.name),
      registerCommand: (n: string) => commands.push(n),
      on: (e: string) => events.push(e),
      getAllTools: () => [],
    } as never);
    assert.deepEqual(registered.sort(), ["cron_create", "cron_delete", "cron_list", "cron_results", "cron_run", "cron_update"]);
    assert.deepEqual(commands, ["cron"]);
    assert.deepEqual(events, ["session_start"]);
  });
});

describe("service failures", () => {
  it("keeps the job and warns when the background service cannot be installed", async () => {
    saveJobs([]);
    const broken = createCronTools(fakePi, {
      ensureService: () => {
        throw new Error("crontab not found");
      },
      startRunNow: () => 0,
    } as never);
    const r = await call(broken.cronCreate, { name: "w", prompt: "p", schedule: "every 1h" });
    assert.match(r.content[0].text, /WARNING.*crontab not found/);
    assert.equal(loadJobs().length, 1);
  });
});
