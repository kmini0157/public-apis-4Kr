/**
 * Workspace (M3) — the governed entry point that wraps the durable Engine with
 * plan enforcement: RBAC (who may run), execution quota (how many runs this
 * month), seat/workflow caps, usage metering, and retention pruning.
 *
 * Engine stays single-purpose (durable execution); all billing/permission
 * policy lives here, so the M0 core remains untouched.
 */

import { getPlan, withinLimit, type PlanLimits } from "./plans.ts";
import { can, type Role, type Tenant } from "./tenancy.ts";
import { pruneRuns, type PruneResult } from "./retention.ts";
import { UsageMeter } from "./usage.ts";
import type { Engine, RunInput, RunResult } from "./engine.ts";
import type { Store, RunQueryStore, PrunableStore } from "./store.ts";
import type { Workflow } from "./types.ts";

export class PermissionError extends Error {}
export class QuotaError extends Error {}

export interface Actor {
  email: string;
  role: Role;
}

export interface UsageSummary {
  plan: PlanLimits;
  executionsUsed: number;
  executionsRemaining: number | "unlimited";
  seatsUsed: number;
  retentionDays: number;
}

export class Workspace {
  private readonly clock: () => number;
  constructor(
    private readonly tenant: Tenant,
    private readonly engine: Engine,
    private readonly store: Store & RunQueryStore & PrunableStore,
    private readonly usage: UsageMeter,
    clock: () => number = () => Date.now(),
  ) {
    this.clock = clock;
  }

  private plan(): PlanLimits {
    return getPlan(this.tenant.plan);
  }

  /** Run a workflow under the actor's permissions and the tenant's quota. */
  async run(workflow: Workflow, actor: Actor, opts: RunInput = {}): Promise<RunResult> {
    if (!can(actor.role, "run")) {
      throw new PermissionError(`${actor.role} '${actor.email}' may not run workflows`);
    }
    const plan = this.plan();
    const used = this.usage.count(this.tenant.id);
    if (!withinLimit(used, plan.executionsPerMonth)) {
      throw new QuotaError(
        `Monthly execution quota reached (${used}/${plan.executionsPerMonth} on ${plan.name}). Upgrade to run more.`,
      );
    }
    const result = await this.engine.run(workflow, opts);
    this.usage.record(this.tenant.id);
    return result;
  }

  /** Whether another workflow can be stored under the plan's workflow cap. */
  canAddWorkflow(currentCount: number): boolean {
    return withinLimit(currentCount, this.plan().maxWorkflows);
  }

  /** Apply the plan's retention window, deleting older run history. */
  enforceRetention(): PruneResult {
    return pruneRuns(this.store, this.plan().logRetentionDays, this.clock());
  }

  summary(): UsageSummary {
    const plan = this.plan();
    const used = this.usage.count(this.tenant.id);
    return {
      plan,
      executionsUsed: used,
      executionsRemaining:
        plan.executionsPerMonth === -1 ? "unlimited" : Math.max(0, plan.executionsPerMonth - used),
      seatsUsed: this.tenant.members.length,
      retentionDays: plan.logRetentionDays,
    };
  }
}
