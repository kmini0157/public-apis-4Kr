/**
 * Connector SDK (M2) — the surface community authors build against.
 *
 *   defineConnector  — wrap a spec with automatic input validation + manifest
 *   makeTestContext  — an offline ConnectorContext for unit tests
 *   scaffoldConnector — `flowdock create-connector` file generator
 *
 * The goal: a new free-API integration is one file + one test, with the engine
 * handling everything else.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateInput } from "./schema.ts";
import type { Connector, ConnectorContext, ConnectorManifest, Json } from "./types.ts";

export interface ConnectorSpec<I = Json, O = Json> {
  id: string;
  title?: string;
  inputs?: Json;
  outputs?: Json;
  rateLimit?: Connector["rateLimit"];
  auth?: Connector["auth"];
  manifest?: Partial<ConnectorManifest>;
  execute(input: I, ctx: ConnectorContext): Promise<O>;
}

/**
 * Define a connector. Inputs are validated against `inputs` before the author's
 * execute runs, so bad wiring fails fast with a precise message.
 */
export function defineConnector<I = Json, O = Json>(spec: ConnectorSpec<I, O>): Connector<I, O> {
  if (!/^[a-z][a-z0-9]*\.[a-z][a-z0-9-]*$/i.test(spec.id)) {
    throw new Error(`Connector id must be 'namespace.name', got '${spec.id}'`);
  }
  const title = spec.title ?? spec.id;
  const manifest: ConnectorManifest = {
    id: spec.id,
    title,
    version: spec.manifest?.version ?? "0.0.0",
    ...spec.manifest,
  };
  return {
    id: spec.id,
    title,
    ...(spec.inputs !== undefined ? { inputs: spec.inputs } : {}),
    ...(spec.outputs !== undefined ? { outputs: spec.outputs } : {}),
    ...(spec.rateLimit ? { rateLimit: spec.rateLimit } : {}),
    ...(spec.auth ? { auth: spec.auth } : {}),
    manifest,
    async execute(input, ctx) {
      const check = validateInput(input as Json, spec.inputs);
      if (!check.valid) {
        throw new Error(`Invalid input for ${spec.id}: ${check.errors!.join("; ")}`);
      }
      return spec.execute(input, ctx);
    },
  };
}

/**
 * Build a ConnectorContext for tests. By default `fetch` throws — a connector
 * test that hits the network is a bug, so we make that impossible by default.
 * Pass `fetch` to supply a deterministic stub.
 */
export function makeTestContext(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  const captured: string[] = [];
  return {
    creds: overrides.creds ?? {},
    secrets: overrides.secrets ?? {},
    idempotencyKey: overrides.idempotencyKey ?? "test:node",
    log: overrides.log ?? ((msg) => captured.push(msg)),
    fetch:
      overrides.fetch ??
      (async () => {
        throw new Error("network disabled in makeTestContext — pass a `fetch` stub");
      }),
  };
}

const CONNECTOR_TEMPLATE = (namespace: string, name: string, id: string) => `import { defineConnector } from "../src/sdk.ts";

/**
 * ${id} — TODO: describe what this connector does.
 */
export default defineConnector({
  id: "${id}",
  title: "${namespace} ${name}",
  manifest: { version: "0.1.0", author: "you" },
  rateLimit: { requests: 5, intervalMs: 1000 },
  inputs: {
    type: "object",
    required: ["query"],
    properties: { query: { type: "string" } },
  },
  outputs: {
    type: "object",
    properties: { result: { type: "string" } },
  },
  async execute(input, ctx) {
    const query = String((input as { query: string }).query);
    ctx.log(\`searching: \${query}\`);
    const res = await ctx.fetch(\`https://api.example.com/search?q=\${encodeURIComponent(query)}\`);
    if (!res.ok) throw new Error(\`example API \${res.status}\`);
    return { result: await res.text() };
  },
});
`;

const TEST_TEMPLATE = (name: string, id: string) => `import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestContext } from "../src/sdk.ts";
import connector from "./${name}.ts";

test("${id} returns a result", async () => {
  const ctx = makeTestContext({
    fetch: async () => new Response("ok", { status: 200 }),
  });
  const out = await connector.execute({ query: "hello" }, ctx);
  assert.equal((out as { result: string }).result, "ok");
});

test("${id} validates input", async () => {
  const ctx = makeTestContext();
  await assert.rejects(() => connector.execute({} as never, ctx), /Invalid input/);
});
`;

export interface ScaffoldResult {
  connectorFile: string;
  testFile: string;
}

/** Write a connector + test skeleton for `flowdock create-connector`. */
export function scaffoldConnector(id: string, targetDir: string): ScaffoldResult {
  const m = /^([a-z][a-z0-9]*)\.([a-z][a-z0-9-]*)$/i.exec(id);
  if (!m) throw new Error(`Connector id must be 'namespace.name', got '${id}'`);
  const [, namespace, name] = m as unknown as [string, string, string];
  mkdirSync(targetDir, { recursive: true });
  const connectorFile = join(targetDir, `${name}.ts`);
  const testFile = join(targetDir, `${name}.test.ts`);
  writeFileSync(connectorFile, CONNECTOR_TEMPLATE(namespace, name, id));
  writeFileSync(testFile, TEST_TEMPLATE(name, id));
  return { connectorFile, testFile };
}
