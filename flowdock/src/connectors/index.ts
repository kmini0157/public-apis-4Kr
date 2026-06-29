/**
 * Connector registry + the built-in M0 set.
 *
 * Design rule: keyless-first. The default pipeline (jina.reader -> llm.chat ->
 * ntfy.publish) runs with zero credentials so a new user reaches "it works" in
 * one command. Credentialed connectors (resend.email) declare their auth so the
 * vault injects creds automatically.
 */

import type { Connector, ConnectorContext, ConnectorManifest, Json } from "../types.ts";

// --- helpers -----------------------------------------------------------------

function str(input: Json, key: string, required = true): string {
  const v = (input as Record<string, Json>)?.[key];
  if (v === undefined || v === null) {
    if (required) throw new Error(`Missing required input '${key}'`);
    return "";
  }
  return typeof v === "string" ? v : JSON.stringify(v);
}

function opt(input: Json, key: string): string | undefined {
  const v = (input as Record<string, Json>)?.[key];
  return v === undefined || v === null ? undefined : String(v);
}

async function readBody(res: Response): Promise<Json> {
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      return JSON.parse(text) as Json;
    } catch {
      return text;
    }
  }
  return text;
}

// --- connectors --------------------------------------------------------------

/** Pass-through. Useful for tests, fan-in joins and shaping data. */
const echo: Connector = {
  id: "echo",
  title: "Echo",
  async execute(input) {
    return input;
  },
};

/** Generic HTTP request — the substrate many other connectors build on. */
const httpRequest: Connector = {
  id: "http.request",
  title: "HTTP Request",
  rateLimit: { requests: 20, intervalMs: 1000 },
  async execute(input, ctx) {
    const url = str(input, "url");
    const method = (opt(input, "method") ?? "GET").toUpperCase();
    const headers = ((input as Record<string, Json>).headers as Record<string, string>) ?? {};
    const bodyVal = (input as Record<string, Json>).body;
    const body =
      bodyVal === undefined || bodyVal === null
        ? undefined
        : typeof bodyVal === "string"
          ? bodyVal
          : JSON.stringify(bodyVal);
    ctx.log(`${method} ${url}`);
    const res = await ctx.fetch(url, { method, headers, body });
    return { status: res.status, ok: res.ok, body: await readBody(res) };
  },
};

/** Jina Reader — clean article/markdown extraction, keyless. */
const jinaReader: Connector = {
  id: "jina.reader",
  title: "Jina Reader (web extract)",
  rateLimit: { requests: 5, intervalMs: 1000 },
  async execute(input, ctx) {
    const target = str(input, "url");
    const res = await ctx.fetch(`https://r.jina.ai/${target}`, {
      headers: { "X-Return-Format": "text", ...(ctx.creds.apiKey ? { Authorization: `Bearer ${ctx.creds.apiKey}` } : {}) },
    });
    if (!res.ok) throw new Error(`Jina Reader ${res.status}`);
    return { url: target, text: await res.text() };
  },
};

/** LLM chat via Pollinations text API — keyless default. */
const llmChat: Connector = {
  id: "llm.chat",
  title: "LLM Chat (Pollinations, keyless)",
  rateLimit: { requests: 1, intervalMs: 1500 },
  async execute(input, ctx) {
    const prompt = str(input, "prompt");
    const system = opt(input, "system");
    const model = opt(input, "model") ?? "openai";
    const messages = [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt },
    ];
    const res = await ctx.fetch("https://text.pollinations.ai/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages, model }),
    });
    if (!res.ok) throw new Error(`Pollinations text ${res.status}`);
    return { text: (await res.text()).trim() };
  },
};

/** Image generation via Pollinations — keyless, returns a stable URL. */
const pollinationsImage: Connector = {
  id: "pollinations.image",
  title: "Pollinations Image (keyless)",
  async execute(input) {
    const prompt = str(input, "prompt");
    const width = opt(input, "width") ?? "1024";
    const height = opt(input, "height") ?? "1024";
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true`;
    return { image_url: url };
  },
};

/** Push notification via ntfy.sh — keyless. */
const ntfyPublish: Connector = {
  id: "ntfy.publish",
  title: "ntfy push (keyless)",
  rateLimit: { requests: 2, intervalMs: 1000 },
  async execute(input, ctx) {
    const topic = str(input, "topic");
    const message = str(input, "message");
    const title = opt(input, "title");
    const res = await ctx.fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers: title ? { Title: title } : {},
      body: message,
    });
    if (!res.ok) throw new Error(`ntfy ${res.status}`);
    return { ok: true };
  },
};

/** Transactional email via Resend — requires an API key from the vault. */
const resendEmail: Connector = {
  id: "resend.email",
  title: "Resend Email",
  auth: { kind: "apiKey", fields: ["apiKey"] },
  rateLimit: { requests: 2, intervalMs: 1000 },
  async execute(input, ctx) {
    const apiKey = ctx.creds.apiKey;
    if (!apiKey) throw new Error("resend.email requires a vault credential 'apiKey'");
    const res = await ctx.fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: opt(input, "from") ?? "FlowDock <onboarding@resend.dev>",
        to: str(input, "to"),
        subject: str(input, "subject"),
        html: str(input, "html"),
      }),
    });
    const body = await readBody(res);
    if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(body)}`);
    return body;
  },
};

/** Keyless TTS — returns a stable audio URL (StreamElements), like pollinations.image. */
const ttsSpeak: Connector = {
  id: "tts.speak",
  title: "Text-to-Speech (keyless)",
  inputs: {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string" }, voice: { type: "string" } },
  },
  outputs: { type: "object", properties: { audio_url: { type: "string" } } },
  async execute(input) {
    const text = str(input, "text");
    const voice = opt(input, "voice") ?? "Brian";
    return {
      audio_url: `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(text)}`,
    };
  },
};

/** Post a message to a Slack incoming webhook URL. */
const slackWebhook: Connector = {
  id: "slack.webhook",
  title: "Slack Incoming Webhook",
  auth: { kind: "apiKey", fields: ["webhook_url"] },
  rateLimit: { requests: 1, intervalMs: 1000 },
  inputs: {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string" }, webhook_url: { type: "string" } },
  },
  async execute(input, ctx) {
    const url = opt(input, "webhook_url") ?? ctx.creds.webhook_url;
    if (!url) throw new Error("slack.webhook requires 'webhook_url' (input or credential)");
    const res = await ctx.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: str(input, "text") }),
    });
    if (!res.ok) throw new Error(`Slack webhook ${res.status}`);
    return { ok: true };
  },
};

/** Post a message to a Discord webhook URL. */
const discordWebhook: Connector = {
  id: "discord.webhook",
  title: "Discord Webhook",
  auth: { kind: "apiKey", fields: ["webhook_url"] },
  rateLimit: { requests: 1, intervalMs: 1000 },
  inputs: {
    type: "object",
    required: ["content"],
    properties: { content: { type: "string" }, webhook_url: { type: "string" } },
  },
  async execute(input, ctx) {
    const url = opt(input, "webhook_url") ?? ctx.creds.webhook_url;
    if (!url) throw new Error("discord.webhook requires 'webhook_url' (input or credential)");
    const res = await ctx.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: str(input, "content") }),
    });
    if (!res.ok) throw new Error(`Discord webhook ${res.status}`);
    return { ok: true };
  },
};

/** Embed text into a vector via an OpenAI-compatible /embeddings endpoint. */
const embed: Connector = {
  id: "embed",
  title: "Text Embedding",
  auth: { kind: "apiKey", fields: ["apiKey"] },
  rateLimit: { requests: 5, intervalMs: 1000 },
  inputs: {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string" }, model: { type: "string" }, base_url: { type: "string" } },
  },
  outputs: { type: "object", properties: { vector: { type: "array" }, dimensions: { type: "number" } } },
  async execute(input, ctx) {
    const base = opt(input, "base_url") ?? "https://api.openai.com/v1";
    const model = opt(input, "model") ?? "text-embedding-3-small";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (ctx.creds.apiKey) headers.Authorization = `Bearer ${ctx.creds.apiKey}`;
    const res = await ctx.fetch(`${base}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: str(input, "text"), model }),
    });
    if (!res.ok) throw new Error(`embed ${res.status}`);
    const data = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    const vector = data.data?.[0]?.embedding ?? [];
    return { vector, dimensions: vector.length };
  },
};

/** Upsert a point into a Qdrant collection (the memory-layer write path). */
const vectorUpsert: Connector = {
  id: "vector.upsert",
  title: "Vector Upsert (Qdrant)",
  auth: { kind: "apiKey", fields: ["apiKey"] },
  rateLimit: { requests: 10, intervalMs: 1000 },
  inputs: {
    type: "object",
    required: ["collection", "id", "vector"],
    properties: { base_url: { type: "string" }, collection: { type: "string" }, vector: { type: "array" } },
  },
  outputs: { type: "object", properties: { status: { type: "string" } } },
  async execute(input, ctx) {
    const inp = input as Record<string, Json>;
    const base = opt(input, "base_url") ?? "http://localhost:6333";
    const collection = str(input, "collection");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (ctx.creds.apiKey) headers["api-key"] = ctx.creds.apiKey;
    const point = { id: inp.id, vector: inp.vector, payload: inp.payload ?? {} };
    const res = await ctx.fetch(`${base}/collections/${encodeURIComponent(collection)}/points`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ points: [point] }),
    });
    if (!res.ok) throw new Error(`vector.upsert ${res.status}`);
    const data = (await res.json()) as { status?: string };
    return { status: data.status ?? "ok" };
  },
};

/** Similarity search over a Qdrant collection (the memory-layer read path). */
const vectorQuery: Connector = {
  id: "vector.query",
  title: "Vector Query (Qdrant)",
  auth: { kind: "apiKey", fields: ["apiKey"] },
  rateLimit: { requests: 10, intervalMs: 1000 },
  inputs: {
    type: "object",
    required: ["collection", "vector"],
    properties: { base_url: { type: "string" }, collection: { type: "string" }, vector: { type: "array" }, limit: { type: "integer" } },
  },
  outputs: { type: "object", properties: { matches: { type: "array" } } },
  async execute(input, ctx) {
    const inp = input as Record<string, Json>;
    const base = opt(input, "base_url") ?? "http://localhost:6333";
    const collection = str(input, "collection");
    const limit = Number(opt(input, "limit") ?? "5");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (ctx.creds.apiKey) headers["api-key"] = ctx.creds.apiKey;
    const res = await ctx.fetch(`${base}/collections/${encodeURIComponent(collection)}/points/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({ vector: inp.vector, limit, with_payload: true }),
    });
    if (!res.ok) throw new Error(`vector.query ${res.status}`);
    const data = (await res.json()) as { result?: Json[] };
    return { matches: data.result ?? [] };
  },
};

const BUILTINS: Connector[] = [
  echo,
  httpRequest,
  jinaReader,
  llmChat,
  pollinationsImage,
  ntfyPublish,
  resendEmail,
  ttsSpeak,
  slackWebhook,
  discordWebhook,
  embed,
  vectorUpsert,
  vectorQuery,
];

export interface DynamicMeta {
  verified: boolean;
  pinVersion?: string;
}

/** Mutable registry so M2's Connector SDK can register community connectors. */
export class ConnectorRegistry {
  private map = new Map<string, Connector>();
  private dynamicMeta = new Map<string, DynamicMeta>();
  constructor(
    initial: Connector[] = BUILTINS,
    private readonly warn: (msg: string) => void = (m) => console.error(m),
  ) {
    for (const c of initial) this.register(c);
  }
  /** Strict registration for built-ins: a duplicate id is a programming error. */
  register(c: Connector): void {
    if (this.map.has(c.id)) throw new Error(`Connector '${c.id}' already registered`);
    this.map.set(c.id, c);
  }
  /**
   * Lenient registration for community connectors: first-wins. A built-in or
   * earlier community connector with the same id is NOT overridden (a malicious
   * package can't shadow `resend.email`); we warn and skip instead.
   */
  registerDynamic(c: Connector, options: { verified?: boolean; pinVersion?: string } = {}): boolean {
    if (this.map.has(c.id)) {
      this.warn(`Connector '${c.id}' already registered — skipping dynamic copy (first wins)`);
      return false;
    }
    this.map.set(c.id, c);
    this.dynamicMeta.set(c.id, {
      verified: options.verified ?? false,
      ...(options.pinVersion ? { pinVersion: options.pinVersion } : {}),
    });
    return true;
  }
  get(id: string): Connector {
    const c = this.map.get(id);
    if (!c) throw new Error(`Unknown connector '${id}'. Registered: ${[...this.map.keys()].join(", ")}`);
    return c;
  }
  has(id: string): boolean {
    return this.map.has(id);
  }
  list(): Connector[] {
    return [...this.map.values()];
  }
  manifest(id: string): ConnectorManifest | undefined {
    return this.map.get(id)?.manifest;
  }
  dynamicInfo(id: string): DynamicMeta | undefined {
    return this.dynamicMeta.get(id);
  }
}

export {
  echo,
  httpRequest,
  jinaReader,
  llmChat,
  pollinationsImage,
  ntfyPublish,
  resendEmail,
  ttsSpeak,
  slackWebhook,
  discordWebhook,
  embed,
  vectorUpsert,
  vectorQuery,
};
export type { ConnectorContext };
