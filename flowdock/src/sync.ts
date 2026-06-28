/**
 * WorkflowSyncer — `flowdock push/pull/diff/history`.
 *
 * Bridges the workflows/ directory (what developers edit + commit to Git) and
 * the version registry (the immutable history). push only writes a version when
 * content actually changed; pull reconstructs files from the registry head.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflow } from "./loader.ts";
import { normalizeYaml, sha256Hex } from "./registry.ts";
import type { WorkflowRegistry } from "./registry.ts";
import type { WorkflowLockFile, WorkflowVersionRecord } from "./types.ts";

export interface SyncOptions {
  clock?: () => number;
  author?: string;
  dryRun?: boolean;
}

export interface WorkflowSyncResult {
  pushed: string[];
  pulled: string[];
  unchanged: string[];
  errors: Record<string, string>;
}

export interface DiffResult {
  added: string[]; // local, not in registry
  removed: string[]; // in registry, not local
  modified: Array<{ name: string; localHash: string; storedHash: string }>;
  unchanged: string[];
}

interface LocalWorkflow {
  name: string;
  file: string;
  normalized: string;
  hash: string;
}

export class WorkflowSyncer {
  private readonly clock: () => number;
  constructor(
    private readonly registry: WorkflowRegistry,
    private readonly projectDir: string,
    private readonly opts: SyncOptions = {},
  ) {
    this.clock = opts.clock ?? (() => Date.now());
  }

  private lockPath(): string {
    return join(this.projectDir, "flowdock.lock.json");
  }

  /** Read + validate every *.yaml in the workflows dir. Per-file errors collected. */
  private readLocal(workflowsDir: string): { ok: LocalWorkflow[]; errors: Record<string, string> } {
    const dir = join(this.projectDir, workflowsDir);
    const ok: LocalWorkflow[] = [];
    const errors: Record<string, string> = {};
    if (!existsSync(dir)) return { ok, errors };
    for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
      const full = join(dir, file);
      try {
        const text = readFileSync(full, "utf8");
        const wf = parseWorkflow(text); // validate before hashing
        const normalized = normalizeYaml(text);
        ok.push({ name: wf.name, file, normalized, hash: sha256Hex(normalized) });
      } catch (err) {
        errors[file] = (err as Error).message;
      }
    }
    return { ok, errors };
  }

  private writeLock(entries: Array<{ name: string; version: string; hash: string }>): void {
    if (this.opts.dryRun) return;
    const lock: WorkflowLockFile = {
      version: "1.0",
      timestamp: this.clock(),
      workflows: Object.fromEntries(entries.map((e) => [e.name, { version: e.version, yamlHash: e.hash }])),
    };
    writeFileSync(this.lockPath(), JSON.stringify(lock, null, 2));
  }

  /** Push local workflow files into the registry as new versions when changed. */
  push(workflowsDir: string): WorkflowSyncResult {
    const { ok, errors } = this.readLocal(workflowsDir);
    const result: WorkflowSyncResult = { pushed: [], pulled: [], unchanged: [], errors };
    const lockEntries: Array<{ name: string; version: string; hash: string }> = [];
    for (const wf of ok) {
      const latest = this.registry.getLatestVersion(wf.name);
      if (latest?.yamlHash === wf.hash) {
        result.unchanged.push(wf.name);
        lockEntries.push({ name: wf.name, version: latest.version, hash: wf.hash });
        continue;
      }
      if (this.opts.dryRun) {
        result.pushed.push(wf.name);
        continue;
      }
      const rec = this.registry.commit(wf.name, wf.normalized, this.opts.author);
      if (rec) {
        result.pushed.push(wf.name);
        lockEntries.push({ name: wf.name, version: rec.version, hash: rec.yamlHash });
      }
    }
    this.writeLock(lockEntries);
    return result;
  }

  /** Reconstruct workflow files from registry heads (idempotent). */
  pull(workflowsDir: string): WorkflowSyncResult {
    const result: WorkflowSyncResult = { pushed: [], pulled: [], unchanged: [], errors: {} };
    const dir = join(this.projectDir, workflowsDir);
    if (!this.opts.dryRun) mkdirSync(dir, { recursive: true });
    const lockEntries: Array<{ name: string; version: string; hash: string }> = [];
    for (const meta of this.registry.listWorkflows()) {
      const latest = this.registry.getLatestVersion(meta.name);
      if (!latest) continue;
      const file = join(dir, `${meta.name}.yaml`);
      lockEntries.push({ name: meta.name, version: latest.version, hash: latest.yamlHash });
      const current = existsSync(file) ? sha256Hex(normalizeYaml(readFileSync(file, "utf8"))) : undefined;
      if (current === latest.yamlHash) {
        result.unchanged.push(meta.name);
        continue;
      }
      if (!this.opts.dryRun) writeFileSync(file, latest.normalizedYaml);
      result.pulled.push(meta.name);
    }
    this.writeLock(lockEntries);
    return result;
  }

  /** Compare local files against registry heads. */
  diff(workflowsDir: string, only?: string): DiffResult {
    const { ok } = this.readLocal(workflowsDir);
    const localByName = new Map(ok.map((w) => [w.name, w]));
    const names = new Set<string>([
      ...localByName.keys(),
      ...this.registry.listWorkflows().map((w) => w.name),
    ]);
    const out: DiffResult = { added: [], removed: [], modified: [], unchanged: [] };
    for (const name of names) {
      if (only && name !== only) continue;
      const local = localByName.get(name);
      const stored = this.registry.getLatestVersion(name);
      if (local && !stored) out.added.push(name);
      else if (!local && stored) out.removed.push(name);
      else if (local && stored && local.hash !== stored.yamlHash) {
        out.modified.push({ name, localHash: local.hash, storedHash: stored.yamlHash });
      } else if (local && stored) out.unchanged.push(name);
    }
    return out;
  }

  getHistory(name: string): WorkflowVersionRecord[] {
    return this.registry.getWorkflowVersions(name);
  }
}
