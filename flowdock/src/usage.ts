/**
 * Usage metering (M3) — counts executions per tenant per calendar month and
 * answers "how much quota is left". Backs the executionsPerMonth limit.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./store.ts";

/** UTC YYYY-MM bucket for a timestamp. */
export function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

type UsageShape = Record<string, Record<string, number>>; // tenantId -> month -> count

export class UsageMeter {
  private data: UsageShape = {};
  constructor(
    private readonly path = join(".flowdock", "usage.json"),
    private readonly clock: () => number = () => Date.now(),
    private readonly persistent = true,
  ) {
    if (persistent && existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, "utf8")) as UsageShape;
      } catch {
        this.data = {};
      }
    }
  }

  private flush() {
    if (this.persistent) atomicWrite(this.path, JSON.stringify(this.data, null, 2));
  }

  /** Record one execution for the tenant in the current month. */
  record(tenantId: string, n = 1): void {
    const month = monthKey(this.clock());
    const byMonth = (this.data[tenantId] ??= {});
    byMonth[month] = (byMonth[month] ?? 0) + n;
    this.flush();
  }

  /** Executions used by a tenant in a month (defaults to current). */
  count(tenantId: string, month: string = monthKey(this.clock())): number {
    return this.data[tenantId]?.[month] ?? 0;
  }
}

/** In-memory meter for tests (no disk). */
export function memoryMeter(clock: () => number = () => Date.now()): UsageMeter {
  return new UsageMeter("", clock, false);
}
