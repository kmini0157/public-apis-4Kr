import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TriggerServer } from "../src/trigger-server.ts";
import { WebhookSecretStore } from "../src/webhook-secret.ts";
import { Engine } from "../src/engine.ts";
import { MemoryStore } from "../src/store.ts";
import { ConnectorRegistry } from "../src/connectors/index.ts";
import type { Workflow } from "../src/types.ts";

const WF: Workflow = {
  name: "hook-wf",
  on: { webhook: { secret: "topsecret" } },
  nodes: [{ id: "n", uses: "echo", with: { trigger: "{{ trigger }}" } }],
};

function makeServer(opts: { bodyLimitBytes?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "flowdock-srv-"));
  const store = new MemoryStore();
  const engine = new Engine({ registry: new ConnectorRegistry(), store });
  const secrets = new WebhookSecretStore(join(dir, "webhooks.json"));
  const server = new TriggerServer(
    [WF],
    engine,
    store,
    { port: 0, ...(opts.bodyLimitBytes !== undefined ? { bodyLimitBytes: opts.bodyLimitBytes } : {}) },
    secrets,
  );
  return { server, dir };
}

test("healthz, webhook run, and run status", async () => {
  const { server, dir } = makeServer();
  const { port, host } = await server.listen();
  const base = `http://${host}:${port}`;
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);

    const post = await fetch(`${base}/hooks/hook-wf/topsecret?foo=bar`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test": "yes" },
      body: JSON.stringify({ hello: "world" }),
    });
    assert.equal(post.status, 200);
    const { runId, status } = (await post.json()) as { runId: string; status: string };
    assert.equal(status, "succeeded");

    const runRes = await fetch(`${base}/runs/${runId}`);
    assert.equal(runRes.status, 200);
    const data = (await runRes.json()) as { steps: Array<{ output: { trigger: { body: unknown; query: unknown; headers: Record<string, string> } } }> };
    const trig = data.steps[0]!.output.trigger;
    assert.deepEqual(trig.body, { hello: "world" });
    assert.deepEqual(trig.query, { foo: "bar" });
    assert.equal(trig.headers["x-test"], "yes");
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects bad secret (401) and unknown workflow (404)", async () => {
  const { server, dir } = makeServer();
  const { port, host } = await server.listen();
  const base = `http://${host}:${port}`;
  try {
    const bad = await fetch(`${base}/hooks/hook-wf/wrong`, { method: "POST", body: "{}" });
    assert.equal(bad.status, 401);
    const missing = await fetch(`${base}/hooks/ghost/topsecret`, { method: "POST", body: "{}" });
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idempotency-key replay returns 409", async () => {
  const { server, dir } = makeServer();
  const { port, host } = await server.listen();
  const base = `http://${host}:${port}`;
  try {
    const headers = { "content-type": "application/json", "idempotency-key": "k1" };
    const first = await fetch(`${base}/hooks/hook-wf/topsecret`, { method: "POST", headers, body: "{}" });
    assert.equal(first.status, 200);
    const dup = await fetch(`${base}/hooks/hook-wf/topsecret`, { method: "POST", headers, body: "{}" });
    assert.equal(dup.status, 409);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("body over the limit returns 413", async () => {
  const { server, dir } = makeServer({ bodyLimitBytes: 8 });
  const { port, host } = await server.listen();
  const base = `http://${host}:${port}`;
  try {
    const big = await fetch(`${base}/hooks/hook-wf/topsecret`, {
      method: "POST",
      body: "x".repeat(100),
    });
    assert.equal(big.status, 413);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
