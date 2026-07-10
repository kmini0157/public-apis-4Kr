import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestContext } from "../src/sdk.ts";
import {
  ttsSpeak,
  slackWebhook,
  discordWebhook,
  embed,
  vectorUpsert,
  vectorQuery,
  qdrantPointId,
} from "../src/connectors/index.ts";
import type { Json } from "../src/types.ts";

/** Capture the last fetch call so we can assert URL/method/body. */
function captureFetch(response: Json, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, ctx: makeTestContext({ fetch: fetchImpl }) };
}

test("tts.speak builds a keyless audio URL with text + voice (no network)", async () => {
  const ctx = makeTestContext(); // fetch disabled — must not be called
  const out = (await ttsSpeak.execute({ text: "안녕", voice: "Brian" }, ctx)) as { audio_url: string };
  assert.match(out.audio_url, /streamelements\.com/);
  assert.match(out.audio_url, /voice=Brian/);
  assert.match(out.audio_url, /text=/);
});

test("slack.webhook posts text to the URL; missing URL throws", async () => {
  const { calls, ctx } = captureFetch({ ok: true });
  const out = (await slackWebhook.execute({ text: "hi", webhook_url: "https://hooks.slack.com/x" }, ctx)) as { ok: boolean };
  assert.equal(out.ok, true);
  assert.equal(calls[0]!.url, "https://hooks.slack.com/x");
  assert.equal(JSON.parse(calls[0]!.init!.body as string).text, "hi");
  await assert.rejects(() => slackWebhook.execute({ text: "hi" }, makeTestContext()), /webhook_url/);
});

test("discord.webhook posts content", async () => {
  const { calls, ctx } = captureFetch({});
  await discordWebhook.execute({ content: "yo", webhook_url: "https://discord.com/api/webhooks/x" }, ctx);
  assert.equal(JSON.parse(calls[0]!.init!.body as string).content, "yo");
});

test("embed returns the vector and its dimensions", async () => {
  const { calls, ctx } = captureFetch({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
  const out = (await embed.execute({ text: "hello" }, ctx)) as { vector: number[]; dimensions: number };
  assert.deepEqual(out.vector, [0.1, 0.2, 0.3]);
  assert.equal(out.dimensions, 3);
  assert.match(calls[0]!.url, /\/embeddings$/);
});

test("vector.upsert PUTs a point to the collection", async () => {
  const { calls, ctx } = captureFetch({ status: "acknowledged" });
  const out = (await vectorUpsert.execute(
    { collection: "mem", id: 1, vector: [1, 2, 3], payload: { src: "x" } },
    ctx,
  )) as { status: string };
  assert.equal(out.status, "acknowledged");
  assert.equal(calls[0]!.init!.method, "PUT");
  assert.match(calls[0]!.url, /\/collections\/mem\/points$/);
  const body = JSON.parse(calls[0]!.init!.body as string);
  assert.deepEqual(body.points[0].vector, [1, 2, 3]);
  assert.deepEqual(body.points[0].payload, { src: "x" });
});

test("vector.query searches and returns matches", async () => {
  const { calls, ctx } = captureFetch({ result: [{ id: 1, score: 0.9 }] });
  const out = (await vectorQuery.execute({ collection: "mem", vector: [1, 2, 3], limit: 3 }, ctx)) as {
    matches: Json[];
  };
  assert.equal(out.matches.length, 1);
  assert.match(calls[0]!.url, /\/points\/search$/);
  assert.equal(JSON.parse(calls[0]!.init!.body as string).limit, 3);
});

test("qdrantPointId: numbers/UUIDs pass through; strings map to stable UUIDs", () => {
  assert.equal(qdrantPointId(42), 42);
  assert.equal(qdrantPointId("123"), 123);
  const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  assert.equal(qdrantPointId(uuid), uuid);
  const a = qdrantPointId("https://example.com/post");
  const b = qdrantPointId("https://example.com/post");
  assert.equal(a, b); // deterministic => upsert dedup preserved
  assert.match(String(a), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(qdrantPointId("other-key"), a);
});

test("vector.upsert coerces a URL id to a UUID and keeps the natural key in payload", async () => {
  const { calls, ctx } = captureFetch({ status: "acknowledged" });
  await vectorUpsert.execute(
    { collection: "mem", id: "https://example.com/x", vector: [1], payload: { url: "https://example.com/x" } },
    ctx,
  );
  const point = JSON.parse(calls[0]!.init!.body as string).points[0];
  assert.match(point.id, /^[0-9a-f-]{36}$/); // valid Qdrant UUID id
  assert.equal(point.payload._source_id, "https://example.com/x");
  assert.equal(point.payload.url, "https://example.com/x");
});

test("vector connectors surface a non-OK response as an error", async () => {
  const { ctx } = captureFetch({ error: "boom" }, 500);
  await assert.rejects(() => vectorQuery.execute({ collection: "m", vector: [1] }, ctx), /vector\.query 500/);
});
