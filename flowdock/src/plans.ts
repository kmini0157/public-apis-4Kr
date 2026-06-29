/**
 * Subscription plans (M3) — where the moat turns into revenue.
 *
 * The conversion lever is `logRetentionDays`: a developer who already depends on
 * FlowDock's execution history for debugging hits the Free 7-day wall and
 * upgrades. Quotas (executions, workflows, seats, concurrency) gate the rest.
 */

export type PlanId = "free" | "pro" | "team";

/** Sentinel for "no limit" in numeric quota fields. */
export const UNLIMITED = -1;

export interface PlanLimits {
  id: PlanId;
  name: string;
  /** Max stored workflows (-1 = unlimited). */
  maxWorkflows: number;
  /** Execution quota per calendar month (-1 = unlimited). */
  executionsPerMonth: number;
  /** Run/step history retention — the paywall. */
  logRetentionDays: number;
  /** Team seats. */
  maxSeats: number;
  /** Concurrent in-flight executions. */
  maxConcurrency: number;
  /** Indicative monthly price (USD). */
  priceUsd: number;
}

export const PLANS: Record<PlanId, PlanLimits> = {
  free: {
    id: "free",
    name: "Free",
    maxWorkflows: 3,
    executionsPerMonth: 100,
    logRetentionDays: 7,
    maxSeats: 1,
    maxConcurrency: 2,
    priceUsd: 0,
  },
  pro: {
    id: "pro",
    name: "Pro",
    maxWorkflows: UNLIMITED,
    executionsPerMonth: 10_000,
    logRetentionDays: 30,
    maxSeats: 1,
    maxConcurrency: 8,
    priceUsd: 19,
  },
  team: {
    id: "team",
    name: "Team",
    maxWorkflows: UNLIMITED,
    executionsPerMonth: 100_000,
    logRetentionDays: 90,
    maxSeats: 10,
    maxConcurrency: 20,
    priceUsd: 99,
  },
};

export function getPlan(id: PlanId): PlanLimits {
  const plan = PLANS[id];
  if (!plan) throw new Error(`Unknown plan '${id}'. Valid: ${Object.keys(PLANS).join(", ")}`);
  return plan;
}

export function isPlanId(v: string): v is PlanId {
  return v === "free" || v === "pro" || v === "team";
}

/** Whether a quota value permits `current` (UNLIMITED always allows). */
export function withinLimit(current: number, limit: number): boolean {
  return limit === UNLIMITED || current < limit;
}
