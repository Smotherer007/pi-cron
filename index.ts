/**
 * pi-cron: scheduled prompts for the pi coding agent, modelled on Hermes cron.
 *
 * A job is a prompt + a schedule + the tools the run may use. Jobs are stored
 * in ~/.pi/agent/cron/jobs.json and fired by a small OS-level service
 * (launchd on macOS, cron on Linux) that ticks every minute, so they run
 * whether or not pi is open and survive reboots. Every run is a fresh,
 * headless pi session; its answer is saved as Markdown and optionally
 * delivered (desktop notification, Telegram, webhook).
 *
 * Layout:
 *   src/core/   dependency-free scheduler, store, executor, OS service
 *               (also copied to ~/.pi/agent/cron/runtime and run by Node)
 *   src/tools.ts      cron_* tools for the model
 *   src/commands.ts   /cron slash command
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleCron, SUBCOMMANDS } from "./src/commands.ts";
import { unseenRuns } from "./src/core/runs.ts";
import { runtimeVersion, status, syncRuntime } from "./src/core/service.ts";
import { loadJobs } from "./src/core/store.ts";
import { packageVersion } from "./src/setup.ts";
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
    // Runs started by pi-cron itself stay quiet.
    if (process.env.PI_CRON || !ctx.hasUI) return;
    try {
      // After a package update, refresh the copy the OS service executes.
      const version = packageVersion();
      if (runtimeVersion() !== null && runtimeVersion() !== version && status().installed) {
        syncRuntime(undefined, version);
      }
      const unseen = unseenRuns();
      if (unseen.length > 0) {
        const failed = unseen.filter((r) => r.status !== "ok").length;
        ctx.ui.notify(
          `pi-cron: ${unseen.length} new result(s)${failed ? `, ${failed} failed` : ""} – /cron results`,
          failed ? "warning" : "info",
        );
      }
    } catch {
      // Never block pi's startup on cron housekeeping.
    }
  });
}
