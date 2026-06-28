/**
 * Dry-run (M1 DX) — validate a workflow's wiring without touching the network.
 *
 * Reuses the SAME topoSort + expression resolver as the real Engine, so a green
 * dry-run guarantees every {{ }} reference resolves and every node's inputs are
 * shaped right. Connector outputs are faked from `node.mock`, else the
 * connector's `outputs` schema, else null. execute() is never called.
 */

import { topoSort } from "./engine.ts";
import { resolve } from "./expr.ts";
import { validateInput } from "./schema.ts";
import { sampleFromSchema } from "./loader-dynamic.ts";
import type { ConnectorRegistry } from "./connectors/index.ts";
import type { Json, RunStatus, Workflow } from "./types.ts";

export interface DryRunStep {
  nodeId: string;
  status: RunStatus;
  output?: Json;
  /** "mock" | "schema" | "null" — where the faked output came from. */
  source: "mock" | "schema" | "null";
  error?: string;
}

export interface DryRunResult {
  status: RunStatus;
  outputs: Record<string, Json>;
  steps: DryRunStep[];
}

export function runDryRun(
  workflow: Workflow,
  registry: ConnectorRegistry,
  trigger: Json = {},
): DryRunResult {
  const order = topoSort(workflow.nodes); // throws on cycle / dangling ref
  const nodesScope: Record<string, Json> = {};
  const steps: DryRunStep[] = [];
  let failed = false;

  for (const node of order) {
    const scope: Record<string, Json> = {
      trigger,
      secrets: {},
      env: {},
      nodes: nodesScope,
    };
    try {
      const connector = registry.get(node.uses); // unknown connector -> error
      const input = resolve(node.with ?? {}, scope); // resolves every {{ }}
      const check = validateInput(input, connector.inputs);
      if (!check.valid) throw new Error(check.errors!.join("; "));

      let output: Json;
      let source: DryRunStep["source"];
      if (node.mock !== undefined) {
        output = node.mock;
        source = "mock";
      } else if (connector.outputs !== undefined) {
        output = sampleFromSchema(connector.outputs);
        source = "schema";
      } else {
        output = null;
        source = "null";
      }
      nodesScope[node.id] = { output };
      steps.push({ nodeId: node.id, status: "succeeded", output, source });
    } catch (err) {
      failed = true;
      steps.push({ nodeId: node.id, status: "failed", source: "null", error: (err as Error).message });
      break;
    }
  }

  const outputs: Record<string, Json> = {};
  for (const s of steps) if (s.status === "succeeded") outputs[s.nodeId] = s.output ?? null;
  return { status: failed ? "failed" : "succeeded", outputs, steps };
}
