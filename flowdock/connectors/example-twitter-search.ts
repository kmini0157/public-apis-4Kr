import { defineConnector } from "../src/sdk.ts";

/**
 * Example COMMUNITY connector, loaded dynamically from the project connectors/
 * dir. It demonstrates the SDK surface; the endpoint is illustrative.
 */
export default defineConnector({
  id: "twitter.search",
  title: "Twitter Search (community example)",
  manifest: { version: "0.1.0", author: "flowdock-examples", keywords: ["social", "search"] },
  rateLimit: { requests: 5, intervalMs: 1000 },
  inputs: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      limit: { type: "integer" },
    },
  },
  outputs: {
    type: "object",
    properties: { tweets: { type: "array" } },
  },
  async execute(input, ctx) {
    const { query, limit } = input as { query: string; limit?: number };
    ctx.log(`searching tweets: ${query}`);
    const res = await ctx.fetch(
      `https://api.example-twitter.test/search?q=${encodeURIComponent(query)}&limit=${limit ?? 10}`,
    );
    if (!res.ok) throw new Error(`twitter.search ${res.status}`);
    const data = (await res.json()) as { tweets?: unknown[] };
    return { tweets: data.tweets ?? [] };
  },
});
