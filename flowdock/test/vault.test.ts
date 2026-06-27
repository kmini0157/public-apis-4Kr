import { test } from "node:test";
import assert from "node:assert/strict";
import { Vault, maskingLogger } from "../src/vault.ts";

const MASTER = Buffer.alloc(32, 7).toString("base64");

test("seal/open round trip", () => {
  const vault = new Vault(MASTER);
  const tk = vault.createTenantKey();
  const sealed = vault.sealSecret(tk, "resend.email", "apiKey", "re_secret_123");
  assert.equal(vault.openSecret(tk, sealed), "re_secret_123");
});

test("openCreds filters by connector", () => {
  const vault = new Vault(MASTER);
  const tk = vault.createTenantKey();
  const secrets = [
    vault.sealSecret(tk, "resend.email", "apiKey", "RKEY"),
    vault.sealSecret(tk, "jina.reader", "apiKey", "JKEY"),
  ];
  assert.deepEqual(vault.openCreds(tk, secrets, "resend.email"), { apiKey: "RKEY" });
});

test("a tenant key cannot open another tenant's secret", () => {
  const vault = new Vault(MASTER);
  const a = vault.createTenantKey();
  const b = vault.createTenantKey();
  const sealed = vault.sealSecret(a, "x", "k", "v");
  // GCM auth tag check fails -> throws, no silent wrong plaintext.
  assert.throws(() => vault.openSecret(b, sealed));
});

test("rejects a malformed master key", () => {
  assert.throws(() => new Vault("too-short"));
});

test("masking logger redacts secret values", () => {
  const lines: string[] = [];
  const log = maskingLogger(["supersecret"], (l) => lines.push(l));
  log("token is supersecret here", { also: "supersecret" });
  assert.ok(!lines[0]!.includes("supersecret"));
  assert.ok(lines[0]!.includes("***"));
});
