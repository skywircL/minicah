import { resolve } from "node:path";
import { API_VERSION, serviceToken, type JsonValue, type Plugin } from "../types.js";
import { HarnessError, fail, throwCollected } from "../errors.js";
import { copyPlugin, freezeJson } from "../plan.js";
import { pluginInstanceId } from "../isolation.js";
import { contentHash } from "../json.js";
import type { PluginChange, PluginState, Runtime } from "../runtime.js";
import { commandRegistry } from "../cli/commands.js";
import { overlayConfig, readHotReloadProfile } from "./profile.js";
import { watchFile, type WatchOptions } from "./watch.js";

export { parseHotReloadProfile, readHotReloadProfile } from "./profile.js";
export type { HotReloadProfile } from "./profile.js";
export interface HotReloadEntry {
  readonly plugin: Plugin;
  /** Startup fallback for catalog entries which are initially disabled. */
  readonly config?: JsonValue;
  /** Set false to allow configuration edits without allowing disable/enable. */
  readonly toggle?: boolean;
}
export interface HotReloadOptions extends WatchOptions {
  readonly path: string;
  /** Trusted Host catalog. Files cannot import code or invent providers. */
  readonly catalog: readonly HotReloadEntry[];
  readonly watch?: boolean;
  readonly debounceMs?: number;
  /** Explicit code/dependency files: edits report restart-required; no module-cache rewriting. */
  readonly codePaths?: readonly string[];
}
export interface ReloadReport {
  readonly sequence: number;
  readonly source: "startup" | "watch" | "manual" | "code";
  readonly status: "applied" | "unchanged" | "failed" | "restart-required";
  readonly at: string;
  readonly configurationVersion: number;
  readonly configurationHash: string;
  readonly profileHash: string | null;
  readonly operationId: string | null;
  readonly code: string | null;
}
export interface HotReloadStatus {
  readonly path: string;
  readonly watching: boolean;
  readonly closed: boolean;
  readonly restartRequired: boolean;
  readonly restartPaths: readonly string[];
  readonly plugins: readonly (PluginState & { readonly configurable: boolean; readonly toggle: boolean })[];
  readonly available: readonly string[];
  readonly last: ReloadReport | null;
}
export interface HotReloadService { status(): HotReloadStatus; history(): readonly ReloadReport[] }
export const hotReloadService = serviceToken<HotReloadService>("HotReloadService");

class HotReload implements HotReloadService {
  readonly #options: HotReloadOptions;
  readonly #catalog = new Map<string, HotReloadEntry>();
  readonly #baseline = new Map<string, { enabled: boolean; config: JsonValue | undefined }>();
  readonly #listeners = new Set<(report: ReloadReport) => void>();
  readonly #reports: ReloadReport[] = [];
  readonly #restartPaths = new Set<string>();
  readonly #abort = new AbortController();
  readonly #reads = new Set<Promise<unknown>>();
  readonly #watchOpenings = new Set<Promise<() => Promise<void>>>();
  #runtime: Runtime | undefined;
  #watchers: (() => Promise<void>)[] = [];
  #tail: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #dirty = false;
  #automatic: Promise<void> | undefined;
  #watching = false;
  #closed = false;
  #closeTask: Promise<void> | undefined;
  #starting: Promise<ReloadReport> | undefined;
  #sequence = 0;
  #pendingRestart = false;
  constructor(options: HotReloadOptions) {
    this.#options = { ...options, path: resolve(options.path), codePaths: Object.freeze((options.codePaths ?? []).map(path => resolve(path))) };
    for (const value of [options.debounceMs ?? 100, options.stabilityMs ?? 250, options.pollIntervalMs ?? 50]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) fail("INVALID_CONFIG", "Watcher durations must be 1–60000 ms");
    }
    for (const entry of options.catalog) {
      const plugin = copyPlugin(entry.plugin), id = pluginInstanceId(plugin);
      if (id === "hot-reload" || this.#catalog.has(id)) fail("INVALID_CONFIG", "Hot reload catalog has a duplicate or owns its controller");
      this.#catalog.set(id, { ...entry, plugin, ...(entry.config === undefined ? {} : { config: freezeJson(entry.config) }) });
    }
  }
  start(runtime: Runtime): Promise<ReloadReport> {
    if (this.#closed) return Promise.reject(new HarnessError("HMR_CLOSED", "Hot reload is closed"));
    if (this.#runtime && this.#runtime !== runtime) return Promise.reject(new HarnessError("HMR_RUNTIME", "Hot reload is already attached"));
    return this.#starting ??= this.#start(runtime);
  }
  async #start(runtime: Runtime): Promise<ReloadReport> {
    this.#runtime = runtime;
    const active = new Set(runtime.plugins().map(plugin => plugin.id));
    for (const [id, entry] of this.#catalog) this.#baseline.set(id, { enabled: active.has(id), config: active.has(id) ? runtime.configurationInput(id) : entry.config });
    try {
      if (this.#options.watch !== false) {
        const paths = new Set([this.#options.path, ...this.#options.codePaths ?? []]);
        for (const path of paths) {
          const opening = watchFile(path, () => {
            if (this.#closed) return;
            if (path === this.#options.path) this.#schedule();
            else {
              this.#restartPaths.add(path);
              this.#report("code", "restart-required", null, null, "CODE_RESTART_REQUIRED");
            }
          }, () => { this.#watching = false; this.#report("watch", "failed", null, null, "WATCH_ERROR"); }, this.#options);
          this.#watchOpenings.add(opening);
          const close = await opening.finally(() => { this.#watchOpenings.delete(opening); });
          if (this.#closed) { await close(); fail("HMR_CLOSED", "Hot reload is closed"); }
          this.#watchers.push(close);
        }
        this.#watching = true;
      }
      // Watch first, then read: a write during startup cannot be lost between read and subscription.
      return await this.#enqueue(() => this.#refresh("startup"));
    } catch (error) { await this.close(); throw error; }
  }
  subscribe(listener: (report: ReloadReport) => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  history(): readonly ReloadReport[] { return Object.freeze([...this.#reports]); }
  status(): HotReloadStatus {
    return Object.freeze({ path: this.#options.path, watching: this.#watching, closed: this.#closed,
      restartRequired: this.#restartPaths.size > 0 || this.#runtime?.health().restartRequired === true || this.#pendingRestart,
      restartPaths: Object.freeze([...this.#restartPaths]), available: Object.freeze([...this.#catalog.keys()]),
      plugins: Object.freeze((this.#runtime?.plugins() ?? []).map(plugin => Object.freeze({ ...plugin,
        configurable: this.#catalog.has(plugin.id), toggle: this.#catalog.has(plugin.id) && this.#catalog.get(plugin.id)!.toggle !== false }))),
      last: this.#reports.at(-1) ?? null });
  }
  reload(): Promise<ReloadReport> { return this.#enqueue(() => this.#refresh("manual")); }
  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.#tail.then(() => { if (this.#closed) fail("HMR_CLOSED", "Hot reload is closed"); return operation(); });
    this.#tail = work.then(() => {}, () => {});
    return work;
  }
  #schedule(): void {
    this.#dirty = true;
    if (this.#automatic) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#automatic = this.#enqueue(async () => {
        while (this.#dirty && !this.#closed) { this.#dirty = false; await this.#refresh("watch"); }
      }).catch(() => {}).finally(() => { this.#automatic = undefined; });
    }, this.#options.debounceMs ?? 100);
  }
  async #refresh(source: ReloadReport["source"]): Promise<ReloadReport> {
    const runtime = this.#runtime;
    if (!runtime) fail("HMR_NOT_STARTED", "Host must attach hot reload before requesting updates");
    let hash: string | null = null;
    try {
      const reading = readHotReloadProfile(this.#options.path);
      this.#reads.add(reading);
      const profile = await reading.finally(() => { this.#reads.delete(reading); });
      this.#abort.signal.throwIfAborted();
      hash = contentHash(profile);
      for (const id of Object.keys(profile.plugins)) if (!this.#catalog.has(id)) fail("PROFILE_PLUGIN", "配置包含不在宿主热更新目录中的插件。");
      const active = new Set(runtime.plugins().map(plugin => plugin.id));
      const changes: PluginChange[] = [], config: Record<string, JsonValue> = Object.create(null), resetConfig: string[] = [];
      for (const [id, entry] of this.#catalog) {
        const baseline = this.#baseline.get(id)!, overlay = Object.hasOwn(profile.plugins, id) ? profile.plugins[id] : undefined;
        const enabled = overlay?.enabled ?? baseline.enabled;
        if (entry.toggle === false && enabled !== baseline.enabled) fail("PROFILE_PROTECTED", "该基础插件允许配置更新，但不允许通过配置文件启停。");
        const value = overlayConfig(baseline.config, overlay?.config);
        // Validate disabled candidates too, without running setup or acquiring resources.
        if ((enabled || overlay?.config !== undefined) && entry.plugin.validateConfig) freezeJson(entry.plugin.validateConfig(value));
        if (enabled) {
          if (!active.has(id)) changes.push({ kind: "enable", plugin: entry.plugin });
          if (value === undefined) resetConfig.push(id); else config[id] = value;
        } else if (active.has(id)) changes.push({ kind: "disable", id });
      }
      this.#abort.signal.throwIfAborted();
      const applied = await runtime.applyUpdate({ changes, config, resetConfig }, this.#abort.signal);
      this.#pendingRestart = applied.status === "restart-required";
      return this.#report(source, applied.status, hash, applied.operationId, applied.status === "restart-required" ? "RESTART_REQUIRED" : null);
    } catch (error) {
      if (this.#closed) throw error;
      return this.#report(source, runtime.health().restartRequired ? "restart-required" : "failed", hash, null,
        error instanceof HarnessError ? error.code : "HOT_RELOAD_FAILED");
    }
  }
  #report(source: ReloadReport["source"], status: ReloadReport["status"], profileHash: string | null, operationId: string | null, code: string | null): ReloadReport {
    const configuration = this.#runtime?.configuration();
    const report = Object.freeze({ sequence: ++this.#sequence, source, status, at: new Date().toISOString(), profileHash, operationId, code,
      configurationVersion: configuration?.version ?? 0, configurationHash: configuration?.hash ?? "" });
    if (this.#closed) return report;
    this.#reports.push(report); if (this.#reports.length > 50) this.#reports.shift();
    for (const listener of this.#listeners) { try { listener(report); } catch { /* UI failure cannot undo a committed update. */ } }
    return report;
  }
  /** Runtime cleanup cancels queued mutations rather than waiting on its own lifecycle queue. */
  close(): Promise<void> {
    if (this.#closeTask) return this.#closeTask;
    this.#closed = true; this.#watching = false; this.#dirty = false; clearTimeout(this.#timer); this.#abort.abort();
    this.#listeners.clear();
    const tasks = [...this.#watchers.splice(0).map(close => close()), ...[...this.#watchOpenings].map(opening => opening.then(close => close())),
      ...[...this.#reads].map(reading => reading.then(() => {}, () => {}))];
    return this.#closeTask = Promise.allSettled(tasks).then(results => {
      throwCollected(results.flatMap(result => result.status === "rejected" ? [result.reason] : []), "Hot reload watcher cleanup failed");
    });
  }
  /** Host entrypoint, outside Runtime/run callbacks: also join the last reload result. */
  async stop(): Promise<void> { await this.close(); await this.#starting?.catch(() => {}); await this.#tail; }
}

export interface HotReloadHost extends HotReloadService {
  readonly plugin: Plugin;
  start(runtime: Runtime): Promise<ReloadReport>;
  reload(): Promise<ReloadReport>;
  subscribe(listener: (report: ReloadReport) => void): () => void;
  stop(): Promise<void>;
}
/** Lifecycle API stays on the Host facade: a model/run cannot await a mutation that drains itself. */
export function createHotReloadPlugin(options: HotReloadOptions): HotReloadHost {
  const listeners = new Set<(report: ReloadReport) => void>();
  const create = () => {
    const instance = new HotReload(options);
    instance.subscribe(report => { for (const listener of listeners) { try { listener(report); } catch { /* Observer only. */ } } });
    return instance;
  };
  let controller = create(), acquired = false;
  return {
    plugin: { id: "hot-reload", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [hotReloadService], requires: [],
      replacementBoundary: "stop-first", upgradePolicy: "restart-required",
      setup(ctx) {
        const resource = ctx.resource("file-watchers", () => {
          if (acquired) controller = create();
          acquired = true;
          return controller;
        }, resource => resource.close());
        ctx.provide(hotReloadService, () => ({ status: () => resource.get().status(), history: () => resource.get().history() }));
        for (const [name, description] of [["reload", "立即重读热更新配置"], ["plugins", "查看插件版本、代次和热更新状态"]] as const) {
          ctx.register(commandRegistry, name, { usage: "", description, parse: args => args
            ? { kind: "error", text: `/${name} 不接受参数` } : { kind: name } });
        }
      },
    },
    start: runtime => controller.start(runtime), reload: () => controller.reload(), stop: () => controller.stop(),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, status: () => controller.status(), history: () => controller.history(),
  };
}
