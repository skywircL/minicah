import { immutable } from "./json.js";
import { positive } from "./pipeline-control.js";
import type { JsonValue } from "./types.js";

export type Redactor = (value: JsonValue) => JsonValue;
/** Conservative baseline; deployments must supply their own domain-specific redactor. */
export function redact(value: JsonValue): JsonValue {
  if (typeof value === "string") return value.replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]").replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s;,}]{4,}/gi, "[REDACTED]").replace(/\b(?:sk|token|secret|password)[-_=:][A-Za-z0-9_\-./+=]{4,}/gi, "[REDACTED]");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|secret|password|authorization|cookie|api[_-]?key/i.test(key) ? "[REDACTED]" : redact(item)]));
  return value;
}
export interface AuditEvidence {
  readonly value: JsonValue;
  readonly redactionVersion: string;
  readonly originalBytes: number;
  readonly truncated: boolean;
}
export function evidence(value: JsonValue, limit: number, custom: Redactor = value => value, version = "baseline-v1"): AuditEvidence {
  positive(limit, "evidence bytes");
  const clean = immutable(redact(custom(immutable(redact(value)))));
  const encoded = JSON.stringify(clean);
  if (Buffer.byteLength(encoded) <= limit) return immutable({ value: clean, redactionVersion: version, originalBytes: Buffer.byteLength(encoded), truncated: false });
  // A byte bounded, valid UTF-8 preview; it is explicitly marked as incomplete evidence.
  let preview = Buffer.from(encoded).subarray(0, Math.max(0, limit - 16)).toString("utf8");
  while (Buffer.byteLength(JSON.stringify(preview)) > limit && preview.length) preview = preview.slice(0, Math.floor(preview.length * 0.9));
  return immutable({ value: limit < 2 ? 0 : preview, redactionVersion: version, originalBytes: Buffer.byteLength(encoded), truncated: true });
}
