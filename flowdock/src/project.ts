/**
 * Project config — single source of truth for where a FlowDock project keeps
 * its workflows, registry and lock file. Read from flowdock.config.json with
 * sensible defaults so a bare directory still works.
 */

import { readFileSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export interface ProjectConfig {
  name: string;
  /** Directory of *.yaml workflow definitions, relative to the project root. */
  workflowsDir: string;
  /** Where the JsonRegistry persists versions. */
  registryPath: string;
  /** Directory of community connector modules to load dynamically. */
  connectorsDir: string;
  /** Absolute project root (derived, not from disk). */
  root: string;
}

export function loadProjectConfig(dir: string = process.cwd()): ProjectConfig {
  const root = resolve(dir);
  const defaults: ProjectConfig = {
    name: basename(root),
    workflowsDir: "workflows",
    registryPath: join(".flowdock", "workflows.json"),
    connectorsDir: "connectors",
    root,
  };
  const file = join(root, "flowdock.config.json");
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ProjectConfig>;
      return { ...defaults, ...parsed, root };
    } catch (err) {
      throw new Error(`Invalid flowdock.config.json: ${(err as Error).message}`);
    }
  }
  return defaults;
}
