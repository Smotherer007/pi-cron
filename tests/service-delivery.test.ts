import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deliver } from "../src/core/delivery.ts";
import type { DeliveryDeps } from "../src/core/delivery.ts";
import { crontabLine, mergeCrontab, renderPlist, runtimeVersion, syncRuntime } from "../src/core/service.ts";
import { DEFAULT_CONFIG } from "../src/core/store.ts";
import { detectPiCommand } from "../src/setup.ts";
import { makeJob, useTempHome } from "./helpers.ts";

describe("service files", () => {
  it("renders a LaunchAgent that ticks every minute", () => {
    const plist = renderPlist("/opt/node/bin/node", "/Users/p/.pi/agent/cron/runtime/runner.ts", "/usr/bin:/bin", "/Users/p/.pi/agent/cron/runner.log");
    assert.match(plist, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
    assert.match(plist, /<string>\/opt\/node\/bin\/node<\/string>\s*<string>[^<]+runner\.ts<\/string>\s*<string>tick<\/string>/);
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<string>\/Users\/p\/\.pi\/agent\/cron<\/string>/);
  });

  it("escapes XML in paths", () => {
    assert.match(renderPlist("/a&b/node", "/r.ts", "/bin", "/l/x.log"), /\/a&amp;b\/node/);
  });

  it("merges exactly one crontab line and keeps the user's other entries", () => {
    const line = crontabLine("/usr/bin/node", "/home/p/my dir/runner.ts", "/home/p/.pi/agent/cron", "/home/p/.pi/agent/cron/runner.log");
    assert.match(line, /^\* \* \* \* \* PI_CRON_HOME=/);
    assert.match(line, /'\/home\/p\/my dir\/runner\.ts' tick/);
    const once = mergeCrontab("0 3 * * * backup.sh\n", line);
    const twice = mergeCrontab(once, line);
    assert.equal(once, twice);
    assert.equal(twice.split("\n").filter(Boolean).length, 2);
    assert.equal(mergeCrontab(twice, null), "0 3 * * * backup.sh\n");
  });
});

describe("runtime copy", () => {
  let home: ReturnType<typeof useTempHome>;
  before(() => {
    home = useTempHome();
  });
  after(() => home.cleanup());

  it("copies the core without tests and stamps the version", () => {
    const dir = syncRuntime(undefined, "1.2.3");
    assert.ok(existsSync(join(dir, "runner.ts")));
    assert.ok(existsSync(join(dir, "executor.ts")));
    assert.equal(runtimeVersion(), "1.2.3");
    assert.equal(readFileSync(join(dir, "VERSION"), "utf8").trim(), "1.2.3");
  });
});

describe("detectPiCommand", () => {
  it("reuses node + the pi CLI script when pi runs on node", () => {
    const cmd = detectPiCommand("/usr/local/bin/node", import.meta.filename);
    assert.deepEqual(cmd, ["/usr/local/bin/node", import.meta.filename]);
  });
  it("uses a compiled pi binary directly", () => {
    assert.deepEqual(detectPiCommand("/opt/pi/bin/pi", "/whatever"), ["/opt/pi/bin/pi"]);
  });
});

describe("deliver", () => {
  const calls: Array<{ kind: string; args: unknown }> = [];
  const deps: DeliveryDeps = {
    platform: "darwin",
    run: async (cmd, args) => {
      calls.push({ kind: cmd, args });
    },
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ kind: "fetch", args: { url, body: JSON.parse(String(init.body)) } });
      return new Response("ok", { status: url.includes("bad") ? 500 : 200 });
    }) as typeof fetch,
  };
  const payload = { status: "ok" as const, body: 'All "good"', outputPath: "/o.md", error: null };

  it("sends a notification, telegram and webhook, reporting each", async () => {
    calls.length = 0;
    const job = makeJob({ deliver: ["notify", "telegram", "webhook"] });
    const config = { ...DEFAULT_CONFIG, telegram: { botToken: "T", chatId: "42" }, webhookUrl: "https://hook" };
    const report = await deliver(job, config, payload, deps);
    assert.deepEqual(report, { file: "ok", notify: "ok", telegram: "ok", webhook: "ok" });
    assert.equal(calls[0].kind, "osascript");
    assert.match(String((calls[0].args as string[])[1]), /All \\"good\\"/);
    assert.equal((calls[1].args as { url: string }).url, "https://api.telegram.org/botT/sendMessage");
    assert.equal((calls[2].args as { body: { status: string } }).body.status, "ok");
  });

  it("never throws; unconfigured or failing channels are reported", async () => {
    const job = makeJob({ deliver: ["telegram", "webhook"] });
    const report = await deliver(job, { ...DEFAULT_CONFIG, webhookUrl: "https://bad" }, payload, deps);
    assert.match(report.telegram, /not configured/);
    assert.match(report.webhook, /HTTP 500/);
  });
});
