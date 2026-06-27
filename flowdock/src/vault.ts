/**
 * Credential vault — envelope encryption (AES-256-GCM).
 *
 *   master key (env)  ─encrypts→  per-tenant data key  ─encrypts→  secret
 *
 * Two layers so a tenant's blast radius is one data key, and rotating the
 * master key never requires re-encrypting every secret. Plaintext secrets
 * live only in memory for the duration of a connector call.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALG = "aes-256-gcm";
const KEY_LEN = 32;

/** A sealed blob: iv | authTag | ciphertext, base64. Self-describing. */
function seal(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

function open(key: Buffer, blob: string): Buffer {
  const raw = Buffer.from(blob, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export interface TenantKey {
  /** Data key, sealed with the master key. Safe to persist. */
  sealedDataKey: string;
}

export interface SealedSecret {
  connector: string;
  name: string;
  /** Secret value, sealed with the tenant data key. */
  ciphertext: string;
}

export class Vault {
  private readonly masterKey: Buffer;

  constructor(masterKeyB64: string | undefined = process.env.FLOWDOCK_MASTER_KEY) {
    if (!masterKeyB64) {
      throw new Error(
        "FLOWDOCK_MASTER_KEY is required (base64, 32 bytes). Generate: openssl rand -base64 32",
      );
    }
    const key = Buffer.from(masterKeyB64, "base64");
    if (key.length !== KEY_LEN) {
      throw new Error(`FLOWDOCK_MASTER_KEY must decode to ${KEY_LEN} bytes, got ${key.length}`);
    }
    this.masterKey = key;
  }

  /** Mint a fresh tenant data key, returned sealed under the master key. */
  createTenantKey(): TenantKey {
    const dataKey = randomBytes(KEY_LEN);
    return { sealedDataKey: seal(this.masterKey, dataKey) };
  }

  private unsealDataKey(tk: TenantKey): Buffer {
    return open(this.masterKey, tk.sealedDataKey);
  }

  /** Encrypt a secret value under the tenant's data key. */
  sealSecret(tk: TenantKey, connector: string, name: string, value: string): SealedSecret {
    const dataKey = this.unsealDataKey(tk);
    return { connector, name, ciphertext: seal(dataKey, Buffer.from(value, "utf8")) };
  }

  /** Decrypt one secret. Caller must keep the result in memory only. */
  openSecret(tk: TenantKey, secret: SealedSecret): string {
    const dataKey = this.unsealDataKey(tk);
    return open(dataKey, secret.ciphertext).toString("utf8");
  }

  /** Decrypt all of a connector's secrets into a creds map for a node call. */
  openCreds(tk: TenantKey, secrets: SealedSecret[], connector: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const s of secrets) {
      if (s.connector === connector) out[s.name] = this.openSecret(tk, s);
    }
    return out;
  }
}

/**
 * Build a logger that redacts known secret values from any logged message —
 * defense in depth so a connector can't accidentally print a token.
 */
export function maskingLogger(
  secretValues: Iterable<string>,
  sink: (line: string) => void = (l) => console.error(l),
): (msg: string, extra?: unknown) => void {
  const values = [...secretValues].filter((v) => v.length >= 4);
  const mask = (text: string): string => {
    let out = text;
    for (const v of values) out = out.split(v).join("***");
    return out;
  };
  return (msg, extra) => {
    const line = extra === undefined ? msg : `${msg} ${JSON.stringify(extra)}`;
    sink(mask(line));
  };
}
