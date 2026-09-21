/**
 * Plain data shapes shared by the extension, the scheduler and the executor.
 *
 * Everything here is serialised to JSON on disk (jobs.json, config.json,
 * runs/*.json), so it contains no classes, no Dates and no functions.
 * Only configuration and history are persisted; the scheduler itself lives in
 * the running pi process.
 */

/** A parsed schedule. `input` keeps what the user typed for display. */
export type Schedule =
  | { readonly kind: "cron"; readonly expr: string; readonly input: string }
  | { readonly kind: "every"; readonly everyMs: number; readonly input: string }
  | { readonly kind: "once"; readonly at: string; readonly input: string };

/** Where a finished run is reported. The output file is always written. */
export type DeliveryTarget = "notify" | "telegram" | "webhook";

/**
 * ok/error/timeout: the run finished. aborted: pi was closed mid-run.
 * crashed: pi died mid-run without cleaning up. Both of the latter re-run on
 * the next start. skipped: a missed slot with catchUp disabled.
 */
export type RunStatus = "ok" | "error" | "timeout" | "aborted" | "crashed" | "skipped";

export interface RunningInfo {
  /** The pi process that owns the run. */
  readonly pid: number;
  readonly startedAt: string;
  /** The headless pi child doing the work (to clean up if the owner died). */
  readonly childPid?: number;
}

/**
 * Optional limits on when a job may run, as ISO timestamps. `startAt` delays
 * the first run (a start in the future re-anchors intervals), `endAt` closes
 * the window: a slot after it never runs and the job ends with
 * `nextRunAt: null`. `null` means "no limit".
 */
export interface RunWindow {
  readonly startAt: string | null;
  readonly endAt: string | null;
}

export interface CronJob extends RunWindow {
  readonly id: string;
  readonly name: string;
  /** The prompt the agent receives when the job fires. */
  readonly prompt: string;
  readonly schedule: Schedule;
  /**
   * Tool allowlist for the run (`pi --tools`). `null` means pi's default
   * tool set, an empty array means no tools at all.
   */
  readonly tools: readonly string[] | null;
  /** Extra skills to load (`pi --skill <path>`). */
  readonly skills: readonly string[];
  /** Model pattern (`pi --model`), e.g. "sonnet" or "anthropic/claude-x:high". */
  readonly model: string | null;
  /** Working directory the agent runs in. */
  readonly cwd: string;
  readonly deliver: readonly DeliveryTarget[];
  readonly enabled: boolean;
  /** Run a missed slot once after downtime (sleep, reboot) instead of skipping it. */
  readonly catchUp: boolean;
  readonly timeoutMinutes: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** ISO timestamp of the next due run, `null` once a one-shot has fired or the window closed. */
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastStatus: RunStatus | null;
  readonly lastOutputPath: string | null;
  readonly runCount: number;
  readonly running: RunningInfo | null;
}

export interface JobsFile {
  readonly version: 1;
  readonly jobs: readonly CronJob[];
}

/** One finished (or skipped) run, stored as runs/<jobId>/<stamp>.json. */
export interface RunRecord {
  readonly jobId: string;
  readonly jobName: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly outputPath: string | null;
  readonly error: string | null;
  readonly delivery: Readonly<Record<string, string>>;
}

export interface TelegramConfig {
  readonly botToken: string;
  readonly chatId: string;
}

export interface CronConfig {
  /**
   * Command that starts a headless pi for a run. Empty = the same pi that is
   * running the scheduler (detected at runtime).
   */
  readonly piCommand: readonly string[];
  /** Extra environment variables for every run (API keys etc.). */
  readonly env: Readonly<Record<string, string>>;
  readonly telegram: TelegramConfig | null;
  readonly webhookUrl: string | null;
  /** Default delivery targets for new jobs. */
  readonly defaultDeliver: readonly DeliveryTarget[];
  /** Runs older than this many days are pruned. */
  readonly keepRunsDays: number;
}
