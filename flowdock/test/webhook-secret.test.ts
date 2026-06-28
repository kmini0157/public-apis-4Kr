import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { generateSecret, verifySecret, verifyHmac, WebhookSecretStore } from "../src/webhook-secret.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("generateSecret has the requested length and varies", () => {
  assert.equal(generateSecret(32).length, 32);
  assert.notEqual(generateSecret(), generateSecret());
});

test("verifySecret accepts a match and rejects mismatch/length-diff", () => {
  const s = generateSecret();
  assert.equal(verifySecret(s, s), true);
  assert.equal(verifySecret(s + "x", s), false);
  assert.equal(verifySecret("nope", s), false);
});

test("verifyHmac validates a correct signature and rejects tampering", () => {
  const secret = "shh";
  const payload = Buffer.from('{"a":1}');
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  assert.equal(verifyHmac(payload, sig, secret), true);
  assert.equal(verifyHmac(payload, sig, "wrong"), false);
  assert.equal(verifyHmac(Buffer.from("tampered"), sig, secret), false);
  assert.equal(verifyHmac(payload, "sha256=" + sig, secret), true);
});

test("WebhookSecretStore mints once and persists", () => {
  const dir = mkdtempSync(join(tmpdir(), "flowdock-wh-"));
  const path = join(dir, "webhooks.json");
  const store = new WebhookSecretStore(path, () => 42);
  const a = store.ensure("wf");
  const b = store.ensure("wf"); // stable
  assert.equal(a, b);
  // reload from disk sees the same secret
  const reopened = new WebhookSecretStore(path);
  assert.equal(reopened.get("wf"), a);
  rmSync(dir, { recursive: true, force: true });
});
