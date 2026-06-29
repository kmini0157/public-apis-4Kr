/**
 * Tenancy + RBAC (M3).
 *
 * A tenant has a plan and a set of members with roles. Permissions are a fixed
 * matrix — viewers can read, members can run, admins manage secrets/members,
 * owners can do anything including billing. Seat additions are gated by the
 * tenant's plan. Dev tier persists to .flowdock/tenant.json.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./store.ts";
import { getPlan, withinLimit, type PlanId } from "./plans.ts";

export type Role = "owner" | "admin" | "member" | "viewer";

export type Action =
  | "view"
  | "run"
  | "push"
  | "pull"
  | "manage_secrets"
  | "manage_members"
  | "manage_billing";

const ROLE_ACTIONS: Record<Role, Set<Action>> = {
  viewer: new Set(["view"]),
  member: new Set(["view", "run", "pull"]),
  admin: new Set(["view", "run", "push", "pull", "manage_secrets", "manage_members"]),
  owner: new Set(["view", "run", "push", "pull", "manage_secrets", "manage_members", "manage_billing"]),
};

export function can(role: Role, action: Action): boolean {
  return ROLE_ACTIONS[role]?.has(action) ?? false;
}

export interface Member {
  email: string;
  role: Role;
}

export interface Tenant {
  id: string;
  name: string;
  plan: PlanId;
  members: Member[];
}

export class SeatLimitError extends Error {}

/** Persisted tenant config; bootstraps a single-owner Free tenant on first use. */
export class TenantStore {
  private tenant: Tenant;
  constructor(
    private readonly path = join(".flowdock", "tenant.json"),
    defaults: Partial<Tenant> = {},
  ) {
    if (existsSync(path)) {
      this.tenant = JSON.parse(readFileSync(path, "utf8")) as Tenant;
    } else {
      this.tenant = {
        id: defaults.id ?? "local",
        name: defaults.name ?? "local",
        plan: defaults.plan ?? "free",
        members: defaults.members ?? [{ email: "owner@local", role: "owner" }],
      };
    }
  }

  get(): Tenant {
    return this.tenant;
  }

  private flush() {
    if (!this.path) return; // empty path => in-memory (tests)
    atomicWrite(this.path, JSON.stringify(this.tenant, null, 2));
  }

  setPlan(plan: PlanId): void {
    getPlan(plan); // validate
    this.tenant.plan = plan;
    this.flush();
  }

  /** Add a member, enforcing the plan's seat cap. */
  addMember(email: string, role: Role): Member {
    if (this.tenant.members.some((m) => m.email === email)) {
      throw new Error(`Member '${email}' already exists`);
    }
    const seats = getPlan(this.tenant.plan).maxSeats;
    if (!withinLimit(this.tenant.members.length, seats)) {
      throw new SeatLimitError(`Plan '${this.tenant.plan}' allows ${seats} seat(s); upgrade to add more`);
    }
    const member: Member = { email, role };
    this.tenant.members.push(member);
    this.flush();
    return member;
  }

  setRole(email: string, role: Role): void {
    const m = this.tenant.members.find((x) => x.email === email);
    if (!m) throw new Error(`No member '${email}'`);
    m.role = role;
    this.flush();
  }

  removeMember(email: string): void {
    const m = this.tenant.members.find((x) => x.email === email);
    if (m?.role === "owner" && this.tenant.members.filter((x) => x.role === "owner").length === 1) {
      throw new Error("Cannot remove the last owner");
    }
    this.tenant.members = this.tenant.members.filter((x) => x.email !== email);
    this.flush();
  }

  roleOf(email: string): Role | undefined {
    return this.tenant.members.find((m) => m.email === email)?.role;
  }
}
