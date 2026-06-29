/**
 * Connector egress sandbox (operational hardening for hosted deployments).
 *
 * Dynamic community connectors run in-process, so a malicious one could try to
 * exfiltrate credentials or hit internal services (SSRF). This is the enforced
 * boundary: each connector's network egress is restricted to an allowlist of
 * hosts (declared in its manifest and approved at "verified" time). Built-in
 * and verified connectors are trusted; unverified ones that declare nothing
 * cannot reach the network at all (fail-closed).
 *
 * NOTE: this controls *egress*, not code execution. Fully untrusted code still
 * needs process-level isolation (worker_threads / isolates / microVM) — see
 * ARCHITECTURE.md. This layer meaningfully reduces the exfiltration/SSRF blast
 * radius and is enforced on the engine's injected fetch.
 */

import type { ConnectorRegistry } from "./connectors/index.ts";

export class EgressBlockedError extends Error {}

export interface EgressPolicy {
  /** allow = no restriction; allowlist = only allowedHosts; deny = no egress. */
  mode: "allow" | "allowlist" | "deny";
  allowedHosts?: string[];
}

export type EgressResolver = (connectorId: string) => EgressPolicy;

/** Extract the hostname from a fetch input (string | URL | Request). */
export function hostOf(input: Parameters<typeof fetch>[0]): string | null {
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Exact match or suffix wildcard: "*.example.com" matches "api.example.com". */
export function isHostAllowed(host: string, allowed: string[] | undefined): boolean {
  if (!allowed || allowed.length === 0) return false;
  const h = host.toLowerCase();
  for (const pattern of allowed) {
    const p = pattern.toLowerCase();
    if (p === h) return true;
    if (p.startsWith("*.")) {
      const suffix = p.slice(1); // ".example.com"
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    }
  }
  return false;
}

/** Throw EgressBlockedError if the policy forbids reaching `input`. */
export function enforceEgress(input: Parameters<typeof fetch>[0], policy: EgressPolicy): void {
  if (policy.mode === "allow") return;
  if (policy.mode === "deny") {
    throw new EgressBlockedError("connector is not permitted to make network requests");
  }
  const host = hostOf(input);
  if (!host) throw new EgressBlockedError("could not determine request host");
  if (!isHostAllowed(host, policy.allowedHosts)) {
    throw new EgressBlockedError(
      `egress to '${host}' blocked; allowed: ${(policy.allowedHosts ?? []).join(", ") || "(none)"}`,
    );
  }
}

export interface SandboxOptions {
  /** When true (hosted mode), unverified connectors are sandboxed. Default false. */
  strict?: boolean;
}

/**
 * Build an egress resolver from a registry. Built-in connectors (not registered
 * dynamically) and verified community connectors are trusted ("allow"). In
 * strict mode, an unverified dynamic connector is restricted to its manifest
 * allowedHosts (or denied entirely if it declares none).
 */
export function buildEgressResolver(
  registry: ConnectorRegistry,
  opts: SandboxOptions = {},
): EgressResolver {
  return (connectorId) => {
    const dyn = registry.dynamicInfo(connectorId);
    if (!dyn) return { mode: "allow" }; // built-in
    if (dyn.verified) return { mode: "allow" };
    if (!opts.strict) return { mode: "allow" }; // dev tier: don't break local testing
    const hosts = registry.manifest(connectorId)?.allowedHosts;
    return hosts && hosts.length > 0 ? { mode: "allowlist", allowedHosts: hosts } : { mode: "deny" };
  };
}
