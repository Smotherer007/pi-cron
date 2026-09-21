/**
 * On-disk layout. Everything lives under one directory so it survives pi
 * updates, reboots and reinstalls of the package:
 *
 *   ~/.pi/agent/cron/
 *     jobs.json              job definitions + scheduling state
 *     config.json            runner settings (pi command, PATH, delivery)
 *     state.json             UI state (which results were already seen)
 *     .lock/                 mutex for jobs.json
 *     output/<job>/<t>.md    final answer of each run
 *     runs/<job>/<t>.json    run metadata (status, duration, delivery)
 *     logs/<job>/<t>.log     stderr of each run
 *     sessions/<job>/        full pi session of each run
 *     runtime/               copy of the runner the OS scheduler starts
 *     runner.log             output of the OS scheduler itself
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
  runtime: () => join(cronHome(), "runtime"),
  runnerLog: () => join(cronHome(), "runner.log"),
};

/** Filesystem-safe timestamp, sortable: 2026-09-21T08-00-00-000Z */
export function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-");
}
