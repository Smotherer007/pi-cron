/**
 * pi-cron: scheduled prompts for the pi coding agent, modelled on Hermes cron.
 *
 * A job is a prompt + a schedule + the tools the run may use. Jobs and the
 * run history are stored in ~/.pi/agent/cron/. The scheduler itself lives in
 * the running pi: it checks every minute while pi is open and stops when pi
 * quits. Nothing runs in the background.
 *
 * - Slots missed while pi was closed run once at the next start (catchUp).
 * - A run cut off by quitting pi runs again at the next start.
 * - With several pi windows, one schedules (lease); the others take over if it quits.
 * - Every run is a fresh, headless pi session (`pi -p --tools …`) started as a
 *   child of this pi; its answer is saved as Markdown, announced in pi and
 *   optionally delivered (desktop notification, Telegram, webhook).
 *
 * Layout:
 *   src/core/         scheduler loop, lease, store, executor, schedules (no pi imports)
 *   src/tools.ts      cron_* tools for the model
 *   src/commands.ts   /cron slash command
 *   src/setup.ts      scheduler instance per pi process
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleCron, SUBCOMMANDS } from "./src/commands.ts";
import { unseenRuns } from "./src/core/runs.ts";
import { loadJobs } from "./src/core/store.ts";
import { notify, setNotifier, startScheduler, stopScheduler } from "./src/setup.ts";
import { createCronTools } from "./src/tools.ts";

export default function (pi: ExtensionAPI) {
  const tools = createCronTools(pi);
  pi.registerTool(tools.cronCreate);
  pi.registerTool(tools.cronList);
  pi.registerTool(tools.cronUpdate);
  pi.registerTool(tools.cronDelete);
  pi.registerTool(tools.cronRun);
  pi.registerTool(tools.cronResults);

  pi.registerCommand("cron", {
    description: "Scheduled prompts: list, add, run, pause, resume, remove, results, status",
    getArgumentCompletions: (prefix: string) => {
      const [sub, ...rest] = prefix.split(" ");
      if (rest.length === 0) {
        const items = SUBCOMMANDS.filter((s) => s.startsWith(sub)).map((s) => ({ value: s, label: s }));
        return items.length ? items : null;
      }
      const needle = rest.join(" ").toLowerCase();
      const items = loadJobs()
        .filter((j) => j.name.toLowerCase().startsWith(needle))
        .map((j) => ({ value: `${sub} ${j.name}`, label: j.name }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      try {
        await handleCron(pi, args ?? "", ctx);
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // Runs started by pi-cron (PI_CRON) and non-interactive pi (-p, json)
    // never schedule: jobs run only while a pi with a UI is open.
    if (process.env.PI_CRON || !ctx.hasUI) return;
    try {
      setNotifier((message, level) => ctx.ui.notify(message, level));
      startScheduler({
        onRunFinished: ({ record }) => {
          if (!record || record.status === "aborted") return;
          const ok = record.status === "ok";
          notify(`pi-cron: ${record.jobName} ${ok ? "finished" : record.status} – /cron results ${record.jobName}`, ok ? "info" : "warning");
        },
        onError: (err) => notify(`pi-cron: ${err instanceof Error ? err.message : String(err)}`, "error"),
      });

      const unseen = unseenRuns().filter((r) => r.status !== "aborted" && r.status !== "crashed");
      if (unseen.length > 0) {
        const failed = unseen.filter((r) => r.status !== "ok").length;
        ctx.ui.notify(
          `pi-cron: ${unseen.length} result(s) since you last looked${failed ? `, ${failed} failed` : ""} – /cron results`,
          failed ? "warning" : "info",
        );
      }
    } catch {
      // Never block pi's startup on cron housekeeping.
    }
  });

  pi.on("session_shutdown", async (event) => {
    // Switching sessions (/new, /resume, /fork) or /reload keeps the process
    // and its scheduler; only quitting pi stops it and aborts running jobs.
    if (event.reason !== "quit") return;
    setNotifier(undefined);
    await stopScheduler();
  });
}
