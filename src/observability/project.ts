import { fail } from "../errors.js";
import { immutable } from "../json.js";
import type { SessionEvent } from "../session/types.js";
import type { JsonValue } from "../types.js";
import type { CallSpan, ModelMetrics, ObservabilityReport, RunMetrics, TokenUsage } from "./types.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Call = Mutable<CallSpan> & { planned: boolean; starts: number };
interface Run {
  runId: string; status: RunMetrics["status"]; startedAt: string | null; endedAt: string | null;
  firstSeq: number; lastSeq: number; configHash: string; calls: Call[];
  permissions: { allow: number; deny: number };
  compactions: Map<string, "started" | "completed" | "failed">;
  context: Mutable<RunMetrics["context"]>;
  budgetExits: number;
}

const object = (value: JsonValue | undefined): { readonly [key: string]: JsonValue } | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as { readonly [key: string]: JsonValue } : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const elapsed = (start: string | null, end: string | null): number | null => {
  if (start === null || end === null) return null;
  const result = Date.parse(end) - Date.parse(start);
  return Number.isFinite(result) && result >= 0 ? result : null;
};

/** Only the versioned Coding Agent response envelope defines provider usage. */
function usage(response: JsonValue): { usage: TokenUsage | null; fallbackEligible: boolean } {
  const envelope = object(response);
  const knownEnvelope = envelope?.format === "coding-agent-v1" || envelope?.format === "coding-summary-v1";
  if (!knownEnvelope) return { usage: null, fallbackEligible: false };
  const completionEnvelope = object(envelope?.completion), value = object(completionEnvelope?.usage);
  const prompt = count(value?.prompt), completion = count(value?.completion), total = count(value?.total);
  return { usage: prompt === null || completion === null || total === null ? null : { prompt, completion, total }, fallbackEligible: completionEnvelope?.usage === null };
}

function modelMetrics(calls: readonly Call[]): ModelMetrics {
  const samples = calls.flatMap(call => call.observedTokens ? [call.observedTokens] : []);
  const sum = (values: readonly number[]) => values.length ? values.reduce((total, value) => total + value, 0) : null;
  const charged = calls.flatMap(call => call.chargedTokens === null ? [] : [call.chargedTokens]);
  const estimated = calls.flatMap(call => call.chargedTokensSource === "fallback-estimate" && call.chargedTokens !== null ? [call.chargedTokens] : []);
  const unclassified = calls.flatMap(call => call.chargedTokensSource === "unclassified" && call.chargedTokens !== null ? [call.chargedTokens] : []);
  return {
    requests: calls.length, completed: calls.filter(call => call.status === "completed").length,
    failed: calls.filter(call => call.status === "failed").length,
    unfinished: calls.filter(call => call.endSeq === null).length,
    withUsage: samples.length, missingUsage: calls.length - samples.length,
    completedWithoutUsage: calls.filter(call => call.status === "completed" && call.observedTokens === null).length,
    observedTokens: { prompt: sum(samples.map(sample => sample.prompt)), completion: sum(samples.map(sample => sample.completion)), total: sum(samples.map(sample => sample.total)) },
    chargedTokens: sum(charged), chargedTokenSamples: charged.length,
    fallbackEstimatedTokens: sum(estimated), fallbackEstimatedSamples: estimated.length,
    unclassifiedChargedTokens: sum(unclassified),
  };
}

/**
 * Project a complete, ordered committed Session journal. No executors, providers,
 * transient UI deltas, or raw payloads participate. Session replay is responsible
 * for validating definitions; this boundary also rejects duplicate sequences,
 * mixed sessions and contradictory call links rather than silently miscounting.
 */
export function projectObservability(events: readonly SessionEvent[]): ObservabilityReport {
  const runs = new Map<string, Run>(), calls = new Map<string, Call>();
  const sessionId = events[0]?.sessionId ?? null;
  function invalid(): never { return fail("INVALID_OBSERVABILITY_EVENTS", "Expected an ordered committed Session journal with consistent call identities"); }
  const createCall = (event: SessionEvent, kind: Call["kind"], callId: string, parentCallId: string | null, planned: boolean): Call => {
    const call: Call = { runId: event.runId!, callId, parentCallId, kind, status: planned ? "unfinished" : "not-started",
      purpose: kind === "model" ? "unspecified" : null, firstSeq: event.seq, lastSeq: event.seq,
      startSeq: planned ? event.seq : null, endSeq: null, startedAt: planned ? event.timestamp : null, endedAt: null, durationMs: null,
      executionStartedAt: null, permission: null, cleanup: null, observedTokens: null, chargedTokens: null, chargedTokensSource: null, planned, starts: 0 };
    calls.set(callId, call); runs.get(event.runId!)!.calls.push(call);
    return call;
  };
  const terminal = (call: Call, event: SessionEvent, status: Call["status"]) => {
    if (call.endSeq !== null) invalid();
    call.status = status; call.endSeq = event.seq; call.endedAt = event.timestamp;
  };

  for (const [index, event] of events.entries()) {
    if (event.schemaVersion !== 1 || event.sessionId !== sessionId || event.seq !== index + 1 || !Number.isFinite(Date.parse(event.timestamp))) invalid();
    const data = event.data;
    if (event.runId === null) {
      if (data.type !== "definition.recorded" && data.type !== "configuration.recorded") invalid();
      continue;
    }
    let run = runs.get(event.runId);
    if (data.type === "run.started") {
      if (run) invalid();
      run = { runId: event.runId, status: "running", startedAt: event.timestamp, endedAt: null,
        firstSeq: event.seq, lastSeq: event.seq, configHash: event.configHash, calls: [], permissions: { allow: 0, deny: 0 },
        compactions: new Map(), context: { measurements: 0, latestPromptTokens: null, peakPromptTokens: null, contextWindow: null, prunedToolResults: 0 }, budgetExits: 0 };
      runs.set(event.runId, run);
    }
    if (!run) invalid();
    run.lastSeq = event.seq;
    if (data.type === "run.finished") { run.status = data.status; run.endedAt = event.timestamp; }
    if (data.type === "permission.decided") run.permissions[data.decision]++;
    if (data.type === "budget.exited") run.budgetExits++;
    if (data.type === "context.compaction") run.compactions.set(data.id, data.phase);
    if (data.type === "context.tool-pruned") run.context.prunedToolResults++;
    if (data.type === "context.measured") {
      const measurement = object(data.measurement), tokens = count(measurement?.promptTokens);
      run.context.measurements++; run.context.latestPromptTokens = tokens;
      if (tokens !== null) run.context.peakPromptTokens = Math.max(run.context.peakPromptTokens ?? 0, tokens);
      run.context.contextWindow = count(measurement?.contextWindow);
    }

    if (data.type === "pipeline.rejected") {
      if (data.parentCallId !== null && calls.get(data.parentCallId)?.runId !== event.runId) invalid();
      const existing = calls.get(data.rejectedCallId);
      if (existing && (existing.runId !== event.runId || existing.parentCallId !== data.parentCallId || existing.planned || existing.kind !== "tool")) invalid();
      const call = existing ?? createCall(event, "tool", data.rejectedCallId, data.parentCallId, true);
      call.planned = true; call.startSeq = event.seq; call.startedAt = event.timestamp; call.lastSeq = event.seq;
      terminal(call, event, "rejected");
      continue;
    }
    if (event.callId === null) continue;
    const starts = data.type === "model.requested" || data.type === "tool.planned" || data.type === "ptc.started";
    let call = calls.get(event.callId);
    if (starts) {
      const kind = data.type === "model.requested" ? "model" : data.type === "tool.planned" ? "tool" : "ptc";
      if (call && (call.planned || call.kind !== kind)) invalid();
      if (!call) call = createCall(event, kind, event.callId, event.parentCallId, true);
      else { call.planned = true; call.startSeq = event.seq; call.startedAt = event.timestamp; }
      call.status = kind === "tool" ? "not-started" : "unfinished";
    }
    if (!call || call.runId !== event.runId || call.parentCallId !== event.parentCallId) invalid();
    if (call.endSeq !== null) invalid();
    call.lastSeq = event.seq;
    if (call.parentCallId !== null && calls.get(call.parentCallId)?.runId !== event.runId) invalid();
    switch (data.type) {
      case "model.requested": call.purpose = data.purpose ?? "unspecified"; break;
      case "model.completed": {
        if (call.kind !== "model") invalid();
        const sample = usage(data.response); call.observedTokens = sample.usage;
        call.chargedTokens = count(data.chargedTokens);
        call.chargedTokensSource = call.chargedTokens === null ? null : sample.usage && sample.usage.total === call.chargedTokens ? "provider-usage" : sample.fallbackEligible ? "fallback-estimate" : "unclassified";
        terminal(call, event, "completed");
        for (const childId of data.childCallIds ?? []) {
          if (calls.has(childId)) invalid();
          createCall(event, "tool", childId, call.callId, false);
        }
        break;
      }
      case "model.failed":
        if (call.kind !== "model") invalid();
        call.chargedTokens = count(data.chargedTokens); call.chargedTokensSource = call.chargedTokens === null ? null : "unclassified";
        terminal(call, event, "failed"); break;
      case "permission.decided": if (call.kind !== "tool") invalid(); call.permission = data.decision; break;
      case "tool.started": if (call.kind !== "tool") invalid(); call.status = "unfinished"; call.starts++; call.executionStartedAt = event.timestamp; break;
      case "tool.completed": if (call.kind !== "tool") invalid(); terminal(call, event, data.outcome === "success" ? "completed" : "failed"); break;
      case "tool.cancelled": if (call.kind !== "tool") invalid(); terminal(call, event, "cancelled"); break;
      case "tool.not-executed": if (call.kind !== "tool") invalid(); call.status = "not-started"; call.permission = null; break;
      case "tool.uncertain": if (call.kind !== "tool") invalid(); call.status = "unknown"; break;
      case "ptc.started": call.executionStartedAt = event.timestamp; break;
      case "ptc.completed":
      case "ptc.uncertain": {
        if (call.kind !== "ptc") invalid();
        const result = object(data.result);
        call.cleanup = result?.cleanup === "verified" || result?.cleanup === "unconfirmed" ? result.cleanup : null;
        if (data.type === "ptc.uncertain" || result?.status === "unknown" || call.cleanup === "unconfirmed") call.status = "unknown";
        else if (result?.status === "completed" || result?.status === "failed") terminal(call, event, result.status);
        else call.status = "unknown";
        break;
      }
    }
  }

  const summaries: RunMetrics[] = [...runs.values()].map(run => {
    const model = run.calls.filter(call => call.kind === "model"), tool = run.calls.filter(call => call.kind === "tool"), ptc = run.calls.filter(call => call.kind === "ptc");
    const compactions = [...run.compactions.values()];
    // A finished run cannot turn a dispatched but unsettled external action into success.
    if (run.status !== "running") for (const call of [...tool, ...ptc]) if (call.status === "unfinished") call.status = "unknown";
    return {
      runId: run.runId, status: run.status, firstSeq: run.firstSeq, lastSeq: run.lastSeq, configHash: run.configHash,
      startedAt: run.startedAt, endedAt: run.endedAt, durationMs: elapsed(run.startedAt, run.endedAt),
      model: { all: modelMetrics(model), agent: modelMetrics(model.filter(call => call.purpose === "agent")),
        compaction: modelMetrics(model.filter(call => call.purpose === "compaction")), unspecified: modelMetrics(model.filter(call => call.purpose === "unspecified")) },
      tools: { attempts: tool.filter(call => call.planned).length, started: tool.reduce((sum, call) => sum + call.starts, 0),
        completed: tool.filter(call => call.status === "completed").length, errors: tool.filter(call => call.status === "failed").length,
        rejected: tool.filter(call => call.status === "rejected").length, cancelled: tool.filter(call => call.status === "cancelled").length,
        notStarted: tool.filter(call => call.planned && call.status === "not-started").length,
        unfinished: tool.filter(call => call.planned && call.endSeq === null).length, unknown: tool.filter(call => call.status === "unknown").length,
        expectedButUnplanned: tool.filter(call => !call.planned).length },
      permissions: run.permissions,
      ptc: { attempts: ptc.length, completed: ptc.filter(call => call.status === "completed").length, failed: ptc.filter(call => call.status === "failed").length,
        unknown: ptc.filter(call => call.status === "unknown").length, unfinished: ptc.filter(call => call.endSeq === null).length,
        cleanupVerified: ptc.filter(call => call.cleanup === "verified").length, cleanupUnconfirmed: ptc.filter(call => call.cleanup === "unconfirmed").length,
        cleanupUnreported: ptc.filter(call => call.cleanup === null).length },
      compaction: { attempts: compactions.length, completed: compactions.filter(phase => phase === "completed").length,
        failed: compactions.filter(phase => phase === "failed").length, unfinished: compactions.filter(phase => phase === "started").length },
      context: run.context, budgetExits: run.budgetExits,
    };
  });
  const spans: CallSpan[] = [...calls.values()].map(({ planned: _planned, starts: _starts, ...call }) => ({ ...call, durationMs: elapsed(call.startedAt, call.endedAt) }));
  return immutable({ schemaVersion: 1, sessionId, throughSeq: events.at(-1)?.seq ?? 0, timingBasis: "committed-event-timestamps", runs: summaries, calls: spans });
}
