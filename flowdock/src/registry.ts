/**
 * Workflow registry — the Workflows-as-Code control plane (M1).
 *
 * This is the developer lock-in artifact: every push appends an immutable,
 * content-addressed version, so a team's workflow history accumulates here and
 * becomes the source of truth they can't walk away from. It is a SIBLING of
 * the run Store (not an extension) — runs and workflow definitions are
 * different lifecycles.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { atomicWrite } from "./store.ts";
import type { WorkflowMetadata, WorkflowVersionRecord } from "./types.ts";

export interface WorkflowRegistry {
  saveWorkflow(wf: WorkflowMetadata): void;
  getWorkflow(name: string): WorkflowMetadata | undefined;
  listWorkflows(): WorkflowMetadata[];
  saveWorkflowVersion(v: WorkflowVersionRecord): void;
  getWorkflowVersion(name: string, version: string): WorkflowVersionRecord | undefined;
  getWorkflowVersions(name: string): WorkflowVersionRecord[];
  getLatestVersion(name: string): WorkflowVersionRecord | undefined;
  /** Append a new version iff content changed; returns it, else undefined. */
  commit(name: string, normalizedYaml: string, author?: string): WorkflowVersionRecord | undefined;
}

/** sha256 hex of a string. */
export function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Canonical form of a workflow YAML: parse → re-serialize with sorted keys,
 * comments/whitespace stripped. Two files with the same meaning hash equal,
 * so cosmetic edits don't create spurious versions.
 */
export function normalizeYaml(yamlText: string): string {
  const parsed = parse(yamlText) as unknown;
  return stringify(parsed, { sortMapEntries: true }).trimEnd() + "\n";
}

/** Version label: time-ordered, with a per-name sequence to break ties. */
function versionLabel(seq: number, now: number): string {
  return `${now.toString(36)}_${seq}`;
}

interface RegistryShape {
  workflows: Record<string, WorkflowMetadata>;
  versions: Record<string, WorkflowVersionRecord[]>;
}

abstract class BaseRegistry implements WorkflowRegistry {
  protected data: RegistryShape = { workflows: {}, versions: {} };
  constructor(protected readonly clock: () => number = () => Date.now()) {}
  protected abstract persist(): void;

  saveWorkflow(wf: WorkflowMetadata) {
    this.data.workflows[wf.name] = wf;
    this.persist();
  }
  getWorkflow(name: string) {
    return this.data.workflows[name];
  }
  listWorkflows() {
    return Object.values(this.data.workflows);
  }
  saveWorkflowVersion(v: WorkflowVersionRecord) {
    (this.data.versions[v.name] ??= []).push(v);
    this.persist();
  }
  getWorkflowVersion(name: string, version: string) {
    return (this.data.versions[name] ?? []).find((v) => v.version === version);
  }
  getWorkflowVersions(name: string) {
    return [...(this.data.versions[name] ?? [])];
  }
  getLatestVersion(name: string) {
    const list = this.data.versions[name] ?? [];
    return list.length ? list[list.length - 1] : undefined;
  }

  /**
   * Append a version only if the content hash differs from the head. Returns
   * the new record, or undefined when the workflow is already up to date.
   */
  commit(name: string, normalizedYaml: string, author?: string): WorkflowVersionRecord | undefined {
    const hash = sha256Hex(normalizedYaml);
    const latest = this.getLatestVersion(name);
    if (latest && latest.yamlHash === hash) return undefined;
    const now = this.clock();
    const seq = this.getWorkflowVersions(name).length + 1;
    const record: WorkflowVersionRecord = {
      name,
      version: versionLabel(seq, now),
      yamlHash: hash,
      normalizedYaml,
      createdAt: now,
      ...(author ? { author } : {}),
    };
    this.saveWorkflowVersion(record);
    const existing = this.getWorkflow(name);
    this.saveWorkflow({
      name,
      yamlHash: hash,
      latestVersion: record.version,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(author ? { author } : {}),
    });
    return record;
  }
}

/** In-memory registry — tests and ephemeral use. */
export class MemoryRegistry extends BaseRegistry {
  protected persist() {
    /* nothing to flush */
  }
}

/** JSON-file registry, default at .flowdock/workflows.json. */
export class JsonRegistry extends BaseRegistry {
  constructor(
    private readonly path = join(".flowdock", "workflows.json"),
    clock?: () => number,
  ) {
    super(clock);
    if (existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, "utf8")) as RegistryShape;
      } catch {
        // start clean on corruption rather than crash a sync
      }
    }
  }
  protected persist() {
    atomicWrite(this.path, JSON.stringify(this.data, null, 2));
  }
}
