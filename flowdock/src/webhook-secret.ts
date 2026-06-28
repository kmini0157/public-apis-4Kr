/**
 * Webhook secret + HMAC utilities (M1 triggers).
 *
 * Secrets live in .flowdock/webhooks.json for the keyless-first dev tier (the
 * envelope Vault needs FLOWDOCK_MASTER_KEY and is tenant-oriented; webhooks.json
 * keeps `flowdock serve` zero-setup). Comparisons are constant-time. Hosted
 * deployments should move these into the Vault — flagged in ARCHITECTURE.md.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./store.ts";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function generateSecret(length = 32): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

/** Constant-time string compare that also resists length leakage. */
export function verifySecret(provided: string, stored: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(stored);
  if (a.length !== b.length) {
    // Still do a compare to keep timing flat, but always return false.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Verify an HMAC-SHA256 signature (hex) over the raw payload. */
export function verifyHmac(payload: Buffer, signatureHex: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(payload).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signatureHex.replace(/^sha256=/, ""), "hex");
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

interface WebhookEntry {
  secret: string;
  createdAt: number;
  lastUsed?: number;
}

type WebhookFile = Record<string, WebhookEntry>;

/** Per-project webhook secret persistence (plaintext, dev tier). */
export class WebhookSecretStore {
  private data: WebhookFile = {};
  constructor(
    private readonly path = join(".flowdock", "webhooks.json"),
    private readonly clock: () => number = () => Date.now(),
  ) {
    if (existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, "utf8")) as WebhookFile;
      } catch {
        this.data = {};
      }
    }
  }
  private flush() {
    atomicWrite(this.path, JSON.stringify(this.data, null, 2));
  }
  /** Return the workflow's secret, minting + persisting one on first use. */
  ensure(workflowName: string, preset?: string): string {
    const existing = this.data[workflowName];
    if (existing) return existing.secret;
    const secret = preset ?? generateSecret();
    this.data[workflowName] = { secret, createdAt: this.clock() };
    this.flush();
    return secret;
  }
  get(workflowName: string): string | undefined {
    return this.data[workflowName]?.secret;
  }
  markUsed(workflowName: string): void {
    const e = this.data[workflowName];
    if (e) {
      e.lastUsed = this.clock();
      this.flush();
    }
  }
  list(): Array<{ name: string; createdAt: number; lastUsed?: number }> {
    return Object.entries(this.data).map(([name, e]) => ({
      name,
      createdAt: e.createdAt,
      ...(e.lastUsed ? { lastUsed: e.lastUsed } : {}),
    }));
  }
}
