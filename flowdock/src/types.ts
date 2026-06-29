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
  /** Publishing metadata for community connectors (M2). */
  manifest?: ConnectorManifest;
  execute(input: I, ctx: ConnectorContext): Promise<O>;
}

/** Published metadata for a community/marketplace connector (M2). */
export interface ConnectorManifest {
  id: string;
  title: string;
  version: string;
  /** Set once the connector passes verification (badge). */
  verified?: boolean;
  /** Hosts this connector is permitted to reach (egress allowlist for sandboxing).
   *  Supports exact ("api.x.com") and suffix wildcard ("*.x.com"). */
  allowedHosts?: string[];
  keywords?: string[];
  description?: string;
  homepage?: string;
  author?: string;
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
  /** Conditional guard expression; if it evaluates falsy the node (and its
   *  dependents) are skipped, e.g. `{{ nodes.check.output.changed }}`. */
  if?: string;
  /** Sample output used by `flowdock run --dry-run` instead of calling the connector. */
  mock?: Json;
}

/** Webhook trigger config. `webhook: true` is shorthand for an auto-secret. */
export interface WebhookTrigger {
  /** Shared secret in the hook path; auto-generated if omitted. */
  secret?: string;
  /** If set, also require an HMAC-SHA256 signature in this header. */
  signatureHeader?: string;
}

export interface TriggerSpec {
  /** Cron expression (UTC, 5-field) for scheduled runs. */
  cron?: string;
  /** Declare a webhook trigger; the server mounts /hooks/{wf}/{secret}. */
  webhook?: boolean | WebhookTrigger;
}

/** A full workflow definition (the Workflows-as-Code unit). */
export interface Workflow {
  name: string;
  on?: TriggerSpec;
  nodes: NodeSpec[];
}

/** Lifecycle status shared by runs and steps. `skipped` = a conditional `if`
 *  was falsy, or an upstream dependency was skipped. */
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "skipped";

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
  /** Set when a run was started via a webhook with an idempotency key (replay guard). */
  idempotencyKey?: string;
}

/** Per-node row for the execution timeline view (M1) and GET /runs/{id}. */
export interface RunTimeline {
  nodeId: string;
  status: RunStatus;
  attempts: number;
  latencyMs: number;
  error?: string;
}

// --- Workflows-as-Code registry records (M1) --------------------------------

/** Head pointer for a workflow, keyed by its `name`. */
export interface WorkflowMetadata {
  name: string;
  /** Hash of the latest stored version. */
  yamlHash: string;
  latestVersion: string;
  createdAt: number;
  updatedAt: number;
  author?: string;
}

/** Immutable, append-only version of a workflow — the lock-in artifact. */
export interface WorkflowVersionRecord {
  name: string;
  version: string;
  yamlHash: string;
  /** Normalized (sorted-key, comment-stripped) YAML — the content of record. */
  normalizedYaml: string;
  createdAt: number;
  author?: string;
}

/** Local manifest of synced state, written to flowdock.lock.json. */
export interface WorkflowLockFile {
  version: "1.0";
  timestamp: number;
  workflows: Record<string, { version: string; yamlHash: string }>;
}
