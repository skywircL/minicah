import type { JsonValue } from "../types.js";

/** Trusted Host request. Model programs cannot select OS policies, Docker flags or Host paths. */
export interface SandboxProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  /** Logical sandbox cwd: /tmp, or /workspace and a child with a snapshot. Native maps it to its private copy. */
  readonly cwd?: string;
  readonly workspace?: "none" | "snapshot";
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxInputBytes?: number;
}
export interface SandboxProcessControl {
  write(data: string): void;
  endInput(): void;
  terminate(): void;
}
export interface SandboxProcessIO {
  /** Called after attach. Omitting this callback closes stdin immediately. */
  started?(process: SandboxProcessControl): void;
  stdout?(chunk: Buffer): void;
  stderr?(chunk: Buffer): void;
  /** Cancellation/limits close Host admission immediately, before asynchronous cleanup. */
  stopped?(reason: SandboxProcessResult["reason"]): void;
}
export interface SandboxProcessResult {
  readonly id: string;
  readonly exitCode: number | null;
  readonly reason: "exit" | "cancelled" | "timeout" | "output-limit" | "input-limit" | "spawn-failed" | "io-failed";
  readonly cleanup: "verified" | "unconfirmed";
  readonly code: string | null;
  readonly profile: JsonValue;
}
export interface SandboxCommandResult extends SandboxProcessResult { readonly stdout: string; readonly stderr: string }
export interface SandboxHealth {
  readonly active: readonly string[]; readonly unresolved: readonly string[]; readonly closed: boolean;
  /** Recovery coordinates for unresolved local processes and their retained private files. */
  readonly details?: readonly { readonly id: string; readonly pid: number | null; readonly retainedPaths: readonly string[] }[];
}
export interface SandboxService {
  readonly profile: JsonValue;
  run(request: SandboxProcessRequest, io?: SandboxProcessIO): Promise<SandboxProcessResult>;
  execute(request: SandboxProcessRequest): Promise<SandboxCommandResult>;
  health(): SandboxHealth;
}
