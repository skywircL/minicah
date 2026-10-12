import type { JsonValue } from "../types.js";
import type { ToolResult } from "../tool-pipeline.js";
import type { AuditEvidence } from "../audit.js";

export interface SandboxRequest {
  readonly program: string; readonly input: JsonValue; readonly bindings: readonly string[];
  readonly maxOutputBytes: number; readonly concurrency: number;
}
export interface SandboxResult {
  readonly status: "completed" | "failed" | "unknown";
  readonly value: JsonValue; readonly code: string | null;
  readonly cleanup: "verified" | "unconfirmed";
  /** Actual execution identity and enforced profile, when reported by the backend. */
  readonly execution?: { readonly id: string; readonly profile: JsonValue };
}
/** Trusted Host adapter. Program frames must never supply Host identity or policy fields. */
export interface IsolationBackend {
  readonly id: string;
  readonly profile: JsonValue;
  close(): Promise<void>;
  run(request: SandboxRequest, host: {
    readonly signal: AbortSignal;
    cancel(): void;
    call(name: string, input: JsonValue): Promise<ToolResult>;
  }): Promise<SandboxResult>;
}
export interface PtcRequest { readonly program: string; readonly input: JsonValue; readonly bindings: readonly string[]; readonly callId?: string; readonly parentCallId?: string }
export interface PtcResult {
  readonly callId: string; readonly status: "completed" | "failed" | "unknown";
  readonly code: string | null; readonly cleanup: "verified" | "unconfirmed";
  readonly output: AuditEvidence; readonly children: readonly ToolResult[];
  readonly execution?: { readonly id: string; readonly profile: JsonValue };
}
export interface PtcRuntimeService { evaluate(request: PtcRequest, signal?: AbortSignal): Promise<PtcResult> }
