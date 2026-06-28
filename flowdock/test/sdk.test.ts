import { test } from "node:test";
import assert from "node:assert/strict";
import { defineConnector, makeTestContext } from "../src/sdk.ts";

const conn = defineConnector({
  id: "demo.search",
  inputs: { type: "object", required: ["q"], properties: { q: { type: "string" } } },
  outputs: { type: "object", properties: { hit: { type: "string" } } },
  async execute(input, ctx) {
    const { q } = input as { q: string };
    const res = await ctx.fetch(`https://x/${q}`);
    return { hit: await res.text() };
  },
});

test("defineConnector attaches a manifest and defaults the title", () => {
  assert.equal(conn.title, "demo.search");
  assert.equal(conn.manifest!.version, "0.0.0");
});

test("defineConnector rejects a non-namespaced id", () => {
  assert.throws(() => defineConnector({ id: "nope", async execute() { return null; } }));
});

test("manifest cannot override the connector's canonical id/title", () => {
  const c = defineConnector({
    id: "real.id",
    title: "Real Title",
    manifest: { id: "evil.spoof", title: "Spoofed", version: "9.9.9", author: "x" } as never,
    async execute() {
      return null;
    },
  });
  assert.equal(c.id, "real.id");
  assert.equal(c.manifest!.id, "real.id");
  assert.equal(c.manifest!.title, "Real Title");
  assert.equal(c.manifest!.author, "x"); // benign passthrough fields preserved
});

test("input validation runs before execute", async () => {
  const ctx = makeTestContext({ fetch: async () => new Response("x") });
  await assert.rejects(() => conn.execute({} as never, ctx), /Invalid input for demo.search/);
});

test("makeTestContext fetch is disabled by default (offline guarantee)", async () => {
  const ctx = makeTestContext();
  await assert.rejects(() => ctx.fetch("https://x"), /network disabled/);
});

test("connector runs with a stubbed fetch", async () => {
  const ctx = makeTestContext({ fetch: async () => new Response("found", { status: 200 }) });
  const out = await conn.execute({ q: "hi" }, ctx);
  assert.equal((out as { hit: string }).hit, "found");
});
