/**
 * Delivery of a finished run. The Markdown output file is always written by
 * the executor; these are the extra channels a job can opt into:
 *
 *   notify    desktop notification (macOS: osascript, Linux: notify-send,
 *             Windows: PowerShell tray balloon)
 *   telegram  message via a bot (config.telegram)
 *   webhook   JSON POST to config.webhookUrl
 *
 * Delivery never fails a run: each channel reports "ok" or an error string.
 * For e-mail, give the job an email tool (e.g. pi-email's email_send) and
 * ask for it in the prompt.
 */

import { execFile } from "node:child_process";
import type { CronConfig, CronJob, RunStatus } from "./types.ts";

export interface DeliveryPayload {
  readonly status: RunStatus;
  readonly body: string;
  readonly outputPath: string;
  readonly error: string | null;
}

export interface DeliveryDeps {
  readonly fetch: typeof fetch;
  readonly run: (cmd: string, args: string[]) => Promise<void>;
  readonly platform: NodeJS.Platform;
}

const defaultDeps: DeliveryDeps = {
  fetch: (...a) => fetch(...a),
  run: (cmd, args) =>
    new Promise((resolve, reject) =>
      execFile(cmd, args, { timeout: 20_000, windowsHide: true }, (err) => (err ? reject(err) : resolve())),
    ),
  platform: process.platform,
};

const TELEGRAM_LIMIT = 4000;

export function title(job: CronJob, status: RunStatus): string {
  return status === "ok" ? `pi-cron: ${job.name}` : `pi-cron: ${job.name} (${status})`;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** AppleScript string literal. */
function osa(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** PowerShell single-quoted string literal. */
function ps(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** Tray balloon via Windows Forms: available on every Windows without modules. */
export function windowsBalloon(heading: string, text: string): string {
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$n = New-Object System.Windows.Forms.NotifyIcon",
    "$n.Icon = [System.Drawing.SystemIcons]::Information",
    "$n.Visible = $true",
    `$n.ShowBalloonTip(10000, ${ps(heading)}, ${ps(text)}, 'Info')`,
    "Start-Sleep -Seconds 10",
    "$n.Dispose()",
  ].join("; ");
}

async function notify(job: CronJob, p: DeliveryPayload, deps: DeliveryDeps): Promise<void> {
  const text = truncate(p.body.replace(/\s+/g, " ").trim() || p.status, 200);
  if (deps.platform === "darwin") {
    await deps.run("osascript", ["-e", `display notification ${osa(text)} with title ${osa(title(job, p.status))}`]);
  } else if (deps.platform === "win32") {
    await deps.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", windowsBalloon(title(job, p.status), text)]);
  } else if (deps.platform !== "android") {
    await deps.run("notify-send", [title(job, p.status), text]);
  } else {
    throw new Error(`notifications not supported on ${deps.platform}`);
  }
}

async function telegram(job: CronJob, p: DeliveryPayload, config: CronConfig, deps: DeliveryDeps): Promise<void> {
  if (!config.telegram) throw new Error("telegram not configured (/cron telegram <botToken> <chatId>)");
  const text = truncate(`${title(job, p.status)}\n\n${p.body}`, TELEGRAM_LIMIT);
  const res = await deps.fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: config.telegram.chatId, text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`telegram HTTP ${res.status}: ${truncate(await res.text(), 200)}`);
}

async function webhook(job: CronJob, p: DeliveryPayload, config: CronConfig, deps: DeliveryDeps): Promise<void> {
  if (!config.webhookUrl) throw new Error("webhookUrl not configured");
  const res = await deps.fetch(config.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      job: { id: job.id, name: job.name },
      status: p.status,
      output: p.body,
      outputPath: p.outputPath,
      error: p.error,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
}

export async function deliver(
  job: CronJob,
  config: CronConfig,
  payload: DeliveryPayload,
  deps: DeliveryDeps = defaultDeps,
): Promise<Record<string, string>> {
  const report: Record<string, string> = { file: "ok" };
  for (const target of job.deliver) {
    try {
      if (target === "notify") await notify(job, payload, deps);
      else if (target === "telegram") await telegram(job, payload, config, deps);
      else if (target === "webhook") await webhook(job, payload, config, deps);
      report[target] = "ok";
    } catch (err) {
      report[target] = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return report;
}
