/**
 * Dynamic connector loading (M2).
 *
 * Imports every module in a project's connectors/ directory and returns the
 * valid Connector exports. Trust model for the offline dev tier: only local
 * project paths are imported (no remote URLs), and malformed modules are
 * skipped rather than crashing the run. Code still runs in-process — a hosted
 * deployment would need a real sandbox (flagged in ARCHITECTURE.md risks).
 */

import { readdirSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Connector, Json } from "./types.ts";

function isConnector(v: unknown): v is Connector {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as Connector).id === "string" &&
    typeof (v as Connector).execute === "function"
  );
}

/** Pick a Connector out of a module's default or named exports. */
function extractConnector(mod: Record<string, unknown>): Connector | undefined {
  if (isConnector(mod.default)) return mod.default;
  for (const val of Object.values(mod)) if (isConnector(val)) return val;
  return undefined;
}

export interface LoadedConnectors {
  connectors: Connector[];
  errors: Record<string, string>;
}

/**
 * Load connectors from `dir`. Safe to call when the directory is absent.
 * Returns valid connectors plus a per-file error map for reporting.
 */
export async function loadConnectors(dir: string): Promise<LoadedConnectors> {
  const out: LoadedConnectors = { connectors: [], errors: {} };
  const abs = isAbsolute(dir) ? dir : resolve(dir);
  if (!existsSync(abs)) return out;

  for (const file of readdirSync(abs)) {
    if (!/\.(ts|js|mjs)$/.test(file) || /\.(test|spec)\./.test(file)) continue;
    const full = join(abs, file);
    try {
      const mod = (await import(pathToFileURL(full).href)) as Record<string, unknown>;
      const connector = extractConnector(mod);
      if (!connector) {
        out.errors[file] = "no Connector export found (need { id, execute })";
        continue;
      }
      out.connectors.push(connector);
    } catch (err) {
      out.errors[file] = (err as Error).message;
    }
  }
  return out;
}

/** Sample-output synthesis helper shared with dry-run, kept here to avoid a cycle. */
export function sampleFromSchema(schema: Json | undefined): Json {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const s = schema as Record<string, Json>;
  if (s.type === "object" && s.properties && typeof s.properties === "object") {
    const out: Record<string, Json> = {};
    for (const [k, sub] of Object.entries(s.properties as Record<string, Json>)) {
      out[k] = sampleFromSchema(sub);
    }
    return out;
  }
  if (s.type === "array") return [];
  if (s.type === "string") return `<${typeof s.title === "string" ? s.title : "string"}>`;
  if (s.type === "number" || s.type === "integer") return 0;
  if (s.type === "boolean") return false;
  return null;
}
