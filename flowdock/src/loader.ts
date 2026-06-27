/**
 * Workflows-as-Code loader: parse + validate a YAML/JSON workflow file into a
 * typed Workflow. Validation happens here (not in the engine) so errors point
 * at the author's file with clear messages.
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { NodeSpec, Workflow } from "./types.ts";

export function parseWorkflow(text: string): Workflow {
  const raw = parse(text) as unknown;
  if (!raw || typeof raw !== "object") throw new Error("Workflow must be a YAML/JSON object");
  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== "string" || !obj.name.trim()) {
    throw new Error("Workflow 'name' is required");
  }
  if (!Array.isArray(obj.nodes) || obj.nodes.length === 0) {
    throw new Error("Workflow 'nodes' must be a non-empty array");
  }

  const seen = new Set<string>();
  const nodes: NodeSpec[] = obj.nodes.map((n, i) => {
    if (!n || typeof n !== "object") throw new Error(`nodes[${i}] must be an object`);
    const node = n as Record<string, unknown>;
    if (typeof node.id !== "string" || !node.id.trim()) throw new Error(`nodes[${i}].id is required`);
    if (seen.has(node.id)) throw new Error(`Duplicate node id '${node.id}'`);
    seen.add(node.id);
    if (typeof node.uses !== "string" || !node.uses.trim()) {
      throw new Error(`nodes[${i}] ('${node.id}') is missing 'uses'`);
    }
    const spec: NodeSpec = { id: node.id, uses: node.uses };
    if (node.with !== undefined) spec.with = node.with as NodeSpec["with"];
    if (node.needs !== undefined) {
      if (!Array.isArray(node.needs)) throw new Error(`nodes[${i}].needs must be an array`);
      spec.needs = node.needs as string[];
    }
    if (node.retry !== undefined) spec.retry = node.retry as NodeSpec["retry"];
    return spec;
  });

  const wf: Workflow = { name: obj.name, nodes };
  if (obj.on !== undefined) wf.on = obj.on as Workflow["on"];
  return wf;
}

export function loadWorkflow(path: string): Workflow {
  return parseWorkflow(readFileSync(path, "utf8"));
}
