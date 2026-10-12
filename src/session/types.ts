import type { ConfigurationVersion, JsonValue, RunManifest } from "../types.js";
import type { ApprovalBinding } from "../permissions.js";

export type Durability = "flush" | "fsync";
export type DefinitionKind = "model" | "prompt" | "tool" | "plugin";
export interface DefinitionRef {
  readonly kind: DefinitionKind;
  readonly id: string;
  readonly version: string;
  readonly hash: string;
}
export interface Definition extends DefinitionRef { readonly content: JsonValue }
export interface Versions {
  readonly model: DefinitionRef;
  readonly prompt: DefinitionRef;
  readonly tools: readonly DefinitionRef[];
  readonly plugins: readonly DefinitionRef[];
}
export interface Coverage { readonly from: 1; readonly to: number }
export interface SurfaceReplacement {
  readonly op: "replace";
  readonly startSeq: number;
  readonly endSeq: number;
}
export interface SessionSurface {
  /** Ordered user messages, complete model/tool batches, and summaries. */
  readonly nodes: readonly number[];
  readonly generation: number;
}
export interface ModelRequestBudget {
  readonly promptTokens: number;
  readonly outputTokens: number;
  /** null means no cumulative consumption ceiling. */
  readonly remainingTokens: number | null;
  readonly requestBytes: number;
  readonly estimator: string;
  readonly calibration: number;
  readonly contextWindow?: number;
  readonly anchorCallId?: string | null;
}
export interface ToolPruning {
  readonly type: "context.tool-pruned";
  readonly callId: string;
  readonly sourceSeq: number;
  readonly version: "head-tail-v1";
  readonly thresholdChars: number;
  readonly headChars: number;
  readonly tailChars: number;
}
export type EventData =
  | { readonly type: "definition.recorded"; readonly definition: Definition }
  | { readonly type: "configuration.recorded"; readonly configuration: ConfigurationVersion }
  | { readonly type: "run.started"; readonly versions: Versions; readonly config: JsonValue; readonly manifest?: RunManifest }
  | { readonly type: "pipeline.rejected"; readonly rejectedCallId: string; readonly parentCallId: string | null; readonly name: string; readonly code: string; readonly inputPath?: string }
  | { readonly type: "ptc.started"; readonly program: JsonValue; readonly input: JsonValue; readonly bindings: readonly string[]; readonly backend: string; readonly isolation: JsonValue; readonly limits: JsonValue }
  | { readonly type: "ptc.completed"; readonly result: JsonValue }
  | { readonly type: "ptc.uncertain"; readonly result: JsonValue }
  | { readonly type: "user.input"; readonly content: string }
  | { readonly type: "model.requested"; readonly request: JsonValue; readonly budget?: ModelRequestBudget; readonly purpose?: "agent" | "compaction"; readonly prompt?: DefinitionRef }
  | { readonly type: "model.completed"; readonly response: JsonValue; readonly text: string; readonly childCallIds?: readonly string[]; readonly chargedTokens?: number }
  | { readonly type: "model.failed"; readonly reason: string; readonly chargedTokens?: number }
  | { readonly type: "tool.planned"; readonly tool: DefinitionRef; readonly input: JsonValue; readonly inputHash?: string; readonly effect: "read" | "idempotent-write" | "non-idempotent-write"; readonly idempotencyKey?: string }
  | { readonly type: "permission.decided"; readonly decision: "allow" | "deny"; readonly reason: string; readonly approval?: ApprovalBinding }
  | { readonly type: "tool.started" }
  | { readonly type: "tool.uncertain"; readonly reason: string }
  | { readonly type: "tool.completed"; readonly outcome: "success" | "error"; readonly result: JsonValue; readonly confirmation: "direct" | "status-query" | "idempotency-key"; readonly evidence?: JsonValue }
  | { readonly type: "tool.not-executed"; readonly evidence: JsonValue }
  | { readonly type: "tool.cancelled"; readonly reason: string }
  | { readonly type: "budget.exited"; readonly budget: "tokens" | "time" | "cost" | "steps" | "bytes"; readonly limit: number; readonly used: number; readonly reason: string; readonly requestBudget?: ModelRequestBudget }
  | { readonly type: "task.status"; readonly taskId: string; readonly status: "pending" | "running" | "completed" | "failed" | "cancelled"; readonly detail: string }
  | { readonly type: "protected.recorded"; readonly id: string; readonly kind: "constraint" | "protected"; readonly content: string }
  | { readonly type: "summary.recorded"; readonly id: string; readonly version: string; readonly text: string; readonly coverage: Coverage }
  | { readonly type: "surface.replaced"; readonly id: string; readonly version: string; readonly text: string; readonly surfaceOp: SurfaceReplacement; readonly sourceEventSeqs: readonly number[]; readonly expectedSurface?: SessionSurface; readonly expectedThroughSeq?: number }
  | ToolPruning
  | { readonly type: "context.measured"; readonly measurement: JsonValue }
  | { readonly type: "context.compaction"; readonly id: string; readonly phase: "started" | "completed" | "failed"; readonly trigger: "pressure" | "context-overflow"; readonly sourceEventSeqs: readonly number[]; readonly detail: JsonValue }
  | { readonly type: "run.finished"; readonly status: "completed" | "failed" | "cancelled" | "budget-exited" };

export interface EventInput {
  readonly runId: string | null;
  readonly callId?: string;
  readonly parentCallId?: string;
  readonly data: EventData;
}
export interface SessionEvent {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly seq: number;
  readonly timestamp: string;
  readonly runId: string | null;
  readonly callId: string | null;
  readonly parentCallId: string | null;
  readonly versions: Versions | null;
  readonly tool: DefinitionRef | null;
  readonly configHash: string;
  readonly data: EventData;
}
export interface CommitReceipt {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly durability: Durability;
}
export interface FlushReceipt {
  readonly flushedThrough: number;
  readonly syncedThrough: number;
}
export interface EventJournal {
  readonly sessionId: string;
  read(): readonly SessionEvent[];
  append(events: readonly SessionEvent[], durability: Durability): Promise<CommitReceipt>;
  flush(durability: Durability): Promise<FlushReceipt>;
  close(): Promise<void>;
}
export interface CommittedNotification {
  readonly kind: "committed";
  readonly receipt: CommitReceipt;
  readonly events: readonly SessionEvent[];
  readonly terminal: boolean;
}
export interface UiDelta {
  readonly kind: "delta";
  readonly runId: string;
  readonly callId: string;
  readonly channel: "model" | "tool";
  readonly text: string;
}
export interface CallState {
  readonly callId: string;
  readonly parentCallId: string | null;
  readonly runId: string;
  readonly kind: "model" | "tool" | "ptc";
  readonly firstSeq: number;
  readonly terminalSeq: number | null;
  readonly status: "not-started" | "uncertain" | "confirmed-complete";
  readonly permission: "allow" | "deny" | null;
  readonly planned: SessionEvent;
}
export interface SessionState {
  readonly throughSeq: number;
  readonly calls: readonly CallState[];
  readonly tasks: readonly SessionEvent[];
  readonly protected: readonly SessionEvent[];
  readonly runs: readonly { readonly runId: string; readonly status: string }[];
  readonly summary: SessionEvent | null;
  readonly surface: SessionSurface;
  readonly toolPrunings: readonly ToolPruning[];
}
export interface RecoveryCall extends CallState {
  readonly nextAction: "none" | "start-after-permission" | "request-model" | "retry-safe" | "reconcile-with-key" | "query-or-confirm" | "restore-input";
}
export interface ContextProjection {
  readonly throughSeq: number;
  readonly summary: SessionEvent | null;
  readonly constraints: readonly SessionEvent[];
  readonly protected: readonly SessionEvent[];
  readonly tasks: readonly SessionEvent[];
  readonly pendingCalls: readonly CallState[];
  readonly history: readonly SessionEvent[];
  readonly surface: SessionSurface & { readonly events: readonly SessionEvent[] };
  readonly toolPrunings: readonly ToolPruning[];
}
export interface ReconstructedRequest {
  readonly request: JsonValue;
  readonly config: JsonValue;
  readonly definitions: readonly Definition[];
  readonly requestEvent: SessionEvent;
  readonly manifest?: RunManifest;
}
export type RunEventInput = Omit<EventInput, "runId">;
export interface RecordedToolResult { readonly outcome: "success" | "error"; readonly result: JsonValue }
export type ToolOperation = (request: { readonly input: JsonValue; readonly idempotencyKey: string | null }) => Promise<RecordedToolResult>;
export interface SessionService {
  readonly sessionId: string;
  readonly runId: string;
  retain(definitions: readonly Definition[]): Promise<CommitReceipt>;
  start(versions: Versions, config: JsonValue): Promise<CommitReceipt>;
  record(events: readonly RunEventInput[], durability?: Durability): Promise<CommitReceipt>;
  executeTool(callId: string, operation: ToolOperation): Promise<RecordedToolResult>;
  events(): readonly SessionEvent[];
  state(): SessionState;
  recovery(): readonly RecoveryCall[];
  reconstructRequest(callId: string): ReconstructedRequest;
  flush(durability: Durability): Promise<FlushReceipt>;
  subscribeCommitted(listener: (notification: CommittedNotification) => void): () => void;
  subscribeDeltas(listener: (delta: UiDelta) => void): () => void;
  publishDelta(delta: Omit<UiDelta, "kind" | "runId">): void;
}
export interface ContextService { build(): ContextProjection }
