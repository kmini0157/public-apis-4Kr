/**
 * Run/step persistence — the durability layer.
 *
 * The engine writes a checkpoint after every node, so a re-run with the same
 * runId skips already-succeeded nodes (node-level idempotency). The interface
 * is intentionally small so the JSON-file dev store can be swapped for D1 /
 * Turso / Postgres without touching the engine.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunRecord, StepRecord } from "./types.ts";

export interface Store {
  saveRun(run: RunRecord): void;
  getRun(runId: string): RunRecord | undefined;
  saveStep(step: StepRecord): void;
  getStep(runId: string, nodeId: string): StepRecord | undefined;
  getSteps(runId: string): StepRecord[];
}

/**
 * Optional capability for stores that can answer run-level queries — used by
 * the trigger server for GET /runs and webhook replay protection. Kept separate
 * from the base Store so the engine and existing impls are unaffected.
 */
export interface RunQueryStore {
  getRunsForWorkflow(workflowName: string): RunRecord[];
  getRunByIdempotencyKey(key: string): RunRecord | undefined;
}

/**
 * Optional capability for stores that can enumerate and delete runs — used by
 * retention pruning (the log-retention paywall). Deleting a run also removes
 * its step checkpoints.
 */
export interface PrunableStore {
  listRuns(): RunRecord[];
  deleteRun(runId: string): void;
}

/** Atomic file write (temp + rename) so a crash mid-write can't truncate state. */
function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** Zero-dependency in-memory store — used by tests and ephemeral runs. */
export class MemoryStore implements Store, RunQueryStore, PrunableStore {
  private runs = new Map<string, RunRecord>();
  private steps = new Map<string, StepRecord>();
  private key(runId: string, nodeId: string) {
    return `${runId}::${nodeId}`;
  }
  saveRun(run: RunRecord) {
    this.runs.set(run.id, run);
  }
  getRun(runId: string) {
    return this.runs.get(runId);
  }
  saveStep(step: StepRecord) {
    this.steps.set(this.key(step.runId, step.nodeId), step);
  }
  getStep(runId: string, nodeId: string) {
    return this.steps.get(this.key(runId, nodeId));
  }
  getSteps(runId: string) {
    return [...this.steps.values()].filter((s) => s.runId === runId);
  }
  getRunsForWorkflow(workflowName: string) {
    return [...this.runs.values()].filter((r) => r.workflowName === workflowName);
  }
  getRunByIdempotencyKey(key: string) {
    return [...this.runs.values()].find((r) => r.idempotencyKey === key);
  }
  listRuns() {
    return [...this.runs.values()];
  }
  deleteRun(runId: string) {
    this.runs.delete(runId);
    for (const key of [...this.steps.keys()]) {
      if (key.startsWith(`${runId}::`)) this.steps.delete(key);
    }
  }
}

interface FileShape {
  runs: Record<string, RunRecord>;
  steps: Record<string, StepRecord>;
}

/** JSON-file store: durable across process restarts, good enough for dev. */
export class JsonStore implements Store, RunQueryStore, PrunableStore {
  private data: FileShape = { runs: {}, steps: {} };

  constructor(private readonly path = join(".flowdock", "state.json")) {
    if (existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, "utf8")) as FileShape;
      } catch {
        // corrupt/partial file — start clean rather than crash a run
      }
    }
  }
  private flush() {
    atomicWrite(this.path, JSON.stringify(this.data, null, 2));
  }
  private key(runId: string, nodeId: string) {
    return `${runId}::${nodeId}`;
  }
  saveRun(run: RunRecord) {
    this.data.runs[run.id] = run;
    this.flush();
  }
  getRun(runId: string) {
    return this.data.runs[runId];
  }
  saveStep(step: StepRecord) {
    this.data.steps[this.key(step.runId, step.nodeId)] = step;
    this.flush();
  }
  getStep(runId: string, nodeId: string) {
    return this.data.steps[this.key(runId, nodeId)];
  }
  getSteps(runId: string) {
    return Object.values(this.data.steps).filter((s) => s.runId === runId);
  }
  getRunsForWorkflow(workflowName: string) {
    return Object.values(this.data.runs).filter((r) => r.workflowName === workflowName);
  }
  getRunByIdempotencyKey(key: string) {
    return Object.values(this.data.runs).find((r) => r.idempotencyKey === key);
  }
  listRuns() {
    return Object.values(this.data.runs);
  }
  deleteRun(runId: string) {
    delete this.data.runs[runId];
    for (const key of Object.keys(this.data.steps)) {
      if (key.startsWith(`${runId}::`)) delete this.data.steps[key];
    }
    this.flush();
  }
}

/** Shared atomic-write helper for sibling stores (registry, webhook secrets). */
export { atomicWrite };
