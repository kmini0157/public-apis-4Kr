/**
 * Execution timeline (M1 DX) — `flowdock logs <runId>`.
 *
 * Turns persisted run + step checkpoints into a per-node view developers rely
 * on for debugging. The debugging data they accumulate here is itself a
 * retention hook (longer log retention = a paid tier).
 */

import type { RunRecord, RunTimeline, StepRecord } from "./types.ts";

/** Typed timeline rows for JSON output and the server's GET /runs/{id}. */
export function buildTimeline(steps: StepRecord[]): RunTimeline[] {
  return steps.map((s) => ({
    nodeId: s.nodeId,
    status: s.status,
    attempts: s.attempts,
    latencyMs: s.latencyMs,
    ...(s.error ? { error: s.error } : {}),
  }));
}

const MARK: Record<string, string> = {
  succeeded: "✓",
  failed: "✗",
  running: "…",
  queued: "·",
  skipped: "⊘",
};

/** ASCII timeline for the terminal. Steps are shown in execution order. */
export function renderTimeline(run: RunRecord, steps: StepRecord[]): string {
  const lines: string[] = [];
  const dur = run.finishedAt ? `${run.finishedAt - run.startedAt}ms` : "in progress";
  lines.push(`run ${run.id} — ${run.workflowName} [${run.status}] (${dur})`);
  if (steps.length === 0) {
    lines.push("  (no steps recorded)");
    return lines.join("\n");
  }
  const width = Math.max(...steps.map((s) => s.nodeId.length));
  for (const s of steps) {
    const mark = MARK[s.status] ?? "?";
    const retries = s.attempts > 1 ? ` ×${s.attempts}` : "";
    const err = s.error ? `  — ${s.error}` : "";
    lines.push(`  ${mark} ${s.nodeId.padEnd(width)}  ${String(s.latencyMs).padStart(6)}ms${retries}${err}`);
  }
  return lines.join("\n");
}
