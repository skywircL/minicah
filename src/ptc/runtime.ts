import { randomUUID } from "node:crypto";
import { API_VERSION, type JsonValue, type Plugin } from "../types.js";
import { immutable } from "../json.js";
import { fail } from "../errors.js";
import { evidence, type Redactor } from "../audit.js";
import { positive, waitForCleanup, limitConfiguration } from "../pipeline-control.js";
import { services } from "../services.js";
import type { SessionService } from "../session/types.js";
import type { ToolResult, ToolService } from "../tool-pipeline.js";
import type { IsolationBackend, PtcRequest, PtcResult, PtcRuntimeService, SandboxResult } from "./types.js";
import { SandboxPtcBackend } from "./docker.js";

export interface PtcOptions {
  readonly deadlineMs?: number; readonly cleanupMs?: number; readonly maxProgramBytes?: number;
  readonly maxInputBytes?: number; readonly maxOutputBytes?: number; readonly concurrency?: number;
  readonly redactor?: Redactor; readonly redactionVersion?: string;
}
function limits(options: PtcOptions) {
  return { deadlineMs: options.deadlineMs ?? 30_000, cleanupMs: options.cleanupMs ?? 10_000, maxProgramBytes: options.maxProgramBytes ?? 64 * 1024, maxInputBytes: options.maxInputBytes ?? 64 * 1024, maxOutputBytes: options.maxOutputBytes ?? 64 * 1024, concurrency: options.concurrency ?? 4 };
}

export class PtcRuntime implements PtcRuntimeService {
  #active = false; #unsafe = false;
  readonly #limits;
  constructor(readonly backend: IsolationBackend, readonly tools: ToolService, readonly session: SessionService, readonly options: PtcOptions = {}) {
    this.options = Object.freeze({ ...options });
    this.#limits = limits(options);
    for (const [key, value] of Object.entries(this.#limits)) positive(value, key);
  }
  async evaluate(request: PtcRequest, signal?: AbortSignal): Promise<PtcResult> {
    if (this.#active || this.#unsafe) fail("PTC_UNAVAILABLE", "PTC is busy or previous cleanup is unconfirmed");
    const copy = immutable(request);
    if (typeof copy.program !== "string" || Buffer.byteLength(copy.program) > this.#limits.maxProgramBytes || Buffer.byteLength(JSON.stringify(copy.input)) > this.#limits.maxInputBytes) fail("INPUT_LIMIT", "Invalid or oversized PTC request");
    if (!Array.isArray(copy.bindings) || Buffer.byteLength(JSON.stringify(copy.bindings)) > this.#limits.maxInputBytes || new Set(copy.bindings).size !== copy.bindings.length || copy.bindings.some(name => typeof name !== "string" || !this.tools.list().some(tool => tool.name === name && tool.effect === "read"))) fail("PTC_BINDING", "PTC requires a unique allow-list of explicitly read-only tools");
    const callId = copy.callId ?? randomUUID();
    if (typeof callId !== "string" || !callId.trim() || callId.length > 256) fail("INVALID_CALL", "Invalid PTC call id");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    const timer = setTimeout(abort, this.#limits.deadlineMs);
    const pending = new Map<Promise<ToolResult>, string>(), children: ToolResult[] = [];
    let accepting = true, loggingFailure: unknown;
    this.#active = true;
    const audit = (value: JsonValue) => evidence(value, this.#limits.maxOutputBytes, this.options.redactor, this.options.redactionVersion);
    try {
      await this.session.record([{ callId, ...(copy.parentCallId ? { parentCallId: copy.parentCallId } : {}), data: { type: "ptc.started", program: { ...audit(copy.program) }, input: { ...audit(copy.input) }, bindings: copy.bindings, backend: this.backend.id, isolation: this.backend.profile, limits: this.#limits } }], "fsync");
      let sandbox: SandboxResult;
      try {
        if (controller.signal.aborted) sandbox = { status: "failed", value: null, code: "CANCELLED", cleanup: "verified" };
        else sandbox = await waitForCleanup(this.backend.run({ program: copy.program, input: copy.input, bindings: copy.bindings, maxOutputBytes: this.#limits.maxOutputBytes, concurrency: this.#limits.concurrency }, {
          signal: controller.signal,
          cancel: abort,
          call: async (name, input) => {
            if (!accepting || controller.signal.aborted) fail("CANCELLED", "PTC dispatch closed");
            // An adversarial adapter/program cannot choose child ids, parent links, source, or approvals.
            if (pending.size >= this.#limits.concurrency) { abort(); fail("PTC_LIMIT", "PTC concurrency limit exceeded"); }
            if (!copy.bindings.includes(name)) { abort(); fail("PTC_BINDING", "Tool is not bound to this program"); }
            const childId = randomUUID();
            const task = this.tools.invoke(name, input, { callId: childId, parentCallId: callId, source: "ptc", signal: controller.signal });
            pending.set(task, childId);
            try { const result = await task; children.push(result); return result; }
            catch (error) { loggingFailure = error; abort(); throw error; }
            finally { pending.delete(task); }
          },
        }), controller.signal, this.#limits.cleanupMs);
        sandbox = immutable(sandbox);
        if (!["completed", "failed", "unknown"].includes(sandbox.status) || !["verified", "unconfirmed"].includes(sandbox.cleanup)) fail("INVALID_BACKEND", "Invalid backend result");
      } catch {
        sandbox = { status: "unknown", value: null, code: "SANDBOX_UNCONFIRMED", cleanup: "unconfirmed" };
      }
      accepting = false;
      // Program completion closes admission too. Its unawaited children are cancelled and settled.
      if (pending.size || sandbox.status !== "completed") abort();
      try { await waitForCleanup(Promise.allSettled([...pending.keys()]), controller.signal, this.#limits.cleanupMs); }
      catch { sandbox = { ...sandbox, status: "unknown", code: "CHILD_CLEANUP_UNCONFIRMED", cleanup: "unconfirmed" }; }
      if (loggingFailure) throw loggingFailure;
      const unknown = sandbox.cleanup === "unconfirmed" || sandbox.status === "unknown" || children.some(child => child.status === "unknown") || pending.size > 0;
      this.#unsafe ||= sandbox.cleanup === "unconfirmed" || pending.size > 0 || children.some(child => child.code === "CLEANUP_UNCONFIRMED");
      // Include every accepted child even if its Host pipeline has not yet returned.
      const details = [...children, ...[...pending.values()].map(childId => ({ callId: childId, parentCallId: callId, status: "unknown" as const, dispatched: null, code: "CHILD_CLEANUP_UNCONFIRMED", value: null }))];
      const failed = sandbox.status === "failed" || controller.signal.aborted || children.some(child => child.status === "failed");
      const result: PtcResult = immutable({ callId, status: unknown ? "unknown" : failed ? "failed" : "completed", code: sandbox.code ?? (controller.signal.aborted ? "CANCELLED" : unknown ? "CHILD_UNKNOWN" : failed ? "CHILD_FAILED" : null), cleanup: this.#unsafe ? "unconfirmed" : "verified", output: audit(sandbox.value), children: details, ...(sandbox.execution ? { execution: sandbox.execution } : {}) });
      await this.session.record([{ callId, data: { type: unknown ? "ptc.uncertain" : "ptc.completed", result: result as unknown as JsonValue } }]);
      return result;
    } finally {
      accepting = false; abort(); clearTimeout(timer); signal?.removeEventListener("abort", abort); this.#active = false;
    }
  }
}

/** Model-only projection. It never edits audit events or claims truncated evidence is complete. */
export function projectPtcOutput(result: PtcResult, maxBytes = 2_048): JsonValue {
  return immutable({ callId: result.callId, status: result.status, code: result.code, cleanup: result.cleanup, auditTruncated: result.output.truncated, redactionVersion: result.output.redactionVersion, output: { ...evidence(result.output.value, maxBytes) }, children: result.children.map(child => ({ callId: child.callId, status: child.status, code: child.code })) });
}
export function createPtcPlugin(backend?: () => IsolationBackend, options: PtcOptions = {}): Plugin {
  options = Object.freeze({ ...options });
  return { id: "ptc", version: "2.1.0", apiVersion: API_VERSION, scope: "session", configMode: "run", validateConfig: input => limitConfiguration(input, limits(options)), provides: [services.ptcRuntime], requires: [services.tool, services.session, ...(backend ? [] : [services.sandbox])],
    setup(ctx) {
      const managed = backend ? ctx.resource("ptc-backend", backend, value => value.close()) : undefined;
      ctx.provide(services.ptcRuntime, run => {
        const adapter = managed?.get() ?? new SandboxPtcBackend(run.services.get(services.sandbox));
        const runtime = new PtcRuntime(adapter, run.services.get(services.tool), run.services.get(services.session), { ...options, ...run.configuration.values[ctx.owner] as Readonly<Record<string, number>> });
        return { evaluate: (request, signal) => run.track(() => runtime.evaluate(request, signal)) };
      });
    },
  };
}
