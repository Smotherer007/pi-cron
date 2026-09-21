#!/usr/bin/env node
/**
 * Background entry point, run directly by Node (native TypeScript):
 *
 *   node runner.ts tick          check jobs and start the due ones (every minute)
 *   node runner.ts exec <job>    run one job now, in the foreground
 *   node runner.ts list          print jobs
 *
 * Imports only files from this directory and node:*, so it runs from the
 * runtime/ copy without any node_modules.
 */

import { executeJob } from "./executor.ts";
import { describeSchedule, formatLocal } from "./schedule.ts";
import { loadJobs } from "./store.ts";
import { tick } from "./tick.ts";

async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;
  switch (cmd) {
    case "tick": {
      const r = tick();
      if (r.started.length || r.skipped.length || r.crashed.length) {
        console.log(
          `[${formatLocal(new Date())}] started: ${r.started.join(", ") || "-"} | skipped: ${r.skipped.join(", ") || "-"} | crashed: ${r.crashed.join(", ") || "-"}`,
        );
      }
      return 0;
    }
    case "exec": {
      if (!arg) {
        console.error("usage: runner.ts exec <job id or name>");
        return 2;
      }
      const r = await executeJob(arg);
      console.log(`[${formatLocal(new Date())}] ${r.message}`);
      return r.record ? 0 : 1;
    }
    case "list": {
      for (const j of loadJobs()) {
        const next = j.nextRunAt ? formatLocal(new Date(j.nextRunAt)) : "-";
        console.log(`${j.id}  ${j.enabled ? "on " : "off"}  ${j.name}  [${describeSchedule(j.schedule)}]  next ${next}  last ${j.lastStatus ?? "-"}`);
      }
      return 0;
    }
    default:
      console.error("usage: runner.ts tick | exec <job> | list");
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  },
);
