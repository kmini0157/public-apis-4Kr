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
import { JsonStore, atomicWrite } from "./store.ts";
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
import { WebhookSecretStore, VaultWebhookSecretStore, type WebhookSecrets } from "./webhook-secret.ts";
import { buildEgressResolver, type EgressResolver as EngineEgress } from "./sandbox.ts";
import { Vault, type TenantKey } from "./vault.ts";
import { BillingService } from "./billing.ts";
import { TenantStore, can, type Role, type Tenant } from "./tenancy.ts";
import { UsageMeter } from "./usage.ts";
import { Workspace, PermissionError, QuotaError, type Actor } from "./workspace.ts";
import { getPlan, isPlanId, PLANS, UNLIMITED } from "./plans.ts";
import type { Json, Workflow } from "./types.ts";

/** Resolve the acting member: --as <email>, else the tenant's first owner. */
function actorFrom(tenants: TenantStore, tenant: Tenant, asEmail?: string): Actor {
  if (asEmail) {
    const role = tenants.roleOf(asEmail);
    if (!role) {
      console.error(`No member '${asEmail}' in this tenant`);
      process.exit(1);
    }
    return { email: asEmail, role };
  }
  const owner = tenant.members.find((m) => m.role === "owner") ?? tenant.members[0];
  if (!owner) {
    console.error("Tenant has no members");
    process.exit(1);
  }
  return { email: owner.email, role: owner.role };
}

const ROLES: Role[] = ["owner", "admin", "member", "viewer"];

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

function buildEngine(
  registry: ConnectorRegistry,
  store: JsonStore = new JsonStore(),
  egress?: EngineEgress,
): Engine {
  return new Engine({
    registry,
    store,
    secrets: collectSecrets(),
    creds: credsProvider(),
    ...(egress ? { egress } : {}),
  });
}

/** Load (or mint + persist) the sealed tenant data key for vault-backed secrets. */
function loadOrCreateTenantKey(vault: Vault): TenantKey {
  const path = join(".flowdock", "tenant-key.json");
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as TenantKey;
  const tk = vault.createTenantKey();
  atomicWrite(path, JSON.stringify(tk, null, 2));
  return tk;
}

/** Choose the webhook secret store: vault-encrypted (hardened) or plaintext (dev). */
function buildWebhookSecrets(useVault: boolean): WebhookSecrets | undefined {
  if (!useVault) return undefined; // server defaults to plaintext WebhookSecretStore
  if (!process.env.FLOWDOCK_MASTER_KEY) {
    console.error("--vault-secrets requires FLOWDOCK_MASTER_KEY (base64, 32 bytes)");
    process.exit(1);
  }
  const vault = new Vault();
  return new VaultWebhookSecretStore(vault, loadOrCreateTenantKey(vault));
}

/** Build the Stripe billing service when a webhook signing secret is configured. */
function buildBilling(): BillingService | undefined {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return undefined;
  let priceToPlan: Record<string, "free" | "pro" | "team"> | undefined;
  if (process.env.FLOWDOCK_STRIPE_PRICES) {
    try {
      priceToPlan = JSON.parse(process.env.FLOWDOCK_STRIPE_PRICES) as typeof priceToPlan;
    } catch {
      console.error("FLOWDOCK_STRIPE_PRICES must be JSON {priceId: plan}");
      process.exit(1);
    }
  }
  return new BillingService(new TenantStore(), secret, priceToPlan ? { priceToPlan } : {});
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

      const store = new JsonStore();
      const engine = buildEngine(registry, store);
      const tenants = new TenantStore();
      const tenant = tenants.get();
      const workspace = new Workspace(tenant, engine, store, new UsageMeter());
      const actor = actorFrom(tenants, tenant, flags.as);

      console.error(`▶ running '${wf.name}' as ${actor.email} (${tenant.plan})...`);
      let result;
      try {
        result = await workspace.run(wf, actor, { runId: flags.resume, trigger });
      } catch (err) {
        if (err instanceof PermissionError || err instanceof QuotaError) {
          console.error(`✗ ${err.message}`);
          process.exitCode = 1;
          break;
        }
        throw err;
      }
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
        // Enforce the plan's workflow cap before storing new versions.
        const tenant = new TenantStore().get();
        const plan = getPlan(tenant.plan);
        const adding = syncer.diff(project.workflowsDir).added.length;
        const have = registry.listWorkflows().length;
        if (plan.maxWorkflows !== UNLIMITED && have + adding > plan.maxWorkflows) {
          console.error(
            `✗ Workflow limit reached: ${plan.name} allows ${plan.maxWorkflows} (have ${have}, adding ${adding}). Upgrade to push more.`,
          );
          process.exitCode = 1;
          break;
        }
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
      const store = new JsonStore();
      // Hosted hardening: --sandbox enforces per-connector egress allowlists.
      const sandboxed = flags.sandbox === "true";
      const egress = sandboxed ? buildEgressResolver(registry, { strict: true }) : undefined;
      const engine = buildEngine(registry, store, egress);
      const workflows = loadWorkflowsDir(join(project.root, project.workflowsDir));
      const portFlag = numFlag(flags.port, "port");
      const bodyLimit = numFlag(flags["body-limit"], "body-limit");
      // Hosted hardening: encrypt webhook secrets at rest when a master key is present.
      const secrets = buildWebhookSecrets(flags["vault-secrets"] === "true");
      // Hosted hardening: Stripe billing webhook if a signing secret is configured.
      const billing = buildBilling();
      const server = new TriggerServer(
        workflows,
        engine,
        store,
        {
          ...(portFlag !== undefined ? { port: portFlag } : {}),
          ...(flags.host ? { host: flags.host } : {}),
          ...(bodyLimit !== undefined ? { bodyLimitBytes: bodyLimit } : {}),
        },
        secrets,
        billing,
      );
      const { host, port } = await server.listen();
      console.error(`▶ FlowDock serving ${workflows.length} workflow(s) on http://${host}:${port}`);
      console.error(`  sandbox: ${sandboxed ? "on (strict egress)" : "off"} · secrets: ${secrets ? "vault" : "plaintext"} · billing: ${billing ? "on" : "off"}`);
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

    case "plan": {
      const tenants = new TenantStore();
      if (positional[0] === "set") {
        const id = requireArg(positional[1], "plan id");
        if (!isPlanId(id)) {
          console.error(`Unknown plan '${id}'. Valid: ${Object.keys(PLANS).join(", ")}`);
          process.exitCode = 1;
          break;
        }
        tenants.setPlan(id);
        console.log(`✓ plan set to ${getPlan(id).name}`);
        break;
      }
      const tenant = tenants.get();
      const p = getPlan(tenant.plan);
      const lim = (n: number) => (n === UNLIMITED ? "∞" : String(n));
      console.log(`Plan: ${p.name} ($${p.priceUsd}/mo)`);
      console.log(`  workflows:     ${lim(p.maxWorkflows)}`);
      console.log(`  executions/mo: ${lim(p.executionsPerMonth)}`);
      console.log(`  log retention: ${p.logRetentionDays} days`);
      console.log(`  seats:         ${tenant.members.length}/${lim(p.maxSeats)}`);
      console.log(`  concurrency:   ${lim(p.maxConcurrency)}`);
      console.log(`  (change with: flowdock plan set <free|pro|team>)`);
      break;
    }

    case "usage": {
      const tenants = new TenantStore();
      const tenant = tenants.get();
      const store = new JsonStore();
      const ws = new Workspace(tenant, buildEngine(new ConnectorRegistry(), store), store, new UsageMeter());
      const s = ws.summary();
      console.log(`Tenant '${tenant.name}' — ${s.plan.name}`);
      console.log(`  executions this month: ${s.executionsUsed} (remaining: ${s.executionsRemaining})`);
      console.log(`  seats: ${s.seatsUsed}/${s.plan.maxSeats === UNLIMITED ? "∞" : s.plan.maxSeats}`);
      console.log(`  log retention: ${s.retentionDays} days`);
      break;
    }

    case "prune": {
      const tenants = new TenantStore();
      const tenant = tenants.get();
      const store = new JsonStore();
      const ws = new Workspace(tenant, buildEngine(new ConnectorRegistry(), store), store, new UsageMeter());
      const r = ws.enforceRetention();
      const days = getPlan(tenant.plan).logRetentionDays;
      console.log(`prune (${days}d retention): deleted ${r.deleted.length} run(s), kept ${r.kept}`);
      break;
    }

    case "members": {
      const tenants = new TenantStore();
      const sub = positional[0];
      const actor = actorFrom(tenants, tenants.get(), flags.as);
      if (sub === "list" || sub === undefined) {
        for (const m of tenants.get().members) console.log(`${m.role.padEnd(7)} ${m.email}`);
        break;
      }
      // mutating member ops require manage_members
      if (!can(actor.role, "manage_members")) {
        console.error(`✗ ${actor.role} '${actor.email}' may not manage members`);
        process.exitCode = 1;
        break;
      }
      try {
        if (sub === "add") {
          const email = requireArg(positional[1], "email");
          const role = (flags.role ?? "member") as Role;
          if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(", ")}`);
          tenants.addMember(email, role);
          console.log(`✓ added ${email} (${role})`);
        } else if (sub === "remove") {
          tenants.removeMember(requireArg(positional[1], "email"));
          console.log(`✓ removed`);
        } else if (sub === "role") {
          const email = requireArg(positional[1], "email");
          const role = requireArg(positional[2], "role") as Role;
          if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(", ")}`);
          tenants.setRole(email, role);
          console.log(`✓ ${email} is now ${role}`);
        } else {
          console.error("usage: flowdock members list | add <email> [--role R] | remove <email> | role <email> <role>");
          process.exitCode = 1;
        }
      } catch (err) {
        console.error(`✗ ${(err as Error).message}`);
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
          "  serve [--port][--host][--sandbox][--vault-secrets]",
          "                                  webhook + cron server (+ /billing/webhook)",
          "  webhooks list                   show webhook secrets",
          "",
          "Ecosystem:",
          "  connectors [--registry DIR]     list connectors",
          "  create-connector <ns.name>      scaffold a new connector + test",
          "  templates list | use <name>     template gallery",
          "",
          "Plan & team:",
          "  plan [set <free|pro|team>]      show or change the plan",
          "  usage                           executions used / remaining",
          "  prune                           apply log-retention policy",
          "  members list | add <email> [--role R] | remove <email> | role <email> <role>",
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

// Exit quietly when output is piped to a command that closes early (e.g. `| head`).
process.stdout.on("error", (err) => {
  if ((err as NodeJS.ErrnoException).code === "EPIPE") process.exit(0);
  throw err;
});

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
