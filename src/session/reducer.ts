import { fail } from "../errors.js";
import { canonical, contentHash, definitionKey, immutable } from "./json.js";
import type { CallState, Definition, DefinitionRef, EventInput, SessionEvent, SessionState, Versions } from "./types.js";
import type { ConfigurationVersion, JsonValue, RunManifest } from "../types.js";
import { applySurface, type SurfaceState } from "./surface.js";
import type { ModelRequestBudget, ToolPruning } from "./types.js";
import { modelToolResult, pruneToolResult, PRUNE_MARKER } from "./tool-projection.js";

interface RunState { versions: Versions; config: JsonValue; status: string; manifest?: RunManifest }
export interface ReplayState {
  sessionId: string;
  events: SessionEvent[];
  definitions: Map<string, Definition>;
  configurations: Map<string, ConfigurationVersion>;
  runs: Map<string, RunState>;
  calls: Map<string, CallState>;
  tasks: Map<string, SessionEvent>;
  protected: Map<string, SessionEvent>;
  summary: SessionEvent | null;
  summaries: Set<string>;
  surface: SurfaceState;
  toolPrunings: Map<string, ToolPruning>;
}

export function emptyState(sessionId: string): ReplayState {
  return { sessionId, events: [], definitions: new Map(), configurations: new Map(), runs: new Map(), calls: new Map(), tasks: new Map(), protected: new Map(), summary: null, summaries: new Set(), surface: { nodes: [], generation: 0 }, toolPrunings: new Map() };
}
export function forkState(state: ReplayState): ReplayState {
  return { ...state, events: [...state.events], definitions: new Map(state.definitions), configurations: new Map(state.configurations), runs: new Map(state.runs), calls: new Map(state.calls), tasks: new Map(state.tasks), protected: new Map(state.protected), summaries: new Set(state.summaries), surface: { nodes: [...state.surface.nodes], generation: state.surface.generation }, toolPrunings: new Map(state.toolPrunings) };
}
function requestBudget(value: ModelRequestBudget): void {
  if (value?.remainingTokens !== null && typeof value?.remainingTokens !== "number") fail("INVALID_EVENT", "Remaining tokens must be a number or null");
  if (!value || ![value.promptTokens, value.outputTokens, value.remainingTokens ?? 0, value.requestBytes, value.contextWindow ?? 0].every(n => Number.isSafeInteger(n) && n >= 0) || !Number.isFinite(value.calibration) || value.calibration < 1) fail("INVALID_EVENT", "Invalid model request budget");
  text(value.estimator, "token estimator");
  if (value.anchorCallId !== undefined && value.anchorCallId !== null) text(value.anchorCallId, "anchor call id");
}
function text(value: unknown, label: string, empty = false): asserts value is string {
  if (typeof value !== "string" || (!empty && !value.trim())) fail("INVALID_EVENT", `${label} must be a string${empty ? "" : " with content"}`);
}
function choice(value: unknown, values: readonly string[]): void {
  if (typeof value !== "string" || !values.includes(value)) fail("INVALID_EVENT", `Expected one of: ${values.join(", ")}`);
}
function serviceManifest(manifest: RunManifest, sessionId: string, owners: ReadonlyMap<string, RunManifest["plugins"][number]>): void {
  if (manifest.services === undefined && manifest.bindings === undefined) return; // Legacy journals.
  if (!Array.isArray(manifest.services) || !Array.isArray(manifest.bindings)) fail("INVALID_EVENT", "Service manifest requires both services and bindings");
  const slot = (id: string, isolation: string | null) => JSON.stringify([id, isolation]);
  const registrations = new Map<string, NonNullable<RunManifest["services"]>[number]>();
  for (const service of manifest.services) {
    if (!service || typeof service !== "object") fail("INVALID_EVENT", "Invalid service manifest entry");
    text(service.id, "manifest service id");
    if (service.isolation !== null) text(service.isolation, "service isolation id");
    const owner = owners.get(service.owner), key = slot(service.id, service.isolation);
    if (!Number.isSafeInteger(service.version) || service.version < 1 || registrations.has(key) || !owner || service.generation !== owner.generation || service.scope !== owner.scope || service.sessionId !== (owner.scope === "session" ? sessionId : null)) fail("INVALID_EVENT", "Invalid service provider binding or generation");
    registrations.set(key, service);
  }
  const consumers = new Map<string, NonNullable<RunManifest["bindings"]>[number]>();
  for (const binding of manifest.bindings) {
    if (!binding || typeof binding !== "object") fail("INVALID_EVENT", "Invalid service binding entry");
    text(binding.id, "bound service id");
    if (binding.isolation !== null) text(binding.isolation, "binding isolation id");
    if (binding.consumer !== null) text(binding.consumer, "binding consumer");
    const consumer = binding.consumer === null ? undefined : owners.get(binding.consumer);
    const provider = registrations.get(slot(binding.id, binding.isolation));
    const key = JSON.stringify([binding.consumer, binding.id]);
    if (consumers.has(key) || (binding.consumer !== null && !consumer) || !provider || provider.version !== binding.version || (consumer?.scope === "runtime" && provider.scope === "session")) fail("INVALID_EVENT", "Invalid consumer service binding");
    consumers.set(key, binding);
  }
  for (const service of registrations.values()) {
    const own = consumers.get(JSON.stringify([service.owner, service.id]));
    if (!own || own.isolation !== service.isolation || own.version !== service.version) fail("INVALID_EVENT", "Provider must resolve its own service binding");
  }
}
function registryManifest(manifest: RunManifest, sessionId: string, owners: ReadonlyMap<string, RunManifest["plugins"][number]>): void {
  const view = manifest.registryView;
  if (view === undefined) {
    if (manifest.tools.some(tool => tool.registryScope != null)) fail("INVALID_EVENT", "Scoped tools require a registry view");
    return; // Legacy journals do not invent a scope chain.
  }
  if (!view || !Array.isArray(view.chain) || !Array.isArray(view.entries)) fail("INVALID_EVENT", "Invalid registry view");
  const chain = new Set<string>();
  for (const id of view.chain) {
    text(id, "registry scope id");
    if (chain.has(id)) fail("INVALID_EVENT", "Registry scope chain must not repeat");
    chain.add(id);
  }
  const versions = new Map<string, number>();
  const entries = new Map<string, (typeof view.entries)[number]>();
  for (const entry of view.entries) {
    if (!entry || typeof entry !== "object") fail("INVALID_EVENT", "Invalid registry entry");
    text(entry.registry, "registry id"); text(entry.name, "registry entry name");
    if (entry.registryScope !== null) text(entry.registryScope, "entry registry scope");
    const owner = owners.get(entry.owner), key = JSON.stringify([entry.registry, entry.name]);
    if (!Number.isSafeInteger(entry.version) || entry.version < 1 || (versions.has(entry.registry) && versions.get(entry.registry) !== entry.version) || entries.has(key) || !owner ||
        entry.generation !== owner.generation || entry.scope !== owner.scope || entry.sessionId !== (owner.scope === "session" ? sessionId : null) || entry.registryScope !== owner.registryScope ||
        (entry.registryScope !== null && !chain.has(entry.registryScope))) fail("INVALID_EVENT", "Registry entry does not belong to this view and provider generation");
    versions.set(entry.registry, entry.version); entries.set(key, entry);
  }
  const tools = [...entries.values()].filter(entry => entry.registry === "tools");
  if (tools.length !== manifest.tools.length) fail("INVALID_EVENT", "Tool manifest and registry view disagree");
  for (const tool of manifest.tools) {
    const entry = entries.get(JSON.stringify(["tools", tool.name]));
    if (!entry || entry.version !== 1 || entry.owner !== tool.owner || entry.generation !== tool.generation || entry.registryScope !== tool.registryScope) fail("INVALID_EVENT", "Tool does not match its pinned registry entry");
  }
}
function refShape(ref: DefinitionRef): void {
  if (!ref || typeof ref !== "object") fail("INVALID_EVENT", "Expected definition reference");
  choice(ref.kind, ["model", "prompt", "tool", "plugin"]);
  text(ref.id, "definition id"); text(ref.version, "definition version");
  if (typeof ref.hash !== "string" || !/^[a-f0-9]{64}$/.test(ref.hash)) fail("INVALID_EVENT", "Expected SHA-256 definition hash");
}
export function resolveDefinition(state: ReplayState, ref: DefinitionRef, kind = ref.kind): Definition {
  refShape(ref);
  if (ref.kind !== kind) fail("INVALID_EVENT", `Expected ${kind} definition`);
  const value = state.definitions.get(definitionKey(ref));
  if (!value || value.hash !== ref.hash) fail("MISSING_DEFINITION", `Definition content is unavailable: ${ref.kind}/${ref.id}@${ref.version}`);
  return value;
}

function unsettledModelChildren(state: ReplayState, through: number, runId?: string): boolean {
  return state.events.some(event => event.seq <= through && (runId === undefined || event.runId === runId) && event.data.type === "model.completed" && event.data.childCallIds?.some(id => {
    const call = state.calls.get(id);
    if (call?.terminalSeq !== null && call?.terminalSeq !== undefined && call.terminalSeq <= through && call.parentCallId === event.callId) return false;
    return !state.events.some(result => result.seq <= through && result.runId === event.runId && result.data.type === "pipeline.rejected" && result.data.rejectedCallId === id && result.data.parentCallId === event.callId);
  }));
}

/** Pure transition logic; replay never receives tool executors or model clients. */
export function applyInput(state: ReplayState, original: EventInput, timestamp: string): SessionEvent {
  const input = immutable(original);
  const data = input.data;
  if (!data || typeof data !== "object") fail("INVALID_EVENT", "Missing event data");
  text(data.type, "event type");
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) fail("INVALID_EVENT", "Invalid event timestamp");
  const global = data.type === "definition.recorded" || data.type === "configuration.recorded";
  if (global ? input.runId !== null : typeof input.runId !== "string" || !input.runId.trim()) fail("INVALID_EVENT", "Event requires the appropriate runId");
  let run = input.runId === null ? undefined : state.runs.get(input.runId);
  const reconciling = ["model.completed", "model.failed", "tool.completed", "tool.not-executed", "tool.cancelled", "tool.uncertain", "ptc.completed", "ptc.uncertain"].includes(data.type);
  if (!global && data.type !== "run.started" && (!run || (run.status !== "running" && !reconciling))) {
    fail("RUN_STATE", "Event requires a running run (closed runs only allow tool reconciliation)");
  }
  const createsCall = data.type === "model.requested" || data.type === "tool.planned" || data.type === "ptc.started";
  const callEvent = createsCall || data.type.startsWith("tool.") || data.type.startsWith("ptc.") || data.type === "model.completed" || data.type === "model.failed" || data.type === "permission.decided";
  if (callEvent) text(input.callId, "callId");
  else if (input.callId !== undefined || input.parentCallId !== undefined) fail("INVALID_EVENT", "This event is not associated with a call");
  const oldCall = input.callId ? state.calls.get(input.callId) : undefined;
  if (createsCall && oldCall) fail("CALL_STATE", `callId already exists: ${input.callId}`);
  if (callEvent && !createsCall && (!oldCall || oldCall.runId !== input.runId)) fail("CALL_STATE", "Unknown call or wrong runId");
  const parentCallId = input.parentCallId ?? oldCall?.parentCallId ?? null;
  if (parentCallId !== null) {
    text(parentCallId, "parentCallId");
    const parent = state.calls.get(parentCallId);
    if (!parent || parent.runId !== input.runId || parent.callId === input.callId) fail("CALL_STATE", "Unknown parent call or wrong runId");
  }
  if (oldCall && oldCall.parentCallId !== parentCallId) fail("CALL_STATE", "A call's parent cannot change");
  const requireCall = (kind: "model" | "tool" | "ptc", status?: CallState["status"]): CallState => {
    if (!oldCall || oldCall.kind !== kind || (status !== undefined && oldCall.status !== status)) fail("CALL_STATE", `Expected ${kind} call${status ? ` in ${status} state` : ""}`);
    return oldCall;
  };

  switch (data.type) {
    case "configuration.recorded": {
      const configuration = data.configuration;
      text(configuration?.id, "configuration id");
      if (!Number.isSafeInteger(configuration.version) || configuration.version < 1 || contentHash(configuration.values) !== configuration.hash) fail("INVALID_CONFIG", "Invalid configuration revision/hash");
      choice(configuration.reason, ["initial", "L1", "L2"]);
      if (!Number.isFinite(Date.parse(configuration.createdAt))) fail("INVALID_CONFIG", "Invalid configuration timestamp");
      const prior = state.configurations.get(configuration.id);
      if (prior && canonical(prior) !== canonical(configuration)) fail("INVALID_CONFIG", "Configuration identity cannot change content");
      state.configurations.set(configuration.id, configuration);
      break;
    }
    case "definition.recorded": {
      const def = data.definition;
      refShape(def);
      if (contentHash(def.content) !== def.hash) fail("DEFINITION_HASH", "Definition content does not match hash");
      const previous = state.definitions.get(definitionKey(def));
      if (previous && previous.hash !== def.hash) fail("DEFINITION_CONFLICT", "The same definition version cannot change content");
      state.definitions.set(definitionKey(def), def);
      break;
    }
    case "run.started": {
      if (run) fail("RUN_STATE", `runId already exists: ${input.runId}`);
      if (!data.versions || !Array.isArray(data.versions.plugins) || !Array.isArray(data.versions.tools)) fail("INVALID_EVENT", "Missing run versions");
      resolveDefinition(state, data.versions.model, "model");
      resolveDefinition(state, data.versions.prompt, "prompt");
      for (const ref of data.versions.tools) resolveDefinition(state, ref, "tool");
      for (const ref of data.versions.plugins) resolveDefinition(state, ref, "plugin");
      contentHash(data.config);
      if (data.manifest) {
        const recorded = state.configurations.get(data.manifest.configuration.id);
        if (!recorded || canonical(recorded) !== canonical(data.manifest.configuration)) fail("INVALID_CONFIG", "Run references an unrecorded configuration");
        if (!Array.isArray(data.manifest.plugins) || !Array.isArray(data.manifest.tools)) fail("INVALID_EVENT", "Invalid run generation manifest");
        const owners = new Map<string, RunManifest["plugins"][number]>();
        for (const plugin of data.manifest.plugins) {
          text(plugin.id, "manifest plugin id"); text(plugin.version, "manifest plugin version");
          if (plugin.definitionId !== undefined) text(plugin.definitionId, "manifest plugin definition id");
          if (plugin.registryScope !== undefined && plugin.registryScope !== null) text(plugin.registryScope, "plugin registry scope");
          choice(plugin.scope, ["runtime", "session"]);
          if (owners.has(plugin.id) || !Number.isSafeInteger(plugin.generation) || plugin.generation < 1) fail("INVALID_EVENT", "Invalid manifest plugin generation");
          owners.set(plugin.id, plugin);
        }
        const names = new Set<string>();
        for (const tool of data.manifest.tools) {
          text(tool.name, "manifest tool name"); text(tool.description, "manifest tool description", true);
          const owner = owners.get(tool.owner);
          if (names.has(tool.name) || !owner || tool.generation !== owner.generation || tool.scope !== owner.scope || tool.sessionId !== (tool.scope === "session" ? state.sessionId : null)) fail("INVALID_EVENT", "Tool schema does not belong to the manifest's provider generation");
          names.add(tool.name); contentHash(tool.inputSchema);
        }
        serviceManifest(data.manifest, state.sessionId, owners);
        registryManifest(data.manifest, state.sessionId, owners);
      }
      run = { versions: data.versions, config: data.config, status: "running", ...(data.manifest ? { manifest: data.manifest } : {}) };
      state.runs.set(input.runId!, run);
      break;
    }
    case "pipeline.rejected":
      text(data.rejectedCallId, "rejected callId"); text(data.name, "tool name", true); text(data.code, "rejection code");
      if (data.inputPath !== undefined && (typeof data.inputPath !== "string" || !data.inputPath.length || data.inputPath.length > 512 || data.inputPath.includes("\0"))) fail("INVALID_EVENT", "Invalid rejected input path");
      if (data.parentCallId !== null && state.calls.get(data.parentCallId)?.runId !== input.runId) fail("CALL_STATE", "Rejected call has an unknown parent");
      break;
    case "ptc.started":
      contentHash(data.program); contentHash(data.input); contentHash(data.isolation); contentHash(data.limits); text(data.backend, "isolation backend");
      if (!Array.isArray(data.bindings) || data.bindings.some(name => typeof name !== "string" || !name.trim()) || new Set(data.bindings).size !== data.bindings.length) fail("INVALID_EVENT", "Invalid PTC bindings");
      break;
    case "ptc.completed":
      requireCall("ptc", "uncertain"); contentHash(data.result);
      if ([...state.calls.values()].some(call => call.parentCallId === input.callId && call.terminalSeq === null)) fail("UNSETTLED_CALLS", "PTC has unsettled children");
      break;
    case "ptc.uncertain": requireCall("ptc", "uncertain"); contentHash(data.result); break;
    case "user.input": text(data.content, "user content", true); break;
    case "model.requested":
      contentHash(data.request); if (data.budget) requestBudget(data.budget);
      if (data.purpose !== undefined) choice(data.purpose, ["agent", "compaction"]);
      if (data.prompt) resolveDefinition(state, data.prompt, "prompt");
      break;
    case "model.completed":
      requireCall("model", "uncertain"); text(data.text, "model text", true); contentHash(data.response);
      if (data.childCallIds !== undefined) {
        if (!Array.isArray(data.childCallIds) || new Set(data.childCallIds).size !== data.childCallIds.length) fail("INVALID_EVENT", "Invalid model child call ids");
        for (const id of data.childCallIds) { text(id, "model child call id"); if (state.calls.has(id)) fail("CALL_STATE", "Model child call id already exists"); }
      }
      break;
    case "model.failed": requireCall("model", "uncertain"); text(data.reason, "model failure"); break;
    case "context.measured": contentHash(data.measurement); break;
    case "context.compaction":
      text(data.id, "compaction id"); choice(data.phase, ["started", "completed", "failed"]); choice(data.trigger, ["pressure", "context-overflow"]);
      if (!Array.isArray(data.sourceEventSeqs) || data.sourceEventSeqs.some(seq => !Number.isSafeInteger(seq) || seq < 1 || seq > state.events.length)) fail("INVALID_SURFACE", "Invalid compaction sources");
      contentHash(data.detail);
      break;
    case "context.tool-pruned": {
      text(data.callId, "pruned callId");
      if (data.version !== "head-tail-v1" || ![data.thresholdChars, data.headChars, data.tailChars].every(n => Number.isSafeInteger(n) && n >= 0) || data.headChars + data.tailChars + [...PRUNE_MARKER].length >= data.thresholdChars) fail("INVALID_SURFACE", "Invalid pruning recipe");
      const source = state.events[data.sourceSeq - 1];
      if (!Number.isSafeInteger(data.sourceSeq) || source?.data.type !== "tool.completed" || source.callId !== data.callId || state.toolPrunings.has(data.callId)) fail("INVALID_SURFACE", "Pruning requires one confirmed original tool result");
      const original = modelToolResult(source.data.result, data.callId);
      if (canonical(original) === canonical(pruneToolResult(original, data))) fail("INVALID_SURFACE", "Pruning must shrink the model-visible result");
      state.toolPrunings.set(data.callId, data);
      break;
    }
    case "tool.planned":
      resolveDefinition(state, data.tool, "tool"); contentHash(data.input);
      if (data.inputHash !== undefined && !/^[a-f0-9]{64}$/.test(data.inputHash)) fail("INVALID_EVENT", "Invalid input hash");
      if (!run!.versions.tools.some(ref => definitionKey(ref) === definitionKey(data.tool) && ref.hash === data.tool.hash)) fail("DEFINITION_CONFLICT", "Tool was not included in this run's version manifest");
      choice(data.effect, ["read", "idempotent-write", "non-idempotent-write"]);
      if (data.idempotencyKey !== undefined) text(data.idempotencyKey, "idempotency key");
      break;
    case "permission.decided":
      requireCall("tool", "not-started"); choice(data.decision, ["allow", "deny"]); text(data.reason, "permission reason", true);
      if (data.approval) {
        const approval = data.approval, plan = oldCall!.planned.data;
        text(approval.approvalId, "approvalId"); text(approval.workspace, "approval workspace"); text(approval.policyVersion, "approval policyVersion");
        if (plan.type !== "tool.planned" || approval.callId !== input.callId || approval.runId !== input.runId || approval.sessionId !== state.sessionId || approval.argumentsHash !== (plan.inputHash ?? contentHash(plan.input)) || !Number.isSafeInteger(approval.expiresAt) || approval.expiresAt <= Date.parse(timestamp)) fail("APPROVAL_MISMATCH", "Recorded approval does not bind this call, arguments, or valid expiry");
        if (!approval.tool || !Number.isSafeInteger(approval.tool.generation) || approval.tool.generation < 1 || !/^[a-f0-9]{64}$/.test(approval.tool.schemaHash)) fail("APPROVAL_MISMATCH", "Invalid approval tool identity");
        if (run?.manifest && !run.manifest.tools.some(tool => tool.name === approval.tool.name && tool.owner === approval.tool.owner && tool.generation === approval.tool.generation && contentHash(tool.inputSchema) === approval.tool.schemaHash)) fail("APPROVAL_MISMATCH", "Approval does not match the pinned tool generation");
      }
      break;
    case "tool.started":
      if (requireCall("tool", "not-started").permission !== "allow") fail("PERMISSION_REQUIRED", "Tool needs an allow decision before execution");
      break;
    case "tool.uncertain": requireCall("tool", "uncertain"); text(data.reason, "uncertainty reason"); break;
    case "tool.completed":
      requireCall("tool", "uncertain"); choice(data.outcome, ["success", "error"]);
      choice(data.confirmation, ["direct", "status-query", "idempotency-key"]); contentHash(data.result);
      if (data.confirmation !== "direct") contentHash(data.evidence);
      break;
    case "tool.not-executed": requireCall("tool", "uncertain"); contentHash(data.evidence); break;
    case "tool.cancelled": requireCall("tool", "not-started"); text(data.reason, "cancellation reason"); break;
    case "budget.exited":
      choice(data.budget, ["tokens", "time", "cost", "steps", "bytes"]); text(data.reason, "budget reason", true);
      if (![data.limit, data.used].every(value => Number.isFinite(value) && value >= 0)) fail("INVALID_EVENT", "Budget values must be finite and nonnegative");
      if (data.requestBudget) requestBudget(data.requestBudget);
      break;
    case "task.status":
      text(data.taskId, "taskId"); choice(data.status, ["pending", "running", "completed", "failed", "cancelled"]); text(data.detail, "task detail", true); break;
    case "protected.recorded":
      text(data.id, "protected id"); choice(data.kind, ["constraint", "protected"]); text(data.content, "protected content");
      if (state.protected.has(data.id)) fail("PROTECTED_CONFLICT", "Protected information cannot be overwritten; use a new id");
      break;
    case "summary.recorded": {
      text(data.id, "summary id"); text(data.version, "summary version"); text(data.text, "summary text");
      if (!data.coverage || data.coverage.from !== 1 || !Number.isSafeInteger(data.coverage.to) || data.coverage.to < 1 || data.coverage.to > state.events.length) {
        fail("INVALID_COVERAGE", "Summary coverage must be an existing contiguous prefix [1, to]");
      }
      const prior = state.summary?.data;
      if (prior?.type === "summary.recorded" && prior.coverage.to > data.coverage.to) fail("INVALID_COVERAGE", "Summary coverage cannot move backwards");
      if (state.summaries.has(canonical([data.id, data.version]))) fail("SUMMARY_CONFLICT", "Summary id/version already exists");
      for (const call of state.calls.values()) {
        if (call.firstSeq <= data.coverage.to && (call.terminalSeq === null || call.terminalSeq > data.coverage.to)) {
          fail("UNSETTLED_COVERAGE", `Summary would split or hide call ${call.callId}`);
        }
      }
      if (unsettledModelChildren(state, data.coverage.to)) fail("UNSETTLED_COVERAGE", "Summary would hide a model tool batch before all child results are covered");
      state.summaries.add(canonical([data.id, data.version]));
      break;
    }
    case "surface.replaced":
      text(data.id, "summary id"); text(data.version, "summary version"); text(data.text, "summary text");
      if (state.summaries.has(canonical([data.id, data.version]))) fail("SUMMARY_CONFLICT", "Summary id/version already exists");
      state.summaries.add(canonical([data.id, data.version]));
      break;
    case "run.finished":
      choice(data.status, ["completed", "failed", "cancelled", "budget-exited"]);
      if (data.status === "completed" && [...state.calls.values()].some(call => call.runId === input.runId && call.terminalSeq === null)) fail("UNSETTLED_CALLS", "Successful run cannot leave unsettled calls");
      if (data.status === "completed" && unsettledModelChildren(state, state.events.length, input.runId!)) fail("UNSETTLED_CALLS", "Successful run cannot leave unplanned model tool calls");
      state.runs.set(input.runId!, { ...run!, status: data.status });
      break;
    default: fail("INVALID_EVENT", `Unknown event type: ${(data as { type: string }).type}`);
  }

  const event: SessionEvent = immutable({
    schemaVersion: 1, sessionId: state.sessionId, seq: state.events.length + 1, timestamp,
    runId: input.runId, callId: input.callId ?? null, parentCallId,
    versions: run?.versions ?? null,
    tool: data.type === "tool.planned" ? data.tool : oldCall?.planned.tool ?? null,
    configHash: contentHash(run?.config ?? null), data,
  });
  if ((data.type === "model.completed" || data.type === "model.failed") && data.chargedTokens !== undefined && (!Number.isSafeInteger(data.chargedTokens) || data.chargedTokens < 0)) fail("INVALID_EVENT", "Invalid model token accounting");
  if (createsCall) {
    state.calls.set(input.callId!, immutable({
      callId: input.callId!, parentCallId, runId: input.runId!, kind: data.type === "tool.planned" ? "tool" : data.type === "ptc.started" ? "ptc" : "model",
      firstSeq: event.seq, terminalSeq: null, status: data.type === "tool.planned" ? "not-started" : "uncertain", permission: null, planned: event,
    }));
  } else if (oldCall) {
    let status = oldCall.status, terminalSeq = oldCall.terminalSeq, permission = oldCall.permission;
    if (data.type === "permission.decided") permission = data.decision;
    if (data.type === "tool.started") status = "uncertain";
    if (data.type === "tool.not-executed") { status = "not-started"; permission = null; }
    if (["model.completed", "model.failed", "tool.completed", "tool.cancelled", "ptc.completed"].includes(data.type)) { status = "confirmed-complete"; terminalSeq = event.seq; }
    state.calls.set(oldCall.callId, immutable({ ...oldCall, status, terminalSeq, permission }));
  }
  if (data.type === "task.status") state.tasks.set(data.taskId, event);
  if (data.type === "protected.recorded") state.protected.set(data.id, event);
  if (data.type === "summary.recorded") state.summary = event;
  applySurface(state.surface, event, state.events, state.calls);
  state.events.push(event);
  return event;
}

export function replay(sessionId: string, events: readonly SessionEvent[]): ReplayState {
  const state = emptyState(sessionId);
  for (const event of events) {
    if (!event || event.schemaVersion !== 1 || event.sessionId !== sessionId || event.seq !== state.events.length + 1) fail("INVALID_LOG", "Event schema, session id, or sequence mismatch");
    const expected = applyInput(state, {
      runId: event.runId, ...(event.callId === null ? {} : { callId: event.callId }),
      ...(event.parentCallId === null ? {} : { parentCallId: event.parentCallId }), data: event.data,
    }, event.timestamp);
    if (canonical(event) !== canonical(expected)) fail("INVALID_LOG", "Event provenance does not match retained run/call definitions");
  }
  return state;
}

export function stateView(state: ReplayState): SessionState {
  return immutable({ throughSeq: state.events.length, calls: [...state.calls.values()], tasks: [...state.tasks.values()],
    protected: [...state.protected.values()], runs: [...state.runs].map(([runId, run]) => ({ runId, status: run.status })), summary: state.summary, surface: state.surface, toolPrunings: [...state.toolPrunings.values()] });
}
