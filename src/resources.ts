import { fail, throwCollected } from "./errors.js";
import { validateToken } from "./plan.js";
import { ConfigurationChannel } from "./configuration.js";
import { serviceBinding } from "./isolation.js";
import { deadline } from "./deadline.js";
import { prepareEntry, RegistryCatalog, type RegistryRegistration, type RegistryToken } from "./registry.js";
import { toolRegistry } from "./tool-registry.js";
import type { Cleanup, ConfigurationVersion, JsonValue, Ownership, Plugin, PluginContext, RegistrationInfo, RunContext, ServiceInfo, ServiceToken, ToolDefinition } from "./types.js";

export interface ServiceRegistration {
  readonly info: ServiceInfo;
  readonly plugin: Plugin;
  readonly factory: (run: RunContext) => unknown;
}

/** A setup transaction owns everything it registers, including partial setup. */
export class RegistrationBatch {
  readonly services = new Map<symbol, ServiceRegistration>();
  readonly catalog = new RegistryCatalog();
  readonly #records: RegistrationInfo[] = [];
  readonly #cleanup: Cleanup[] = [];
  readonly #listeners: { attach: () => void; detach: () => void }[] = [];
  readonly #activations: (() => Promise<void>)[] = [];
  readonly #unregister: (() => void)[] = [];
  #open = true;
  #disposal: Promise<void> | undefined;
  #activationConfiguration: ConfigurationVersion | undefined;

  constructor(
    readonly plugin: Plugin,
    readonly ownership: Ownership,
    readonly occupiedServices: ReadonlySet<symbol>,
    readonly occupiedEntries: readonly RegistryRegistration[],
    readonly configChannel: ConfigurationChannel,
    readonly candidate = false,
    readonly cleanupTimeoutMs = 10_000,
  ) {}

  async setup(config: JsonValue | undefined): Promise<void> {
    const plugin = this.plugin;
    const assertOpen = () => {
      if (!this.#open) fail("REGISTRATION_CLOSED", `Registration is closed for ${this.plugin.id}`);
    };
    const record = (kind: RegistrationInfo["kind"], name: string) => {
      this.#records.push(Object.freeze({ ...this.ownership, kind, name, ...(kind === "service" ? { isolation: serviceBinding(plugin.serviceScope, name).isolation } : {}) }));
    };
    const register = <T>(token: RegistryToken<T>, name: string, value: T): void => {
      assertOpen();
      if (typeof name !== "string" || !name.trim()) fail("INVALID_REGISTRATION", "Registry entry needs a name");
      const prepared = prepareEntry(token, value);
      if (token.id === toolRegistry.id && token !== toolRegistry) fail("REGISTRY_ID_CONFLICT", "The tools registry requires the exported toolRegistry token");
      if (token === toolRegistry && (prepared as ToolDefinition).name !== name) fail("INVALID_REGISTRATION", "Tool registration name must match its definition");
      for (const entry of [...this.occupiedEntries, ...this.catalog.entries()]) {
        if (entry.token.id !== token.id) continue;
        if (entry.token !== token) fail("REGISTRY_ID_CONFLICT", `Contributors must share the same token for registry ${token.id}`);
        if (entry.plugin.registryScope === plugin.registryScope && entry.info.name === name) fail(token === toolRegistry ? "DUPLICATE_TOOL" : "DUPLICATE_REGISTRATION", `Duplicate ${token.id} entry in one scope: ${name}`);
      }
      const info = Object.freeze({ ...this.ownership, registry: token.id, version: token.version, name, registryScope: plugin.registryScope?.id ?? null });
      this.catalog.add({ registryScope: plugin.registryScope, onCleanup: dispose => { this.#unregister.push(dispose); this.#cleanup.push(dispose); } }, Object.freeze({ info, value: prepared, token, plugin }));
      this.#records.push(Object.freeze({ ...info, kind: token === toolRegistry ? "tool" : "registry" }));
    };
    const context: PluginContext = Object.freeze({
      ...this.ownership,
      registryScope: plugin.registryScope,
      get config() {
        if (plugin.configMode === "run") fail("RUN_CONFIG_REQUIRED", "Dynamic configuration must be read from run.configuration");
        return config;
      },
      provide: <T>(token: ServiceToken<T>, factory: (run: RunContext) => T) => {
        assertOpen();
        validateToken(token);
        const declared = this.plugin.provides.find(item => item.id === token.id && item.version === token.version);
        if (!declared) fail("UNDECLARED_SERVICE", `${this.plugin.id} did not declare ${token.id}@${token.version}`);
        if (typeof factory !== "function") fail("INVALID_REGISTRATION", `Service ${token.id} needs a factory`);
        const { key, isolation } = serviceBinding(plugin.serviceScope, token.id);
        if (this.services.has(key) || this.occupiedServices.has(key)) fail("DUPLICATE_SERVICE", `Duplicate service: ${token.id}`);
        this.services.set(key, Object.freeze({
          info: Object.freeze({ ...this.ownership, id: token.id, version: token.version, isolation }),
          plugin: this.plugin, factory,
        }));
        record("service", token.id);
      },
      registerTool: (tool: ToolDefinition) => register(toolRegistry, tool?.name, tool),
      register,
      listen: (target: EventTarget, type: string, listener: (event: Event) => void) => {
        assertOpen();
        if (typeof target?.addEventListener !== "function" || typeof target?.removeEventListener !== "function" || typeof listener !== "function") {
          fail("INVALID_REGISTRATION", "Listener registration requires an EventTarget and callback");
        }
        // A unique wrapper prevents rollback from removing another owner's callback.
        const wrapped = (event: Event) => listener(event);
        let attached = false;
        const detach = () => {
          if (!attached) return;
          attached = false;
          target.removeEventListener(type, wrapped);
        };
        this.#listeners.push({
          attach: () => { attached = true; target.addEventListener(type, wrapped); }, detach,
        });
        this.#cleanup.push(detach);
        record("listener", type);
      },
      onCleanup: (cleanup: Cleanup) => {
        assertOpen();
        if (typeof cleanup !== "function") fail("INVALID_REGISTRATION", "Cleanup must be a function");
        this.#cleanup.push(cleanup);
        record("cleanup", `cleanup:${this.#cleanup.length}`);
      },
      manage: <T>(resource: T, dispose: (resource: T) => void | Promise<void>): T => {
        assertOpen();
        if (this.candidate) fail("REGISTRATION_ONLY", "Candidates must defer acquisition with ctx.resource()");
        if (typeof dispose !== "function") fail("INVALID_REGISTRATION", "Managed resources need a disposer");
        this.#cleanup.push(() => dispose(resource));
        record("resource", `resource:${this.#cleanup.length}`);
        return resource;
      },
      resource: <T>(name: string, acquire: () => T | Promise<T>, dispose: (resource: T) => void | Promise<void>) => {
        assertOpen();
        if (typeof name !== "string" || !name.trim() || typeof acquire !== "function" || typeof dispose !== "function") fail("INVALID_REGISTRATION", "Resource needs a name, acquire, and dispose");
        let acquired = false, usable = false, value: T;
        this.#activations.push(async () => { value = await acquire(); acquired = true; usable = true; });
        this.#cleanup.push(async () => { usable = false; if (acquired) await dispose(value); });
        record("resource", name);
        return Object.freeze({ get: () => {
          if (!usable) fail("RESOURCE_INACTIVE", `Resource ${name} is not active`);
          return value;
        } });
      },
      onConfigChange: (listener: (configuration: ConfigurationVersion) => void) => {
        assertOpen();
        const wrapped = (configuration: ConfigurationVersion) => {
          const result: unknown = listener(configuration);
          if (result && (typeof result === "object" || typeof result === "function") && "then" in result) {
            void Promise.resolve(result).catch(() => {});
            fail("ASYNC_CONFIG_LISTENER", "Configuration invalidation must complete synchronously");
          }
        };
        this.#activations.push(async () => {
          this.configChannel.listeners.add(wrapped);
          const configuration = this.#activationConfiguration ?? this.configChannel.current;
          if (configuration) wrapped(configuration);
        });
        this.#cleanup.push(() => { this.configChannel.listeners.delete(wrapped); });
        record("listener", "configuration.changed");
      },
    });
    try {
      await this.plugin.setup(context);
      for (const token of this.plugin.provides) {
        if (!this.services.has(serviceBinding(plugin.serviceScope, token.id).key)) fail("MISSING_PROVISION", `${this.plugin.id} did not register ${token.id}`);
      }
    } finally {
      this.#open = false;
    }
  }

  async activate(configuration?: ConfigurationVersion): Promise<void> {
    this.#activationConfiguration = configuration;
    for (const activate of this.#activations) await activate();
    for (const listener of this.#listeners) listener.attach();
  }

  inspect(): readonly RegistrationInfo[] { return Object.freeze([...this.#records]); }

  dispose(): Promise<void> {
    this.#disposal ??= this.#dispose();
    return this.#disposal;
  }

  async #dispose(): Promise<void> {
    this.#open = false;
    this.services.clear();
    const errors: unknown[] = [];
    for (const remove of this.#unregister.toReversed()) {
      try { remove(); } catch (error) { errors.push(error); }
    }
    // Stop callbacks before awaiting arbitrary asynchronous cleanup.
    for (const listener of this.#listeners) {
      try { listener.detach(); } catch (error) { errors.push(error); }
    }
    for (const cleanup of this.#cleanup.toReversed()) {
      try { await deadline(Promise.resolve().then(cleanup), this.cleanupTimeoutMs, "RESTART_REQUIRED", `Cleanup timed out for ${this.plugin.id}; resource may still be alive`); }
      catch (error) { errors.push(error); }
    }
    if (!errors.length) this.#records.length = 0;
    throwCollected(errors, `Cleanup failed for ${this.plugin.id}`);
  }
}

export function registrations(batches: readonly RegistrationBatch[]) {
  return {
    services: new Map(batches.flatMap(batch => [...batch.services])),
    entries: batches.flatMap(batch => [...batch.catalog.entries()]),
  };
}
