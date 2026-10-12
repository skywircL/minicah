import { randomUUID } from "node:crypto";
import { Ajv, type ValidateFunction } from "ajv";
import { HarnessError, fail } from "./errors.js";
import { contentHash, immutable } from "./json.js";
import { evidence, type Redactor } from "./audit.js";
import { ToolUsageMeter, Scheduler, positive, waitForCleanup, limitConfiguration } from "./pipeline-control.js";
import { definition, reference } from "./session/json.js";
import type { Definition, SessionService } from "./session/types.js";
import type { ApprovalReply, ApprovalRequest, PermissionService } from "./permissions.js";
import type { ApprovalUi } from "./agent/contracts.js";
import { API_VERSION, type JsonValue, type Plugin, type RunContext, type ToolInfo, type ServiceToken } from "./types.js";
import { services } from "./services.js";

export interface ToolCall { readonly callId: string; readonly name: string; readonly arguments: JsonValue }
export interface ModelResponse { readonly text: string; readonly toolCalls: readonly ToolCall[] }
export interface ToolResult {
  readonly callId: string; readonly parentCallId: string | null;
  readonly status: "completed" | "failed" | "unknown";
  readonly dispatched: boolean | null; readonly code: string | null;
  readonly value: JsonValue;
}
export interface InvokeOptions {
  readonly callId?: string; readonly parentCallId?: string;
  readonly source?: "native" | "ptc"; readonly signal?: AbortSignal;
  readonly approval?: ApprovalReply;
}
export interface PolicyRequest { readonly call: ToolCall; readonly tool: ToolInfo; readonly source: "native" | "ptc"; readonly run: RunContext }
export interface ToolPolicy {
  authorize(request: PolicyRequest, signal: AbortSignal): Promise<{ decision: "allow" | "deny"; reason: string }> | { decision: "allow" | "deny"; reason: string };
  /** Synchronous recheck at the actual dispatch boundary (e.g. current policy version). */
  assertCurrent(request: PolicyRequest): void;
}
export interface PipelineOptions {
  readonly approve?: (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalReply>;
  readonly concurrency?: number; readonly maxQueued?: number;
  readonly deadlineMs?: number; readonly cleanupMs?: number; readonly maxInputBytes?: number; readonly maxOutputBytes?: number;
  readonly cost?: (tool: ToolInfo) => number; readonly policy?: ToolPolicy; readonly redactor?: Redactor; readonly redactionVersion?: string;
}
export interface ToolService {
  list(): readonly ToolInfo[];
  definitions(): readonly Definition[];
  invoke(name: string, input: unknown, options?: InvokeOptions): Promise<ToolResult>;
  invokeMany(calls: readonly ToolCall[], options?: Omit<InvokeOptions, "callId" | "approval">): Promise<readonly ToolResult[]>;
  state(): { readonly usage: ReturnType<ToolUsageMeter["state"]>; readonly scheduler: ReturnType<Scheduler["state"]> };
}

function errorCode(error: unknown): string {
  if (error instanceof HarnessError) return error.code;
  if (error instanceof Error && ["CANCELLED", "QUEUE_FULL", "CLEANUP_UNCONFIRMED"].includes(error.message)) return error.message;
  return "EXECUTION_UNCERTAIN";
}

/** Run-local orchestrator. Native batches and PTC children use this exact instance. */
export class ToolPipeline implements ToolService {
  readonly #usage: ToolUsageMeter; readonly #scheduler: Scheduler;
  readonly #validators = new Map<string, ValidateFunction>(); readonly #definitions: readonly Definition[];
  readonly #seen = new Set<string>();
  readonly #limits: { deadlineMs: number; cleanupMs: number; maxInputBytes: number; maxOutputBytes: number; maxBatch: number };
  constructor(readonly run: RunContext, readonly session: SessionService, readonly options: PipelineOptions = {}, readonly permissions?: PermissionService) {
    this.options = Object.freeze({ ...options });
    if (run.id !== session.runId || run.sessionId !== session.sessionId) fail("RUN_MISMATCH", "Pipeline and journal must belong to the same run");
    this.#usage = new ToolUsageMeter();
    this.#scheduler = new Scheduler(options.concurrency ?? 4, options.maxQueued ?? 32);
    this.#limits = { deadlineMs: options.deadlineMs ?? 30_000, cleanupMs: options.cleanupMs ?? 5_000, maxInputBytes: options.maxInputBytes ?? 64 * 1024, maxOutputBytes: options.maxOutputBytes ?? 64 * 1024, maxBatch: (options.maxQueued ?? 32) + (options.concurrency ?? 4) };
    for (const [key, value] of Object.entries(this.#limits)) positive(value, key);
    const ajv = new Ajv({ strict: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false });
    this.#definitions = Object.freeze(run.tools.list().map(tool => {
      const validate = ajv.compile(tool.inputSchema as object);
      if ("$async" in validate && validate.$async) fail("INVALID_SCHEMA", "Tool parameter schemas must validate synchronously");
      this.#validators.set(tool.name, validate);
      const plugin = run.manifest.plugins.find(plugin => plugin.id === tool.owner)!;
      // Different scoped providers may share a name and generation in the same Session.
      return definition("tool", tool.name, `${plugin.version}+generation.${tool.generation}.owner.${contentHash(tool.owner)}`, { ...tool, sessionId: tool.sessionId ?? null });
    }));
  }
  list(): readonly ToolInfo[] { return this.run.tools.list(); }
  definitions(): readonly Definition[] { return this.#definitions; }
  state() { return Object.freeze({ usage: this.#usage.state(), scheduler: this.#scheduler.state() }); }
  async invokeMany(calls: readonly ToolCall[], options: Omit<InvokeOptions, "callId" | "approval"> = {}): Promise<readonly ToolResult[]> {
    if (calls.length > this.#limits.maxBatch) fail("BATCH_LIMIT", "Native tool batch exceeds the bounded admission queue");
    const copies = immutable(calls);
    if (new Set(copies.map(call => call.callId)).size !== copies.length) fail("DUPLICATE_CALL", "Batch contains duplicate call ids");
    return Object.freeze(await Promise.all(copies.map(call => this.invoke(call.name, call.arguments, { ...options, callId: call.callId }))));
  }
  invoke(name: string, input: unknown, options: InvokeOptions = {}): Promise<ToolResult> {
    return this.run.track(() => this.#invoke(name, input, { ...options }));
  }
  async #invoke(name: string, input: unknown, options: InvokeOptions): Promise<ToolResult> {
    const callId = options.callId ?? randomUUID(), parentCallId = options.parentCallId ?? null;
    if (typeof callId !== "string" || !callId.trim() || callId.length > 256 || this.#seen.has(callId)) fail("DUPLICATE_CALL", "Invalid or reused callId");
    this.#seen.add(callId);
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(abort, this.#limits.deadlineMs);
    const signal = controller.signal;
    let planned = false, started = false, dispatched = false, cost = 1;
    let release: (() => void) | undefined, settle: ((dispatched: boolean) => void) | undefined;
    let work: Promise<unknown> | undefined;
    let inputPath: string | undefined;
    const result = (status: ToolResult["status"], code: string | null, value: JsonValue): ToolResult => immutable({ callId, parentCallId, status, code, value, dispatched });
    const record = (data: Parameters<SessionService["record"]>[0][number]["data"]) => this.session.record([{ callId, ...(parentCallId ? { parentCallId } : {}), data }]);
    try {
      // Admission attempts count even when validation/policy later rejects the child.
      this.#usage.attempt();
      const tool = this.list().find(tool => tool.name === name);
      if (!tool) fail("MISSING_TOOL", "Unknown tool");
      const args = immutable(input) as JsonValue;
      // Retain bounded, redacted path evidence even when schema validation fails.
      if (args && typeof args === "object" && !Array.isArray(args) && "path" in args && typeof args.path === "string" && args.path.length > 0 && args.path.length <= 512 && !args.path.includes("\0")) {
        const pathEvidence = evidence(args.path, 4096, this.options.redactor, this.options.redactionVersion).value;
        if (typeof pathEvidence === "string" && pathEvidence.length > 0 && pathEvidence.length <= 512 && !pathEvidence.includes("\0")) inputPath = pathEvidence;
      }
      if (Buffer.byteLength(JSON.stringify(args)) > this.#limits.maxInputBytes) fail("INPUT_LIMIT", "Tool input too large");
      if (!this.#validators.get(name)!(args)) fail("INVALID_ARGUMENTS", "Tool input does not match its pinned schema");
      const source = options.source ?? "native";
      const effect = tool.effect ?? "non-idempotent-write";
      const ref = reference(this.#definitions.find(def => def.id === name)!);
      const inputEvidence = evidence(args, this.#limits.maxInputBytes, this.options.redactor, this.options.redactionVersion);
      await record({ type: "tool.planned", tool: ref, input: inputEvidence.value, inputHash: contentHash(args), effect }); planned = true;
      if (signal.aborted) fail("CANCELLED", "Dispatch cancelled");
      const request = { call: { callId, name, arguments: args }, tool, source, run: this.run };
      // The program's allow-list is only a filter; the Host independently enforces effect and policy.
      const decision = source === "ptc" && effect !== "read" ? { decision: "deny" as const, reason: "PTC v1 only permits read tools" } :
        await waitForCleanup(Promise.resolve(this.options.policy?.authorize(request, signal) ?? { decision: effect === "read" || !!options.approval || !!this.options.approve ? "allow" as const : "deny" as const, reason: "Host default policy" }), signal, this.#limits.cleanupMs);
      if (!["allow", "deny"].includes(decision.decision)) fail("INVALID_POLICY", "Invalid policy result");
      let approval: ApprovalReply | undefined;
      if (decision.decision === "allow" && effect !== "read") {
        if (!this.permissions || (!options.approval && !this.options.approve)) fail("APPROVAL_REQUIRED", "Writes require a bound Host approval");
        const reply = options.approval ?? await waitForCleanup(this.options.approve!(this.permissions.request(callId, name, args), signal), signal, this.#limits.cleanupMs);
        if (signal.aborted) fail("CANCELLED", "Approval cancelled");
        approval = this.permissions.reply(reply);
      }
      await record({ type: "permission.decided", decision: approval?.decision ?? decision.decision, reason: String(evidence(decision.reason, 512, this.options.redactor).value), ...(approval ? { approval: approval.binding } : {}) });
      if (decision.decision === "deny" || approval?.decision === "deny") fail("POLICY_DENIED", "Tool policy denied this call");
      if (signal.aborted) fail("CANCELLED", "Dispatch cancelled");
      cost = this.options.cost?.(tool) ?? 1;
      settle = this.#usage.reserve(cost);
      release = await this.#scheduler.acquire(signal);
      if (signal.aborted) fail("CANCELLED", "Dispatch cancelled");
      // Intent is durable before any side effect. It does not claim an atomic external transaction.
      await this.session.record([{ callId, data: { type: "tool.started" } }], "fsync"); started = true;
      const execution = { signal, callId, parentCallId };
      const guard = () => {
        if (signal.aborted) fail("CANCELLED", "Dispatch cancelled");
        const check: unknown = this.options.policy?.assertCurrent(request);
        if (check && (typeof check === "object" || typeof check === "function") && "then" in check) {
          void Promise.resolve(check).catch(() => {});
          fail("ASYNC_POLICY_GUARD", "Dispatch policy recheck must be synchronous");
        }
        dispatched = true;
      };
      if (approval) {
        // PermissionService also consumes the one-use grant at its final dispatch boundary.
        work = this.permissions!.invokeApproved(approval.binding.approvalId, callId, name, args, execution, guard);
      } else work = this.run.tools.invoke(name, args, guard, execution);
      const releaseWork = release, settleWork = settle;
      release = undefined; settle = undefined;
      void work.then(() => { releaseWork(); settleWork(dispatched); }, () => { releaseWork(); settleWork(dispatched); });
      const output = immutable(await waitForCleanup(work, signal, this.#limits.cleanupMs)) as JsonValue;
      const bounded = evidence(output, this.#limits.maxOutputBytes, this.options.redactor, this.options.redactionVersion);
      const final = result("completed", bounded.truncated ? "OUTPUT_TRUNCATED" : null, bounded.value);
      await record({ type: "tool.completed", outcome: "success", result: { ...final, evidence: { ...bounded } }, confirmation: "direct" });
      return final;
    } catch (error) {
      const code = errorCode(error);
      // Never catch a failed journal commit and manufacture a successful persistent terminal state.
      if (["COMMIT_UNCERTAIN", "SESSION_CLOSED"].includes(code)) throw error;
      if (started && dispatched) {
        await record({ type: "tool.uncertain", reason: code });
        return result("unknown", code, null);
      }
      if (started) await record({ type: "tool.not-executed", evidence: { code, hostDispatch: false } });
      if (planned) await record({ type: "tool.cancelled", reason: code });
      else await this.session.record([{ data: { type: "pipeline.rejected", rejectedCallId: callId, parentCallId, name: String(evidence(String(name), 256).value), code, ...(inputPath !== undefined ? { inputPath } : {}) } }]);
      return result("failed", code, null);
    } finally {
      this.permissions?.revoke(callId);
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      release?.(); settle?.(dispatched);
    }
  }
}

export function createToolPipelinePlugin(options: PipelineOptions = {}, withPermissions = false, ui?: ServiceToken<ApprovalUi>): Plugin {
  options = Object.freeze({ ...options });
  const id = "tool-pipeline";
  const defaults = { concurrency: options.concurrency ?? 4, maxQueued: options.maxQueued ?? 32, deadlineMs: options.deadlineMs ?? 30_000, cleanupMs: options.cleanupMs ?? 5_000, maxInputBytes: options.maxInputBytes ?? 64 * 1024, maxOutputBytes: options.maxOutputBytes ?? 64 * 1024 };
  return { id, version: "2.0.0", apiVersion: API_VERSION, scope: "session", configMode: "run", validateConfig: input => limitConfiguration(input, defaults), provides: [services.tool], requires: [services.session, ...(withPermissions ? [services.permission] : []), ...(ui ? [ui] : [])],
    setup(ctx) { ctx.provide(services.tool, run => new ToolPipeline(run, run.services.get(services.session), { ...options, ...run.configuration.values[ctx.owner] as Readonly<Record<string, number>>, ...(ui ? { approve: (request: ApprovalRequest, signal: AbortSignal) => run.services.get(ui).approve(request, signal) } : {}) }, withPermissions ? run.services.get(services.permission) : undefined)); },
  };
}
