import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyPatch, buildJob } from "../src/core/jobs.ts";
import { local, makeJob } from "./helpers.ts";

const now = local(2026, 9, 21, 12, 0);

describe("buildJob", () => {
  it("fills defaults", () => {
    const job = makeJob();
    assert.equal(job.tools, null);
    assert.deepEqual(job.skills, []);
    assert.equal(job.enabled, true);
    assert.equal(job.catchUp, true);
    assert.equal(job.timeoutMinutes, 30);
    assert.equal(job.nextRunAt, local(2026, 9, 21, 13, 0).toISOString());
    assert.match(job.id, /^[0-9a-f]{8}$/);
  });

  it("keeps an explicit empty tool list (no tools) and dedupes", () => {
    assert.deepEqual(makeJob({ tools: [] }).tools, []);
    assert.deepEqual(makeJob({ tools: ["read", " read", "bash"] }).tools, ["read", "bash"]);
  });

  it("validates", () => {
    const existing = [makeJob({ name: "Inbox" })];
    const base = { prompt: "x", schedule: "every 1h", cwd: "/" };
    assert.throws(() => buildJob({ ...base, name: "inbox" }, existing, now, { deliver: [] }), /already exists/);
    assert.throws(() => buildJob({ ...base, name: "a", prompt: " " }, [], now, { deliver: [] }), /Prompt/);
    assert.throws(
      () => buildJob({ ...base, name: "a", deliver: ["sms" as never] }, [], now, { deliver: [] }),
      /Unknown delivery target/,
    );
    assert.throws(() => buildJob({ ...base, name: "a", timeoutMinutes: 0 }, [], now, { deliver: [] }), /timeoutMinutes/);
  });
});

describe("applyPatch", () => {
  it("re-arms the clock on schedule change", () => {
    const job = makeJob();
    const later = local(2026, 9, 21, 15, 0);
    const next = applyPatch(job, { schedule: "daily 9:00" }, [job], later);
    assert.equal(next.nextRunAt, local(2026, 9, 22, 9, 0).toISOString());
  });

  it("resuming does not fire the backlog", () => {
    const paused = makeJob({ enabled: false });
    const later = local(2026, 9, 25, 10, 0);
    const resumed = applyPatch(paused, { enabled: true }, [paused], later);
    assert.equal(resumed.nextRunAt, local(2026, 9, 25, 11, 0).toISOString());
  });

  it("null tools restores pi defaults", () => {
    const job = makeJob({ tools: ["read"] });
    assert.equal(applyPatch(job, { tools: null }, [job], now).tools, null);
  });

  it("rejects renaming onto another job", () => {
    const a = makeJob({ name: "a" });
    const b = makeJob({ name: "b" });
    assert.throws(() => applyPatch(a, { name: "B" }, [a, b], now), /already exists/);
    assert.equal(applyPatch(a, { name: "a" }, [a, b], now).name, "a");
  });
});
