/**
 * Log retention (M3) — the paywall.
 *
 * Prunes run + step history older than the plan's retention window. A developer
 * who relies on FlowDock's execution history to debug hits the Free 7-day wall
 * and upgrades to keep it. `UNLIMITED` retention keeps everything.
 */

import { UNLIMITED } from "./plans.ts";
import type { Store, PrunableStore } from "./store.ts";

export interface PruneResult {
  deleted: string[];
  kept: number;
  cutoff: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Delete runs whose end (or start, if still unfinished) is older than
 * `retentionDays` before `now`. A negative retention (UNLIMITED) is a no-op.
 */
export function pruneRuns(
  store: Store & PrunableStore,
  retentionDays: number,
  now: number,
): PruneResult {
  if (retentionDays === UNLIMITED) {
    return { deleted: [], kept: store.listRuns().length, cutoff: 0 };
  }
  const cutoff = now - retentionDays * DAY_MS;
  const deleted: string[] = [];
  let kept = 0;
  for (const run of store.listRuns()) {
    const ts = run.finishedAt ?? run.startedAt;
    if (ts < cutoff) {
      store.deleteRun(run.id);
      deleted.push(run.id);
    } else {
      kept++;
    }
  }
  return { deleted, kept, cutoff };
}
