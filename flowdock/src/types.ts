/**
 * Core type contracts for the FlowDock engine.
 *
 * A workflow is a DAG of nodes. Each node `uses` a connector and passes it
 * `with` inputs that may reference upstream outputs via {{ }} expressions.
 * Connectors are the single extension point: add a new free API by
 * implementing this one interface — the engine handles ordering, retries,
 * rate-limiting, checkpointing and credential injection for you.
 */

/** JSON-serializable value. Everything that crosses a node boundary is one. */
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

/** Per-connector free-tier rate limit, enforced centrally by the engine. */
export interface RateLimitSpec {
  /** Sustained requests allowed per `intervalMs` window. */
  requests: number;
  intervalMs: number;
}

export type AuthKind = "none" | "apiKey" | "bearer" | "basic";

export interface AuthSpec {
  kind: AuthKind;
  /** Credential field names this connector expects from the vault. */
  fields?: string[];
}

/**
 * Runtime handed to a connector. The connector author writes business logic
 * only — `fetch` already has rate-limiting, timeout, retry and secret-masking
 * woven in, and `creds` are decrypted in-memory just for this call.
 */
export interface ConnectorContext {
  /** Decrypted credentials for this connector (never logged). */
  creds: Record<string, string>;
  /** Workflow-level secrets referenced as {{ secrets.NAME }}. */
  secrets: Record<string, string>;
  /** Instrumented fetch: rate-limited + timed-out + logged. Use this, not global fetch. */
  fetch: typeof fetch;
  /** Structured logger scoped to the current node (auto-masks secret values). */
  log: (msg: string, extra?: Json) => void;
  /** Stable idempotency key for this node execution (same across retries/resumes). */
  idempotencyKey: string;
}

/**
 * The one interface every integration implements. `inputs`/`outputs` are JSON
 * Schemas used to auto-generate the builder UI and to type-check wiring.
 */
export interface Connector<I = Json, O = Json> {
  /** Stable id, e.g. "jina.reader". */
  id: string;
  /** Human label for the builder. */
  title: string;
  auth?: AuthSpec;
  rateLimit?: RateLimitSpec;
  /** JSON Schema describing accepted inputs (for UI + validation). */
  inputs?: Json;
  /** JSON Schema describing produced outputs (for UI + downstream typing). */
  outputs?: Json;
  execute(input: I, ctx: ConnectorContext): Promise<O>;
}

/** Retry policy for a single node. */
export interface RetrySpec {
  max: number;
  /** Base backoff in ms; actual delay grows exponentially per attempt. */
  backoffMs: number;
}

/** One node in the workflow DAG. */
export interface NodeSpec {
  id: string;
  /** Connector id to run, e.g. "llm.chat". */
  uses: string;
  /** Inputs, possibly containing {{ }} expressions over trigger/nodes/secrets. */
  with?: Record<string, Json>;
  /** Explicit dependencies in addition to those inferred from expressions. */
  needs?: string[];
  retry?: RetrySpec;
}

export interface TriggerSpec {
  /** Cron expression (UTC) for scheduled runs. */
  cron?: string;
  /** Declare a webhook trigger; the server mounts /hooks/{wf}/{secret}. */
  webhook?: boolean;
}

/** A full workflow definition (the Workflows-as-Code unit). */
export interface Workflow {
  name: string;
  on?: TriggerSpec;
  nodes: NodeSpec[];
}

/** Lifecycle status shared by runs and steps. */
export type RunStatus = "queued" | "running" | "succeeded" | "failed";

/** Persisted result of a single node execution — the durability checkpoint. */
export interface StepRecord {
  runId: string;
  nodeId: string;
  status: RunStatus;
  output?: Json;
  error?: string;
  attempts: number;
  latencyMs: number;
}

export interface RunRecord {
  id: string;
  workflowName: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
}
