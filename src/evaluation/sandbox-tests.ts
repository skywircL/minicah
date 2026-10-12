import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { evidence } from "../audit.js";
import { deadline } from "../deadline.js";
import { fail, HarnessError } from "../errors.js";
import { canonical, contentHash, immutable } from "../json.js";
import type { RegistryEntry } from "../registry.js";
import { DockerProcessSandbox } from "../sandbox/docker.js";
import { SeatbeltProcessSandbox } from "../sandbox/seatbelt.js";
import type { SandboxProcessResult, SandboxService } from "../sandbox/types.js";
import { API_VERSION, serviceToken, type JsonValue, type Plugin } from "../types.js";
import { SANDBOX_TEST_BOOTSTRAP, SANDBOX_TEST_PROTOCOL_PREFIX, SANDBOX_TEST_RUNNER_VERSION } from "./sandbox-test-bootstrap.js";
import { sandboxTestRegistry, type SandboxTestRegistration } from "./test-pack.js";
import type { SandboxCaseEvidence, SandboxTestCase, SandboxTestGrade, SandboxTestService } from "./sandbox-test-types.js";

export { createSandboxTestPackPlugin, readSandboxTestPack, validateSandboxTestPack, sandboxTestRegistry } from "./test-pack.js";
export type { SandboxTestCase, SandboxTestDefinition, SandboxTestPack, SandboxTestGrade, SandboxTestEvidence, SandboxTestService } from "./sandbox-test-types.js";
export const sandboxTestService = serviceToken<SandboxTestService>("SandboxTestService", 1);

export interface ManagedTestSandbox extends SandboxService { close(): Promise<void> }
export interface SandboxTestOptions {
  readonly backend: "native" | "docker";
  readonly image?: string;
  readonly timeoutMs?: number;
  readonly caseTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly cleanupMs?: number;
  /** Trusted transport seam for lifecycle tests, never selected by datasets or models. */
  readonly factory?: (workspace: string) => ManagedTestSandbox;
}
interface Limits { readonly timeoutMs: number; readonly caseTimeoutMs: number; readonly maxOutputBytes: number; readonly cleanupMs: number }
type Entry = RegistryEntry<SandboxTestRegistration>;
type Outcome = { readonly kind: "return"; readonly value: JsonValue } | { readonly kind: "throw"; readonly name: string }
  | { readonly kind: "import-error" | "missing-export" | "invalid-return" | "runner-error" };
const INPUT_BYTES = 2 * 1024 * 1024, WORKSPACE_BYTES = 8 * 1024 * 1024, WORKSPACE_FILES = 1000;

function limits(options: SandboxTestOptions): Limits {
  const bounded = (value: number | undefined, fallback: number, ceiling: number, name: string): number => {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > ceiling) fail("EVAL_TEST_OPTIONS", `Invalid ${name}`);
    return resolved;
  };
  if (options.backend !== "native" && options.backend !== "docker") fail("EVAL_TEST_OPTIONS", "Sandbox tests require a native or docker backend");
  if (options.backend === "docker" && !/^[a-zA-Z0-9][a-zA-Z0-9._/:-]*@sha256:[a-f0-9]{64}$/.test(options.image ?? "")) {
    fail("INVALID_IMAGE", "Sandbox tests require a provisioned digest-pinned Docker image");
  }
  if (options.backend === "native" && options.image !== undefined) fail("EVAL_TEST_OPTIONS", "Native sandbox tests do not accept a Docker image");
  return Object.freeze({ timeoutMs: bounded(options.timeoutMs, 30_000, 300_000, "test timeout"),
    caseTimeoutMs: bounded(options.caseTimeoutMs, 5000, 60_000, "case timeout"),
    maxOutputBytes: bounded(options.maxOutputBytes, 16 * 1024, 256 * 1024, "output limit"),
    cleanupMs: bounded(options.cleanupMs, 2500, 30_000, "cleanup deadline") });
}

function policy(options: SandboxTestOptions, configured: Limits): JsonValue {
  return immutable({ runnerVersion: SANDBOX_TEST_RUNNER_VERSION, runnerHash: contentHash(SANDBOX_TEST_BOOTSTRAP),
    backend: options.backend, image: options.image ?? null, nodeVersion: options.backend === "native" ? process.version : "pinned-image",
    ...configured, maxInputBytes: INPUT_BYTES, maxWorkspaceBytes: WORKSPACE_BYTES, maxWorkspaceFiles: WORKSPACE_FILES,
    invocation: "fixed-node-export-json", perCase: "fresh-process-and-workspace-snapshot", network: "none", hostWrites: false,
    expectedValues: "host-only", ...(options.factory ? { transport: "trusted-test-factory" } : {}) });
}

/** Ordinary stdout may contain diagnostics; only exactly one correctly ordered protocol pair is evidence. */
function validOutput(value: unknown): value is JsonValue {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > 10_000 || item.depth > 64) return false;
    const current = item.value;
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number") { if (!Number.isFinite(current)) return false; continue; }
    if (!current || typeof current !== "object") return false;
    for (const child of Object.values(current)) pending.push({ value: child, depth: item.depth + 1 });
  }
  return true;
}

function decode(stdout: string, nonce: string, caseId: string): { ready: boolean; outcome: Outcome | null; valid: boolean } {
  let ready = false, outcome: Outcome | null = null, valid = true;
  const lines = stdout.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.startsWith(SANDBOX_TEST_PROTOCOL_PREFIX)) continue;
    if (index === lines.length - 1) { valid = false; continue; }
    let value: unknown;
    try { value = JSON.parse(line.slice(SANDBOX_TEST_PROTOCOL_PREFIX.length)); } catch { valid = false; continue; }
    if (!value || typeof value !== "object" || Array.isArray(value)) { valid = false; continue; }
    const record = value as Record<string, unknown>;
    if (record.nonce !== nonce || record.caseId !== caseId) { valid = false; continue; }
    const only = (...expected: string[]): boolean => Object.keys(record).every(key => ["nonce", "caseId", "type", ...expected].includes(key));
    if (record.type === "ready") {
      if (ready || outcome || !only()) valid = false;
      ready = true;
    } else if (record.type === "result") {
      if (!ready || outcome) { valid = false; continue; }
      if (record.kind === "return" && Object.hasOwn(record, "value") && only("kind", "value") && validOutput(record.value)) outcome = { kind: "return", value: record.value };
      else if (record.kind === "throw" && typeof record.name === "string" && record.name.length <= 128 && only("kind", "name")) outcome = { kind: "throw", name: record.name };
      else if (["import-error", "missing-export", "invalid-return", "runner-error"].includes(record.kind as string) && only("kind")) outcome = { kind: record.kind as "import-error" | "missing-export" | "invalid-return" | "runner-error" };
      else valid = false;
    } else valid = false;
  }
  return { ready, outcome, valid };
}

function outcomeCode(outcome: Outcome, testCase: SandboxTestCase): string | null {
  if (outcome.kind === "return") return Object.hasOwn(testCase, "expected") && canonical(outcome.value) === canonical(testCase.expected) ? null : "EVAL_TEST_RETURN_MISMATCH";
  if (outcome.kind === "throw") return testCase.throws !== undefined && outcome.name === testCase.throws ? null : "EVAL_TEST_THROW_MISMATCH";
  return { "import-error": "EVAL_TEST_IMPORT_FAILED", "missing-export": "EVAL_TEST_EXPORT_MISSING", "invalid-return": "EVAL_TEST_NON_JSON_RETURN", "runner-error": "EVAL_TEST_PROTOCOL" }[outcome.kind];
}

class SandboxTestManager {
  readonly #resources = new Set<ManagedTestSandbox>();
  readonly #active = new Map<AbortController, Promise<SandboxTestGrade>>();
  #closed = false;
  #unsafe = false;
  constructor(readonly options: SandboxTestOptions, readonly configured: Limits, readonly declaredPolicy: JsonValue) {}

  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#active.keys()) controller.abort();
    await Promise.allSettled(this.#active.values());
    for (const sandbox of this.#resources) {
      try {
        await deadline(sandbox.close(), this.configured.cleanupMs, "CLEANUP_UNCONFIRMED", "Sandbox grader cleanup remains unconfirmed");
        const health = sandbox.health();
        if (!health.active.length && !health.unresolved.length) this.#resources.delete(sandbox);
      } catch { /* Keep the owner registered and report the unresolved resource below. */ }
    }
    if (this.#resources.size || this.#unsafe) fail("RESTART_REQUIRED", "Sandbox grader process cleanup remains unconfirmed");
  }

  grade(entry: Entry, workspace: string, externalSignal: AbortSignal): Promise<SandboxTestGrade> {
    const controller = new AbortController(), cancel = () => controller.abort();
    externalSignal.addEventListener("abort", cancel, { once: true });
    if (externalSignal.aborted || this.#closed) controller.abort();
    const operation = this.#grade(entry, workspace, controller, externalSignal).finally(() => {
      externalSignal.removeEventListener("abort", cancel); this.#active.delete(controller);
    });
    this.#active.set(controller, operation);
    return operation;
  }

  #make(workspace: string): ManagedTestSandbox {
    if (this.options.factory) return this.options.factory(workspace);
    const shared = { workspace, timeoutMs: this.configured.caseTimeoutMs, maxOutputBytes: this.configured.maxOutputBytes,
      maxInputBytes: INPUT_BYTES, maxWorkspaceBytes: WORKSPACE_BYTES, maxWorkspaceFiles: WORKSPACE_FILES, concurrency: 1 };
    return this.options.backend === "native" ? new SeatbeltProcessSandbox({ ...shared, cleanupMs: this.configured.cleanupMs })
      : new DockerProcessSandbox({ ...shared, image: this.options.image!, commandTimeoutMs: this.configured.cleanupMs, maxTransferBytes: INPUT_BYTES });
  }

  async #grade(entry: Entry, workspace: string, controller: AbortController, externalSignal: AbortSignal): Promise<SandboxTestGrade> {
    const started = Date.now(), expires = started + this.configured.timeoutMs;
    const testId = entry.info.name, definition = entry.value.definition, cases: SandboxCaseEvidence[] = [];
    let sandbox: ManagedTestSandbox | undefined, backend: JsonValue = this.declaredPolicy;
    let cleanup: "verified" | "unconfirmed" = "verified", errorCode: string | null = null, expired = false;
    const retained = new Set<string>();
    const timer = setTimeout(() => { expired = true; controller.abort(); }, this.configured.timeoutMs);
    try {
      if (this.#unsafe) fail("RESTART_REQUIRED", "An earlier grading process has unconfirmed cleanup");
      if (controller.signal.aborted) fail("EVAL_TEST_CANCELLED", "Sandbox test cancelled");
      if (!isAbsolute(workspace) || workspace.includes("\0")) fail("EVAL_TEST_WORKSPACE", "Sandbox grader requires an absolute workspace");
      sandbox = this.#make(workspace); this.#resources.add(sandbox); backend = sandbox.profile;
      for (const testCase of definition.cases) {
        if (controller.signal.aborted || Date.now() >= expires) {
          if ((expired || Date.now() >= expires) && cases.length && !externalSignal.aborted && !this.#closed) {
            cases.push({ id: testCase.id, status: "failed", code: "EVAL_TEST_DEADLINE", durationMs: 0, executionId: null, exitCode: null, reason: "deadline-before-case", cleanup });
          } else errorCode = externalSignal.aborted || this.#closed ? "EVAL_TEST_CANCELLED" : "EVAL_TEST_DEADLINE";
          break;
        }
        const caseStart = Date.now(), nonce = randomUUID(), stdout: Buffer[] = [], stderr: Buffer[] = [];
        let outputBytes = 0, overflow = false, result: SandboxProcessResult | undefined, runError: unknown;
        const capture = (target: Buffer[], chunk: Buffer): void => {
          const remaining = Math.max(0, this.configured.maxOutputBytes - outputBytes);
          outputBytes += chunk.length;
          if (remaining) target.push(Buffer.from(chunk.subarray(0, remaining)));
          if (outputBytes > this.configured.maxOutputBytes) overflow = true;
        };
        const requestTimeout = Math.max(1, Math.min(this.configured.caseTimeoutMs, expires - Date.now()));
        // No expectation, test source, Host directory or shell command crosses this channel.
        const input = JSON.stringify({ nonce, caseId: testCase.id, module: definition.module, export: definition.export, args: testCase.args });
        const operation = sandbox.run({ command: "node", args: ["--max-old-space-size=96", "--input-type=commonjs", "-e", SANDBOX_TEST_BOOTSTRAP],
          cwd: "/workspace", workspace: "snapshot", signal: controller.signal, timeoutMs: requestTimeout,
          maxInputBytes: INPUT_BYTES, maxOutputBytes: this.configured.maxOutputBytes }, {
          started(process) { process.write(input); process.endInput(); }, stdout: chunk => capture(stdout, chunk), stderr: chunk => capture(stderr, chunk),
        });
        try { result = await deadline(operation, requestTimeout + this.configured.cleanupMs + 100, "EVAL_TEST_SETTLE", "Sandbox did not settle"); }
        catch (error) {
          runError = error;
          if (error instanceof HarnessError && error.code === "EVAL_TEST_SETTLE") {
            controller.abort();
            try { result = await deadline(operation, this.configured.cleanupMs, "CLEANUP_UNCONFIRMED", "Sandbox termination has not been confirmed"); }
            catch { cleanup = "unconfirmed"; }
          }
        }
        const out = Buffer.concat(stdout).toString("utf8"), err = Buffer.concat(stderr).toString("utf8"), decoded = decode(out, nonce, testCase.id);
        if (result) backend = result.profile;
        let status: SandboxCaseEvidence["status"] = "failed", code: string | null;
        if (cleanup === "unconfirmed" || result?.cleanup === "unconfirmed") { cleanup = "unconfirmed"; status = "error"; code = "CLEANUP_UNCONFIRMED"; }
        else if (externalSignal.aborted || this.#closed) { status = "error"; code = "EVAL_TEST_CANCELLED"; }
        else if (!decoded.ready) { status = "error"; code = result?.code ?? (runError instanceof HarnessError ? runError.code : "EVAL_TEST_NOT_READY"); }
        else if (overflow || result?.reason === "output-limit") code = "EVAL_TEST_OUTPUT_LIMIT";
        else if (expired || result?.reason === "timeout" || result?.reason === "cancelled") code = "EVAL_TEST_DEADLINE";
        else if (runError || !result || result.reason !== "exit" || result.exitCode !== 0) code = "EVAL_TEST_PROCESS_FAILED";
        else if (!decoded.valid || !decoded.outcome) code = "EVAL_TEST_PROTOCOL";
        else { code = outcomeCode(decoded.outcome, testCase); status = code === null ? "passed" : "failed"; }
        cases.push({ id: testCase.id, status, code, durationMs: Math.max(0, Date.now() - caseStart), executionId: result?.id ?? null,
          exitCode: result?.exitCode ?? null, reason: result?.reason ?? null, cleanup,
          ...(status === "passed" ? {} : { diagnostics: evidence({ stdout: out, stderr: err }, 512) }) });
        if (status === "error") { errorCode = code; break; }
        // A total deadline is a candidate failure after ready; do not dispatch another case.
        if (controller.signal.aborted || expired) break;
      }
    } catch (error) {
      errorCode = error instanceof HarnessError ? error.code : "EVAL_TEST_BACKEND_FAILED";
    } finally {
      clearTimeout(timer);
      if (sandbox) {
        try { await deadline(sandbox.close(), this.configured.cleanupMs, "CLEANUP_UNCONFIRMED", "Sandbox cleanup remains unconfirmed"); }
        catch { cleanup = "unconfirmed"; }
        try {
          const health = sandbox.health();
          if (health.active.length || health.unresolved.length) cleanup = "unconfirmed";
          for (const detail of health.details ?? []) for (const path of detail.retainedPaths) retained.add(path);
        } catch { cleanup = "unconfirmed"; }
        if (cleanup === "verified") this.#resources.delete(sandbox);
      }
      if (cleanup === "unconfirmed") {
        this.#unsafe = true; errorCode = "CLEANUP_UNCONFIRMED";
        for (const active of this.#active.keys()) if (active !== controller) active.abort();
      }
    }
    const cancelled = externalSignal.aborted || this.#closed;
    if (cancelled && cleanup === "verified") errorCode = "EVAL_TEST_CANCELLED";
    const status = errorCode ? "error" : cases.length === definition.cases.length && cases.every(item => item.status === "passed") ? "passed" : "failed";
    return immutable({ status, score: status === "error" ? null : cases.filter(item => item.status === "passed").length / definition.cases.length,
      errorCode, cleanup, cancelled, evidence: { testId, definitionHash: contentHash(entry.value), runnerVersion: SANDBOX_TEST_RUNNER_VERSION,
        backend, durationMs: Math.max(0, Date.now() - started), cases, retainedPaths: [...retained] } });
  }
}

export function createSandboxTestPlugin(options: SandboxTestOptions): Plugin {
  const configured = limits(options), declaredPolicy = policy(options, configured), fixedOptions = Object.freeze({ ...options });
  return { id: "sandbox-tests", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", configMode: "static", provides: [sandboxTestService], requires: [],
    validateConfig(input) { if (input !== undefined) fail("EVAL_TEST_OPTIONS", "Sandbox grading policy is supplied by the trusted plugin constructor"); return declaredPolicy; },
    setup(ctx) {
      const manager = ctx.resource("sandbox-test-processes", () => new SandboxTestManager(fixedOptions, configured, declaredPolicy), value => value.close());
      ctx.provide(sandboxTestService, run => {
        const registry = run.registries.get(sandboxTestRegistry);
        const lookup = (testId: string): Entry => {
          const entry = registry.get(testId);
          if (!entry) fail("EVAL_TEST_REFERENCE", `Unknown sandbox test reference: ${testId}`);
          return entry;
        };
        return Object.freeze<SandboxTestService>({
          manifest(testIds) {
            if (testIds.length > 64_000) fail("EVAL_TEST_REFERENCE", "Too many sandbox test references");
            return immutable({ schemaVersion: 1, policy: declaredPolicy, tests: [...new Set(testIds)].sort().map(testId => {
              const entry = lookup(testId);
              return { testId, definitionHash: contentHash(entry.value), registration: { ...entry.info, sessionId: entry.info.sessionId ?? null }, ...entry.value };
            }) }) as unknown as JsonValue;
          },
          grade: (testId, workspace, signal) => run.track(() => manager.get().grade(lookup(testId), workspace, signal)),
        });
      });
    },
  };
}
