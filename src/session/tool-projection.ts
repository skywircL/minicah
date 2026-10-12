import type { JsonValue } from "../types.js";
import type { ToolPruning } from "./types.js";

export const PRUNE_MARKER = "\n[... context text pruned; full result retained in session log ...]\n";
export function modelToolResult(value: JsonValue, callId: string): JsonValue {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("callId" in value) || value.callId !== callId || !("status" in value) || !["completed", "failed", "unknown"].includes(String(value.status))) return value;
  if (!("value" in value) || !("code" in value) || !("dispatched" in value)) return value;
  return { status: value.status!, dispatched: value.dispatched!, code: value.code!, value: value.value! };
}

/** Pure versioned projection: preserve structured fields and prune only oversized strings. */
export function pruneToolResult(value: JsonValue, policy: Pick<ToolPruning, "thresholdChars" | "headChars" | "tailChars">): JsonValue {
  const prune = (input: JsonValue): JsonValue => {
    if (typeof input === "string") {
      const chars = [...input];
      return chars.length > policy.thresholdChars ? chars.slice(0, policy.headChars).join("") + PRUNE_MARKER + (policy.tailChars ? chars.slice(-policy.tailChars).join("") : "") : input;
    }
    if (Array.isArray(input)) return input.map(prune);
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, prune(item)]));
    return input;
  };
  // Pipeline status, error code and dispatch facts are never shortened.
  if (value && typeof value === "object" && !Array.isArray(value) && "status" in value && "value" in value) return { ...value, value: prune(value.value!) };
  return prune(value);
}
