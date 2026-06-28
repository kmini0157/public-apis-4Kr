import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTimeline, buildTimeline } from "../src/timeline.ts";
import type { RunRecord, StepRecord } from "../src/types.ts";

const run: RunRecord = {
  id: "run_1",
  workflowName: "demo",
  status: "failed",
  startedAt: 1000,
  finishedAt: 1500,
};
const steps: StepRecord[] = [
  { runId: "run_1", nodeId: "fetch", status: "succeeded", attempts: 1, latencyMs: 120 },
  { runId: "run_1", nodeId: "send", status: "failed", attempts: 3, latencyMs: 50, error: "boom" },
];

test("buildTimeline maps step records to typed rows", () => {
  const rows = buildTimeline(steps);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], { nodeId: "send", status: "failed", attempts: 3, latencyMs: 50, error: "boom" });
});

test("renderTimeline shows status, latency, retries and errors", () => {
  const out = renderTimeline(run, steps);
  assert.match(out, /run_1 — demo \[failed\] \(500ms\)/);
  assert.match(out, /✓ fetch/);
  assert.match(out, /✗ send/);
  assert.match(out, /×3/);
  assert.match(out, /boom/);
});

test("renderTimeline handles a run with no steps", () => {
  assert.match(renderTimeline({ ...run, finishedAt: undefined }, []), /no steps recorded/);
});
