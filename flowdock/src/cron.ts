/**
 * 5-field cron parser + in-process scheduler (M1 triggers).
 *
 * Supports `*`, lists (`1,2`), ranges (`1-5`), and steps (`*​/15`, `0-30/10`).
 * Day-of-week 7 aliases 0 (Sunday). Vixie semantics: when BOTH day-of-month and
 * day-of-week are restricted, a match on EITHER fires. The scheduler uses an
 * injectable clock and tracks lastFire per workflow to avoid double-firing; it
 * does NOT backfill missed fires after a restart.
 */

import type { Engine } from "./engine.ts";
import type { Workflow } from "./types.ts";

export interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
  /** Whether each day field was explicitly restricted (for Vixie OR logic). */
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step in '${part}'`);
    let lo = min;
    let hi = max;
    if (rangePart !== "*" && rangePart !== "") {
      const range = rangePart!.split("-");
      lo = Number(range[0]);
      hi = range.length > 1 ? Number(range[1]) : lo;
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`Invalid range '${rangePart}'`);
      if (lo < min || hi > max || lo > hi) throw new Error(`Range '${rangePart}' out of bounds ${min}-${max}`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (values.size === 0) throw new Error(`Empty cron field '${field}'`);
  return [...values].sort((a, b) => a - b);
}

export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron must have 5 fields (got ${parts.length}): '${expression}'`);
  }
  const [min, hr, dom, mon, dow] = parts as [string, string, string, string, string];
  const dowValues = parseField(dow, 0, 7).map((v) => (v === 7 ? 0 : v));
  return {
    minute: parseField(min, 0, 59),
    hour: parseField(hr, 0, 23),
    dayOfMonth: parseField(dom, 1, 31),
    month: parseField(mon, 1, 12),
    dayOfWeek: [...new Set(dowValues)].sort((a, b) => a - b),
    domRestricted: dom !== "*",
    dowRestricted: dow !== "*",
  };
}

/** Does the given UTC timestamp match the cron expression (to the minute)? */
export function cronMatches(fields: CronFields, ts: number): boolean {
  const d = new Date(ts);
  const minuteOk = fields.minute.includes(d.getUTCMinutes());
  const hourOk = fields.hour.includes(d.getUTCHours());
  const monthOk = fields.month.includes(d.getUTCMonth() + 1);
  if (!minuteOk || !hourOk || !monthOk) return false;
  const domMatch = fields.dayOfMonth.includes(d.getUTCDate());
  const dowMatch = fields.dayOfWeek.includes(d.getUTCDay());
  // Vixie: both restricted -> OR; otherwise the restricted one (or AND of *).
  if (fields.domRestricted && fields.dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/** Next firing time strictly after `now` (scans minute-by-minute, bounded). */
export function nextFire(expression: string, now: number): number | null {
  const fields = parseCron(expression);
  const MINUTE = 60_000;
  let t = Math.floor(now / MINUTE) * MINUTE + MINUTE; // start at next minute boundary
  const limit = now + 366 * 24 * 60 * MINUTE; // search up to ~1 year
  for (; t <= limit; t += MINUTE) {
    if (cronMatches(fields, t)) return t;
  }
  return null;
}

interface Scheduled {
  workflow: Workflow;
  expression: string;
  fields: CronFields;
  lastFire: number;
}

export class CronScheduler {
  private jobs: Scheduled[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly clock: () => number;

  constructor(
    workflows: Workflow[],
    private readonly engine: Engine,
    clock: () => number = () => Date.now(),
    private readonly onError: (wf: string, err: Error) => void = () => {},
  ) {
    this.clock = clock;
    for (const wf of workflows) {
      if (wf.on?.cron) {
        this.jobs.push({
          workflow: wf,
          expression: wf.on.cron,
          fields: parseCron(wf.on.cron),
          lastFire: 0,
        });
      }
    }
  }

  /** Evaluate all jobs against `now`; fire those whose minute matches once. */
  tick(now: number = this.clock()): Workflow[] {
    const minuteBucket = Math.floor(now / 60_000);
    const fired: Workflow[] = [];
    for (const job of this.jobs) {
      if (job.lastFire === minuteBucket) continue; // already fired this minute
      if (cronMatches(job.fields, now)) {
        job.lastFire = minuteBucket;
        fired.push(job.workflow);
        void this.engine
          .run(job.workflow, { trigger: { cron: job.expression, firedAt: now } })
          .catch((err) => this.onError(job.workflow.name, err as Error));
      }
    }
    return fired;
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  jobCount(): number {
    return this.jobs.length;
  }
}
