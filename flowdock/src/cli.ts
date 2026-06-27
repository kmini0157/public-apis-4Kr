#!/usr/bin/env -S node --import tsx
/**
 * flowdock CLI — the developer entry point (Workflows-as-Code).
 *
 *   flowdock validate <file>            type/DAG-check without running
 *   flowdock run <file> [--resume ID]   execute (or resume) a workflow
 *   flowdock connectors                 list registered connectors
 *
 * Secrets come from FLOWDOCK_SECRET_<NAME> env vars; dev credentials from
 * .flowdock/credentials.json ({ "resend.email": { "apiKey": "..." } }).
 */

import { existsSync, readFileSync } from "node:fs";
import { loadWorkflow } from "./loader.ts";
import { Engine } from "./engine.ts";
import { topoSort } from "./engine.ts";
import { JsonStore } from "./store.ts";
import { ConnectorRegistry } from "./connectors/index.ts";
import type { Json } from "./types.ts";

function collectSecrets(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("FLOWDOCK_SECRET_") && v !== undefined) {
      out[k.slice("FLOWDOCK_SECRET_".length)] = v;
    }
  }
  return out;
}

function credsProvider(): (id: string) => Record<string, string> {
  const path = ".flowdock/credentials.json";
  let table: Record<string, Record<string, string>> = {};
  if (existsSync(path)) {
    table = JSON.parse(readFileSync(path, "utf8")) as typeof table;
  }
  return (id) => table[id] ?? {};
}

function buildEngine(): Engine {
  return new Engine({
    registry: new ConnectorRegistry(),
    store: new JsonStore(),
    secrets: collectSecrets(),
    creds: credsProvider(),
  });
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);

  switch (cmd) {
    case "validate": {
      const wf = loadWorkflow(requireArg(positional[0], "file"));
      const order = topoSort(wf.nodes);
      const registry = new ConnectorRegistry();
      for (const n of wf.nodes) registry.get(n.uses); // throws on unknown connector
      console.log(`✓ '${wf.name}' is valid — ${wf.nodes.length} nodes`);
      console.log(`  execution order: ${order.map((n) => n.id).join(" → ")}`);
      break;
    }
    case "run": {
      const wf = loadWorkflow(requireArg(positional[0], "file"));
      const trigger = flags.trigger ? (JSON.parse(flags.trigger) as Json) : {};
      const engine = buildEngine();
      console.error(`▶ running '${wf.name}'...`);
      const result = await engine.run(wf, {
        runId: flags.resume,
        trigger,
      });
      console.error(`\n${result.status === "succeeded" ? "✓" : "✗"} run ${result.runId} — ${result.status}`);
      for (const s of result.steps) {
        const mark = s.status === "succeeded" ? "✓" : "✗";
        console.error(`  ${mark} ${s.nodeId} (${s.attempts} attempt(s), ${s.latencyMs}ms)${s.error ? " — " + s.error : ""}`);
      }
      // Final output (last node) to stdout for piping.
      console.log(JSON.stringify(result.outputs, null, 2));
      if (result.status !== "succeeded") process.exitCode = 1;
      break;
    }
    case "connectors": {
      const registry = new ConnectorRegistry();
      for (const c of registry.list()) {
        const auth = c.auth ? ` [auth: ${c.auth.kind}]` : " [keyless]";
        console.log(`${c.id.padEnd(22)} ${c.title}${auth}`);
      }
      break;
    }
    default:
      console.log(
        [
          "flowdock — developer-first multi-API automation hub",
          "",
          "Usage:",
          "  flowdock validate <file>           validate a workflow (DAG + connectors)",
          "  flowdock run <file> [--resume ID] [--trigger '<json>']",
          "  flowdock connectors                list registered connectors",
        ].join("\n"),
      );
      if (cmd && cmd !== "help") process.exitCode = 1;
  }
}

function requireArg(v: string | undefined, name: string): string {
  if (!v) {
    console.error(`Missing required argument: ${name}`);
    process.exit(1);
  }
  return v;
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
