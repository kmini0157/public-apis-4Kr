/**
 * The durable workflow engine.
 *
 * Responsibilities the connector author never has to think about:
 *   1. Order   — topological sort of the node DAG (edges inferred from
 *                {{ nodes.x }} references plus explicit `needs`).
 *   2. Resume  — every node's output is checkpointed; a re-run with the same
 *                runId skips succeeded nodes, so a mid-workflow crash never
 *                re-sends an email or loses upstream results.
 *   3. Resilience — per-node retry with exponential backoff.
 *   4. Throttle — a rate-limited, timed-out, secret-masking `fetch` is injected
 *                 into each connector call.
 */

import { randomUUID } from "node:crypto";
import { resolve, referencedNodes, interpolate, evalExpr, isTruthy } from "./expr.ts";
import { RateLimiter } from "./ratelimit.ts";
import { maskingLogger } from "./vault.ts";
import { enforceEgress, type EgressResolver } from "./sandbox.ts";
import type { ConnectorRegistry } from "./connectors/index.ts";
import type { Store } from "./store.ts";
import type {
  ConnectorContext,
  Json,
  NodeSpec,
  RetrySpec,
  RunRecord,
  RunStatus,
  StepRecord,
  Workflow,
} from "./types.ts";

const DEFAULT_RETRY: RetrySpec = { max: 2, backoffMs: 500 };

export interface EngineOptions {
  registry: ConnectorRegistry;
  store: Store;
  rateLimiter?: RateLimiter;
  /** Workflow-level secrets exposed as {{ secrets.NAME }}. */
  secrets?: Record<string, string>;
  /** Decrypted credentials per connector id (from the vault). */
  creds?: (connectorId: string) => Record<string, string>;
  /** Override fetch (tests / offline). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout, default 30s. */
  timeoutMs?: number;
  now?: () => number;
  logSink?: (line: string) => void;
  /** Per-connector egress policy (sandboxing). Default: allow all (M0 behavior). */
  egress?: EgressResolver;
}

export interface RunInput {
  /** Reuse a prior runId to resume; a fresh one starts clean. */
  runId?: string;
  /** Trigger payload exposed as {{ trigger.* }}. */
  trigger?: Json;
  /** Webhook idempotency key, recorded on the run for replay detection. */
  idempotencyKey?: string;
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  outputs: Record<string, Json>;
  steps: StepRecord[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Kahn topological sort; throws on cycle or dangling reference. */
export function topoSort(nodes: NodeSpec[]): NodeSpec[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length) throw new Error("Duplicate node id in workflow");

  const deps = new Map<string, Set<string>>();
  for (const n of nodes) {
    const d = new Set<string>(n.needs ?? []);
    for (const ref of referencedNodes(n.with ?? null)) d.add(ref);
    if (n.if !== undefined) for (const ref of referencedNodes(n.if)) d.add(ref);
    for (const ref of d) {
      if (!byId.has(ref)) throw new Error(`Node '${n.id}' references unknown node '${ref}'`);
    }
    deps.set(n.id, d);
  }

  const order: NodeSpec[] = [];
  const ready = nodes.filter((n) => deps.get(n.id)!.size === 0).map((n) => n.id);
  const remaining = new Map([...deps].map(([k, v]) => [k, new Set(v)]));
  // Stable order: process ready nodes in declaration order.
  const queue = nodes.filter((n) => ready.includes(n.id)).map((n) => n.id);

  while (queue.length) {
    const id = queue.shift()!;
    order.push(byId.get(id)!);
    for (const n of nodes) {
      const r = remaining.get(n.id)!;
      if (r.delete(id) && r.size === 0 && !order.some((o) => o.id === n.id) && !queue.includes(n.id)) {
        queue.push(n.id);
      }
    }
  }

  if (order.length !== nodes.length) {
    const stuck = nodes.filter((n) => !order.includes(n)).map((n) => n.id);
    throw new Error(`Cycle detected among nodes: ${stuck.join(", ")}`);
  }
  return order;
}

export class Engine {
  private readonly registry: ConnectorRegistry;
  private readonly store: Store;
  private readonly limiter: RateLimiter;
  private readonly secrets: Record<string, string>;
  private readonly creds: (id: string) => Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly logSink: (line: string) => void;
  private readonly egress: EgressResolver;

  constructor(opts: EngineOptions) {
    this.registry = opts.registry;
    this.store = opts.store;
    this.limiter = opts.rateLimiter ?? new RateLimiter(opts.now);
    this.secrets = opts.secrets ?? {};
    this.creds = opts.creds ?? (() => ({}));
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
    this.logSink = opts.logSink ?? ((l) => console.error(l));
    this.egress = opts.egress ?? (() => ({ mode: "allow" }));
  }

  /** Time-ordered + UUID suffix so rapid same-millisecond fires never collide. */
  private newRunId(): string {
    return `run_${this.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  }

  /** Build the rate-limited, timed-out, masking fetch handed to a connector. */
  private instrumentedFetch(connectorId: string, log: ConnectorContext["log"]): typeof fetch {
    const rateLimit = this.registry.get(connectorId).rateLimit;
    const policy = this.egress(connectorId);
    const wrapped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      enforceEgress(input, policy); // sandbox: block disallowed hosts before any I/O
      await this.limiter.acquire(connectorId, rateLimit);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        return await this.fetchImpl(input, { ...init, signal: ctrl.signal });
      } catch (err) {
        log(`fetch failed: ${(err as Error).message}`);
        throw err;
      } finally {
        clearTimeout(timer);
      }
    };
    return wrapped as typeof fetch;
  }

  private async runNode(
    node: NodeSpec,
    runId: string,
    scope: Record<string, Json>,
  ): Promise<StepRecord> {
    const connector = this.registry.get(node.uses);
    const creds = this.creds(node.uses);
    const idempotencyKey = `${runId}:${node.id}`;
    const log = maskingLogger(
      [...Object.values(creds), ...Object.values(this.secrets)],
      this.logSink,
    );
    const nodeLog: ConnectorContext["log"] = (msg, extra) =>
      log(`[${node.id}] ${msg}`, extra as unknown);

    const ctx: ConnectorContext = {
      creds,
      secrets: this.secrets,
      fetch: this.instrumentedFetch(node.uses, nodeLog),
      log: nodeLog,
      idempotencyKey,
    };

    const retry = node.retry ?? DEFAULT_RETRY;
    const started = this.now();
    let attempts = 0;
    let lastErr: unknown;

    while (attempts <= retry.max) {
      attempts++;
      try {
        const input = resolve(node.with ?? {}, scope);
        const output = await connector.execute(input, ctx);
        return {
          runId,
          nodeId: node.id,
          status: "succeeded",
          output,
          attempts,
          latencyMs: this.now() - started,
        };
      } catch (err) {
        lastErr = err;
        nodeLog(`attempt ${attempts}/${retry.max + 1} failed: ${(err as Error).message}`);
        if (attempts <= retry.max) {
          await sleep(retry.backoffMs * 2 ** (attempts - 1));
        }
      }
    }
    return {
      runId,
      nodeId: node.id,
      status: "failed",
      error: (lastErr as Error)?.message ?? String(lastErr),
      attempts,
      latencyMs: this.now() - started,
    };
  }

  /** Dependencies of a node (explicit needs + expression refs in with/if). */
  private depsOf(node: NodeSpec): Set<string> {
    const d = new Set<string>(node.needs ?? []);
    for (const ref of referencedNodes(node.with ?? null)) d.add(ref);
    if (node.if !== undefined) for (const ref of referencedNodes(node.if)) d.add(ref);
    return d;
  }

  /** Return a reason to skip the node (dependency skipped or `if` falsy), else null. */
  private skipReason(node: NodeSpec, skipped: Set<string>, scope: Record<string, Json>): string | null {
    for (const dep of this.depsOf(node)) {
      if (skipped.has(dep)) return `dependency '${dep}' was skipped`;
    }
    if (node.if !== undefined) {
      const value = node.if.includes("{{") ? interpolate(node.if, scope) : evalExpr(node.if, scope);
      if (!isTruthy(value)) return "if condition was falsy";
    }
    return null;
  }

  /** Execute a workflow end-to-end (or resume one via opts.runId). */
  async run(workflow: Workflow, opts: RunInput = {}): Promise<RunResult> {
    const order = topoSort(workflow.nodes);
    const runId = opts.runId ?? this.newRunId();

    const run: RunRecord = this.store.getRun(runId) ?? {
      id: runId,
      workflowName: workflow.name,
      status: "running",
      startedAt: this.now(),
    };
    run.status = "running";
    if (opts.idempotencyKey !== undefined) run.idempotencyKey = opts.idempotencyKey;
    this.store.saveRun(run);

    // Seed scope with any already-succeeded checkpoints (resume path).
    const nodesScope: Record<string, Json> = {};
    for (const prior of this.store.getSteps(runId)) {
      if (prior.status === "succeeded") {
        nodesScope[prior.nodeId] = { output: prior.output ?? null };
      }
    }

    const scope: Record<string, Json> = {
      trigger: opts.trigger ?? {},
      secrets: this.secrets,
      env: sanitizedEnv(),
      nodes: nodesScope,
    };

    let failed = false;
    const skipped = new Set<string>();
    for (const node of order) {
      const existing = this.store.getStep(runId, node.id);
      if (existing?.status === "succeeded") {
        this.logSink(`[${node.id}] skipped (checkpoint)`);
        continue;
      }
      if (existing?.status === "skipped") {
        skipped.add(node.id);
        continue;
      }

      // Cascade: skip when a dependency was skipped, or the `if` guard is falsy.
      const skipReason = this.skipReason(node, skipped, scope);
      if (skipReason) {
        const step: StepRecord = {
          runId,
          nodeId: node.id,
          status: "skipped",
          attempts: 0,
          latencyMs: 0,
          error: skipReason,
        };
        this.store.saveStep(step);
        skipped.add(node.id);
        this.logSink(`[${node.id}] skipped (${skipReason})`);
        continue;
      }

      const step = await this.runNode(node, runId, scope);
      this.store.saveStep(step);
      if (step.status === "succeeded") {
        nodesScope[node.id] = { output: step.output ?? null };
      } else {
        failed = true;
        break; // stop the run; resume re-enters at this node
      }
    }

    run.status = failed ? "failed" : "succeeded";
    run.finishedAt = this.now();
    this.store.saveRun(run);

    const steps = this.store.getSteps(runId);
    const outputs: Record<string, Json> = {};
    for (const s of steps) if (s.status === "succeeded") outputs[s.nodeId] = s.output ?? null;

    return { runId, status: run.status, outputs, steps };
  }
}

/** Only expose env vars explicitly opted in via FLOWDOCK_ENV_ALLOW (CSV). */
function sanitizedEnv(): Record<string, Json> {
  const allow = (process.env.FLOWDOCK_ENV_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const out: Record<string, Json> = {};
  for (const key of allow) if (process.env[key] !== undefined) out[key] = process.env[key]!;
  return out;
}
