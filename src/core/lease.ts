/**
 * With several pi windows open, exactly one of them schedules jobs.
 *
 * scheduler.json holds the owner's pid and a heartbeat. Every open pi tries to
 * take the lease each minute; it succeeds when nobody holds it, when it holds
 * it already, or when the holder is gone (process dead or heartbeat stale).
 * The lease is released when pi quits, so another open window takes over
 * within a minute.
 */

import { rmSync } from "node:fs";
import { paths } from "./paths.ts";
import { isProcessAlive } from "./scheduler.ts";
import { readJson, withLock, writeJsonAtomic } from "./store.ts";

export interface Lease {
  readonly pid: number;
  readonly since: string;
  readonly heartbeatAt: string;
}

export const LEASE_STALE_MS = 3 * 60_000;

export function readLease(): Lease | null {
  return readJson<Lease | null>(paths.lease(), null);
}

export function isLeaseLive(lease: Lease | null, now: Date, alive: (pid: number) => boolean = isProcessAlive): boolean {
  if (!lease) return false;
  return now.getTime() - new Date(lease.heartbeatAt).getTime() < LEASE_STALE_MS && alive(lease.pid);
}

/** Take or renew the lease. True if `pid` now holds it. */
export function acquireLease(pid: number, now: Date = new Date(), alive: (pid: number) => boolean = isProcessAlive): boolean {
  return withLock(() => {
    const current = readLease();
    if (current && current.pid !== pid && isLeaseLive(current, now, alive)) return false;
    const since = current?.pid === pid ? current.since : now.toISOString();
    writeJsonAtomic(paths.lease(), { pid, since, heartbeatAt: now.toISOString() } satisfies Lease);
    return true;
  });
}

export function releaseLease(pid: number): void {
  withLock(() => {
    if (readLease()?.pid === pid) rmSync(paths.lease(), { force: true });
  });
}
