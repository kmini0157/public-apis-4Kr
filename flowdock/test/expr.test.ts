import { test } from "node:test";
import assert from "node:assert/strict";
import { evalExpr, interpolate, resolve, referencedNodes } from "../src/expr.ts";

const scope = {
  trigger: { body: { voice: null, name: "Kim" } },
  nodes: { fetch: { output: { text: "hello", items: [{ id: 1 }, { id: 2 }] } } },
  secrets: { MY_EMAIL: "a@b.com" },
};

test("path lookup", () => {
  assert.equal(evalExpr("nodes.fetch.output.text", scope), "hello");
  assert.equal(evalExpr("secrets.MY_EMAIL", scope), "a@b.com");
});

test("array indexing", () => {
  assert.equal(evalExpr("nodes.fetch.output.items[1].id", scope), 2);
});

test("nullish coalescing picks first non-null", () => {
  assert.equal(evalExpr("trigger.body.voice ?? 'ko-KR'", scope), "ko-KR");
  assert.equal(evalExpr("trigger.body.name ?? 'anon'", scope), "Kim");
  assert.equal(evalExpr("nodes.missing.output ?? 'fallback'", scope), "fallback");
});

test("literals", () => {
  assert.equal(evalExpr("'literal'", scope), "literal");
  assert.equal(evalExpr("42", scope), 42);
  assert.equal(evalExpr("true", scope), true);
  assert.equal(evalExpr("null", scope), null);
});

test("interpolate returns typed value for sole expression", () => {
  const v = interpolate("{{ nodes.fetch.output.items }}", scope);
  assert.deepEqual(v, [{ id: 1 }, { id: 2 }]);
});

test("interpolate splices into surrounding text", () => {
  assert.equal(interpolate("say: {{ nodes.fetch.output.text }}!", scope), "say: hello!");
});

test("resolve walks nested structures", () => {
  const out = resolve(
    { to: "{{ secrets.MY_EMAIL }}", meta: { n: "{{ nodes.fetch.output.text }}" }, lit: 5 },
    scope,
  );
  assert.deepEqual(out, { to: "a@b.com", meta: { n: "hello" }, lit: 5 });
});

test("referencedNodes finds DAG edges", () => {
  const refs = referencedNodes({
    a: "{{ nodes.fetch.output.text }}",
    b: ["{{ nodes.other.output }}", "plain"],
  });
  assert.deepEqual([...refs].sort(), ["fetch", "other"]);
});

test("rejects unbalanced quotes and stray tokens", () => {
  assert.throws(() => evalExpr("'unterminated", scope));
  assert.throws(() => evalExpr("nodes.fetch extra", scope));
});

test("no code execution — function calls are not parsed", () => {
  // Parens are not part of the grammar, so this cannot invoke anything.
  assert.throws(() => evalExpr("constructor('return 1')()", scope));
});
