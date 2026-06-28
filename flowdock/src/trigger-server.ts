/**
 * HTTP trigger server (M1) — turns `on.webhook` / `on.cron` into live triggers.
 *
 *   POST /hooks/{workflow}/{secret}   run a workflow from an external event
 *   GET  /runs/{id}                   run status + step timeline
 *   GET  /workflows                   declared workflows + their triggers
 *   GET  /healthz                     liveness
 *
 * Security: constant-time secret check, optional HMAC body signature, body size
 * limit, idempotency-key replay guard, and secret-masking logs.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { CronScheduler } from "./cron.ts";
import { buildTimeline } from "./timeline.ts";
import { WebhookSecretStore, verifySecret, verifyHmac } from "./webhook-secret.ts";
import { maskingLogger } from "./vault.ts";
import type { Engine } from "./engine.ts";
import type { Store, RunQueryStore } from "./store.ts";
import type { Json, WebhookTrigger, Workflow } from "./types.ts";

export interface TriggerServerConfig {
  port?: number;
  host?: string;
  /** Max webhook body size in bytes (default 1 MiB). */
  bodyLimitBytes?: number;
  clock?: () => number;
  logSink?: (line: string) => void;
}

function webhookConfig(wf: Workflow): WebhookTrigger | undefined {
  const w = wf.on?.webhook;
  if (!w) return undefined;
  return w === true ? {} : w;
}

export class TriggerServer {
  private server: Server | undefined;
  private readonly secrets: WebhookSecretStore;
  private readonly scheduler: CronScheduler;
  private readonly byName: Map<string, Workflow>;
  private readonly log: (msg: string, extra?: unknown) => void;
  private readonly bodyLimit: number;

  constructor(
    private readonly workflows: Workflow[],
    private readonly engine: Engine,
    private readonly store: Store & RunQueryStore,
    private readonly config: TriggerServerConfig = {},
    secrets?: WebhookSecretStore,
  ) {
    this.byName = new Map(workflows.map((w) => [w.name, w]));
    this.secrets = secrets ?? new WebhookSecretStore();
    this.scheduler = new CronScheduler(workflows, engine, config.clock);
    this.bodyLimit = config.bodyLimitBytes ?? 1024 * 1024;
    // collect secret values so logs never leak them
    const secretValues = workflows
      .map((w) => webhookConfig(w) && this.secrets.ensure(w.name, webhookConfig(w)!.secret))
      .filter((v): v is string => typeof v === "string");
    this.log = maskingLogger(secretValues, config.logSink ?? ((l) => console.error(l)));
  }

  /** Webhook URLs to print on boot. */
  hookUrls(base: string): Array<{ workflow: string; url: string }> {
    return this.workflows
      .filter((w) => webhookConfig(w))
      .map((w) => ({ workflow: w.name, url: `${base}/hooks/${encodeURIComponent(w.name)}/${this.secrets.get(w.name)}` }));
  }

  getWebhookSecret(workflowName: string): string | undefined {
    return this.secrets.get(workflowName);
  }

  /** Status + timeline for a run, or null if unknown. */
  getRunStatus(runId: string) {
    const run = this.store.getRun(runId);
    if (!run) return null;
    const steps = this.store.getSteps(runId);
    return { run, steps, timeline: buildTimeline(steps) };
  }

  private async readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > this.bodyLimit) throw new PayloadTooLarge();
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  /** The request handler — exposed for in-process testing without a socket. */
  handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code: number, body: Json) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        return send(200, { ok: true, workflows: this.byName.size, cronJobs: this.scheduler.jobCount() });
      }
      if (req.method === "GET" && url.pathname === "/workflows") {
        return send(200, {
          workflows: this.workflows.map((w) => ({
            name: w.name,
            webhook: !!webhookConfig(w),
            cron: w.on?.cron ?? null,
          })),
        });
      }
      const runMatch = /^\/runs\/(.+)$/.exec(url.pathname);
      if (req.method === "GET" && runMatch) {
        const status = this.getRunStatus(decodeURIComponent(runMatch[1]!));
        return status ? send(200, status as unknown as Json) : send(404, { error: "run not found" });
      }

      const hookMatch = /^\/hooks\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (hookMatch) {
        if (req.method !== "POST") return send(405, { error: "use POST" });
        return await this.handleHook(req, res, decodeURIComponent(hookMatch[1]!), decodeURIComponent(hookMatch[2]!), url, send);
      }

      return send(404, { error: "not found" });
    } catch (err) {
      if (err instanceof PayloadTooLarge) return send(413, { error: "payload too large" });
      this.log(`server error: ${(err as Error).message}`);
      return send(500, { error: "internal error" });
    }
  };

  private async handleHook(
    req: IncomingMessage,
    _res: ServerResponse,
    workflowName: string,
    secret: string,
    url: URL,
    send: (code: number, body: Json) => void,
  ): Promise<void> {
    const wf = this.byName.get(workflowName);
    const hook = wf ? webhookConfig(wf) : undefined;
    if (!wf || !hook) return send(404, { error: "unknown webhook" });

    const stored = this.secrets.get(workflowName);
    if (!stored || !verifySecret(secret, stored)) return send(401, { error: "bad secret" });

    const body = await this.readBody(req);

    if (hook.signatureHeader) {
      const sig = req.headers[hook.signatureHeader.toLowerCase()];
      if (typeof sig !== "string" || !verifyHmac(body, sig, stored)) {
        return send(401, { error: "bad signature" });
      }
    }

    const idempotencyKey = (req.headers["idempotency-key"] as string | undefined) ?? undefined;
    if (idempotencyKey) {
      const prior = this.store.getRunByIdempotencyKey(idempotencyKey);
      if (prior) return send(409, { error: "duplicate", runId: prior.id });
    }

    this.secrets.markUsed(workflowName);
    const trigger: Json = {
      body: parseBody(body, req.headers["content-type"]),
      headers: flattenHeaders(req.headers),
      query: Object.fromEntries(url.searchParams),
      timestamp: (this.config.clock ?? Date.now)(),
    };

    const result = await this.engine.run(wf, { trigger, ...(idempotencyKey ? { idempotencyKey } : {}) });
    this.log(`[${workflowName}] webhook run ${result.runId} -> ${result.status}`);
    return send(result.status === "succeeded" ? 200 : 502, { runId: result.runId, status: result.status });
  }

  async listen(): Promise<{ port: number; host: string }> {
    const host = this.config.host ?? "127.0.0.1";
    const port = this.config.port ?? 8787;
    this.server = createServer(this.handler);
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    this.scheduler.start();
    const addr = this.server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : port;
    return { port: actualPort, host };
  }

  async close(): Promise<void> {
    this.scheduler.stop();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }
}

class PayloadTooLarge extends Error {}

function parseBody(body: Buffer, contentType: string | undefined): Json {
  const text = body.toString("utf8");
  if (contentType?.includes("application/json")) {
    try {
      return JSON.parse(text) as Json;
    } catch {
      return text;
    }
  }
  return text;
}

function flattenHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.join(", ");
  }
  return out;
}
