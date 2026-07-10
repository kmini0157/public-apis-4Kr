/**
 * Stripe billing integration (operational hardening).
 *
 * The inbound, security-critical half — webhook signature verification and
 * event→plan application — is implemented in full and is offline-testable. The
 * outbound half (creating a Checkout Session) takes an injectable fetch so it
 * can be stubbed in tests and hits the real API only in production.
 *
 * Plan changes are driven by Stripe webhooks, never trusted from the client:
 *   checkout.session.completed   -> upgrade + link customer/subscription
 *   customer.subscription.updated -> re-map plan from the active price
 *   customer.subscription.deleted -> downgrade to Free
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./store.ts";
import { isPlanId, type PlanId } from "./plans.ts";
import type { TenantStore } from "./tenancy.ts";

export class SignatureError extends Error {}

/**
 * Verify a Stripe `Stripe-Signature` header.
 * Header form: `t=<unix>,v1=<hexmac>[,v1=<hexmac>...]`.
 * signedPayload = `${t}.${rawBody}`, mac = HMAC-SHA256(signedPayload, secret).
 * Rejects on bad mac or when |now - t| exceeds the tolerance (replay guard).
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string,
  secret: string,
  nowSec: number,
  toleranceSec = 300,
): void {
  const parts = Object.create(null) as Record<string, string[]>;
  for (const kv of header.split(",")) {
    const idx = kv.indexOf("=");
    if (idx === -1) continue;
    const k = kv.slice(0, idx).trim();
    const v = kv.slice(idx + 1).trim();
    (parts[k] ??= []).push(v);
  }
  const t = parts["t"]?.[0];
  const v1s = parts["v1"] ?? [];
  if (!t || v1s.length === 0) throw new SignatureError("malformed Stripe-Signature header");

  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) {
    throw new SignatureError("timestamp outside tolerance (possible replay)");
  }

  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const ok = v1s.some((v) => {
    let provided: Buffer;
    try {
      provided = Buffer.from(v, "hex");
    } catch {
      return false;
    }
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
  if (!ok) throw new SignatureError("no matching v1 signature");
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/** Seen-event log so Stripe redeliveries are no-ops (webhook idempotency). */
export interface EventLog {
  has(id: string): boolean;
  add(id: string): void;
}

/** JSON-file event log, capped to the most recent entries. */
export class JsonEventLog implements EventLog {
  private ids: string[] = [];
  private set = new Set<string>();
  constructor(
    private readonly path = join(".flowdock", "billing-events.json"),
    private readonly cap = 1000,
  ) {
    if (path && existsSync(path)) {
      try {
        this.ids = JSON.parse(readFileSync(path, "utf8")) as string[];
        this.set = new Set(this.ids);
      } catch {
        this.ids = [];
      }
    }
  }
  has(id: string): boolean {
    return this.set.has(id);
  }
  add(id: string): void {
    if (this.set.has(id)) return;
    this.ids.push(id);
    this.set.add(id);
    while (this.ids.length > this.cap) {
      const evicted = this.ids.shift()!;
      this.set.delete(evicted);
    }
    if (this.path) atomicWrite(this.path, JSON.stringify(this.ids));
  }
}

export interface BillingConfig {
  /** Maps a Stripe price id to a FlowDock plan. */
  priceToPlan?: Record<string, PlanId>;
  /** Optional override: map a plan to a price id for Checkout. */
  planToPrice?: Record<PlanId, string>;
  toleranceSec?: number;
}

export interface BillingResult {
  type: string;
  applied: boolean;
  plan?: PlanId;
  reason?: string;
}

export class BillingService {
  constructor(
    private readonly tenants: TenantStore,
    private readonly signingSecret: string,
    private readonly config: BillingConfig = {},
    /** Optional idempotency log; Stripe redelivers events, so hosted setups pass one. */
    private readonly events?: EventLog,
  ) {}

  /** Verify + apply a raw Stripe webhook. Redelivered events are no-ops. */
  handleWebhook(rawBody: string, signatureHeader: string, nowSec: number): BillingResult {
    verifyStripeSignature(rawBody, signatureHeader, this.signingSecret, nowSec, this.config.toleranceSec);
    let event: StripeEvent;
    try {
      event = JSON.parse(rawBody) as StripeEvent;
    } catch {
      throw new SignatureError("webhook body is not valid JSON");
    }
    // Only record ids AFTER signature verification (unauthenticated ids must not pollute the log).
    if (this.events && event.id) {
      if (this.events.has(event.id)) {
        return { type: event.type, applied: false, reason: "duplicate event (already processed)" };
      }
      const result = this.applyEvent(event);
      this.events.add(event.id);
      return result;
    }
    return this.applyEvent(event);
  }

  /** Apply an already-verified event (exposed for testing the mapping). */
  applyEvent(event: StripeEvent): BillingResult {
    const obj = event.data?.object ?? {};
    switch (event.type) {
      case "checkout.session.completed": {
        const plan = this.resolvePlan(obj);
        const customerId = strField(obj, "customer");
        const subscriptionId = strField(obj, "subscription");
        if (customerId || subscriptionId) {
          this.tenants.setBilling({
            ...(customerId ? { customerId } : {}),
            ...(subscriptionId ? { subscriptionId } : {}),
            status: "active",
          });
        }
        if (!plan) return { type: event.type, applied: false, reason: "no plan in metadata/price" };
        this.tenants.setPlan(plan);
        return { type: event.type, applied: true, plan };
      }
      case "customer.subscription.updated": {
        const plan = this.resolvePlan(obj);
        this.tenants.setBilling({ status: strField(obj, "status") ?? "active" });
        if (!plan) return { type: event.type, applied: false, reason: "no mappable price" };
        this.tenants.setPlan(plan);
        return { type: event.type, applied: true, plan };
      }
      case "customer.subscription.deleted": {
        this.tenants.setBilling({ status: "canceled" });
        this.tenants.setPlan("free");
        return { type: event.type, applied: true, plan: "free" };
      }
      default:
        return { type: event.type, applied: false, reason: "unhandled event type" };
    }
  }

  /** Derive the plan from event metadata.plan, else the price→plan map. */
  private resolvePlan(obj: Record<string, unknown>): PlanId | undefined {
    const meta = obj["metadata"];
    if (meta && typeof meta === "object") {
      const p = (meta as Record<string, unknown>)["plan"];
      if (typeof p === "string" && isPlanId(p)) return p;
    }
    const priceId = extractPriceId(obj);
    if (priceId && this.config.priceToPlan?.[priceId]) return this.config.priceToPlan[priceId];
    return undefined;
  }

  /**
   * Create a Stripe Checkout Session for upgrading. Uses an injectable fetch so
   * tests never hit the network; returns the redirect URL.
   */
  async createCheckoutSession(args: {
    plan: PlanId;
    apiKey: string;
    successUrl: string;
    cancelUrl: string;
    tenantId: string;
    customerId?: string;
    fetchImpl?: typeof fetch;
  }): Promise<{ id: string; url: string }> {
    const priceId = this.config.planToPrice?.[args.plan];
    if (!priceId) throw new Error(`No Stripe price configured for plan '${args.plan}'`);
    const form = new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      "metadata[plan]": args.plan,
      "metadata[tenantId]": args.tenantId,
      ...(args.customerId ? { customer: args.customerId } : {}),
    });
    const doFetch = args.fetchImpl ?? fetch;
    const res = await doFetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    const body = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
    if (!res.ok || !body.url || !body.id) {
      throw new Error(`Stripe checkout failed: ${body.error?.message ?? res.status}`);
    }
    return { id: body.id, url: body.url };
  }
}

function strField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

/** Pull the active price id from a subscription/checkout object shape. */
function extractPriceId(obj: Record<string, unknown>): string | undefined {
  const items = obj["items"];
  if (items && typeof items === "object") {
    const data = (items as Record<string, unknown>)["data"];
    if (Array.isArray(data) && data[0] && typeof data[0] === "object") {
      const price = (data[0] as Record<string, unknown>)["price"];
      if (price && typeof price === "object") {
        const id = (price as Record<string, unknown>)["id"];
        if (typeof id === "string") return id;
      }
      if (typeof price === "string") return price;
    }
  }
  return undefined;
}
