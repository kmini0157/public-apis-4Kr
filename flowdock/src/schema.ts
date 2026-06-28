/**
 * Minimal, zero-dependency JSON Schema validator.
 *
 * Scope is deliberately small (type / required / properties / enum / pattern /
 * items) — enough to validate connector `with` inputs and give authors clear
 * errors without pulling in ajv. Unsupported keywords are ignored, never throw.
 */

import type { Json } from "./types.ts";

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

type Schema = Record<string, Json>;

function typeOf(v: Json): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // "object" | "string" | "number" | "boolean"
}

function checkType(value: Json, type: string, path: string, errors: string[]): boolean {
  const actual = typeOf(value);
  const ok =
    type === actual ||
    (type === "integer" && actual === "number" && Number.isInteger(value as number));
  if (!ok) errors.push(`${path}: expected ${type}, got ${actual}`);
  return ok;
}

function validateNode(value: Json, schema: Json, path: string, errors: string[]): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const s = schema as Schema;

  if (typeof s.type === "string") {
    if (!checkType(value, s.type, path, errors)) return;
  }

  if (Array.isArray(s.enum)) {
    const ok = s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value));
    if (!ok) errors.push(`${path}: must be one of ${JSON.stringify(s.enum)}`);
  }

  if (typeof s.pattern === "string" && typeof value === "string") {
    let re: RegExp | undefined;
    try {
      re = new RegExp(s.pattern);
    } catch {
      errors.push(`${path}: invalid pattern /${s.pattern}/`);
    }
    if (re && !re.test(value)) {
      errors.push(`${path}: does not match pattern /${s.pattern}/`);
    }
  }

  if (typeOf(value) === "object") {
    const obj = value as Record<string, Json>;
    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (typeof key === "string" && !(key in obj)) {
          errors.push(`${path}: missing required property '${key}'`);
        }
      }
    }
    if (s.properties && typeof s.properties === "object" && !Array.isArray(s.properties)) {
      for (const [key, sub] of Object.entries(s.properties as Schema)) {
        if (key in obj) validateNode(obj[key]!, sub, path === "" ? key : `${path}.${key}`, errors);
      }
    }
  }

  if (typeOf(value) === "array" && s.items) {
    (value as Json[]).forEach((item, i) => validateNode(item, s.items!, `${path}[${i}]`, errors));
  }
}

/** Validate a value against a schema. An undefined schema always passes. */
export function validateInput(input: Json, schema: Json | undefined): ValidationResult {
  if (schema === undefined || schema === null) return { valid: true };
  const errors: string[] = [];
  validateNode(input, schema, "", errors);
  return errors.length ? { valid: false, errors } : { valid: true };
}
