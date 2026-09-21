/**
 * On-disk layout. Only configuration and history live here; the scheduler
 * itself runs inside pi and keeps no state that must survive a restart:
 *
 *   ~/.pi/agent/cron/
 *     jobs.json              job definitions + scheduling state
 *     config.json            delivery settings, extra env for runs
 *     state.json             which results were already seen
 *     scheduler.json         which open pi process is scheduling (lease)
 *     .lock/                 mutex for the JSON files
 *     output/<job>/<t>.md    final answer of each run
 *     runs/<job>/<t>.json    run history (status, duration, delivery)
 *     logs/<job>/<t>.log     stderr of each run
 *     sessions/<job>/        full pi session of each run
 *
 * Override with PI_CRON_HOME (tests) or PI_CODING_AGENT_DIR (pi's own knob).
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function cronHome(): string {
  return process.env.PI_CRON_HOME || join(agentDir(), "cron");
}

export const paths = {
  jobs: () => join(cronHome(), "jobs.json"),
  config: () => join(cronHome(), "config.json"),
  state: () => join(cronHome(), "state.json"),
  lock: () => join(cronHome(), ".lock"),
  outputDir: (jobId: string) => join(cronHome(), "output", jobId),
  runsDir: (jobId: string) => join(cronHome(), "runs", jobId),
  runsRoot: () => join(cronHome(), "runs"),
  logsDir: (jobId: string) => join(cronHome(), "logs", jobId),
  sessionsDir: (jobId: string) => join(cronHome(), "sessions", jobId),
  lease: () => join(cronHome(), "scheduler.json"),
};

/** Filesystem-safe timestamp, sortable: 2026-09-21T08-00-00-000Z */
export function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-");
}
