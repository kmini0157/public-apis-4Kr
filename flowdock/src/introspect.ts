/**
 * Small workflow introspection helpers shared across templates / validation.
 */

import type { Workflow } from "./types.ts";

/** The distinct connector ids a workflow uses, in first-seen order. */
export function referencedConnectors(workflow: Workflow): Set<string> {
  const out = new Set<string>();
  for (const node of workflow.nodes) out.add(node.uses);
  return out;
}
