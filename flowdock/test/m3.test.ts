import { test } from "node:test";
import assert from "node:assert/strict";
import { getPlan, withinLimit, isPlanId, UNLIMITED } from "../src/plans.ts";
import { can, TenantStore, SeatLimitError, type Tenant } from "../src/tenancy.ts";
import { UsageMeter, memoryMeter, monthKey } from "../src/usage.ts";
import { pruneRuns } from "../src/retention.ts";
import { Workspace, PermissionError, QuotaError } from "../src/workspace.ts";
import { Engine } from "../src/engine.ts";
import { MemoryStore } from "../src/store.ts";
import { ConnectorRegistry } from "../src/connectors/index.ts";
import type { RunRecord, StepRecord, Workflow } from "../src/types.ts";

// --- plans -------------------------------------------------------------------

test("plans: free is tighter than team; withinLimit honors UNLIMITED", () => {
  assert.ok(getPlan("free").logRetentionDays < getPlan("team").logRetentionDays);
  assert.equal(withinLimit(2, getPlan("free").maxWorkflows), true); // 2 < 3
  assert.equal(withinLimit(3, getPlan("free").maxWorkflows), false); // at cap
  assert.equal(withinLimit(1e9, UNLIMITED), true);
  assert.equal(isPlanId("pro"), true);
  assert.equal(isPlanId("enterprise"), false);
});

// --- RBAC --------------------------------------------------------------------

test("rbac: role/action matrix", () => {
  assert.equal(can("viewer", "run"), false);
  assert.equal(can("viewer", "view"), true);
  assert.equal(can("member", "run"), true);
  assert.equal(can("member", "push"), false);
  assert.equal(can("admin", "manage_members"), true);
  assert.equal(can("admin", "manage_billing"), false);
  assert.equal(can("owner", "manage_billing"), true);
});

// --- seats -------------------------------------------------------------------

test("tenancy: seat cap enforced on the free plan", () => {
  const store = new TenantStore("", { id: "t", name: "t", plan: "free", members: [{ email: "o", role: "owner" }] });
  // free = 1 seat, already has the owner
  assert.throws(() => store.addMember("a@x", "member"), SeatLimitError);
  store.setPlan("team"); // 10 seats
  assert.equal(store.addMember("a@x", "member").email, "a@x");
});

test("tenancy: cannot remove the last owner", () => {
  const store = new TenantStore("", { id: "t", name: "t", plan: "team", members: [{ email: "o", role: "owner" }] });
  assert.throws(() => store.removeMember("o"), /last owner/);
});

// --- usage metering ----------------------------------------------------------

test("usage: per-tenant monthly counting rolls over by month", () => {
  let now = Date.UTC(2026, 0, 15);
  const meter = memoryMeter(() => now);
  meter.record("t");
  meter.record("t");
  assert.equal(meter.count("t"), 2);
  now = Date.UTC(2026, 1, 1); // next month
  assert.equal(meter.count("t"), 0);
  meter.record("t");
  assert.equal(meter.count("t"), 1);
  assert.equal(meter.count("t", monthKey(Date.UTC(2026, 0, 15))), 2); // last month preserved
});

// --- retention pruning -------------------------------------------------------

function seedRun(store: MemoryStore, id: string, finishedAt: number) {
  const run: RunRecord = { id, workflowName: "w", status: "succeeded", startedAt: finishedAt - 10, finishedAt };
  store.saveRun(run);
  const step: StepRecord = { runId: id, nodeId: "n", status: "succeeded", attempts: 1, latencyMs: 5 };
  store.saveStep(step);
}

test("retention: prunes runs older than the window and their steps", () => {
  const store = new MemoryStore();
  const now = Date.UTC(2026, 5, 30);
  const DAY = 86_400_000;
  seedRun(store, "old", now - 10 * DAY);
  seedRun(store, "fresh", now - 2 * DAY);
  const r = pruneRuns(store, 7, now); // free = 7 days
  assert.deepEqual(r.deleted, ["old"]);
  assert.equal(r.kept, 1);
  assert.equal(store.getRun("old"), undefined);
  assert.equal(store.getSteps("old").length, 0);
  assert.ok(store.getRun("fresh"));
});

test("retention: UNLIMITED keeps everything", () => {
  const store = new MemoryStore();
  seedRun(store, "ancient", 0);
  const r = pruneRuns(store, UNLIMITED, Date.UTC(2026, 0, 1));
  assert.deepEqual(r.deleted, []);
  assert.equal(r.kept, 1);
});

// --- workspace orchestration -------------------------------------------------

const WF: Workflow = { name: "w", nodes: [{ id: "n", uses: "echo", with: { x: 1 } }] };

function workspace(plan: Tenant["plan"], clock = () => Date.UTC(2026, 0, 1)) {
  const tenant: Tenant = { id: "t", name: "t", plan, members: [{ email: "o", role: "owner" }] };
  const store = new MemoryStore();
  const engine = new Engine({ registry: new ConnectorRegistry(), store });
  const meter = memoryMeter(clock);
  return { ws: new Workspace(tenant, engine, store, meter, clock), meter, store };
}

test("workspace: viewer is denied, member may run, usage is metered", async () => {
  const { ws, meter } = workspace("team");
  await assert.rejects(() => ws.run(WF, { email: "v", role: "viewer" }), PermissionError);
  const res = await ws.run(WF, { email: "m", role: "member" });
  assert.equal(res.status, "succeeded");
  assert.equal(meter.count("t"), 1);
});

test("workspace: execution quota blocks once the monthly cap is hit", async () => {
  // free = 100/mo; pre-fill the meter to the cap
  const { ws, meter } = workspace("free");
  meter.record("t", 100);
  await assert.rejects(() => ws.run(WF, { email: "o", role: "owner" }), QuotaError);
});

test("workspace: canAddWorkflow respects the plan cap; summary reports remaining", async () => {
  const { ws } = workspace("free");
  assert.equal(ws.canAddWorkflow(2), true); // 2 < 3
  assert.equal(ws.canAddWorkflow(3), false);
  const before = ws.summary();
  assert.equal(before.executionsRemaining, 100);
  await ws.run(WF, { email: "o", role: "owner" });
  assert.equal(ws.summary().executionsRemaining, 99);
});
