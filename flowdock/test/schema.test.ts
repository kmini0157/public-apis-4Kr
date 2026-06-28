import { test } from "node:test";
import assert from "node:assert/strict";
import { validateInput } from "../src/schema.ts";

test("undefined schema always passes", () => {
  assert.deepEqual(validateInput({ anything: true }, undefined), { valid: true });
});

test("type checking", () => {
  assert.equal(validateInput("x", { type: "string" }).valid, true);
  assert.equal(validateInput(5, { type: "string" }).valid, false);
  assert.equal(validateInput(5, { type: "integer" }).valid, true);
  assert.equal(validateInput(5.5, { type: "integer" }).valid, false);
});

test("required + nested properties", () => {
  const schema = {
    type: "object",
    required: ["url"],
    properties: { url: { type: "string" }, n: { type: "number" } },
  };
  assert.equal(validateInput({ url: "x", n: 1 }, schema).valid, true);
  const bad = validateInput({ n: "no" }, schema);
  assert.equal(bad.valid, false);
  assert.ok(bad.errors!.some((e) => e.includes("missing required property 'url'")));
  assert.ok(bad.errors!.some((e) => e.includes("n: expected number")));
});

test("enum + pattern", () => {
  assert.equal(validateInput("ko", { enum: ["ko", "en"] }).valid, true);
  assert.equal(validateInput("fr", { enum: ["ko", "en"] }).valid, false);
  assert.equal(validateInput("a1", { type: "string", pattern: "^[a-z][0-9]$" }).valid, true);
  assert.equal(validateInput("11", { type: "string", pattern: "^[a-z][0-9]$" }).valid, false);
});

test("array items", () => {
  const schema = { type: "array", items: { type: "number" } };
  assert.equal(validateInput([1, 2, 3], schema).valid, true);
  assert.equal(validateInput([1, "two"], schema).valid, false);
});
