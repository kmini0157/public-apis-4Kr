import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRegistry, normalizeYaml, sha256Hex } from "../src/registry.ts";

let clock = 1000;
const tick = () => (clock += 1000);

test("commit appends a version and updates the head", () => {
  const reg = new MemoryRegistry(tick);
  const yaml = "name: A\nnodes:\n  - id: n\n    uses: echo\n";
  const v1 = reg.commit("A", normalizeYaml(yaml));
  assert.ok(v1);
  assert.equal(reg.getWorkflow("A")!.latestVersion, v1!.version);
  assert.equal(reg.getWorkflowVersions("A").length, 1);
});

test("commit is content-addressed — identical content is a no-op", () => {
  const reg = new MemoryRegistry(tick);
  const yaml = "name: B\nnodes:\n  - id: n\n    uses: echo\n";
  reg.commit("B", normalizeYaml(yaml));
  const again = reg.commit("B", normalizeYaml(yaml));
  assert.equal(again, undefined);
  assert.equal(reg.getWorkflowVersions("B").length, 1);
});

test("changed content creates a new version; getLatest returns it", () => {
  const reg = new MemoryRegistry(tick);
  reg.commit("C", normalizeYaml("name: C\nnodes:\n  - id: a\n    uses: echo\n"));
  const v2 = reg.commit("C", normalizeYaml("name: C\nnodes:\n  - id: b\n    uses: echo\n"));
  assert.equal(reg.getWorkflowVersions("C").length, 2);
  assert.equal(reg.getLatestVersion("C")!.version, v2!.version);
});

test("normalizeYaml is stable regardless of key order / comments", () => {
  const a = normalizeYaml("# comment\nnodes:\n  - uses: echo\n    id: n\nname: X\n");
  const b = normalizeYaml("name: X\nnodes:\n  - id: n\n    uses: echo\n");
  assert.equal(sha256Hex(a), sha256Hex(b));
});
