/**
 * Reading run history back: newest first, optionally per job, and "unseen"
 * results since the user last looked (for the notice when pi starts).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.ts";
import { readJson, writeJsonAtomic } from "./store.ts";
import type { RunRecord } from "./types.ts";

interface UiState {
  readonly lastSeenAt: string | null;
}

export function listRuns(jobId?: string, limit = 20): RunRecord[] {
  const root = paths.runsRoot();
  if (!existsSync(root)) return [];
  const dirs = jobId ? [jobId] : readdirSync(root);
  const records: RunRecord[] = [];
  for (const dir of dirs) {
    const full = join(root, dir);
    if (!existsSync(full)) continue;
    for (const file of readdirSync(full)) {
      if (!file.endsWith(".json")) continue;
      try {
        records.push(JSON.parse(readFileSync(join(full, file), "utf8")) as RunRecord);
      } catch {
        // half-written or foreign file: ignore
      }
    }
  }
  return records.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt)).slice(0, limit);
}

export function unseenRuns(): RunRecord[] {
  const { lastSeenAt } = readJson<UiState>(paths.state(), { lastSeenAt: null });
  return listRuns(undefined, 200).filter((r) => r.status !== "skipped" && (!lastSeenAt || r.finishedAt > lastSeenAt));
}

export function markSeen(now: Date = new Date()): void {
  writeJsonAtomic(paths.state(), { lastSeenAt: now.toISOString() } satisfies UiState);
}

export function readOutput(record: RunRecord, maxChars = 20_000): string {
  if (!record.outputPath || !existsSync(record.outputPath)) return record.error ?? "(no output)";
  const text = readFileSync(record.outputPath, "utf8");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n… (truncated, full output: ${record.outputPath})` : text;
}
