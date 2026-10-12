import type { ServiceScope } from "./isolation.js";
import type { RegistryScope } from "./scopes.js";
import type { RegistryInfo, RegistrySnapshots, RegistryToken } from "./registry.js";

export const API_VERSION = 1;
export type ScopeKind = "runtime" | "session";
export type Awaitable<T> = T | Promise<T>;
export type Cleanup = () => Awaitable<void>;
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** The phantom member carries T without exposing a concrete implementation. */
export interface ServiceToken<T = unknown> {
  readonly id: string;
  readonly version: number;
  readonly __type?: T;
}

export function serviceToken<T>(id: string, version = 1): ServiceToken<T> {
  return Object.freeze({ id, version });
}

export interface Ownership {
  readonly owner: string;
  readonly generation: number;
  readonly scope: ScopeKind;
  readonly sessionId: string | undefined;
}

export interface RegistrationInfo extends Ownership {
  readonly kind: "service" | "tool" | "registry" | "listener" | "cleanup" | "resource";
  readonly name: string;
  readonly isolation?: string | null;
  readonly registry?: string;
  readonly registryScope?: string | null;
}

export interface ServiceInfo extends Ownership {
  readonly id: string;
  readonly version: number;
  readonly isolation: string | null;
}

export type ToolEffect = "read" | "idempotent-write" | "non-idempotent-write";
export interface ToolExecution { readonly signal: AbortSignal; readonly callId: string; readonly parentCallId: string | null }

export interface ToolInfo extends Ownership {
  readonly registryScope?: string | null;
  readonly effect?: ToolEffect;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonValue;
}

export interface ServiceSnapshot {
  get<T>(token: ServiceToken<T>): T;
  list(): readonly ServiceInfo[];
}

export interface ToolSnapshot {
  list(): readonly ToolInfo[];
  invoke(name: string, input: unknown, beforeExecute?: () => void, execution?: ToolExecution): Promise<unknown>;
}

export interface ConfigurationVersion {
  readonly id: string;
  readonly version: number;
  readonly reason: "initial" | "L1" | "L2";
  readonly createdAt: string;
  readonly hash: string;
  readonly values: Readonly<Record<string, JsonValue>>;
}
export interface RunManifest {
  readonly configuration: ConfigurationVersion;
  /** id is the mount identity; definitionId is absent in legacy logs. */
  readonly plugins: readonly { readonly id: string; readonly definitionId?: string; readonly version: string; readonly generation: number; readonly scope: ScopeKind; readonly registryScope?: string | null }[];
  readonly tools: readonly (Omit<ToolInfo, "sessionId"> & { readonly sessionId: string | null })[];
  /** Optional only for backward compatibility with logs written before service isolation. */
  readonly services?: readonly (Omit<ServiceInfo, "sessionId"> & { readonly sessionId: string | null })[];
  readonly bindings?: readonly { readonly consumer: string | null; readonly id: string; readonly version: number; readonly isolation: string | null }[];
  /** Visible contributions and their scope chain, absent only in legacy logs. */
  readonly registryView?: {
    readonly chain: readonly string[];
    readonly entries: readonly (Omit<RegistryInfo, "sessionId"> & { readonly sessionId: string | null })[];
  };
}

export interface RunOptions {
  readonly serviceScope?: ServiceScope;
  readonly registryScope?: RegistryScope;
}

export interface RunContext {
  /** Track capability work through validation, scheduling, execution and commit. */
  track<T>(operation: () => Promise<T>): Promise<T>;
  readonly id: string;
  readonly sessionId: string;
  readonly services: ServiceSnapshot;
  readonly tools: ToolSnapshot;
  readonly registries: RegistrySnapshots;
  readonly registryScope: RegistryScope | undefined;
  readonly configuration: ConfigurationVersion;
  readonly manifest: RunManifest;
}

export interface ToolDefinition {
  /** Omission is conservatively treated as non-idempotent-write. */
  readonly effect?: ToolEffect;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonValue;
  execute(input: unknown, run: RunContext, execution?: ToolExecution): Awaitable<unknown>;
}

export interface PluginContext<C = JsonValue | undefined> extends Ownership {
  readonly registryScope: RegistryScope | undefined;
  readonly config: C;
  /** Factories run once per run; setup cannot acquire live service references. */
  provide<T>(token: ServiceToken<T>, factory: (run: RunContext) => T): void;
  registerTool(tool: ToolDefinition): void;
  /** Registry-specific definitions stay in capability modules, outside the kernel. */
  register<T>(registry: RegistryToken<T>, name: string, value: T): void;
  listen(target: EventTarget, type: string, listener: (event: Event) => void): void;
  onCleanup(cleanup: Cleanup): void;
  manage<T>(resource: T, dispose: (resource: T) => Awaitable<void>): T;
  /** Registration now; acquisition only after the drain boundary. */
  resource<T>(name: string, acquire: () => Awaitable<T>, dispose: (resource: T) => Awaitable<void>): { get(): T };
  onConfigChange(listener: (configuration: ConfigurationVersion) => void): void;
}

export interface Plugin<C = JsonValue | undefined> {
  /** Definition identity, reusable across mounts. */
  readonly id: string;
  /** Mount identity used for ownership, configuration and lifecycle operations. Defaults to id. */
  readonly instanceId?: string;
  readonly serviceScope?: ServiceScope;
  readonly registryScope?: RegistryScope;
  readonly version: string;
  readonly apiVersion: number;
  readonly scope: ScopeKind;
  readonly provides: readonly ServiceToken[];
  readonly requires: readonly ServiceToken[];
  readonly validateConfig?: (input: JsonValue | undefined) => C;
  /** L1 requires run mode and a validator. Read values from run.configuration. */
  readonly configMode?: "static" | "run";
  readonly replacementBoundary?: "drained" | "stop-first";
  readonly upgradePolicy?: "in-process" | "restart-required";
  setup(context: PluginContext<C>): Awaitable<void>;
}

/** Keep typed config local to a plugin while exposing a uniform descriptor. */
export function definePlugin<C extends JsonValue | undefined>(plugin: Plugin<C>): Plugin {
  const setup = plugin.setup;
  return {
    ...plugin,
    setup(context) { return setup(context as PluginContext<C>); },
  };
}

export interface RuntimeOptions {
  readonly plugins: readonly Plugin[];
  readonly config?: Readonly<Record<string, JsonValue>>;
  readonly drainTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
}
