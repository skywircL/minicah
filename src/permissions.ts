import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fail } from "./errors.js";
import { canonical, contentHash, immutable } from "./json.js";
import { API_VERSION, type ConfigurationVersion, type JsonValue, type Plugin, type ToolInfo, type ToolExecution } from "./types.js";
import { services } from "./services.js";

export interface ToolIdentity { readonly name: string; readonly owner: string; readonly generation: number; readonly schemaHash: string }
export interface ApprovalInvocation {
  readonly sessionId: string;
  readonly runId: string;
  readonly callId: string;
  readonly arguments: JsonValue;
  readonly workspace: string;
  readonly policyVersion: string;
  readonly tool: ToolIdentity;
}
export interface ApprovalBinding extends Omit<ApprovalInvocation, "arguments"> {
  readonly approvalId: string;
  readonly argumentsHash: string;
  readonly expiresAt: number;
}
export interface ApprovalRequest { readonly binding: ApprovalBinding; readonly arguments: JsonValue }
export interface ApprovalReply { readonly binding: ApprovalBinding; readonly decision: "allow" | "deny" }
export interface PermissionService {
  request(callId: string, tool: string, args: JsonValue): ApprovalRequest;
  reply(reply: ApprovalReply): ApprovalReply;
  revoke(callId: string): void;
  invokeApproved(approvalId: string, callId: string, tool: string, args: JsonValue, execution?: ToolExecution, beforeExecute?: () => void): Promise<unknown>;
}
interface Entry { binding: ApprovalBinding; state: "pending" | "allow" | "deny" | "consumed" | "revoked" }
function callKey(value: Pick<ApprovalInvocation, "sessionId" | "runId" | "callId">): string { return canonical([value.sessionId, value.runId, value.callId]); }
function invocationFields(input: ApprovalInvocation) {
  for (const value of [input.sessionId, input.runId, input.callId, input.workspace, input.policyVersion, input.tool?.name, input.tool?.owner]) {
    if (typeof value !== "string" || !value.trim()) fail("INVALID_APPROVAL", "Approval must bind session, run, call, workspace, policy, and tool identity");
  }
  if (!Number.isSafeInteger(input.tool.generation) || input.tool.generation < 1 || !/^[a-f0-9]{64}$/.test(input.tool.schemaHash)) fail("INVALID_APPROVAL", "Invalid tool generation/schema hash");
  return immutable({ sessionId: input.sessionId, runId: input.runId, callId: input.callId, workspace: resolve(input.workspace), policyVersion: input.policyVersion, tool: input.tool, argumentsHash: contentHash(input.arguments) });
}

/** Ephemeral, one-use approvals; replayed permission records do not recreate grants. */
export class ApprovalAuthority {
  #entries = new Map<string, Entry>();
  #current = new Map<string, string>();
  #policyVersion: string;
  #closed = false;
  constructor(policyVersion: string, readonly now: () => number = Date.now) { this.#policyVersion = policyVersion; }

  setPolicyVersion(version: string): void {
    if (typeof version !== "string" || !version.trim()) fail("INVALID_APPROVAL", "Policy version must be nonempty");
    if (version === this.#policyVersion) return;
    this.#policyVersion = version;
    for (const entry of this.#entries.values()) if (entry.state !== "consumed") entry.state = "revoked";
  }
  request(invocation: ApprovalInvocation, ttlMs: number): ApprovalRequest {
    if (this.#closed) fail("APPROVAL_REVOKED", "Approval authority is closed");
    const fields = invocationFields(invocation);
    if (fields.policyVersion !== this.#policyVersion) fail("STALE_POLICY", "Run policy is no longer current");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(this.now() + ttlMs)) fail("INVALID_APPROVAL", "Invalid approval expiry");
    this.revoke(invocation);
    const binding = immutable({ ...fields, approvalId: randomUUID(), expiresAt: this.now() + ttlMs });
    this.#entries.set(binding.approvalId, { binding, state: "pending" });
    this.#current.set(callKey(binding), binding.approvalId);
    return immutable({ binding, arguments: invocation.arguments });
  }
  reply(reply: ApprovalReply): ApprovalReply {
    if (!reply?.binding || !["allow", "deny"].includes(reply.decision)) fail("INVALID_APPROVAL", "Reply must include the complete binding and decision");
    const entry = this.#get(reply.binding.approvalId);
    if (entry.state !== "pending") fail("APPROVAL_REPLAY", "Approval reply already settled or revoked");
    if (canonical(entry.binding) !== canonical(reply.binding)) fail("APPROVAL_MISMATCH", "Reply does not match the issued approval binding");
    entry.state = reply.decision;
    return immutable(reply);
  }
  consume(approvalId: string, invocation: ApprovalInvocation): ApprovalBinding {
    const entry = this.#get(approvalId);
    const { approvalId: _id, expiresAt: _expiry, ...issued } = entry.binding;
    if (canonical(issued) !== canonical(invocationFields(invocation))) {
      entry.state = "revoked";
      fail("APPROVAL_MISMATCH", "Call arguments, workspace, policy, or tool generation changed");
    }
    if (entry.state !== "allow") fail("APPROVAL_REQUIRED", "An unconsumed allow reply is required");
    entry.state = "consumed";
    return entry.binding;
  }
  revoke(call: Pick<ApprovalInvocation, "sessionId" | "runId" | "callId">): void {
    const id = this.#current.get(callKey(call));
    const entry = id ? this.#entries.get(id) : undefined;
    if (entry && entry.state !== "consumed") entry.state = "revoked";
    this.#current.delete(callKey(call));
  }
  close(): void { this.#closed = true; this.#entries.clear(); this.#current.clear(); }
  #get(id: string): Entry {
    const entry = this.#entries.get(id);
    if (this.#closed || !entry || entry.state === "revoked" || this.#current.get(callKey(entry.binding)) !== id) fail("APPROVAL_REVOKED", "Approval is unknown or no longer current");
    if (entry.binding.policyVersion !== this.#policyVersion || this.now() >= entry.binding.expiresAt) {
      entry.state = "revoked"; fail("APPROVAL_EXPIRED", "Approval expired or its policy changed");
    }
    return entry;
  }
}

type PolicyConfig = { readonly workspace: string; readonly policyVersion: string; readonly ttlMs: number };
function policyConfig(input: JsonValue | undefined): PolicyConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("INVALID_CONFIG", "Permissions require workspace, policyVersion, and ttlMs");
  const value = input as Record<string, JsonValue>;
  if (Object.keys(value).some(key => !["workspace", "policyVersion", "ttlMs"].includes(key))) fail("INVALID_CONFIG", "Unknown permission policy field");
  if (typeof value.workspace !== "string" || !value.workspace.trim() || typeof value.policyVersion !== "string" || !value.policyVersion.trim() || typeof value.ttlMs !== "number" || !Number.isSafeInteger(value.ttlMs) || value.ttlMs < 1) fail("INVALID_CONFIG", "Invalid permission policy schema");
  return immutable({ workspace: resolve(value.workspace), policyVersion: value.policyVersion, ttlMs: value.ttlMs });
}
function policyVersion(configuration: ConfigurationVersion, id: string): string {
  const value = policyConfig(configuration.values[id]);
  // A unique configuration revision prevents approvals surviving an ABA change.
  return `${value.policyVersion}:${configuration.id}`;
}
function identity(tool: ToolInfo): ToolIdentity {
  return immutable({ name: tool.name, owner: tool.owner, generation: tool.generation, schemaHash: contentHash(tool.inputSchema) });
}

export function createPermissionPlugin(): Plugin {
  const id = "permissions";
  return {
    id, version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", configMode: "run", validateConfig: policyConfig,
    provides: [services.permission], requires: [],
    setup(ctx) {
      const authority = ctx.resource("approval-authority", () => new ApprovalAuthority("initializing"), authority => authority.close());
      ctx.onConfigChange(configuration => {
        if (!configuration.values[ctx.owner]) { authority.get().close(); return; }
        authority.get().setPolicyVersion(policyVersion(configuration, ctx.owner));
      });
      ctx.provide(services.permission, run => {
        const config = policyConfig(run.configuration.values[ctx.owner]);
        const version = policyVersion(run.configuration, ctx.owner);
        const invocation = (callId: string, name: string, args: JsonValue): ApprovalInvocation => {
          const tool = run.tools.list().find(tool => tool.name === name);
          if (!tool) fail("MISSING_TOOL", `Unknown tool: ${name}`);
          return { sessionId: run.sessionId, runId: run.id, callId, arguments: immutable(args), workspace: config.workspace, policyVersion: version, tool: identity(tool) };
        };
        return Object.freeze({
          request: (callId: string, name: string, args: JsonValue) => authority.get().request(invocation(callId, name, args), config.ttlMs),
          reply: (reply: ApprovalReply) => {
            if (reply?.binding?.runId !== run.id || reply.binding.sessionId !== run.sessionId) fail("APPROVAL_MISMATCH", "Reply belongs to another run/session");
            return authority.get().reply(reply);
          },
          revoke: (callId: string) => authority.get().revoke({ sessionId: run.sessionId, runId: run.id, callId }),
          invokeApproved: async (approvalId: string, callId: string, name: string, args: JsonValue, execution?: ToolExecution, beforeExecute?: () => void) => {
            const current = invocation(callId, name, args);
            return run.tools.invoke(name, current.arguments, () => { authority.get().consume(approvalId, current); beforeExecute?.(); }, execution);
          },
        });
      });
    },
  };
}
