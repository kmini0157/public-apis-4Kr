/**
 * Safe expression resolver for {{ }} templates.
 *
 * Deliberately NOT `eval`/`Function`: a tiny, sandboxed grammar that only
 * supports path lookups, literals and `??` coalescing. Arbitrary code lives
 * in a dedicated Code node (isolated worker), never in input expressions.
 *
 *   {{ nodes.fetch.output.text }}
 *   {{ trigger.body.voice ?? 'ko-KR' }}
 *   {{ secrets.MY_EMAIL }}
 */

import type { Json } from "./types.ts";

export type Scope = Record<string, Json>;

// --- tokenizer ---------------------------------------------------------------

type Tok =
  | { t: "ident"; v: string }
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "dot" }
  | { t: "lbracket" }
  | { t: "rbracket" }
  | { t: "coalesce" };

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_-]/;

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === ".") {
      toks.push({ t: "dot" });
      i++;
      continue;
    }
    if (c === "[") {
      toks.push({ t: "lbracket" });
      i++;
      continue;
    }
    if (c === "]") {
      toks.push({ t: "rbracket" });
      i++;
      continue;
    }
    if (c === "?" && src[i + 1] === "?") {
      toks.push({ t: "coalesce" });
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== quote) {
        if (src[j] === "\\" && j + 1 < src.length) {
          out += src[j + 1];
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new Error(`Unterminated string in expression: ${src}`);
      toks.push({ t: "str", v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      toks.push({ t: "num", v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i;
      while (j < src.length && IDENT_PART.test(src[j]!)) j++;
      toks.push({ t: "ident", v: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character '${c}' in expression: ${src}`);
  }
  return toks;
}

// --- parser + evaluator (single pass over a flat token list) -----------------

const KEYWORDS: Record<string, Json> = { true: true, false: false, null: null };

function evalPrimary(toks: Tok[], pos: { i: number }, scope: Scope): Json {
  const tok = toks[pos.i];
  if (!tok) throw new Error("Unexpected end of expression");

  if (tok.t === "str") {
    pos.i++;
    return tok.v;
  }
  if (tok.t === "num") {
    pos.i++;
    return tok.v;
  }
  if (tok.t === "ident") {
    pos.i++;
    if (tok.v in KEYWORDS && !isPathContinuation(toks[pos.i])) {
      return KEYWORDS[tok.v]!;
    }
    // path lookup starting from a root scope key
    let cur: Json | undefined = scope[tok.v];
    cur = walkPath(toks, pos, cur);
    return cur === undefined ? null : cur;
  }
  throw new Error(`Unexpected token in expression: ${JSON.stringify(tok)}`);
}

function isPathContinuation(tok: Tok | undefined): boolean {
  return tok?.t === "dot" || tok?.t === "lbracket";
}

function walkPath(toks: Tok[], pos: { i: number }, start: Json | undefined): Json | undefined {
  let cur = start;
  while (true) {
    const tok = toks[pos.i];
    if (tok?.t === "dot") {
      pos.i++;
      const key = toks[pos.i];
      if (key?.t !== "ident") throw new Error("Expected property name after '.'");
      pos.i++;
      cur = indexInto(cur, key.v);
    } else if (tok?.t === "lbracket") {
      pos.i++;
      const idx = toks[pos.i];
      if (idx?.t !== "num" && idx?.t !== "str") throw new Error("Expected index inside [ ]");
      pos.i++;
      if (toks[pos.i]?.t !== "rbracket") throw new Error("Expected ']'");
      pos.i++;
      cur = indexInto(cur, idx.v);
    } else {
      break;
    }
  }
  return cur;
}

function indexInto(cur: Json | undefined, key: string | number): Json | undefined {
  if (cur === null || cur === undefined) return undefined;
  if (typeof cur !== "object") return undefined;
  return (cur as Record<string, Json>)[String(key)];
}

function isNullish(v: Json): boolean {
  return v === null || v === undefined;
}

/** Evaluate a single expression (the text inside {{ }}). */
export function evalExpr(src: string, scope: Scope): Json {
  const toks = tokenize(src);
  if (toks.length === 0) return null;
  const pos = { i: 0 };
  let left = evalPrimary(toks, pos, scope);
  while (toks[pos.i]?.t === "coalesce") {
    pos.i++;
    const right = evalPrimary(toks, pos, scope);
    if (isNullish(left)) left = right;
  }
  if (pos.i !== toks.length) {
    throw new Error(`Trailing tokens in expression: ${src}`);
  }
  return left;
}

const TEMPLATE = /\{\{(.+?)\}\}/g;

/**
 * Interpolate a string. If the string is exactly one {{ }} expression, the
 * typed value is returned (so objects/arrays survive). Otherwise each match is
 * stringified and spliced into the surrounding text.
 */
export function interpolate(str: string, scope: Scope): Json {
  const whole = str.match(/^\s*\{\{(.+?)\}\}\s*$/);
  if (whole) return evalExpr(whole[1]!, scope);
  return str.replace(TEMPLATE, (_m, expr: string) => {
    const v = evalExpr(expr, scope);
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

/** Recursively resolve every {{ }} inside an arbitrary input value. */
export function resolve(value: Json, scope: Scope): Json {
  if (typeof value === "string") return interpolate(value, scope);
  if (Array.isArray(value)) return value.map((v) => resolve(v, scope));
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolve(v, scope);
    return out;
  }
  return value;
}

/** Truthiness for conditional `if` guards. Strings "", "false", "0" are falsy. */
export function isTruthy(v: Json): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return !(v === "" || v === "false" || v === "0");
  return true; // non-empty objects/arrays
}

/** Collect node ids referenced by `{{ nodes.<id>... }}` for DAG edge inference. */
export function referencedNodes(value: Json, acc = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const m of value.matchAll(TEMPLATE)) {
      for (const ref of m[1]!.matchAll(/\bnodes\s*\.\s*([A-Za-z_][A-Za-z0-9_-]*)/g)) {
        acc.add(ref[1]!);
      }
    }
  } else if (Array.isArray(value)) {
    for (const v of value) referencedNodes(v, acc);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) referencedNodes(v, acc);
  }
  return acc;
}
