import type { JsonValue } from "../types.js";
import type { SandboxTestEvidence, SandboxTestService } from "./sandbox-test-types.js";

export type EvaluationMode = "native" | "ptc";
interface GraderBase {
  readonly id: string;
  readonly required?: boolean;
  readonly weight?: number;
}
export interface ComparisonGrader extends GraderBase {
  readonly kind: "text-equals" | "text-includes" | "text-json-equals" | "file-equals" | "file-includes" | "file-json-equals";
  readonly expected: JsonValue;
  readonly path?: string;
}
export interface SandboxTestGrader extends GraderBase {
  readonly kind: "sandbox-test";
  readonly testId: string;
}
export interface WorkspacePreservationGrader extends GraderBase {
  readonly kind: "workspace-unchanged-except";
  /** Exact relative file paths, never globs or directory prefixes. */
  readonly paths: readonly string[];
}
export interface ToolCallCountGrader extends GraderBase {
  readonly kind: "tool-call-count";
  readonly tools: readonly string[];
  readonly phase: "attempted" | "dispatched" | "rejected" | "approval-denied" | "attempted-after-denial";
  readonly min: number;
  readonly max: number;
  /** Optional exact workspace path argument; used to prove exposure to task material. */
  readonly path?: string;
  /** Count calls outside these exact paths; mutually exclusive with path. */
  readonly exceptPaths?: readonly string[];
}
export type EvaluationGrader = ComparisonGrader | SandboxTestGrader | WorkspacePreservationGrader | ToolCallCountGrader;
export type OracleLayer = "outcome" | "behavior" | "response";
export interface GroundTruthContract {
  readonly version: "1.0.0";
  readonly capabilityId: string;
  readonly seedId: string;
  readonly mutation: "none" | "wording" | "boundary" | "permission" | "adversarial";
  readonly risk: "low" | "medium" | "high";
  readonly reset: "fresh-workspace-and-session";
  readonly sources: readonly { readonly id: string; readonly reference: string; readonly version: string; readonly statement: string }[];
  readonly assertions: readonly { readonly graderId: string; readonly layer: OracleLayer; readonly sourceIds: readonly string[]; readonly description: string }[];
}
export interface EvaluationExecutionPolicy {
  readonly allowedTools: readonly ("list_files" | "read_file" | "search_text" | "write_file" | "edit_file")[];
  /** Narrows the Host's --allow-writes authorization; cannot grant it. */
  readonly writeApproval: "allow" | "deny";
}
export interface TrialProtocol {
  readonly repetitions: number;
  readonly timeoutMs: number;
}
export interface EvaluationTask {
  readonly id: string;
  readonly prompt: string;
  readonly tags?: readonly string[];
  readonly files?: Readonly<Record<string, string>>;
  readonly graders: readonly EvaluationGrader[];
  /** Host-only provenance and assertion mapping, never model input. */
  readonly contract?: GroundTruthContract;
  readonly executionPolicy?: EvaluationExecutionPolicy;
  readonly trialProtocol?: TrialProtocol;
}
export interface EvaluationSuite {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly split: "regression" | "capability" | "holdout";
  readonly tasks: readonly EvaluationTask[];
}
/** Only public task material crosses into the executor. Graders stay on the Host. */
export interface TrialTask {
  readonly id: string;
  readonly prompt: string;
  readonly tags: readonly string[];
  readonly files: Readonly<Record<string, string>>;
}
export interface TrialExecutionRequest {
  readonly task: TrialTask;
  readonly workspace: string;
  readonly trialId: string;
  readonly signal: AbortSignal;
  readonly mode: EvaluationMode;
  /** Private directory outside workspace; journal references must be relative to this directory. */
  readonly logDirectory: string;
  readonly executionPolicy?: EvaluationExecutionPolicy;
}
/** Produced by trusted Host code from committed events; not candidate output. */
export interface ToolTraceEvidence {
  readonly version: 1;
  readonly runId: string;
  readonly throughSeq: number;
  readonly complete: boolean;
  readonly counts: Readonly<Record<string, { readonly attempted: number; readonly dispatched: number; readonly rejected: number }>>;
  readonly pathCounts?: ToolTraceEvidence["counts"];
  /** Bound Host approval denied, then terminally rejected before dispatch.
   * Missing on legacy evidence; absence cannot establish zero denials. */
  readonly approvalDenials?: { readonly counts: Readonly<Record<string, number>>; readonly pathCounts: Readonly<Record<string, number>> };
  /** Attempts recorded after the first bound, terminal Host approval denial in
   * this run, including malformed arguments. No path filtering is supported. */
  readonly postDenialAttempts?: { readonly firstDeniedSeq: number | null; readonly counts: Readonly<Record<string, number>> };
}
export interface TrialExecutionResult {
  readonly status: "completed" | "failed" | "cancelled" | "unknown";
  readonly failureKind?: "agent" | "infrastructure";
  /** Trusted executor's independently observed violation; unknown cleanup must not erase it. */
  readonly confirmedFailure?: "COMPLETION_PROTECTED_CHANGED";
  /** Resolving execute alone does not prove process/tool cleanup. */
  readonly cleanup: "verified" | "unconfirmed";
  readonly finalText?: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly journalRefs?: readonly string[];
  readonly metrics?: JsonValue;
  /** Stable code only. Raw exception messages and model content are not persisted. */
  readonly errorCode?: string;
  readonly toolTrace?: ToolTraceEvidence;
}
export type TrialExecutor = (request: TrialExecutionRequest) => Promise<TrialExecutionResult>;
export interface EvaluationReference {
  readonly baselineId?: string;
  readonly model?: string;
  readonly configurationHash?: string;
  readonly executor?: string;
}
export interface EvaluationRunOptions {
  readonly outputDirectory: string;
  readonly mode?: EvaluationMode;
  readonly repetitions?: number;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly cancellationGraceMs?: number;
  readonly signal?: AbortSignal;
  readonly reference?: EvaluationReference;
  readonly k?: readonly number[];
  /** Cap applies to runner-owned JSON artifacts; executors must bound their own journals. */
  readonly maxArtifactBytes?: number;
  /** Trusted Host service. Never passed to the Agent executor. */
  readonly sandboxTests?: SandboxTestService;
}
export interface GraderResult {
  readonly id: string;
  readonly required: boolean;
  readonly weight: number;
  readonly status: "passed" | "failed" | "error";
  readonly score: number | null;
  readonly errorCode: string | null;
  readonly cleanup?: "verified" | "unconfirmed";
  readonly cancelled?: boolean;
  readonly test?: SandboxTestEvidence;
  readonly layer?: OracleLayer;
  readonly sourceIds?: readonly string[];
  readonly observedCount?: number;
  /** Bounds when some matching tools have unavailable path arguments. */
  readonly observedCountRange?: { readonly min: number; readonly max: number };
}
export interface TrialRecord {
  readonly trialId: string;
  readonly taskId: string;
  readonly taskHash: string;
  readonly repetition: number;
  readonly mode: EvaluationMode;
  readonly status: TrialExecutionResult["status"] | "not-started";
  readonly classification: "success" | "task-failure" | "agent-failure" | "infrastructure-failure" | "grader-failure" | "cancelled" | "not-started";
  readonly cleanup: "verified" | "unconfirmed";
  readonly confirmedFailure?: "COMPLETION_PROTECTED_CHANGED";
  readonly passed: boolean | null;
  readonly score: number | null;
  readonly startedAt: string | null;
  readonly durationMs: number | null;
  readonly runId: string | null;
  readonly sessionId: string | null;
  readonly journalRefs: readonly string[];
  readonly metrics: JsonValue | null;
  readonly toolTrace?: ToolTraceEvidence;
  readonly graders: readonly GraderResult[];
  readonly errorCode: string | null;
  readonly retainedWorkspace: string | null;
}
export interface CaseAggregate {
  readonly taskId: string;
  readonly plannedTrials: number;
  readonly eligibleTrials: number;
  readonly passedTrials: number;
  readonly passAt1: number | null;
  readonly empiricalAtLeastOne: boolean | null;
  readonly empiricalAllTrials: boolean | null;
  readonly passAtK: Readonly<Record<string, number | null>>;
  readonly passPowerK: Readonly<Record<string, number | null>>;
}
export interface EvaluationAggregate {
  readonly plannedTrials: number;
  readonly eligibleTrials: number;
  readonly excludedTrials: number;
  readonly eligibleCases: number;
  readonly macroPassAt1: number | null;
  readonly classifications: Readonly<Record<TrialRecord["classification"], number>>;
  readonly cases: readonly CaseAggregate[];
}
export interface EvaluationReport {
  readonly schemaVersion: 1;
  readonly evaluationId: string;
  readonly suite: { readonly id: string; readonly version: string; readonly split: EvaluationSuite["split"]; readonly hash: string };
  readonly mode: EvaluationMode;
  readonly reference: EvaluationReference;
  readonly testManifest?: { readonly path: "test-manifest.json"; readonly hash: string };
  readonly settings: { readonly repetitions: number; readonly concurrency: number; readonly timeoutMs: number; readonly cancellationGraceMs: number };
  readonly taskProtocols?: Readonly<Record<string, TrialProtocol>>;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly status: "completed" | "cancelled" | "needs-reconciliation" | "cleanup-unconfirmed";
  readonly artifactDirectory: string;
  readonly trials: readonly TrialRecord[];
  readonly aggregate: EvaluationAggregate;
}
export interface EvaluationService {
  run(suite: EvaluationSuite, executor: TrialExecutor, options: EvaluationRunOptions): Promise<EvaluationReport>;
  health(): { readonly closed: boolean; readonly unresolvedTrials: readonly string[] };
}
