import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fail, HarnessError, throwCollected } from "./errors.js";
import { buildPlan, copyPlugin, freezeJson, type Plan } from "./plan.js";
import { RegistrationBatch, registrations } from "./resources.js";
import { createSnapshot } from "./snapshot.js";
import { ConfigurationChannel, configurationVersion } from "./configuration.js";
import { deadline } from "./deadline.js";
import { pluginInstanceId, validateScopes, ServiceScope } from "./isolation.js";
import { validateRegistryScopes } from "./scopes.js";
import type { Awaitable, ConfigurationVersion, JsonValue, Plugin, RegistrationInfo, RunContext, RunOptions, RuntimeOptions, ScopeKind } from "./types.js";

export interface Session {
  readonly id: string;
  run<T>(callback: (run: RunContext) => Awaitable<T>, options?: ServiceScope | RunOptions): Promise<T>;
  close(): Promise<void>;
}
export interface UpgradeResult {
  readonly operationId: string;
  readonly pluginId: string;
  readonly kind: "enable" | "disable" | "replace";
  readonly boundary: "drained" | "stop-first";
  readonly status: "switched" | "failed" | "restart-required";
  readonly switched: boolean;
  readonly generation: number;
  readonly cleanupErrors: readonly unknown[];
}
export type ReplacementResult = UpgradeResult;
export type PluginChange =
  | { readonly kind: "enable"; readonly plugin: Plugin | string }
  | { readonly kind: "replace"; readonly plugin: Plugin }
  | { readonly kind: "disable"; readonly id: string };
export interface RuntimeUpdate {
  readonly changes?: readonly PluginChange[];
  readonly config?: Readonly<Record<string, JsonValue>>;
  readonly resetConfig?: readonly string[];
}
export interface RuntimeUpdateResult {
  readonly operationId: string;
  readonly status: "unchanged" | "applied" | "restart-required";
  readonly configuration: ConfigurationVersion;
  readonly upgrades: readonly UpgradeResult[];
}
export interface PluginState {
  readonly id: string;
  readonly definitionId: string;
  readonly version: string;
  readonly scope: ScopeKind;
  readonly configMode: "run" | "static";
  readonly generation: number;
}
interface SessionState { id: string; batches: RegistrationBatch[]; closed: boolean; closePromise?: Promise<void> }
interface OperationContext { active: boolean }

export class Runtime {
  #plan: Plan;
  #config: Readonly<Record<string, JsonValue>>;
  #catalog: Map<string, Plugin>;
  #configuration: ConfigurationVersion;
  #configHistory: ConfigurationVersion[];
  #configChannel = new ConfigurationChannel();
  #batches: RegistrationBatch[] = [];
  #sessions = new Map<string, SessionState>();
  #generations = new Map<string, number>();
  #lastGeneration = new Map<string, number>();
  #tail: Promise<void> = Promise.resolve();
  #barrier: { promise: Promise<void>; release: () => void } | undefined;
  #activeRuns = 0;
  #idle: (() => void) | undefined;
  #closing = false;
  #closed = false;
  #restartRequired = false;
  #unresolved = new Set<RegistrationBatch>();
  #upgradeResults: UpgradeResult[] = [];
  #closePromise: Promise<void> | undefined;
  #operation = new AsyncLocalStorage<OperationContext>();
  readonly #drainTimeoutMs: number;
  readonly #cleanupTimeoutMs: number;

  private constructor(options: RuntimeOptions) {
    this.#drainTimeoutMs = options.drainTimeoutMs ?? 30_000;
    this.#cleanupTimeoutMs = options.cleanupTimeoutMs ?? 10_000;
    for (const value of [this.#drainTimeoutMs, this.#cleanupTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) fail("INVALID_CONFIG", "Lifecycle timeouts must be positive timer durations");
    }
    this.#config = freezeJson(options.config ?? {});
    this.#plan = buildPlan({ plugins: options.plugins, config: this.#config });
    this.#catalog = new Map(this.#plan.plugins.map(plugin => [pluginInstanceId(plugin), plugin]));
    this.#configuration = configurationVersion(1, this.#plan.configs, "initial");
    this.#configChannel.publish(this.#configuration);
    this.#configHistory = [this.#configuration];
    for (const plugin of this.#plan.plugins) {
      this.#generations.set(pluginInstanceId(plugin), 1); this.#lastGeneration.set(pluginInstanceId(plugin), 1);
    }
  }

  static async create(options: RuntimeOptions): Promise<Runtime> {
    const runtime = new Runtime(options);
    runtime.#batches = await runtime.#prepare(runtime.#plan.plugins.filter(plugin => plugin.scope === "runtime"), runtime.#plan, "runtime", undefined, [], runtime.#generations);
    try { for (const batch of runtime.#batches) await batch.activate(); }
    catch (cause) {
      const errors = await runtime.#dispose(runtime.#batches);
      throw new HarnessError("SETUP_FAILED", "Runtime activation failed", { cause: new AggregateError([cause, ...errors]) });
    }
    return runtime;
  }

  configuration(): ConfigurationVersion { return this.#configuration; }
  /** Original immutable input, for overlays; normalized schema output need not be a valid input. */
  configurationInput(pluginId: string): JsonValue | undefined { return Object.hasOwn(this.#config, pluginId) ? this.#config[pluginId] : undefined; }
  plugins(): readonly PluginState[] {
    return Object.freeze(this.#plan.plugins.map(plugin => Object.freeze({ id: pluginInstanceId(plugin), definitionId: plugin.id,
      version: plugin.version, scope: plugin.scope, configMode: plugin.configMode ?? "static", generation: this.#generations.get(pluginInstanceId(plugin))! })));
  }
  configurationHistory(): readonly ConfigurationVersion[] { return Object.freeze([...this.#configHistory]); }
  upgradeHistory(): readonly UpgradeResult[] { return Object.freeze([...this.#upgradeResults]); }
  health() { return Object.freeze({ restartRequired: this.#restartRequired, unresolved: Object.freeze([...this.#unresolved].flatMap(batch => batch.inspect())) }); }
  inspect(): readonly RegistrationInfo[] {
    return Object.freeze([...this.#batches, ...[...this.#sessions.values()].flatMap(session => session.batches)].flatMap(batch => batch.inspect()));
  }

  updateConfig(patch: Readonly<Record<string, JsonValue>>): Promise<ConfigurationVersion> {
    this.#assertMutationAllowed();
    patch = freezeJson(patch);
    return this.#serialize(async () => {
      this.#assertHealthy();
      for (const id of Object.keys(patch)) {
        const plugin = this.#plan.plugins.find(item => pluginInstanceId(item) === id);
        if (!plugin) fail("MISSING_PLUGIN", `No enabled plugin: ${id}`);
        if (plugin.configMode !== "run" || !plugin.validateConfig) fail("STATIC_CONFIG", `${id} requires L2 replacement for configuration changes`);
      }
      const raw = freezeJson({ ...this.#config, ...patch });
      const plan = this.#build(this.#plan.plugins, raw);
      const next = configurationVersion(this.#configuration.version + 1, plan.configs, "L1");
      if (next.hash === this.#configuration.hash) return this.#configuration;
      this.#config = raw; this.#plan = plan;
      const errors = this.#publishConfiguration(next);
      if (errors.length) throw new HarnessError("RESTART_REQUIRED", "Configuration committed but invalidation failed", { cause: new AggregateError(errors) });
      return next;
    });
  }

  openSession(id?: string): Promise<Session> {
    this.#assertMutationAllowed();
    const sessionId = id ?? `session-${randomUUID()}`;
    if (!sessionId.trim()) fail("INVALID_SESSION", "Session id must not be empty");
    return this.#serialize(() => this.#withBarrier(async () => {
      this.#assertHealthy();
      if (this.#sessions.has(sessionId)) fail("DUPLICATE_SESSION", `Session already exists: ${sessionId}`);
      const batches = await this.#prepare(this.#plan.plugins.filter(plugin => plugin.scope === "session"), this.#plan, "session", sessionId, this.#batches, this.#generations);
      try { for (const batch of batches) await batch.activate(); }
      catch (cause) {
        const errors = await this.#dispose(batches);
        throw new HarnessError("SETUP_FAILED", `Session activation failed: ${sessionId}`, { cause: new AggregateError([cause, ...errors]) });
      }
      const state: SessionState = { id: sessionId, batches, closed: false };
      this.#sessions.set(sessionId, state);
      return Object.freeze({ id: sessionId, run: <T>(callback: (run: RunContext) => Awaitable<T>, options?: ServiceScope | RunOptions) => this.#run(state, callback, options), close: () => this.#closeSession(state) });
    }));
  }

  replacePlugin(plugin: Plugin, config?: JsonValue): Promise<UpgradeResult> {
    this.#assertMutationAllowed();
    const copied = copyPlugin(plugin);
    return this.#upgrade("replace", pluginInstanceId(copied), copied, freezeJson(config));
  }
  disablePlugin(id: string): Promise<UpgradeResult> {
    this.#assertMutationAllowed(); return this.#upgrade("disable", id);
  }
  enablePlugin(plugin: Plugin | string, config?: JsonValue): Promise<UpgradeResult> {
    this.#assertMutationAllowed();
    const copied = typeof plugin === "string" ? undefined : copyPlugin(plugin);
    return this.#upgrade("enable", typeof plugin === "string" ? plugin : pluginInstanceId(copied!), copied, freezeJson(config));
  }

  #upgrade(kind: UpgradeResult["kind"], id: string, descriptor?: Plugin, config?: JsonValue): Promise<UpgradeResult> {
    const change: PluginChange = kind === "disable" ? { kind, id }
      : kind === "replace" ? { kind, plugin: descriptor! } : { kind, plugin: descriptor ?? id };
    return this.applyUpdate({ changes: [change], ...(config === undefined ? {} : { config: { [id]: config } }) })
      .then(result => result.upgrades[0]!);
  }

  /** Reconcile one complete change set: validate the final graph, stage, then publish at one boundary. */
  applyUpdate(update: RuntimeUpdate, signal?: AbortSignal): Promise<RuntimeUpdateResult> {
    this.#assertMutationAllowed();
    const requested = (update.changes ?? []).map(change => change.kind === "disable" ? { ...change }
      : { ...change, plugin: typeof change.plugin === "string" ? change.plugin : copyPlugin(change.plugin) }) as PluginChange[];
    const patch = freezeJson(update.config ?? {}), reset = [...update.resetConfig ?? []];
    return this.#serialize(async () => {
      this.#assertHealthy(); signal?.throwIfAborted();
      const operationId = randomUUID();
      const changes = new Map<string, { kind: UpgradeResult["kind"]; plugin?: Plugin; previous?: Plugin; supplied: boolean }>();
      let boundary: UpgradeResult["boundary"] = "drained";
      let validated = false, stopped = false, switched = false;
      const staged: { session?: SessionState; batches: RegistrationBatch[] }[] = [];
      const rollbackErrors: unknown[] = [];
      const generations = new Map(this.#generations);
      const publish = (status: UpgradeResult["status"]): readonly UpgradeResult[] => {
        const results = [...changes].map(([id, change]) => Object.freeze({ operationId, pluginId: id, kind: change.kind,
          boundary, status, switched, generation: generations.get(id) ?? 0, cleanupErrors: Object.freeze([...rollbackErrors]) }));
        this.#upgradeResults.push(...results);
        return Object.freeze(results);
      };
      const result = (status: RuntimeUpdateResult["status"], upgrades: readonly UpgradeResult[] = []): RuntimeUpdateResult =>
        Object.freeze({ operationId, status, configuration: this.#configuration, upgrades });
      try {
        const definitions = new Map(this.#plan.plugins.map(plugin => [pluginInstanceId(plugin), plugin]));
        for (const request of requested) {
          const id = request.kind === "disable" ? request.id : typeof request.plugin === "string" ? request.plugin : pluginInstanceId(request.plugin);
          if (changes.has(id)) fail("DUPLICATE_PLUGIN", `Duplicate change for ${id}`);
          const previous = definitions.get(id);
          if (request.kind !== "enable" && !previous) fail("MISSING_PLUGIN", `No enabled plugin: ${id}`);
          if (request.kind === "enable" && previous) fail("DUPLICATE_PLUGIN", `Plugin already enabled: ${id}`);
          const plugin = request.kind === "disable" ? undefined : typeof request.plugin === "string" ? this.#catalog.get(id) : request.plugin;
          if (request.kind !== "disable" && !plugin) fail("MISSING_PLUGIN", `Unknown plugin: ${id}`);
          if (previous && plugin && previous.scope !== plugin.scope) fail("SCOPE_CHANGE", `Replacement must preserve the scope of ${id}`);
          changes.set(id, { kind: request.kind, ...(plugin ? { plugin } : {}), ...(previous ? { previous } : {}), supplied: request.kind !== "disable" && typeof request.plugin !== "string" });
          if (plugin) definitions.set(id, plugin); else definitions.delete(id);
        }
        for (const id of [...Object.keys(patch), ...reset]) {
          if (!definitions.has(id)) fail("MISSING_PLUGIN", `Cannot configure disabled or unknown plugin: ${id}`);
        }
        const raw = freezeJson({ ...Object.fromEntries(Object.entries(this.#config).filter(([id]) => !reset.includes(id))), ...patch });
        const plan = this.#build([...definitions.values()], raw);
        // Static config changes use the same L2 transaction as explicit replacements.
        for (const plugin of plan.plugins) {
          const id = pluginInstanceId(plugin);
          if (changes.has(id) || isDeepStrictEqual(this.#plan.configs.get(id), plan.configs.get(id)) || plugin.configMode === "run") continue;
          changes.set(id, { kind: "replace", plugin, previous: definitions.get(id)!, supplied: false });
        }
        for (const [id, change] of changes) {
          if (change.previous?.replacementBoundary === "stop-first" || change.plugin?.replacementBoundary === "stop-first") boundary = "stop-first";
          const restart = change.previous?.upgradePolicy === "restart-required" || change.plugin?.upgradePolicy === "restart-required" || this.#catalog.get(id)?.upgradePolicy === "restart-required";
          if (restart && (change.kind === "replace" || (change.kind === "enable" && change.supplied))) {
            return result("restart-required", publish("restart-required"));
          }
        }
        validated = true;
        const configuration = configurationVersion(this.#configuration.version + 1, plan.configs, changes.size ? "L2" : "L1");
        if (!changes.size) {
          this.#config = raw; this.#plan = plan;
          if (configuration.hash === this.#configuration.hash) return result("unchanged");
          const errors = this.#publishConfiguration(configuration);
          if (errors.length) throw new HarnessError("RESTART_REQUIRED", "Configuration committed but invalidation failed", { cause: new AggregateError(errors) });
          return result("applied");
        }
        for (const id of changes.keys()) {
          const generation = (this.#lastGeneration.get(id) ?? 0) + 1;
          generations.set(id, generation); this.#lastGeneration.set(id, generation);
        }
        const keep = (batch: RegistrationBatch) => !changes.has(batch.ownership.owner);
        const candidates = plan.plugins.filter(plugin => changes.has(pluginInstanceId(plugin)));
        const retainedRuntime = this.#batches.filter(keep);
        const runtimeCandidates = await this.#prepare(candidates.filter(plugin => plugin.scope === "runtime"), plan, "runtime", undefined,
          [...retainedRuntime, ...[...this.#sessions.values()].flatMap(session => session.batches.filter(keep))], generations, true);
        staged.push({ batches: runtimeCandidates });
        for (const session of this.#sessions.values()) {
          staged.push({ session, batches: await this.#prepare(candidates.filter(plugin => plugin.scope === "session"), plan, "session", session.id,
            [...retainedRuntime, ...runtimeCandidates, ...session.batches.filter(keep)], generations, true) });
        }
        signal?.throwIfAborted();
        return await this.#withBarrier(async () => {
          try {
            signal?.throwIfAborted();
            const retired = [...this.#batches, ...[...this.#sessions.values()].flatMap(session => session.batches)].filter(batch => !keep(batch));
            const removeOld = () => {
              this.#batches = this.#batches.filter(keep);
              for (const session of this.#sessions.values()) session.batches = session.batches.filter(keep);
            };
            if (boundary === "stop-first") {
              stopped = retired.length > 0; removeOld();
              rollbackErrors.push(...await this.#dispose(retired));
              if (rollbackErrors.length) {
                rollbackErrors.push(...await this.#dispose(staged.flatMap(entry => entry.batches)));
                staged.length = 0;
                return result("restart-required", publish("restart-required"));
              }
            }
            for (const entry of staged) for (const batch of entry.batches) await batch.activate(configuration);
            removeOld();
            const order = new Map(plan.plugins.map((item, index) => [pluginInstanceId(item), index]));
            for (const entry of staged) {
              const current = entry.session ? entry.session.batches : this.#batches;
              const next = [...current, ...entry.batches].sort((a, b) => order.get(a.ownership.owner)! - order.get(b.ownership.owner)!);
              if (entry.session) entry.session.batches = next; else this.#batches = next;
            }
            this.#plan = plan; this.#config = raw; this.#generations = generations;
            for (const [id, change] of changes) if (change.plugin) this.#catalog.set(id, change.plugin);
            switched = true;
            rollbackErrors.push(...this.#publishConfiguration(configuration));
            if (boundary !== "stop-first") rollbackErrors.push(...await this.#dispose(retired));
            return result(rollbackErrors.length ? "restart-required" : "applied", publish(rollbackErrors.length ? "restart-required" : "switched"));
          } catch (cause) {
            if (!switched) rollbackErrors.push(...await this.#dispose(staged.flatMap(entry => entry.batches)));
            if (stopped || switched) this.#restartRequired = true;
            staged.length = 0;
            throw cause;
          }
        });
      } catch (cause) {
        rollbackErrors.push(...await this.#dispose(staged.flatMap(entry => entry.batches)));
        if (stopped || switched || rollbackErrors.length) this.#restartRequired = true;
        const upgrades = publish(this.#restartRequired ? "restart-required" : "failed");
        if (this.#restartRequired) throw new HarnessError("RESTART_REQUIRED", "Update cannot safely roll back", { cause: { error: cause, upgrades } });
        if (!validated || !changes.size) throw cause;
        throw new HarnessError("REPLACEMENT_FAILED", "Update rolled back", { cause: { error: cause, upgrades } });
      }
    });
  }

  close(): Promise<void> {
    this.#assertNotReentrant();
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = this.#serialize(() => this.#withBarrier(async () => {
      const errors: unknown[] = [];
      for (const session of [...this.#sessions.values()].reverse()) {
        session.closed = true; errors.push(...await this.#dispose(session.batches)); session.batches = [];
      }
      this.#sessions.clear(); errors.push(...await this.#dispose(this.#batches)); this.#batches = []; this.#closed = true;
      if (this.#unresolved.size && !errors.length) errors.push(new HarnessError("RESTART_REQUIRED", "Previously failed resources remain unresolved"));
      throwCollected(errors, "Runtime shutdown failed");
    }));
    return this.#closePromise;
  }

  #build(plugins: readonly Plugin[], config: Readonly<Record<string, JsonValue>>): Plan {
    const ids = new Set(plugins.map(pluginInstanceId));
    return buildPlan({ plugins, config: Object.fromEntries(Object.entries(config).filter(([id]) => ids.has(id))) });
  }
  #publishConfiguration(configuration: ConfigurationVersion): unknown[] {
    this.#configuration = configuration; this.#configHistory.push(configuration);
    const errors = this.#configChannel.publish(configuration);
    if (errors.length) this.#restartRequired = true;
    return errors;
  }
  async #prepare(plugins: readonly Plugin[], plan: Plan, scope: ScopeKind, sessionId: string | undefined, base: readonly RegistrationBatch[], generations: ReadonlyMap<string, number>, candidate = false): Promise<RegistrationBatch[]> {
    const batches: RegistrationBatch[] = [];
    try {
      for (const plugin of plugins) {
        const id = pluginInstanceId(plugin);
        const occupied = registrations([...base, ...batches]);
        const batch = new RegistrationBatch(plugin, Object.freeze({ owner: id, generation: generations.get(id)!, scope, sessionId }), new Set(occupied.services.keys()), occupied.entries, this.#configChannel, candidate, this.#cleanupTimeoutMs);
        batches.push(batch); await batch.setup(plan.configs.get(id));
      }
      return batches;
    } catch (cause) {
      const errors = await this.#dispose(batches);
      throw new HarnessError("SETUP_FAILED", `Plugin setup failed in ${scope} scope`, { cause: new AggregateError([cause, ...errors]) });
    }
  }
  async #dispose(batches: readonly RegistrationBatch[]): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const batch of [...batches].reverse()) {
      try { await batch.dispose(); }
      catch (error) { errors.push(error); this.#unresolved.add(batch); this.#restartRequired = true; }
    }
    return errors;
  }

  async #run<T>(session: SessionState, callback: (run: RunContext) => Awaitable<T>, options?: ServiceScope | RunOptions): Promise<T> {
    this.#assertNotReentrant();
    if (options !== undefined && !(options instanceof ServiceScope) && (!options || typeof options !== "object" || Object.getPrototypeOf(options) !== Object.prototype || Object.keys(options).some(key => key !== "serviceScope" && key !== "registryScope"))) fail("INVALID_RUN_OPTIONS", "Expected ServiceScope or { serviceScope, registryScope }");
    const { serviceScope, registryScope } = options instanceof ServiceScope ? { serviceScope: options, registryScope: undefined } : { ...options };
    while (this.#barrier) await this.#barrier.promise;
    if (this.#closing || this.#closed) fail("RUNTIME_CLOSED", "Runtime is closing or closed");
    if (session.closed || session.closePromise) fail("SESSION_CLOSED", `Session is closed: ${session.id}`);
    this.#assertHealthy();
    validateScopes([...this.#plan.plugins.map(plugin => plugin.serviceScope), serviceScope]);
    validateRegistryScopes([...this.#plan.plugins.map(plugin => plugin.registryScope), registryScope]);
    this.#activeRuns++;
    const operation = { active: true };
    return this.#operation.run(operation, async () => {
      let snapshot: ReturnType<typeof createSnapshot> | undefined;
      try {
        snapshot = createSnapshot(`run-${randomUUID()}`, session.id, [...this.#batches, ...session.batches], this.#configuration, serviceScope, registryScope);
        return await callback(snapshot.context);
      }
      finally {
        try { await snapshot?.finish(); }
        finally {
          operation.active = false; this.#activeRuns--;
          if (this.#activeRuns === 0) this.#idle?.();
        }
      }
    });
  }
  #closeSession(session: SessionState): Promise<void> {
    this.#assertNotReentrant();
    if (session.closePromise) return session.closePromise;
    if (session.closed) return Promise.resolve();
    if (this.#closing) return this.#closePromise!;
    session.closePromise = this.#serialize(() => this.#withBarrier(async () => {
      session.closed = true; this.#sessions.delete(session.id);
      const errors = await this.#dispose(session.batches); session.batches = [];
      throwCollected(errors, `Session shutdown failed: ${session.id}`);
    }));
    return session.closePromise;
  }
  #assertHealthy(): void { if (this.#restartRequired) fail("RESTART_REQUIRED", "Runtime has unresolved resources or a failed boundary; restart is required"); }
  #assertNotReentrant(): void { if (this.#operation.getStore()?.active) fail("REENTRANT_LIFECYCLE", "Start runs and lifecycle operations outside run/setup/cleanup callbacks"); }
  #assertMutationAllowed(): void {
    this.#assertNotReentrant(); this.#assertHealthy();
    if (this.#closing || this.#closed) fail("RUNTIME_CLOSED", "Runtime is closing or closed");
  }
  #serialize<T>(callback: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(() => {
      const operation = { active: true };
      return this.#operation.run(operation, async () => { try { return await callback(); } finally { operation.active = false; } });
    });
    this.#tail = next.then(() => {}, () => {}); return next;
  }
  async #withBarrier<T>(callback: () => Promise<T>): Promise<T> {
    let release!: () => void;
    this.#barrier = { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
    try {
      if (this.#activeRuns) await deadline(new Promise<void>(resolve => { this.#idle = resolve; }), this.#drainTimeoutMs, "DRAIN_TIMEOUT", "Active runs did not reach the declared upgrade boundary");
      return await callback();
    } finally { this.#idle = undefined; this.#barrier = undefined; release(); }
  }
}
