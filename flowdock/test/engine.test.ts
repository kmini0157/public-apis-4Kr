import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, topoSort } from "../src/engine.ts";
import { MemoryStore } from "../src/store.ts";
import { ConnectorRegistry } from "../src/connectors/index.ts";
import type { Connector, NodeSpec } from "../src/types.ts";

function recorder(order: string[]): Connector[] {
  const mk = (id: string): Connector => ({
    id,
    title: id,
    async execute(input) {
      order.push(id);
      return { value: id, input };
    },
  });
  return [mk("a"), mk("b"), mk("c")];
}

test("topoSort respects inferred + explicit dependencies", () => {
  const nodes: NodeSpec[] = [
    { id: "c", uses: "c", with: { x: "{{ nodes.b.output.value }}" } },
    { id: "b", uses: "b", with: { x: "{{ nodes.a.output.value }}" } },
    { id: "a", uses: "a" },
  ];
  assert.deepEqual(topoSort(nodes).map((n) => n.id), ["a", "b", "c"]);
});

test("topoSort detects cycles and dangling refs", () => {
  assert.throws(() =>
    topoSort([
      { id: "a", uses: "a", with: { x: "{{ nodes.b.output }}" } },
      { id: "b", uses: "b", with: { x: "{{ nodes.a.output }}" } },
    ]),
  );
  assert.throws(() => topoSort([{ id: "a", uses: "a", with: { x: "{{ nodes.ghost.output }}" } }]));
});

test("engine executes in dependency order and wires outputs", async () => {
  const order: string[] = [];
  const engine = new Engine({
    registry: new ConnectorRegistry(recorder(order)),
    store: new MemoryStore(),
  });
  const result = await engine.run({
    name: "wire",
    nodes: [
      { id: "c", uses: "c", with: { from: "{{ nodes.b.output.value }}" } },
      { id: "b", uses: "b", with: { from: "{{ nodes.a.output.value }}" } },
      { id: "a", uses: "a" },
    ],
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(order, ["a", "b", "c"]);
  // c received b's output via expression
  assert.deepEqual((result.outputs.c as any).input, { from: "b" });
});

test("retries with backoff then succeeds", async () => {
  let attempts = 0;
  const flaky: Connector = {
    id: "flaky",
    title: "flaky",
    async execute() {
      attempts++;
      if (attempts < 3) throw new Error("transient");
      return { ok: true };
    },
  };
  const engine = new Engine({
    registry: new ConnectorRegistry([flaky]),
    store: new MemoryStore(),
  });
  const result = await engine.run({
    name: "retry",
    nodes: [{ id: "n", uses: "flaky", retry: { max: 2, backoffMs: 1 } }],
  });
  assert.equal(result.status, "succeeded");
  assert.equal(attempts, 3);
  assert.equal(result.steps[0]!.attempts, 3);
});

test("failure stops the run; resume skips checkpointed nodes", async () => {
  const store = new MemoryStore();
  let aCalls = 0;
  let bShouldFail = true;
  const connectors: Connector[] = [
    {
      id: "a",
      title: "a",
      async execute() {
        aCalls++;
        return { value: "A" };
      },
    },
    {
      id: "b",
      title: "b",
      async execute() {
        if (bShouldFail) throw new Error("boom");
        return { value: "B" };
      },
    },
  ];
  const wf = {
    name: "resume",
    nodes: [
      { id: "a", uses: "a" },
      { id: "b", uses: "b", needs: ["a"], retry: { max: 0, backoffMs: 1 } },
    ],
  };

  const engine = new Engine({ registry: new ConnectorRegistry(connectors), store });
  const first = await engine.run(wf);
  assert.equal(first.status, "failed");
  assert.equal(aCalls, 1);

  // Fix the downstream failure and resume the SAME run.
  bShouldFail = false;
  const second = await engine.run(wf, { runId: first.runId });
  assert.equal(second.status, "succeeded");
  assert.equal(aCalls, 1, "node 'a' must not re-execute on resume (checkpoint)");
  assert.equal((second.outputs.b as any).value, "B");
});

test("a falsy `if` skips the node and cascades to its dependents", async () => {
  const order: string[] = [];
  const engine = new Engine({
    registry: new ConnectorRegistry(recorder(order)),
    store: new MemoryStore(),
  });
  const result = await engine.run({
    name: "cond",
    nodes: [
      { id: "a", uses: "a" },
      { id: "b", uses: "b", if: "false", with: { from: "{{ nodes.a.output.value }}" } },
      { id: "c", uses: "c", with: { from: "{{ nodes.b.output.value }}" } }, // depends on b
    ],
  });
  assert.equal(result.status, "succeeded"); // skips are not failures
  assert.deepEqual(order, ["a"]); // b and c never executed
  const byId = Object.fromEntries(result.steps.map((s) => [s.nodeId, s.status]));
  assert.equal(byId.a, "succeeded");
  assert.equal(byId.b, "skipped");
  assert.equal(byId.c, "skipped"); // cascade
});

test("a truthy `if` (from upstream output) runs the node", async () => {
  const order: string[] = [];
  const reg = new ConnectorRegistry([
    { id: "flag", title: "flag", async execute() { return { go: true }; } },
    { id: "work", title: "work", async execute() { order.push("work"); return { done: true }; } },
  ]);
  const engine = new Engine({ registry: reg, store: new MemoryStore() });
  const result = await engine.run({
    name: "cond2",
    nodes: [
      { id: "flag", uses: "flag" },
      { id: "work", uses: "work", if: "{{ nodes.flag.output.go }}" },
    ],
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(order, ["work"]);
  assert.equal((result.outputs.work as { done: boolean }).done, true);
});

test("trigger payload is available to nodes", async () => {
  const seen: unknown[] = [];
  const cap: Connector = {
    id: "cap",
    title: "cap",
    async execute(input) {
      seen.push(input);
      return input;
    },
  };
  const engine = new Engine({ registry: new ConnectorRegistry([cap]), store: new MemoryStore() });
  await engine.run(
    { name: "trig", nodes: [{ id: "n", uses: "cap", with: { who: "{{ trigger.body.name }}" } }] },
    { trigger: { body: { name: "Ada" } } },
  );
  assert.deepEqual(seen[0], { who: "Ada" });
});
