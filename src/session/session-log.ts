import { fail } from "../errors.js";
import type { RunManifest } from "../types.js";
import { immutable, contentHash } from "./json.js";
import { applyInput, forkState, replay, resolveDefinition, stateView, type ReplayState } from "./reducer.js";
import type {
  CommitReceipt, CommittedNotification, Durability, EventInput, EventJournal, FlushReceipt,
  RecordedToolResult, ReconstructedRequest, RecoveryCall, SessionEvent, SessionService,
  SessionState, ToolOperation, UiDelta,
} from "./types.js";

const terminal = new Set(["model.completed", "model.failed", "tool.completed", "tool.cancelled", "budget.exited", "run.finished", "ptc.completed"]);

export class SessionLog {
  readonly #journal: EventJournal;
  #state: ReplayState;
  #tail: Promise<void> = Promise.resolve();
  #faulted = false;
  #closing: Promise<void> | undefined;
  #committed = new Set<(notification: CommittedNotification) => void>();
  #deltas = new Set<(delta: UiDelta) => void>();
  #observerErrors: unknown[] = [];
  #executions = new Set<Promise<RecordedToolResult>>();

  private constructor(journal: EventJournal, readonly durability: Durability) {
    if (durability !== "flush" && durability !== "fsync") fail("INVALID_DURABILITY", "Expected flush or fsync");
    this.#journal = journal;
    this.#state = replay(journal.sessionId, journal.read());
  }
  static async open(journal: EventJournal, durability: Durability = "fsync"): Promise<SessionLog> {
    try { return new SessionLog(journal, durability); }
    catch (cause) {
      try { await journal.close(); } catch (cleanup) { throw new AggregateError([cause, cleanup], "Session replay and cleanup failed"); }
      throw cause;
    }
  }
  get sessionId(): string { return this.#journal.sessionId; }
  events(): readonly SessionEvent[] { return Object.freeze([...this.#state.events]); }
  state(): SessionState { return stateView(this.#state); }

  forRun(runId: string, manifest?: RunManifest): SessionService {
    return Object.freeze({
      sessionId: this.sessionId, runId,
      retain: definitions => this.commit(definitions.map(definition => ({ runId: null, data: { type: "definition.recorded", definition } }))),
      start: (versions, config) => this.commit([
        ...(manifest ? [{ runId: null, data: { type: "configuration.recorded" as const, configuration: manifest.configuration } }] : []),
        { runId, data: { type: "run.started", versions, config, ...(manifest ? { manifest } : {}) } },
      ]),
      record: (events, durability = this.durability) => this.commit(events.map(event => ({ ...event, runId })), durability),
      executeTool: (callId, operation) => this.executeTool(runId, callId, operation),
      events: () => this.events(), state: () => this.state(), recovery: () => this.recovery(),
      reconstructRequest: callId => this.reconstructRequest(callId),
      flush: durability => this.flush(durability),
      subscribeCommitted: listener => this.subscribeCommitted(listener),
      subscribeDeltas: listener => this.subscribeDeltas(listener),
      publishDelta: delta => this.publishDelta({ ...delta, kind: "delta", runId }),
    } satisfies SessionService);
  }

  commit(inputs: readonly EventInput[], durability = this.durability): Promise<CommitReceipt> {
    return this.#commit(inputs, durability, false);
  }
  #commit(inputs: readonly EventInput[], durability: Durability, internal: boolean): Promise<CommitReceipt> {
    this.#assertOpen(internal);
    if (durability !== "flush" && durability !== "fsync") fail("INVALID_DURABILITY", "Expected flush or fsync");
    const copies = immutable(inputs);
    if (!copies.length) fail("INVALID_EVENT", "Cannot commit an empty transaction");
    return this.#enqueue(async () => {
      if (this.#faulted) fail("COMMIT_UNCERTAIN", "Session must be reopened after a failed commit");
      const candidate = forkState(this.#state);
      const events = Object.freeze(copies.map(input => applyInput(candidate, input, new Date().toISOString())));
      let receipt: CommitReceipt;
      try { receipt = await this.#journal.append(events, durability); }
      catch (error) { this.#faulted = true; throw error; }
      this.#state = candidate;
      this.#emit(this.#committed, Object.freeze({ kind: "committed", receipt, events, terminal: events.some(event =>
        terminal.has(event.data.type) || (event.data.type === "task.status" && ["completed", "failed", "cancelled"].includes(event.data.status))) }));
      return receipt;
    });
  }

  flush(durability: Durability): Promise<FlushReceipt> {
    this.#assertOpen();
    if (durability !== "flush" && durability !== "fsync") fail("INVALID_DURABILITY", "Expected flush or fsync");
    return this.#enqueue(async () => {
      if (this.#faulted) fail("COMMIT_UNCERTAIN", "Session must be reopened after a failed commit");
      try { return await this.#journal.flush(durability); }
      catch (error) { this.#faulted = true; throw error; }
    });
  }

  /** Durable intent precedes the external call; neither replay nor recovery calls this. */
  executeTool(runId: string, callId: string, operation: ToolOperation): Promise<RecordedToolResult> {
    this.#assertOpen();
    const work = this.#executeTool(runId, callId, operation);
    this.#executions.add(work);
    void work.then(() => this.#executions.delete(work), () => this.#executions.delete(work));
    return work;
  }
  async #executeTool(runId: string, callId: string, operation: ToolOperation): Promise<RecordedToolResult> {
    const retained = this.#state.calls.get(callId)?.planned.data;
    if (retained?.type === "tool.planned" && retained.inputHash !== undefined && retained.inputHash !== contentHash(retained.input)) {
      fail("INPUT_UNAVAILABLE", "Audit input was redacted/truncated; restore exact arguments with fresh validation and permission before an explicit new call");
    }
    await this.#commit([{ runId, callId, data: { type: "tool.started" } }], "fsync", true);
    const planned = this.#state.calls.get(callId)!.planned.data;
    if (planned.type !== "tool.planned") fail("CALL_STATE", "Expected a tool plan");
    let result: RecordedToolResult;
    try {
      result = immutable(await operation({ input: planned.input, idempotencyKey: planned.idempotencyKey ?? null }));
    } catch (cause) {
      // A thrown error may follow a successful write. Never label it not-executed.
      try {
        await this.#commit([{ runId, callId, data: { type: "tool.uncertain", reason: cause instanceof Error ? cause.message || cause.name : String(cause) } }], this.durability, true);
      } catch (loggingError) { throw new AggregateError([cause, loggingError], "Tool outcome and its error log are uncertain"); }
      throw cause;
    }
    await this.#commit([{ runId, callId, data: { type: "tool.completed", outcome: result.outcome, result: result.result, confirmation: "direct" } }], this.durability, true);
    return result;
  }

  recovery(): readonly RecoveryCall[] {
    return immutable([...this.#state.calls.values()].map(call => {
      let nextAction: RecoveryCall["nextAction"];
      const plan = call.planned.data;
      if (call.status === "confirmed-complete") nextAction = "none";
      else if (plan.type === "tool.planned" && plan.inputHash !== undefined && plan.inputHash !== contentHash(plan.input)) nextAction = "restore-input";
      else if (call.status === "not-started") nextAction = "start-after-permission";
      else if (plan.type === "tool.planned" && plan.effect !== "non-idempotent-write") nextAction = "retry-safe";
      else if (plan.type === "tool.planned" && plan.idempotencyKey) nextAction = "reconcile-with-key";
      else nextAction = "query-or-confirm";
      return { ...call, nextAction };
    }));
  }

  reconstructRequest(callId: string): ReconstructedRequest {
    const call = this.#state.calls.get(callId);
    if (!call || call.kind !== "model" || call.planned.data.type !== "model.requested") fail("CALL_STATE", "No retained model request with this callId");
    const run = this.#state.runs.get(call.runId)!;
    const definitions = [run.versions.model, run.versions.prompt, ...run.versions.tools, ...run.versions.plugins]
      .map(ref => resolveDefinition(this.#state, ref));
    if (call.planned.data.prompt) definitions.push(resolveDefinition(this.#state, call.planned.data.prompt, "prompt"));
    return immutable({ request: call.planned.data.request, config: run.config, definitions, requestEvent: call.planned, ...(run.manifest ? { manifest: run.manifest } : {}) });
  }

  subscribeCommitted(listener: (notification: CommittedNotification) => void): () => void {
    this.#assertOpen(); this.#committed.add(listener); return () => { this.#committed.delete(listener); };
  }
  subscribeDeltas(listener: (delta: UiDelta) => void): () => void {
    this.#assertOpen(); this.#deltas.add(listener); return () => { this.#deltas.delete(listener); };
  }
  publishDelta(delta: UiDelta): void {
    this.#assertOpen();
    const copy = immutable(delta);
    const call = this.#state.calls.get(copy.callId);
    if (copy.kind !== "delta" || typeof copy.text !== "string" || !call || call.runId !== copy.runId || call.kind !== copy.channel || call.status !== "uncertain") {
      fail("INVALID_DELTA", "Delta requires a recorded, active model/tool call");
    }
    this.#emit(this.#deltas, copy);
  }
  drainObserverErrors(): readonly unknown[] {
    const errors = Object.freeze([...this.#observerErrors]); this.#observerErrors = []; return errors;
  }
  #emit<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const listener of [...listeners]) {
      try { void Promise.resolve(listener(value)).catch(error => { this.#observerErrors.push(error); }); }
      catch (error) { this.#observerErrors.push(error); }
    }
  }
  close(): Promise<void> {
    if (!this.#closing) this.#closing = (async () => {
      await Promise.allSettled([...this.#executions]);
      await this.#tail;
      this.#committed.clear(); this.#deltas.clear();
      await this.#journal.close();
    })();
    return this.#closing;
  }
  #assertOpen(internal = false): void {
    if (this.#closing && !internal) fail("SESSION_CLOSED", "Session log is closing or closed");
    if (this.#faulted) fail("COMMIT_UNCERTAIN", "Session requires recovery");
  }
  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation);
    this.#tail = next.then(() => {}, () => {});
    return next;
  }
}
