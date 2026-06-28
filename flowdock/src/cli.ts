#!/usr/bin/env -S node --import tsx
/**
 * flowdock CLI — the developer entry point (Workflows-as-Code).
 *
 * M0:  validate · run · connectors
 * M1:  push · pull · history · diff · serve · webhooks · logs · run --dry-run
 * M2:  create-connector · templates · connectors --registry
 *
 * Secrets come from FLOWDOCK_SECRET_<NAME> env vars; dev credentials from
 * .flowdock/credentials.json. Community connectors load from connectors/.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadWorkflow, parseWorkflow } from "./loader.ts";
import { Engine, topoSort } from "./engine.ts";
import { JsonStore } from "./store.ts";
import { ConnectorRegistry } from "./connectors/index.ts";
import { loadConnectors } from "./loader-dynamic.ts";
import { loadProjectConfig, type ProjectConfig } from "./project.ts";
import { JsonRegistry } from "./registry.ts";
import { WorkflowSyncer } from "./sync.ts";
import { runDryRun } from "./dryrun.ts";
import { renderTimeline, buildTimeline } from "./timeline.ts";
import { TriggerServer } from "./trigger-server.ts";
import { scaffoldConnector } from "./sdk.ts";
import { listTemplates, useTemplate } from "./templates.ts";
import { WebhookSecretStore } from "./webhook-secret.ts";
import type { Json, Workflow } from "./types.ts";

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
  if (existsSync(path)) table = JSON.parse(readFileSync(path, "utf8")) as typeof table;
  return (id) => table[id] ?? {};
}

/** Build a registry, loading community connectors from the project dir. */
async function buildRegistry(project: ProjectConfig): Promise<ConnectorRegistry> {
  const registry = new ConnectorRegistry();
  const dir = join(project.root, project.connectorsDir);
  const { connectors, errors } = await loadConnectors(dir);
  for (const c of connectors) registry.registerDynamic(c);
  for (const [file, msg] of Object.entries(errors)) console.error(`⚠ connector ${file}: ${msg}`);
  return registry;
}

function buildEngine(registry: ConnectorRegistry): Engine {
  return new Engine({
    registry,
    store: new JsonStore(),
    secrets: collectSecrets(),
    creds: credsProvider(),
  });
}

/** Load every *.yaml in a directory into Workflows (skips invalid, warns). */
function loadWorkflowsDir(dir: string): Workflow[] {
  if (!existsSync(dir)) return [];
  const out: Workflow[] = [];
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    try {
      out.push(parseWorkflow(readFileSync(join(dir, file), "utf8")));
    } catch (err) {
      console.error(`⚠ skipping ${file}: ${(err as Error).message}`);
    }
  }
  return out;
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
      } else flags[key] = "true";
    } else positional.push(a);
  }
  return { positional, flags };
}

function requireArg(v: string | undefined, name: string): string {
  if (!v) {
    console.error(`Missing required argument: ${name}`);
    process.exit(1);
  }
  return v;
}

/** Parse a numeric flag, rejecting a bare `--flag` (parser yields "true") -> NaN. */
function numFlag(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`--${name} requires a numeric value`);
    process.exit(1);
  }
  return n;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);

  switch (cmd) {
    case "validate": {
      const wf = loadWorkflow(requireArg(positional[0], "file"));
      const order = topoSort(wf.nodes);
      const project = loadProjectConfig();
      const registry = await buildRegistry(project);
      for (const n of wf.nodes) registry.get(n.uses);
      console.log(`✓ '${wf.name}' is valid — ${wf.nodes.length} nodes`);
      console.log(`  order: ${order.map((n) => n.id).join(" → ")}`);
      break;
    }

    case "run": {
      const wf = loadWorkflow(requireArg(positional[0], "file"));
      const trigger = flags.trigger ? (JSON.parse(flags.trigger) as Json) : {};
      const project = loadProjectConfig();
      const registry = await buildRegistry(project);

      if (flags["dry-run"]) {
        const dry = runDryRun(wf, registry, trigger);
        console.error(`${dry.status === "succeeded" ? "✓" : "✗"} dry-run '${wf.name}'`);
        for (const s of dry.steps) {
          const mark = s.status === "succeeded" ? "✓" : "✗";
          console.error(`  ${mark} ${s.nodeId} (output: ${s.source})${s.error ? " — " + s.error : ""}`);
        }
        console.log(JSON.stringify(dry.outputs, null, 2));
        if (dry.status !== "succeeded") process.exitCode = 1;
        break;
      }

      const engine = buildEngine(registry);
      console.error(`▶ running '${wf.name}'...`);
      const result = await engine.run(wf, { runId: flags.resume, trigger });
      console.error(`\n${result.status === "succeeded" ? "✓" : "✗"} run ${result.runId} — ${result.status}`);
      for (const s of result.steps) {
        const mark = s.status === "succeeded" ? "✓" : "✗";
        console.error(`  ${mark} ${s.nodeId} (${s.attempts} attempt(s), ${s.latencyMs}ms)${s.error ? " — " + s.error : ""}`);
      }
      console.log(JSON.stringify(result.outputs, null, 2));
      if (result.status !== "succeeded") process.exitCode = 1;
      break;
    }

    case "connectors": {
      const project = loadProjectConfig();
      const registry = flags.registry
        ? await buildRegistryFrom(flags.registry)
        : await buildRegistry(project);
      for (const c of registry.list()) {
        const auth = c.auth ? `[auth: ${c.auth.kind}]` : "[keyless]";
        const dyn = registry.dynamicInfo(c.id);
        const tag = dyn ? (dyn.verified ? " (community ✓)" : " (community)") : "";
        console.log(`${c.id.padEnd(22)} ${c.title} ${auth}${tag}`);
      }
      break;
    }

    case "push":
    case "pull":
    case "diff":
    case "history": {
      const project = loadProjectConfig();
      const registry = new JsonRegistry(join(project.root, project.registryPath));
      const syncer = new WorkflowSyncer(registry, project.root, {
        dryRun: flags["dry-run"] === "true",
        ...(flags.author ? { author: flags.author } : {}),
      });
      if (cmd === "push") {
        const r = syncer.push(project.workflowsDir);
        console.log(`push: ${r.pushed.length} new, ${r.unchanged.length} unchanged`);
        if (r.pushed.length) console.log(`  + ${r.pushed.join(", ")}`);
        for (const [f, e] of Object.entries(r.errors)) console.error(`  ✗ ${f}: ${e}`);
      } else if (cmd === "pull") {
        const r = syncer.pull(project.workflowsDir);
        console.log(`pull: ${r.pulled.length} written, ${r.unchanged.length} unchanged`);
        if (r.pulled.length) console.log(`  ↓ ${r.pulled.join(", ")}`);
      } else if (cmd === "diff") {
        const d = syncer.diff(project.workflowsDir, positional[0]);
        for (const n of d.added) console.log(`+ ${n} (local only)`);
        for (const n of d.removed) console.log(`- ${n} (registry only)`);
        for (const m of d.modified) console.log(`~ ${m.name} (${m.localHash.slice(0, 8)} → ${m.storedHash.slice(0, 8)})`);
        if (!d.added.length && !d.removed.length && !d.modified.length) console.log("no changes");
      } else {
        const name = requireArg(positional[0], "name");
        const limit = numFlag(flags.limit, "limit");
        const versions = syncer.getHistory(name).slice(-(limit ?? 1000));
        if (!versions.length) console.log(`no history for '${name}'`);
        for (const v of versions) {
          console.log(`${v.version}  ${v.yamlHash.slice(0, 12)}  ${new Date(v.createdAt).toISOString()}${v.author ? "  " + v.author : ""}`);
        }
      }
      break;
    }

    case "serve": {
      const project = loadProjectConfig();
      const registry = await buildRegistry(project);
      const engine = buildEngine(registry);
      const store = new JsonStore();
      const workflows = loadWorkflowsDir(join(project.root, project.workflowsDir));
      const portFlag = numFlag(flags.port, "port");
      const bodyLimit = numFlag(flags["body-limit"], "body-limit");
      const server = new TriggerServer(workflows, engine, store, {
        ...(portFlag !== undefined ? { port: portFlag } : {}),
        ...(flags.host ? { host: flags.host } : {}),
        ...(bodyLimit !== undefined ? { bodyLimitBytes: bodyLimit } : {}),
      });
      const { host, port } = await server.listen();
      console.error(`▶ FlowDock serving ${workflows.length} workflow(s) on http://${host}:${port}`);
      for (const h of server.hookUrls(`http://${host}:${port}`)) console.error(`  hook: ${h.workflow} → ${h.url}`);
      console.error("  (Ctrl-C to stop)");
      process.on("SIGINT", () => {
        void server.close().then(() => process.exit(0));
      });
      break;
    }

    case "webhooks": {
      if (positional[0] !== "list") {
        console.error("usage: flowdock webhooks list");
        process.exitCode = 1;
        break;
      }
      const store = new WebhookSecretStore();
      const list = store.list();
      if (!list.length) console.log("no webhook secrets yet (run `flowdock serve` to mint them)");
      for (const w of list) {
        console.log(`${w.name.padEnd(24)} created ${new Date(w.createdAt).toISOString()}${w.lastUsed ? "  last used " + new Date(w.lastUsed).toISOString() : ""}`);
      }
      break;
    }

    case "logs": {
      const runId = requireArg(positional[0], "runId");
      const store = new JsonStore();
      const run = store.getRun(runId);
      if (!run) {
        console.error(`run '${runId}' not found`);
        process.exitCode = 1;
        break;
      }
      const steps = store.getSteps(runId);
      if (flags.json) console.log(JSON.stringify(buildTimeline(steps), null, 2));
      else console.log(renderTimeline(run, steps));
      break;
    }

    case "create-connector": {
      const id = requireArg(positional[0], "id");
      const project = loadProjectConfig();
      const dir = flags["output-dir"] ?? join(project.root, project.connectorsDir);
      const out = scaffoldConnector(id, dir);
      console.log(`✓ created connector:`);
      console.log(`  ${out.connectorFile}`);
      console.log(`  ${out.testFile}`);
      break;
    }

    case "templates": {
      const sub = positional[0];
      if (sub === "list") {
        const filter = flags.filter;
        for (const t of listTemplates()) {
          if (filter && !`${t.name} ${t.description}`.includes(filter)) continue;
          console.log(`${t.name.padEnd(24)} ${t.description}`);
          console.log(`${" ".repeat(24)} ${t.nodes} nodes · ${t.connectors.join(", ")}`);
        }
      } else if (sub === "use") {
        const name = requireArg(positional[1], "template name");
        const project = loadProjectConfig();
        const dir = flags["output-dir"] ?? join(project.root, project.workflowsDir);
        const dest = useTemplate(name, dir);
        console.log(`✓ created ${dest}`);
      } else {
        console.error("usage: flowdock templates list | flowdock templates use <name>");
        process.exitCode = 1;
      }
      break;
    }

    default:
      console.log(
        [
          "flowdock — developer-first multi-API automation hub",
          "",
          "Workflows:",
          "  validate <file>                 validate DAG + connectors",
          "  run <file> [--dry-run] [--resume ID] [--trigger '<json>']",
          "  logs <runId> [--json]           per-node execution timeline",
          "",
          "Workflows-as-Code:",
          "  push [--dry-run] [--author N]   store changed workflows as versions",
          "  pull [--dry-run]                reconstruct workflows/ from registry",
          "  diff [<name>]                   local vs registry",
          "  history <name> [--limit N]      version history",
          "",
          "Triggers:",
          "  serve [--port][--host]          run webhook + cron trigger server",
          "  webhooks list                   show webhook secrets",
          "",
          "Ecosystem:",
          "  connectors [--registry DIR]     list connectors",
          "  create-connector <ns.name>      scaffold a new connector + test",
          "  templates list | use <name>     template gallery",
        ].join("\n"),
      );
      if (cmd && cmd !== "help") process.exitCode = 1;
  }
}

/** connectors --registry DIR : list ONLY the connectors in a given dir. */
async function buildRegistryFrom(dir: string): Promise<ConnectorRegistry> {
  const registry = new ConnectorRegistry();
  const { connectors, errors } = await loadConnectors(dir);
  for (const c of connectors) registry.registerDynamic(c);
  for (const [file, msg] of Object.entries(errors)) console.error(`⚠ connector ${file}: ${msg}`);
  return registry;
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
