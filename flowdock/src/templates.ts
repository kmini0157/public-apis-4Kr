/**
 * Template gallery (M2) — `flowdock templates list/use`.
 *
 * Ready-made workflows seed the network effect: users start from a template,
 * customize it, and it becomes one of their accumulated workflows. Templates
 * ship in the package's templates/ dir and use only keyless built-ins so they
 * run offline out of the box.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflow } from "./loader.ts";
import { referencedConnectors } from "./introspect.ts";

export interface TemplateMetadata {
  name: string;
  file: string;
  description: string;
  nodes: number;
  connectors: string[];
}

/** templates/ lives next to src/, so resolve from this module, not cwd. */
function templatesDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "templates");
}

/** First `# ...` comment line in the file, used as the human description. */
function leadingComment(text: string): string {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("#")) return t.replace(/^#+\s?/, "");
    if (t.length > 0) break; // stop at the first non-comment content
  }
  return "";
}

export function listTemplates(): TemplateMetadata[] {
  const dir = templatesDir();
  if (!existsSync(dir)) return [];
  const out: TemplateMetadata[] = [];
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const text = readFileSync(join(dir, file), "utf8");
    try {
      const wf = parseWorkflow(text);
      out.push({
        name: file.replace(/\.ya?ml$/, ""),
        file,
        description: leadingComment(text) || wf.name,
        nodes: wf.nodes.length,
        connectors: [...referencedConnectors(wf)],
      });
    } catch {
      // skip a malformed template rather than break `templates list`
    }
  }
  return out;
}

/** Copy a template into the target dir, applying simple {{VAR}} substitution. */
export function useTemplate(
  name: string,
  targetDir: string,
  vars: Record<string, string> = {},
): string {
  const dir = templatesDir();
  const candidates = [join(dir, name), join(dir, `${name}.yaml`), join(dir, `${name}.yml`)];
  const src = candidates.find((p) => existsSync(p));
  if (!src) throw new Error(`Template '${name}' not found. Try: flowdock templates list`);
  let content = readFileSync(src, "utf8");
  for (const [k, v] of Object.entries(vars)) {
    content = content.split(`{{${k}}}`).join(v);
  }
  mkdirSync(targetDir, { recursive: true });
  const dest = join(targetDir, `${name}.yaml`);
  writeFileSync(dest, content);
  return dest;
}
