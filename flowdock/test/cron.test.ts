import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCron, cronMatches, nextFire, CronScheduler } from "../src/cron.ts";
import { Engine } from "../src/engine.ts";
import { MemoryStore } from "../src/store.ts";
import { ConnectorRegistry } from "../src/connectors/index.ts";
import type { Workflow } from "../src/types.ts";

test("parseField: ranges, steps and lists", () => {
  assert.deepEqual(parseCron("*/15 * * * *").minute, [0, 15, 30, 45]);
  assert.deepEqual(parseCron("1-5 * * * *").minute, [1, 2, 3, 4, 5]);
  assert.deepEqual(parseCron("1,3,5 * * * *").minute, [1, 3, 5]);
});

test("day-of-week 7 aliases Sunday (0)", () => {
  assert.ok(parseCron("0 0 * * 7").dayOfWeek.includes(0));
});

test("rejects malformed expressions", () => {
  assert.throws(() => parseCron("* * * *"));
  assert.throws(() => parseCron("99 * * * *"));
});

test("nextFire returns the next minute boundary and fires once", () => {
  const now = Date.UTC(2026, 0, 1, 10, 7);
  assert.equal(nextFire("*/15 * * * *", now), Date.UTC(2026, 0, 1, 10, 15));
});

test("Vixie semantics: both day fields restricted => OR", () => {
  const fields = parseCron("0 0 13 * 5"); // 13th OR Friday
  // 2026-02-13 is a Friday -> matches
  assert.ok(cronMatches(fields, Date.UTC(2026, 1, 13, 0, 0)));
  // 2026-03-13 is a Friday (not needed) ; pick a 13th that is not Friday: 2026-01-13 (Tuesday)
  assert.ok(cronMatches(fields, Date.UTC(2026, 0, 13, 0, 0)));
  // a day that is neither the 13th nor Friday
  assert.equal(cronMatches(fields, Date.UTC(2026, 0, 14, 0, 0)), false);
});

test("scheduler fires a matching workflow exactly once per minute", async () => {
  const wf: Workflow = {
    name: "cronwf",
    on: { cron: "7 10 * * *" },
    nodes: [{ id: "n", uses: "echo", with: { x: 1 } }],
  };
  const store = new MemoryStore();
  const engine = new Engine({ registry: new ConnectorRegistry(), store });
  const now = Date.UTC(2026, 0, 1, 10, 7);
  const scheduler = new CronScheduler([wf], engine, () => now);

  const fired1 = scheduler.tick(now);
  const fired2 = scheduler.tick(now); // same minute -> no double fire
  assert.deepEqual(fired1.map((w) => w.name), ["cronwf"]);
  assert.deepEqual(fired2, []);

  // let the async run complete and verify it actually executed
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.getRunsForWorkflow("cronwf").length, 1);
});
