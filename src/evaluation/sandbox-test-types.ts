import type { JsonValue } from "../types.js";
import type { AuditEvidence } from "../audit.js";

export interface SandboxTestCase {
  readonly id: string;
  readonly args: readonly JsonValue[];
  readonly expected?: JsonValue;
  readonly throws?: string;
}
export interface SandboxTestDefinition {
  readonly id: string;
  readonly module: string;
  readonly export: string;
  readonly cases: readonly SandboxTestCase[];
}
/** Explicit Host input, separate from model-visible task material. No command/source fields. */
export interface SandboxTestPack {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly tests: readonly SandboxTestDefinition[];
}
export interface SandboxCaseEvidence {
  readonly id: string;
  readonly status: "passed" | "failed" | "error";
  readonly code: string | null;
  readonly durationMs: number;
  readonly executionId: string | null;
  readonly exitCode: number | null;
  readonly reason: string | null;
  readonly cleanup: "verified" | "unconfirmed";
  readonly diagnostics?: AuditEvidence;
}
export interface SandboxTestEvidence {
  readonly testId: string;
  readonly definitionHash: string;
  readonly runnerVersion: string;
  readonly backend: JsonValue;
  readonly durationMs: number;
  readonly cases: readonly SandboxCaseEvidence[];
  readonly retainedPaths: readonly string[];
}
export interface SandboxTestGrade {
  readonly status: "passed" | "failed" | "error";
  readonly score: number | null;
  readonly errorCode: string | null;
  readonly cleanup: "verified" | "unconfirmed";
  readonly cancelled: boolean;
  readonly evidence: SandboxTestEvidence;
}
export interface SandboxTestService {
  /** Validates all references before Agent dispatch; returns retained exact definitions and policy. */
  manifest(testIds: readonly string[]): JsonValue;
  grade(testId: string, workspace: string, signal: AbortSignal): Promise<SandboxTestGrade>;
}
