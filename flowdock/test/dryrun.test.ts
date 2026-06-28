import { test } from "node:test";
import assert from "node:assert/strict";
import { runDryRun } from "../src/dryrun.ts";
import { ConnectorRegistry } from "../src/connectors/index.ts";
import type { Connector } from "../src/types.ts";

const withOutputs: Connector = {
  id: "x.out",
  title: "x",
  outputs: { type: "object", properties: { text: { type: "string" } } },
  async execute() {
    throw new Error("execute must NOT be called in dry-run");
  },
};

function registry() {
  return new ConnectorRegistry([withOutputs]);
}

test("dry-run never calls execute and synthesizes outputs from schema", () => {
  const res = runDryRun(
    { name: "d", nodes: [{ id: "a", uses: "x.out" }] },
    registry(),
  );
  assert.equal(res.status, "succeeded");
  assert.equal(res.steps[0]!.source, "schema");
  assert.deepEqual(res.outputs.a, { text: "<string>" });
});

test("dry-run uses node.mock when provided and wires it downstream", () => {
  const res = runDryRun(
    {
      name: "d",
      nodes: [
        { id: "a", uses: "x.out", mock: { text: "hello" } },
        { id: "b", uses: "x.out", with: { echo: "{{ nodes.a.output.text }}" } },
      ],
    },
    registry(),
  );
  assert.equal(res.steps[0]!.source, "mock");
  assert.deepEqual(res.outputs.a, { text: "hello" });
  assert.equal(res.status, "succeeded");
});

test("dry-run fails fast on an unknown connector", () => {
  const res = runDryRun({ name: "d", nodes: [{ id: "a", uses: "ghost" }] }, registry());
  assert.equal(res.status, "failed");
  assert.match(res.steps[0]!.error!, /Unknown connector/);
});

test("dry-run surfaces input-schema violations without network", () => {
  const strict: Connector = {
    id: "y.in",
    title: "y",
    inputs: { type: "object", required: ["url"], properties: { url: { type: "string" } } },
    async execute() {
      return null;
    },
  };
  const res = runDryRun(
    { name: "d", nodes: [{ id: "a", uses: "y.in", with: {} }] },
    new ConnectorRegistry([strict]),
  );
  assert.equal(res.status, "failed");
  assert.match(res.steps[0]!.error!, /missing required property 'url'/);
});
