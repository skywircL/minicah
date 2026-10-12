/** Capability contracts only. The kernel does not implement or require them. */
import { serviceToken, type JsonValue } from "./types.js";
import type { SessionService, ContextService } from "./session/types.js";
import type { ToolService } from "./tool-pipeline.js";
import type { AgentLoopService, ModelService } from "./agent/contracts.js";
export type { AgentLoopService, ModelService, Message } from "./agent/contracts.js";
import type { PtcRuntimeService } from "./ptc/types.js";
import type { SandboxService } from "./sandbox/types.js";
export type { SandboxService } from "./sandbox/types.js";
export type { ToolService, ModelResponse } from "./tool-pipeline.js";
export type { PtcRuntimeService } from "./ptc/types.js";
import type { PermissionService } from "./permissions.js";
export type { PermissionService } from "./permissions.js";
export type { SessionService, ContextService } from "./session/types.js";

export interface ExecutionService {
  execute(request: { readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly signal?: AbortSignal }):
    Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string; readonly reason: "exit" | "cancelled" | "timeout" | "output-limit" | "spawn-failed";
      readonly sandbox?: { readonly id: string; readonly cleanup: "verified" | "unconfirmed"; readonly code: string | null; readonly profile: JsonValue } }>;
}

export const services = Object.freeze({
  model: serviceToken<ModelService>("ModelService", 3),
  tool: serviceToken<ToolService>("ToolService", 3),
  session: serviceToken<SessionService>("SessionService", 4),
  context: serviceToken<ContextService>("ContextService", 4),
  permission: serviceToken<PermissionService>("PermissionService", 3),
  sandbox: serviceToken<SandboxService>("SandboxService", 1),
  execution: serviceToken<ExecutionService>("ExecutionService", 2),
  ptcRuntime: serviceToken<PtcRuntimeService>("PtcRuntimeService", 2),
  agentLoop: serviceToken<AgentLoopService>("AgentLoopService", 2),
});
