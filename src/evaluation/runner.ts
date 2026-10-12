import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fail } from "../errors.js";
import { contentHash, immutable } from "../json.js";
import type { JsonValue } from "../types.js";
import { validateSuite, validateTaskPath } from "./dataset.js";
import { gradeTask } from "./graders.js";
import type { SandboxTestService } from "./sandbox-test-types.js";
import type { CaseAggregate, EvaluationAggregate, EvaluationReport, EvaluationRunOptions, EvaluationService, EvaluationSuite, EvaluationTask,
  GraderResult, TrialExecutionRequest, TrialExecutionResult, TrialExecutor, TrialRecord, ToolTraceEvidence } from "./types.js";

function integer(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail("EVAL_OPTIONS", `${name} must be an integer from ${min} to ${max}`);
  return value;
}
function safeCode(value: unknown): string | null { return typeof value === "string" && /^[A-Z0-9_:-]{1,80}$/.test(value) ? value : null; }
function boundedId(value: unknown): string | null { return typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,256}$/.test(value) ? value : null; }
function boundedMetrics(value: JsonValue | undefined): JsonValue | null {
  if (value === undefined) return null;
  try { const json = immutable(value); return Buffer.byteLength(JSON.stringify(json)) <= 8192 ? json : null; } catch { return null; }
}
function boundedTrace(value: ToolTraceEvidence | undefined): ToolTraceEvidence | undefined {
  try { return value && Buffer.byteLength(JSON.stringify(value)) <= 65536 ? immutable(value) : undefined; }
  catch { return undefined; }
}
async function privateWrite(path: string, text: string): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
}
async function initializeWorkspace(task: EvaluationTask): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "minicah-eval-workspace-")));
  try {
    await chmod(directory, 0o700);
    for (const [path, content] of Object.entries(task.files ?? {})) {
      const destination = join(directory, path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await privateWrite(destination, content);
    }
    return directory;
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
const combinationRatio = (chosen: number, total: number, k: number): number => {
  if (chosen < k) return 0;
  let value = 1;
  for (let index = 0; index < k; index++) value *= (chosen - index) / (total - index);
  return value;
};
/** Null outcomes are excluded, explicitly counted, and never silently converted to failures or zero usage. */
export function aggregateTrials(trials: readonly TrialRecord[], ks: readonly number[] = [1, 2, 3]): EvaluationAggregate {
  const classifications: Record<TrialRecord["classification"], number> = {
    success: 0, "task-failure": 0, "agent-failure": 0, "infrastructure-failure": 0, "grader-failure": 0, cancelled: 0, "not-started": 0,
  };
  const groups = new Map<string, TrialRecord[]>();
  for (const trial of trials) { classifications[trial.classification]++; const group = groups.get(trial.taskId) ?? []; group.push(trial); groups.set(trial.taskId, group); }
  const cases: CaseAggregate[] = [];
  for (const [taskId, group] of groups) {
    const eligible = group.filter(trial => trial.passed !== null), n = eligible.length, c = eligible.filter(trial => trial.passed).length;
    const passAtK: Record<string, number | null> = {}, passPowerK: Record<string, number | null> = {};
    for (const k of ks) {
      integer(k, 1, 1000, "k");
      // Missing/infra trials can bias repeated-sample estimates; require the entire case to be eligible.
      const enough = n === group.length && n >= k;
      passAtK[String(k)] = enough ? 1 - combinationRatio(n - c, n, k) : null;
      passPowerK[String(k)] = enough ? combinationRatio(c, n, k) : null;
    }
    cases.push({ taskId, plannedTrials: group.length, eligibleTrials: n, passedTrials: c, passAt1: n ? c / n : null,
      empiricalAtLeastOne: n === group.length && n ? c > 0 : null, empiricalAllTrials: n === group.length && n ? c === n : null, passAtK, passPowerK });
  }
  const eligibleCases = cases.filter(item => item.passAt1 !== null), eligibleTrials = trials.filter(trial => trial.passed !== null).length;
  return { plannedTrials: trials.length, eligibleTrials, excludedTrials: trials.length - eligibleTrials, eligibleCases: eligibleCases.length,
    macroPassAt1: eligibleCases.length ? eligibleCases.reduce((total, item) => total + item.passAt1!, 0) / eligibleCases.length : null, classifications, cases };
}

export class EvaluationRunner implements EvaluationService {
  #closed = false;
  #active = false;
  readonly #unresolved = new Set<string>();
  readonly #controllers = new Set<AbortController>();
  health(): { readonly closed: boolean; readonly unresolvedTrials: readonly string[] } {
    return { closed: this.#closed, unresolvedTrials: [...this.#unresolved] };
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    if (this.#active || this.#unresolved.size) fail("EVAL_CLEANUP_UNCONFIRMED", "Evaluation shutdown requires active executors and graders to confirm cleanup");
  }

  async run(input: EvaluationSuite, executor: TrialExecutor, options: EvaluationRunOptions): Promise<EvaluationReport> {
    if (this.#closed || this.#unresolved.size) fail("EVAL_UNAVAILABLE", "Evaluation runner is closed or has unresolved execution cleanup");
    if (this.#active) fail("EVAL_BUSY", "One evaluation campaign may run per runner");
    const suite = validateSuite(input), repetitions = integer(options.repetitions ?? 1, 1, 100, "repetitions"),
      concurrency = integer(options.concurrency ?? 1, 1, 32, "concurrency"), timeoutMs = integer(options.timeoutMs ?? 120_000, 1, 86_400_000, "timeoutMs"),
      cancellationGraceMs = integer(options.cancellationGraceMs ?? 10_000, 1, 60_000, "cancellationGraceMs"), mode = options.mode ?? "native";
    if (mode !== "native" && mode !== "ptc") fail("EVAL_OPTIONS", "mode must be native or ptc");
    const taskProtocols = Object.fromEntries(suite.tasks.map(task => [task.id, {
      repetitions: options.repetitions ?? task.trialProtocol?.repetitions ?? repetitions,
      timeoutMs: options.timeoutMs ?? task.trialProtocol?.timeoutMs ?? timeoutMs,
    }]));
    const count = suite.tasks.reduce((sum, task) => sum + taskProtocols[task.id]!.repetitions, 0);
    integer(count, 1, 1000, "total trials");
    const byteLimit = integer(options.maxArtifactBytes ?? 128 * 1024 * 1024, 65536, 512 * 1024 * 1024, "maxArtifactBytes");
    const suiteBytes = Buffer.byteLength(JSON.stringify(suite, null, 2) + "\n");
    const testIds = [...new Set(suite.tasks.flatMap(task => task.graders.flatMap(grader => grader.kind === "sandbox-test" ? [grader.testId] : [])))];
    if (testIds.length && !options.sandboxTests) fail("EVAL_SANDBOX_TEST_REQUIRED", "Sandbox-test graders require a trusted Host sandbox test service");
    // Validate every reference and pin the exact definitions before any Agent dispatch.
    const testManifest = testIds.length ? immutable(options.sandboxTests!.manifest(testIds)) : undefined;
    const manifestBytes = testManifest === undefined ? 0 : Buffer.byteLength(JSON.stringify(testManifest, null, 2) + "\n");
    const sandboxRecords = suite.tasks.reduce((sum, task) => sum + task.graders.filter(grader => grader.kind === "sandbox-test").length * taskProtocols[task.id]!.repetitions, 0);
    if (byteLimit < count * 131072 + sandboxRecords * 131072 + 32768 + suiteBytes + manifestBytes) fail("EVAL_ARTIFACT_LIMIT", "Artifact limit is too small for the suite and planned bounded trial records");
    const ks = options.k ?? [1, 2, 3];
    for (const k of ks) integer(k, 1, 1000, "k");
    if (ks.length > 20) fail("EVAL_OPTIONS", "At most 20 k values are supported");
    const reference = immutable(options.reference ?? {});
    if (Buffer.byteLength(JSON.stringify(reference)) > 4096) fail("EVAL_OPTIONS", "Evaluation reference metadata exceeds its limit");
    this.#active = true;
    const evaluationId = randomUUID(), startedAt = new Date().toISOString(), start = performance.now();
    const shared = new AbortController();
    this.#controllers.add(shared);
    const abort = (): void => { shared.abort(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let bytesWritten = 0;
    try {
      await mkdir(options.outputDirectory, { recursive: true, mode: 0o700 });
      const outputStat = await lstat(options.outputDirectory);
      if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) fail("EVAL_ARTIFACT_PATH", "Output directory must be a real directory");
      const root = await realpath(resolve(options.outputDirectory));
      const artifactDirectory = await mkdtemp(join(root, "evaluation-"));
      await chmod(artifactDirectory, 0o700);
      const writeArtifact = async (name: string, data: unknown): Promise<void> => {
        const text = JSON.stringify(data, null, 2) + "\n", bytes = Buffer.byteLength(text);
        if (bytesWritten + bytes > byteLimit) fail("EVAL_ARTIFACT_LIMIT", "Evaluation artifacts exceed their configured limit");
        bytesWritten += bytes;
        await privateWrite(join(artifactDirectory, name), text);
      };
      const suiteIdentity = { id: suite.id, version: suite.version, split: suite.split, hash: contentHash(suite) };
      const testIdentity = testManifest === undefined ? {} : { testManifest: { path: "test-manifest.json" as const, hash: contentHash(testManifest) } };
      // Keep exact grading definitions in private Host artifacts. The executor
      // only receives public task material and a separate disposable workspace.
      await writeArtifact("suite.json", suite);
      if (testManifest !== undefined) await writeArtifact("test-manifest.json", testManifest);
      await writeArtifact("plan.json", { schemaVersion: 1, evaluationId, suite: suiteIdentity, mode, reference, ...testIdentity, startedAt,
        settings: { repetitions, concurrency, timeoutMs, cancellationGraceMs }, taskProtocols, tasks: suite.tasks.map(task => ({ id: task.id, hash: contentHash(task) })) });
      const plan = suite.tasks.flatMap(task => Array.from({ length: taskProtocols[task.id]!.repetitions }, (_, repetition) => ({ task, repetition: repetition + 1, trialId: randomUUID() })));
      const records: TrialRecord[] = new Array(plan.length);
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          if (shared.signal.aborted) return;
          const index = next++;
          if (index >= plan.length) return;
          const item = plan[index]!;
          records[index] = await this.#trial(item.task, item.repetition, item.trialId, executor, {
            artifactDirectory, mode, signal: shared.signal, timeoutMs: taskProtocols[item.task.id]!.timeoutMs, cancellationGraceMs,
            ...(options.sandboxTests ? { sandboxTests: options.sandboxTests } : {}),
          });
          if (records[index]!.cleanup === "unconfirmed" || records[index]!.status === "unknown") shared.abort();
          try { await writeArtifact(`trial-${item.trialId}.json`, records[index]); }
          catch (error) { shared.abort(); throw error; }
        }
      };
      const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, count) }, worker));
      const failure = workers.find((value): value is PromiseRejectedResult => value.status === "rejected");
      if (failure) throw failure.reason;
      for (const [index, item] of plan.entries()) {
        if (records[index]) continue;
        records[index] = this.#empty(item.task, item.repetition, item.trialId, mode);
        await writeArtifact(`trial-${item.trialId}.json`, records[index]);
      }
      const report: EvaluationReport = immutable({ schemaVersion: 1, evaluationId, suite: suiteIdentity, mode, reference, ...testIdentity,
        settings: { repetitions, concurrency, timeoutMs, cancellationGraceMs }, taskProtocols, startedAt, durationMs: performance.now() - start,
        status: this.#unresolved.size ? "cleanup-unconfirmed" : records.some(trial => trial.status === "unknown") ? "needs-reconciliation" : shared.signal.aborted ? "cancelled" : "completed", artifactDirectory,
        trials: records, aggregate: aggregateTrials(records, ks) });
      await writeArtifact("report.json", report);
      return report;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      this.#controllers.delete(shared);
      this.#active = false;
    }
  }

  #empty(task: EvaluationTask, repetition: number, trialId: string, mode: EvaluationRunOptions["mode"]): TrialRecord {
    return { trialId, taskId: task.id, taskHash: contentHash(task), repetition, mode: mode ?? "native", status: "not-started", classification: "not-started",
      cleanup: "verified", passed: null, score: null, startedAt: null, durationMs: null, runId: null, sessionId: null, journalRefs: [], metrics: null,
      graders: [], errorCode: null, retainedWorkspace: null };
  }

  async #trial(task: EvaluationTask, repetition: number, trialId: string, executor: TrialExecutor,
    options: { artifactDirectory: string; mode: "native" | "ptc"; signal: AbortSignal; timeoutMs: number; cancellationGraceMs: number; sandboxTests?: SandboxTestService }): Promise<TrialRecord> {
    const start = performance.now(), startedAt = new Date().toISOString(), base = this.#empty(task, repetition, trialId, options.mode);
    let workspace: string | undefined, cleanup: "verified" | "unconfirmed" = "verified", result: TrialRecord;
    try {
      workspace = await initializeWorkspace(task);
      const logDirectory = join(options.artifactDirectory, `logs-${trialId}`);
      await mkdir(logDirectory, { mode: 0o700 });
      // Workspace staging is infrastructure preparation. A single active-work
      // deadline covers Agent execution and subsequent grading, not two budgets.
      const activeStart = performance.now();
      const execution = await this.#execute(executor, { task: immutable({ id: task.id, prompt: task.prompt, tags: task.tags ?? [], files: task.files ?? {} }),
        workspace, trialId, mode: options.mode, logDirectory, ...(task.executionPolicy ? { executionPolicy: task.executionPolicy } : {}) }, options);
      const toolTrace = boundedTrace(execution.toolTrace);
      cleanup = execution.cleanup;
      if (cleanup === "unconfirmed") this.#unresolved.add(trialId);
      const refs: string[] = [];
      for (const ref of (execution.journalRefs ?? []).slice(0, 16)) {
        try { validateTaskPath(ref); refs.push(`logs-${trialId}/${ref}`); } catch { /* Invalid executor references are omitted. */ }
      }
      const grading = execution.status === "completed" && cleanup === "verified"
        ? await this.#grade(task, workspace, execution.finalText ?? "", { ...options, ...(toolTrace ? { toolTrace } : {}), ...(execution.runId ? { runId: execution.runId } : {}), timeoutMs: Math.max(0, options.timeoutMs - (performance.now() - activeStart)) })
        : { graders: [] as readonly GraderResult[], cleanup: "verified" as const, cancelled: false, timedOut: false, errorCode: null };
      const graders = grading.graders;
      if (grading.cleanup === "unconfirmed") { cleanup = "unconfirmed"; this.#unresolved.add(trialId); }
      let classification: TrialRecord["classification"], passed: boolean | null = null, score: number | null = null;
      if (execution.confirmedFailure === "COMPLETION_PROTECTED_CHANGED") { classification = "agent-failure"; passed = false; }
      else if (cleanup === "unconfirmed" || execution.status === "unknown") classification = "infrastructure-failure";
      else if (execution.status === "cancelled") classification = "cancelled";
      else if (grading.timedOut) classification = "grader-failure";
      else if (grading.cancelled) classification = "cancelled";
      else if (execution.status === "failed" && execution.failureKind === "infrastructure") classification = "infrastructure-failure";
      else if (execution.status === "failed") { classification = "agent-failure"; passed = false; score = 0; }
      else if (graders.some(grader => grader.status === "error")) {
        // An unrelated missing oracle cannot erase an established violation.
        // Keep the weighted score unknown rather than treating errors as zero.
        if (graders.some(grader => grader.required && grader.status === "failed")) { classification = "task-failure"; passed = false; }
        else classification = "grader-failure";
      }
      else {
        passed = graders.filter(grader => grader.required).every(grader => grader.status === "passed");
        score = graders.reduce((sum, grader) => sum + grader.score! * grader.weight, 0) / graders.reduce((sum, grader) => sum + grader.weight, 0);
        classification = passed ? "success" : "task-failure";
      }
      result = { ...base, status: cleanup === "unconfirmed" ? "unknown" : grading.timedOut ? "failed" : grading.cancelled ? "cancelled" : execution.status, classification, cleanup, passed, score, startedAt, durationMs: performance.now() - start,
        ...(execution.confirmedFailure === "COMPLETION_PROTECTED_CHANGED" ? { confirmedFailure: execution.confirmedFailure } : {}),
        runId: boundedId(execution.runId), sessionId: boundedId(execution.sessionId), journalRefs: refs, metrics: boundedMetrics(execution.metrics), ...(toolTrace ? { toolTrace } : {}), graders,
        errorCode: safeCode(grading.errorCode ?? execution.errorCode), retainedWorkspace: cleanup === "unconfirmed" || execution.status === "unknown" ? workspace : null };
    } catch {
      result = { ...base, status: "failed", classification: "infrastructure-failure", cleanup, startedAt, durationMs: performance.now() - start,
        errorCode: "TRIAL_INFRASTRUCTURE", retainedWorkspace: cleanup === "unconfirmed" ? workspace ?? null : null };
    }
    if (workspace && cleanup === "verified" && result.status !== "unknown") {
      try { await rm(workspace, { recursive: true, force: true }); }
      catch {
        this.#unresolved.add(trialId);
        result = { ...result, cleanup: "unconfirmed", classification: result.passed === false ? result.classification : "infrastructure-failure", passed: result.passed === false ? false : null, score: null,
          errorCode: "WORKSPACE_CLEANUP", retainedWorkspace: workspace };
      }
    }
    return result;
  }

  async #grade(task: EvaluationTask, workspace: string, finalText: string,
    options: { signal: AbortSignal; timeoutMs: number; cancellationGraceMs: number; sandboxTests?: SandboxTestService; toolTrace?: ToolTraceEvidence; runId?: string }): Promise<{
      graders: readonly GraderResult[]; cleanup: "verified" | "unconfirmed"; cancelled: boolean; timedOut: boolean; errorCode: string | null;
    }> {
    const controller = new AbortController();
    let cancel!: () => void, timedOut = false;
    const cancelled = new Promise<null>(resolve => { cancel = () => { controller.abort(); resolve(null); }; });
    options.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; cancel(); }, Math.max(0, options.timeoutMs));
    if (options.signal.aborted) cancel();
    else if (options.timeoutMs <= 0) { timedOut = true; cancel(); }
    const grading = Promise.resolve().then(() => gradeTask(task, workspace, finalText, {
      signal: controller.signal, ...(options.sandboxTests ? { sandboxTests: options.sandboxTests } : {}),
      ...(options.toolTrace ? { toolTrace: options.toolTrace } : {}), ...(options.runId ? { runId: options.runId } : {}),
    })).then(graders => ({ graders, rejected: false }), () => ({ graders: [] as readonly GraderResult[], rejected: true }));
    try {
      let settled = await Promise.race([grading, cancelled]);
      if (!settled) {
        // Freeze the cause before grace waiting so a user abort remains a cancellation.
        clearTimeout(timer);
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        try { settled = await Promise.race([grading, new Promise<null>(resolve => { graceTimer = setTimeout(() => resolve(null), options.cancellationGraceMs); })]); }
        finally { if (graceTimer) clearTimeout(graceTimer); }
      }
      const uncertain = !settled || settled.rejected || settled.graders.some(grader => grader.cleanup === "unconfirmed");
      const wasCancelled = controller.signal.aborted || settled?.graders.some(grader => grader.cancelled) === true;
      return { graders: settled?.graders ?? [], cleanup: uncertain ? "unconfirmed" : "verified", cancelled: wasCancelled, timedOut,
        errorCode: uncertain ? "GRADING_CLEANUP_UNCONFIRMED" : timedOut ? "GRADING_TIMEOUT" : wasCancelled ? "GRADING_CANCELLED" : null };
    } finally { clearTimeout(timer); options.signal.removeEventListener("abort", cancel); }
  }

  async #execute(executor: TrialExecutor, request: Omit<TrialExecutionRequest, "signal">,
    options: { signal: AbortSignal; timeoutMs: number; cancellationGraceMs: number }): Promise<TrialExecutionResult> {
    const controller = new AbortController();
    let cancel!: () => void;
    const cancelled = new Promise<null>(resolve => { cancel = () => { controller.abort(); resolve(null); }; });
    options.signal.addEventListener("abort", cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; cancel(); }, options.timeoutMs);
    if (options.signal.aborted) cancel();
    else if (options.timeoutMs <= 0) { timedOut = true; cancel(); }
    // Rejections cannot attest cleanup. Observe them even if the grace deadline wins.
    const execution = Promise.resolve().then(() => controller.signal.aborted
      ? { status: "cancelled" as const, cleanup: "verified" as const }
      : executor({ ...request, signal: controller.signal })).then(result => {
      if (!result || !["completed", "failed", "cancelled", "unknown"].includes(result.status) || !["verified", "unconfirmed"].includes(result.cleanup)) {
        return { status: "unknown" as const, cleanup: "unconfirmed" as const, errorCode: "INVALID_EXECUTOR_RESULT" };
      }
      return result;
    }, () => ({ status: "unknown" as const, cleanup: "unconfirmed" as const, errorCode: "EXECUTOR_REJECTED" }));
    try {
      const first = await Promise.race([execution, cancelled]);
      if (first) return first;
      clearTimeout(timer);
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const after = await Promise.race([execution, new Promise<null>(resolve => { graceTimer = setTimeout(() => resolve(null), options.cancellationGraceMs); })]);
      if (graceTimer) clearTimeout(graceTimer);
      if (!after) return { status: "unknown", cleanup: "unconfirmed", errorCode: "CLEANUP_UNCONFIRMED" };
      if (after.status === "unknown" || after.cleanup === "unconfirmed") return { ...after, status: "unknown" };
      // A late success following cancellation is not a successful timed trial.
      return { ...after, status: timedOut ? "failed" : "cancelled", errorCode: timedOut ? "TRIAL_TIMEOUT" : "CANCELLED" };
    } finally { clearTimeout(timer); options.signal.removeEventListener("abort", cancel); }
  }
}
