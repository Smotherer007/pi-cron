import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deliver, windowsBalloon } from "../src/core/delivery.ts";
import type { DeliveryDeps } from "../src/core/delivery.ts";
import { DEFAULT_CONFIG } from "../src/core/store.ts";
import { detectPiCommand, which } from "../src/setup.ts";
import { makeJob } from "./helpers.ts";

describe("detectPiCommand", () => {
  it("reuses node + the pi CLI script when pi runs on node", () => {
    assert.deepEqual(detectPiCommand("/usr/local/bin/node", import.meta.filename), ["/usr/local/bin/node", import.meta.filename]);
    assert.deepEqual(detectPiCommand("C:\\Program Files\\nodejs\\node.exe", import.meta.filename)[1], import.meta.filename);
  });
  it("uses a compiled pi binary directly", () => {
    assert.deepEqual(detectPiCommand("/opt/pi/bin/pi", "/whatever"), ["/opt/pi/bin/pi"]);
  });
  it("which finds executables on PATH", () => {
    assert.equal(which("node", process.env.PATH), which("node"));
    assert.equal(which("definitely-not-a-binary-xyz"), null);
  });
});

describe("deliver", () => {
  const calls: Array<{ kind: string; args: unknown }> = [];
  const deps = (platform: NodeJS.Platform): DeliveryDeps => ({
    platform,
    run: async (cmd, args) => {
      calls.push({ kind: cmd, args });
    },
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ kind: "fetch", args: { url, body: JSON.parse(String(init.body)) } });
      return new Response("ok", { status: url.includes("bad") ? 500 : 200 });
    }) as typeof fetch,
  });
  const payload = { status: "ok" as const, body: 'All "good"', outputPath: "/o.md", error: null };

  it("sends a notification, telegram and webhook, reporting each", async () => {
    calls.length = 0;
    const job = makeJob({ deliver: ["notify", "telegram", "webhook"] });
    const config = { ...DEFAULT_CONFIG, telegram: { botToken: "T", chatId: "42" }, webhookUrl: "https://hook" };
    const report = await deliver(job, config, payload, deps("darwin"));
    assert.deepEqual(report, { file: "ok", notify: "ok", telegram: "ok", webhook: "ok" });
    assert.equal(calls[0].kind, "osascript");
    assert.match(String((calls[0].args as string[])[1]), /All \\"good\\"/);
    assert.equal((calls[1].args as { url: string }).url, "https://api.telegram.org/botT/sendMessage");
    assert.equal((calls[2].args as { body: { status: string } }).body.status, "ok");
  });

  it("uses the native notifier per OS", async () => {
    const job = makeJob({ deliver: ["notify"] });
    calls.length = 0;
    await deliver(job, DEFAULT_CONFIG, payload, deps("linux"));
    await deliver(job, DEFAULT_CONFIG, payload, deps("win32"));
    assert.deepEqual(calls.map((c) => c.kind), ["notify-send", "powershell.exe"]);
    assert.match(windowsBalloon("it's", "x"), /'it''s'/);
  });

  it("never throws; unconfigured or failing channels are reported", async () => {
    const job = makeJob({ deliver: ["telegram", "webhook"] });
    const report = await deliver(job, { ...DEFAULT_CONFIG, webhookUrl: "https://bad" }, payload, deps("darwin"));
    assert.match(report.telegram, /not configured/);
    assert.match(report.webhook, /HTTP 500/);
  });
});
