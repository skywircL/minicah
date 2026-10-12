import type { JsonValue, ToolInfo } from "../types.js";
import type { Definition } from "../session/types.js";
import type { ApprovalReply, ApprovalRequest } from "../permissions.js";
import { serviceToken } from "../types.js";

export interface Message {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly ProviderCall[];
  /** Opaque provider continuation field; never render it as assistant output. */
  readonly reasoning_content?: string;
  /** Versioned opaque provider replay state; never render as assistant output. */
  readonly providerReplay?: JsonValue;
}
export interface ProviderCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}
export interface ModelCompletion {
  readonly message: Message;
  readonly finishReason: string;
  readonly usage: { readonly prompt: number; readonly completion: number; readonly total: number } | null;
  readonly providerId: string;
}
export interface ModelService {
  definition(): Definition;
  /** Required by the coding context policy; older standalone model plugins may omit it. */
  limits?(): { readonly contextWindow: number; readonly maxOutputTokens: number };
  prepare(messages: readonly Message[], tools: readonly ToolInfo[], maxOutputTokens?: number): JsonValue;
  complete(request: JsonValue, options?: { signal?: AbortSignal; onText?: (text: string) => void }): Promise<ModelCompletion>;
}
export interface AgentResult {
  readonly status: "completed" | "failed" | "cancelled" | "budget-exited" | "needs-reconciliation";
  readonly text: string;
  readonly runId: string;
  readonly steps: number;
  readonly tokens: number;
}
/** Public task conditions supplied by a trusted caller, never inferred from hidden graders. */
export interface CompletionContract {
  readonly jsonTargets?: readonly { readonly path: string; readonly pointer: string; readonly value: JsonValue }[];
  readonly preservePaths?: readonly string[];
  /** Keep all JSON fields outside the declared target pointers unchanged. */
  readonly preserveJsonOtherFields?: boolean;
  /** Only these paths may change among Workspace.files() visible regular files. */
  readonly allowedChanges?: readonly string[];
  /** Require an actual successful, complete read_file snapshot in this run. Optional for valid no-op tasks. */
  readonly readPaths?: readonly string[];
  readonly responseSchema?: JsonValue;
  readonly responseStatus?: { readonly pointer: string; readonly completed?: JsonValue; readonly denied?: JsonValue };
  readonly expectedDenial?: { readonly tool: string; readonly path?: string; readonly kind?: "approval" | "policy" };
  readonly maxContinuations?: 0 | 1;
}
export interface AgentRunOptions { readonly completion?: CompletionContract }
export interface AgentLoopService { run(input: string, signal?: AbortSignal, options?: AgentRunOptions): Promise<AgentResult> }
export interface ApprovalUi { approve(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalReply> }
export const approvalUi = serviceToken<ApprovalUi>("ApprovalUiService");
