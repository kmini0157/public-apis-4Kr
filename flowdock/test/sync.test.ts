import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryRegistry } from "../src/registry.ts";
import { WorkflowSyncer } from "../src/sync.ts";

function project(): { dir: string; wfDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "flowdock-sync-"));
  const wfDir = join(dir, "workflows");
  mkdirSync(wfDir, { recursive: true });
  return { dir, wfDir };
}

const WF = (name: string, node = "echo") =>
  `name: ${name}\nnodes:\n  - id: n\n    uses: ${node}\n`;

let clock = 1;
const tick = () => clock++;

test("push stores new versions, re-push is unchanged", () => {
  const { dir } = project();
  writeFileSync(join(dir, "workflows", "a.yaml"), WF("Alpha"));
  const reg = new MemoryRegistry(tick);
  const syncer = new WorkflowSyncer(reg, dir, { clock: tick });

  const first = syncer.push("workflows");
  assert.deepEqual(first.pushed, ["Alpha"]);
  assert.ok(existsSync(join(dir, "flowdock.lock.json")));

  const second = syncer.push("workflows");
  assert.deepEqual(second.unchanged, ["Alpha"]);
  assert.deepEqual(second.pushed, []);
  rmSync(dir, { recursive: true, force: true });
});

test("push collects per-file errors but continues", () => {
  const { dir } = project();
  writeFileSync(join(dir, "workflows", "good.yaml"), WF("Good"));
  writeFileSync(join(dir, "workflows", "bad.yaml"), "name: 123\nnope:\n");
  const syncer = new WorkflowSyncer(new MemoryRegistry(tick), dir, { clock: tick });
  const r = syncer.push("workflows");
  assert.deepEqual(r.pushed, ["Good"]);
  assert.ok(r.errors["bad.yaml"]);
  rmSync(dir, { recursive: true, force: true });
});

test("pull reconstructs files and is idempotent", () => {
  const { dir } = project();
  writeFileSync(join(dir, "workflows", "a.yaml"), WF("Beta"));
  const reg = new MemoryRegistry(tick);
  const syncer = new WorkflowSyncer(reg, dir, { clock: tick });
  syncer.push("workflows");

  // wipe local, pull back
  rmSync(join(dir, "workflows", "a.yaml"));
  const pulled = syncer.pull("workflows");
  assert.deepEqual(pulled.pulled, ["Beta"]);
  assert.ok(readFileSync(join(dir, "workflows", "Beta.yaml"), "utf8").includes("Beta"));

  const again = syncer.pull("workflows");
  assert.deepEqual(again.unchanged, ["Beta"]);
  rmSync(dir, { recursive: true, force: true });
});

test("dryRun push does not write versions", () => {
  const { dir } = project();
  writeFileSync(join(dir, "workflows", "a.yaml"), WF("Gamma"));
  const reg = new MemoryRegistry(tick);
  const syncer = new WorkflowSyncer(reg, dir, { clock: tick, dryRun: true });
  const r = syncer.push("workflows");
  assert.deepEqual(r.pushed, ["Gamma"]);
  assert.equal(reg.getWorkflowVersions("Gamma").length, 0);
  assert.equal(existsSync(join(dir, "flowdock.lock.json")), false);
  rmSync(dir, { recursive: true, force: true });
});

test("diff reports added / modified / removed", () => {
  const { dir } = project();
  const reg = new MemoryRegistry(tick);
  const syncer = new WorkflowSyncer(reg, dir, { clock: tick });

  writeFileSync(join(dir, "workflows", "a.yaml"), WF("Delta"));
  assert.deepEqual(syncer.diff("workflows").added, ["Delta"]);

  syncer.push("workflows");
  assert.deepEqual(syncer.diff("workflows").unchanged, ["Delta"]);

  writeFileSync(join(dir, "workflows", "a.yaml"), WF("Delta", "http.request"));
  const d = syncer.diff("workflows");
  assert.equal(d.modified.length, 1);
  assert.equal(d.modified[0]!.name, "Delta");
  rmSync(dir, { recursive: true, force: true });
});
