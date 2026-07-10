import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

import { Engine } from "../src/engine.ts";
import { MemoryStore, JsonKv } from "../src/store.ts";
import { ConnectorRegistry, kvGet, kvSet } from "../src/connectors/index.ts";
import { makeTestContext } from "../src/sdk.ts";
import { BillingService, JsonEventLog } from "../src/billing.ts";
import { TenantStore } from "../src/tenancy.ts";
import type { Connector, Workflow } from "../src/types.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- parallel DAG execution ----------------------------------------------------

function gauge() {
  let inflight = 0;
  let max = 0;
  const conn = (id: string): Connector => ({
    id,
    title: id,
    async execute() {
      inflight++;
      max = Math.max(max, inflight);
      await sleep(25);
      inflight--;
      return { id };
    },
  });
  return { conn, max: () => max };
}

test("independent nodes run concurrently within a level", async () => {
  const g = gauge();
  const engine = new Engine({
    registry: new ConnectorRegistry([g.conn("a"), g.conn("b"), g.conn("c")]),
    store: new MemoryStore(),
  });
  const wf: Workflow = {
    name: "par",
    nodes: [
      { id: "a", uses: "a" },
      { id: "b", uses: "b" },
      { id: "c", uses: "c" },
    ],
  };
  const result = await engine.run(wf);
  assert.equal(result.status, "succeeded");
  assert.ok(g.max() >= 2, `expected concurrent execution, max in-flight was ${g.max()}`);
});

test("concurrency: 1 forces serial execution (plan cap is real)", async () => {
  const g = gauge();
  const engine = new Engine({
    registry: new ConnectorRegistry([g.conn("a"), g.conn("b"), g.conn("c")]),
    store: new MemoryStore(),
    concurrency: 1,
  });
  await engine.run({
    name: "serial",
    nodes: [
      { id: "a", uses: "a" },
      { id: "b", uses: "b" },
      { id: "c", uses: "c" },
    ],
  });
  assert.equal(g.max(), 1);
});

test("dependency chains still execute strictly in order under parallelism", async () => {
  const order: string[] = [];
  const mk = (id: string): Connector => ({
    id,
    title: id,
    async execute() {
      order.push(id);
      return { v: id };
    },
  });
  const engine = new Engine({
    registry: new ConnectorRegistry([mk("a"), mk("b"), mk("c")]),
    store: new MemoryStore(),
  });
  await engine.run({
    name: "chain",
    nodes: [
      { id: "c", uses: "c", with: { x: "{{ nodes.b.output.v }}" } },
      { id: "b", uses: "b", with: { x: "{{ nodes.a.output.v }}" } },
      { id: "a", uses: "a" },
    ],
  });
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("a failing node lets same-level siblings finish; later levels stop; resume works", async () => {
  const store = new MemoryStore();
  let failOnce = true;
  let goodRuns = 0;
  const connectors: Connector[] = [
    {
      id: "bad",
      title: "bad",
      async execute() {
        if (failOnce) throw new Error("boom");
        return { ok: true };
      },
    },
    {
      id: "good",
      title: "good",
      async execute() {
        goodRuns++;
        return { ok: true };
      },
    },
    { id: "after", title: "after", async execute() { return { done: true }; } },
  ];
  const wf: Workflow = {
    name: "sibling",
    nodes: [
      { id: "bad", uses: "bad", retry: { max: 0, backoffMs: 1 } },
      { id: "good", uses: "good" }, // same level as bad
      { id: "after", uses: "after", needs: ["bad", "good"] }, // next level
    ],
  };
  const engine = new Engine({ registry: new ConnectorRegistry(connectors), store });

  const first = await engine.run(wf);
  assert.equal(first.status, "failed");
  const byId = Object.fromEntries(first.steps.map((s) => [s.nodeId, s.status]));
  assert.equal(byId.bad, "failed");
  assert.equal(byId.good, "succeeded"); // sibling checkpoint kept
  assert.equal(byId.after, undefined); // later level never launched
  assert.equal(goodRuns, 1);

  failOnce = false;
  const second = await engine.run(wf, { runId: first.runId });
  assert.equal(second.status, "succeeded");
  assert.equal(goodRuns, 1, "good must not re-run on resume (checkpoint)");
  assert.equal((second.outputs.after as { done: boolean }).done, true);
});

// --- fetch response cache -------------------------------------------------------

test("GET responses are cached for the TTL; POST is never cached", async () => {
  let gets = 0;
  let posts = 0;
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() === "POST") posts++;
    else gets++;
    return new Response("payload", { status: 200, headers: { "content-type": "text/plain" } });
  }) as unknown as typeof fetch;

  const reader: Connector = {
    id: "r.read",
    title: "r",
    async execute(_i, ctx) {
      const res = await ctx.fetch("https://cached.example.com/page");
      await ctx.fetch("https://cached.example.com/page", { method: "POST", body: "x" });
      return { text: await res.text() };
    },
  };
  const engine = new Engine({
    registry: new ConnectorRegistry([reader]),
    store: new MemoryStore(),
    fetchImpl,
    fetchCacheTtlMs: 60_000,
  });
  const wf: Workflow = {
    name: "cache",
    nodes: [
      { id: "one", uses: "r.read" },
      { id: "two", uses: "r.read", needs: ["one"] },
    ],
  };
  const result = await engine.run(wf);
  assert.equal(result.status, "succeeded");
  assert.equal(gets, 1, "second GET must be served from cache");
  assert.equal(posts, 2, "POSTs are never cached");
  assert.equal((result.outputs.two as { text: string }).text, "payload");
});

test("cache off by default — every GET hits the network", async () => {
  let gets = 0;
  const fetchImpl = (async () => {
    gets++;
    return new Response("x", { status: 200 });
  }) as unknown as typeof fetch;
  const reader: Connector = {
    id: "r.read",
    title: "r",
    async execute(_i, ctx) {
      await ctx.fetch("https://nocache.example.com");
      return {};
    },
  };
  const engine = new Engine({ registry: new ConnectorRegistry([reader]), store: new MemoryStore(), fetchImpl });
  await engine.run({
    name: "nc",
    nodes: [
      { id: "one", uses: "r.read" },
      { id: "two", uses: "r.read", needs: ["one"] },
    ],
  });
  assert.equal(gets, 2);
});

// --- kv state connectors ---------------------------------------------------------

test("kv.set/kv.get round-trip with namespaces and defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flowdock-kv-"));
  const path = join(dir, "kv.json");
  const ctx = makeTestContext();
  try {
    const miss = (await kvGet.execute({ key: "snap", namespace: "watch", default: "", path }, ctx)) as {
      value: unknown;
      found: boolean;
    };
    assert.deepEqual(miss, { value: "", found: false });

    const set = (await kvSet.execute({ key: "snap", namespace: "watch", value: "v1", path }, ctx)) as {
      ok: boolean;
      previous: unknown;
    };
    assert.deepEqual(set, { ok: true, previous: null });

    const hit = (await kvGet.execute({ key: "snap", namespace: "watch", path }, ctx)) as {
      value: unknown;
      found: boolean;
    };
    assert.deepEqual(hit, { value: "v1", found: true });

    const set2 = (await kvSet.execute({ key: "snap", namespace: "watch", value: "v2", path }, ctx)) as {
      previous: unknown;
    };
    assert.equal(set2.previous, "v1");

    // namespace isolation
    const other = (await kvGet.execute({ key: "snap", namespace: "elsewhere", default: null, path }, ctx)) as {
      found: boolean;
    };
    assert.equal(other.found, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("JsonKv persists across instances (atomic write)", () => {
  const dir = mkdtempSync(join(tmpdir(), "flowdock-kv2-"));
  const path = join(dir, "kv.json");
  try {
    const a = new JsonKv(path);
    a.set("ns", "k", { deep: [1, 2] });
    const b = new JsonKv(path);
    assert.deepEqual(b.get("ns", "k"), { deep: [1, 2] });
    assert.ok(existsSync(path));
    assert.ok(readFileSync(path, "utf8").includes("deep"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- billing event idempotency ----------------------------------------------------

const SECRET = "whsec_m4";
function sign(body: string, t: number): string {
  const mac = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${mac}`;
}

test("a redelivered Stripe event is a no-op the second time", () => {
  const dir = mkdtempSync(join(tmpdir(), "flowdock-bill-"));
  try {
    const tenants = new TenantStore("", { id: "t", name: "t", plan: "free", members: [{ email: "o", role: "owner" }] });
    const events = new JsonEventLog(join(dir, "events.json"));
    const svc = new BillingService(tenants, SECRET, {}, events);
    const body = JSON.stringify({
      id: "evt_once",
      type: "checkout.session.completed",
      data: { object: { metadata: { plan: "pro" } } },
    });
    const now = 1_700_000_000;
    const first = svc.handleWebhook(body, sign(body, now), now);
    assert.equal(first.applied, true);
    assert.equal(tenants.get().plan, "pro");

    tenants.setPlan("free"); // if the dup applied, this would flip back to pro
    const second = svc.handleWebhook(body, sign(body, now), now);
    assert.equal(second.applied, false);
    assert.match(second.reason!, /duplicate/);
    assert.equal(tenants.get().plan, "free");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("JsonEventLog caps its size and survives reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "flowdock-log-"));
  const path = join(dir, "events.json");
  try {
    const log = new JsonEventLog(path, 3);
    for (const id of ["e1", "e2", "e3", "e4"]) log.add(id);
    assert.equal(log.has("e1"), false); // evicted by cap
    assert.equal(log.has("e4"), true);
    const reloaded = new JsonEventLog(path, 3);
    assert.equal(reloaded.has("e4"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
