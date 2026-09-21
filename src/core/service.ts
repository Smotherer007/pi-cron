/**
 * Registers the minute tick with the operating system so jobs run whether or
 * not pi is open, and survive reboots:
 *
 *   macOS  LaunchAgent ~/Library/LaunchAgents/<LABEL>.plist (StartInterval 60)
 *   Linux  one line in the user's crontab, tagged "# pi-cron"
 *
 * The OS scheduler starts a COPY of src/core in ~/.pi/agent/cron/runtime/.
 * Node refuses to strip TypeScript types from files inside node_modules, which
 * is where `pi install npm:…` puts this package, and the copy also keeps the
 * service working while the package is being updated.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "./paths.ts";
import { ensureHome, saveConfig } from "./store.ts";

export const LABEL = "dev.pi.cron";
const CRON_TAG = "# pi-cron";

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderPlist(nodePath: string, runner: string, pathEnv: string, logFile: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(runner)}</string>
    <string>tick</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(pathEnv)}</string>
    <key>PI_CRON_HOME</key>
    <string>${xml(dirname(logFile))}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function crontabLine(nodePath: string, runner: string, home: string, logFile: string): string {
  const q = shellQuote;
  return `* * * * * PI_CRON_HOME=${q(home)} ${q(nodePath)} ${q(runner)} tick >> ${q(logFile)} 2>&1 ${CRON_TAG}`;
}

/** Replace our line in an existing crontab, leaving everything else alone. */
export function mergeCrontab(existing: string, line: string | null): string {
  const kept = existing.split("\n").filter((l) => l.trim() !== "" && !l.includes(CRON_TAG));
  if (line) kept.push(line);
  return kept.length ? `${kept.join("\n")}\n` : "";
}

function sh(cmd: string, args: string[], input?: string): string {
  return execFileSync(cmd, args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
}

/** Directory holding this file (src/core in the package, or runtime/). */
export function coreDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Copy the dependency-free core into runtime/, skipping tests. */
export function syncRuntime(sourceDir: string = coreDir(), version = "dev"): string {
  const target = paths.runtime();
  if (sourceDir === target) return target;
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const file of readdirSync(sourceDir)) {
    if (file.endsWith(".ts") && !file.endsWith(".test.ts")) copyFileSync(join(sourceDir, file), join(target, file));
  }
  writeFileSync(join(target, "VERSION"), `${version}\n`);
  // The copy lives outside any package; make sure Node treats it as ESM.
  writeFileSync(join(target, "package.json"), `${JSON.stringify({ type: "module", private: true })}\n`);
  return target;
}

export function runtimeVersion(): string | null {
  const f = join(paths.runtime(), "VERSION");
  return existsSync(f) ? readFileSync(f, "utf8").trim() : null;
}

export interface InstallOptions {
  readonly piCommand: readonly string[];
  readonly nodePath: string;
  readonly path: string;
  readonly version: string;
}

export interface ServiceStatus {
  readonly installed: boolean;
  readonly platform: NodeJS.Platform;
  readonly detail: string;
}

export function install(opts: InstallOptions): ServiceStatus {
  ensureHome();
  saveConfig({ piCommand: opts.piCommand, nodePath: opts.nodePath, path: opts.path });
  const runner = join(syncRuntime(coreDir(), opts.version), "runner.ts");
  const log = paths.runnerLog();

  if (process.platform === "darwin") {
    const plist = plistPath();
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, renderPlist(opts.nodePath, runner, opts.path, log));
    const domain = `gui/${userInfo().uid}`;
    try {
      sh("launchctl", ["bootout", `${domain}/${LABEL}`]);
    } catch {
      // not loaded yet
    }
    sh("launchctl", ["bootstrap", domain, plist]);
    return { installed: true, platform: "darwin", detail: `LaunchAgent ${plist}` };
  }

  if (process.platform === "linux") {
    let current = "";
    try {
      current = sh("crontab", ["-l"]);
    } catch {
      // no crontab yet
    }
    sh("crontab", ["-"], mergeCrontab(current, crontabLine(opts.nodePath, runner, dirname(log), log)));
    return { installed: true, platform: "linux", detail: "crontab entry (# pi-cron)" };
  }

  throw new Error(`Unsupported platform ${process.platform}. Run "node ${runner} tick" every minute yourself.`);
}

export function uninstall(): ServiceStatus {
  if (process.platform === "darwin") {
    try {
      sh("launchctl", ["bootout", `gui/${userInfo().uid}/${LABEL}`]);
    } catch {
      // not loaded
    }
    rmSync(plistPath(), { force: true });
  } else if (process.platform === "linux") {
    try {
      sh("crontab", ["-"], mergeCrontab(sh("crontab", ["-l"]), null));
    } catch {
      // no crontab
    }
  }
  return { installed: false, platform: process.platform, detail: "removed (jobs.json is kept)" };
}

export function status(): ServiceStatus {
  if (process.platform === "darwin") {
    if (!existsSync(plistPath())) return { installed: false, platform: "darwin", detail: "LaunchAgent not installed" };
    try {
      sh("launchctl", ["print", `gui/${userInfo().uid}/${LABEL}`]);
      return { installed: true, platform: "darwin", detail: "LaunchAgent loaded" };
    } catch {
      return { installed: false, platform: "darwin", detail: "plist exists but is not loaded" };
    }
  }
  if (process.platform === "linux") {
    try {
      const has = sh("crontab", ["-l"]).includes(CRON_TAG);
      return { installed: has, platform: "linux", detail: has ? "crontab entry present" : "no crontab entry" };
    } catch {
      return { installed: false, platform: "linux", detail: "no crontab" };
    }
  }
  return { installed: false, platform: process.platform, detail: "unsupported platform" };
}
