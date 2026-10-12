import { createHash } from "node:crypto";
import { fail } from "./errors.js";

/** Strict JSON copying is required: JSON.stringify silently discards undefined. */
export function immutable<T>(value: T): T {
  const seen = new Set<object>();
  const copy = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || !item || seen.has(item)) fail("INVALID_EVENT", "Expected finite, acyclic JSON data");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      fail("INVALID_EVENT", "Only plain JSON objects can be persisted");
    }
    seen.add(item);
    const result = Array.isArray(item)
      ? Array.from(item, copy)
      : Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, copy(entry)]));
    seen.delete(item);
    return Object.freeze(result);
  };
  return copy(value) as T;
}

export function canonical(value: unknown): string {
  const clean = immutable(value);
  const encode = (item: unknown): string => {
    if (item === null || typeof item !== "object") return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    return `{${Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, val]) => `${JSON.stringify(key)}:${encode(val)}`).join(",")}}`;
  };
  return encode(clean);
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

