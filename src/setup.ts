/**
 * Glue between the running pi process and the background service: works out
 * how to start pi and node outside of pi, installs the OS tick on first use,
 * keeps the runtime copy in sync with the package version, and starts
 * one-off runs.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "./core/paths.ts";
import { install, runtimeVersion, status, syncRuntime } from "./core/service.ts";
import type { ServiceStatus } from "./core/service.ts";
import { loadConfig } from "./core/store.ts";
import type { CronJob } from "./core/types.ts";

const MIN_NODE_MAJOR = 22;

export function packageVersion(): string {
  try {
    const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version ?? "dev";
  } catch {
    return "dev";
  }
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function which(name: string, pathEnv: string = process.env.PATH ?? ""): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, name);
    if (existsSync(full) && isExecutable(full)) return full;
  }
  return null;
}

function isNode(execPath: string): boolean {
  return /^node(\d+)?(\.exe)?$/.test(basename(execPath));
}

/**
 * How to start pi from launchd/cron. When pi runs on Node, reuse exactly this
 * interpreter and CLI script, which survives nvm/fnm shims not being on the
 * service PATH. A compiled pi binary is its own interpreter.
 */
export function detectPiCommand(execPath = process.execPath, argv1 = process.argv[1]): string[] {
  if (isNode(execPath) && argv1 && existsSync(argv1)) return [execPath, realpathSync(argv1)];
  if (!isNode(execPath)) return [execPath];
  const pi = which("pi");
  return pi ? [pi] : ["pi"];
}

/** A Node that can run .ts files natively (type stripping, Node >= 22.18). */
export function detectNode(execPath = process.execPath): string {
  if (isNode(execPath) && Number(process.versions.node.split(".")[0]) >= MIN_NODE_MAJOR) return execPath;
  const node = which("node");
  if (!node) throw new Error("No `node` found on PATH; pi-cron's background runner needs Node >= 22.18");
  return node;
}

export function ensureService(): { status: ServiceStatus; installedNow: boolean } {
  const current = status();
  const version = packageVersion();
  if (current.installed) {
    if (runtimeVersion() !== version) syncRuntime(undefined, version);
    return { status: current, installedNow: false };
  }
  const result = install({
    piCommand: detectPiCommand(),
    nodePath: detectNode(),
    path: process.env.PATH ?? "",
    version,
  });
  return { status: result, installedNow: true };
}

/** Start a job right now in the background, independent of its schedule. */
export function startRunNow(job: CronJob): number {
  const version = packageVersion();
  if (runtimeVersion() !== version) syncRuntime(undefined, version);
  const config = loadConfig();
  const nodePath = config.nodePath !== "node" ? config.nodePath : detectNode();
  mkdirSync(paths.logsDir(job.id), { recursive: true });
  const out = openSync(join(paths.logsDir(job.id), "runner.log"), "a");
  const child = spawn(nodePath, [join(paths.runtime(), "runner.ts"), "exec", job.id], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, PATH: config.path || process.env.PATH },
  });
  child.unref();
  return child.pid ?? 0;
}
