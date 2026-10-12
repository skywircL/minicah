import { API_VERSION, type JsonValue, type Plugin } from "../types.js";
import { fail } from "../errors.js";
import { services } from "../services.js";
import { DockerProcessSandbox, type DockerProcessSandboxOptions } from "./docker.js";
import type { DockerDriver } from "./docker-driver.js";
import type { SandboxService } from "./types.js";
import { SeatbeltProcessSandbox, type SeatbeltProcessSandboxOptions } from "./seatbelt.js";

/** Security policy changes require L2 replacement and draining the old generation. */
export function createDockerSandboxPlugin(options: DockerProcessSandboxOptions, driver?: DockerDriver): Plugin {
  const defaults = new DockerProcessSandbox(options, driver).configuration;
  return { id: "docker-sandbox", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", configMode: "static",
    provides: [services.sandbox], requires: [],
    validateConfig(value) {
      if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) fail("INVALID_CONFIG", "Sandbox configuration must be an object");
      const raw = (value ?? {}) as Record<string, JsonValue>;
      const keys = new Set([...Object.keys(defaults), "workspace"]);
      for (const [key, entry] of Object.entries(raw)) {
        if (!keys.has(key) || typeof entry !== (key === "image" || key === "workspace" ? "string" : "number")) fail("INVALID_CONFIG", `Invalid sandbox option: ${key}`);
      }
      return new DockerProcessSandbox({ ...defaults, ...raw } as unknown as DockerProcessSandboxOptions, driver).configuration;
    },
    setup(ctx) {
      const managed = ctx.resource("docker-processes", () => new DockerProcessSandbox(ctx.config as unknown as DockerProcessSandboxOptions, driver), sandbox => sandbox.close());
      ctx.provide(services.sandbox, (run): SandboxService => {
        const sandbox = managed.get();
        return Object.freeze<SandboxService>({ profile: sandbox.profile, health: () => sandbox.health(),
          run: (request, io) => run.track(() => sandbox.run(request, io)),
          execute: request => run.track(() => sandbox.execute(request)),
        });
      });
    },
  };
}

/** macOS's OS sandbox, with child creation denied so the single process can be reaped conclusively. */
export function createSeatbeltSandboxPlugin(options: SeatbeltProcessSandboxOptions = {}): Plugin {
  const defaults = new SeatbeltProcessSandbox(options).configuration;
  return { id: "seatbelt-sandbox", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", configMode: "static",
    provides: [services.sandbox], requires: [],
    validateConfig(value) {
      if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) fail("INVALID_CONFIG", "Sandbox configuration must be an object");
      const raw = (value ?? {}) as Record<string, JsonValue>, keys = new Set([...Object.keys(defaults), "workspace"]);
      for (const [key, entry] of Object.entries(raw)) {
        if (!keys.has(key)) fail("INVALID_CONFIG", `Unknown sandbox option: ${key}`);
        if (key === "runtimeReadPaths") {
          if (!Array.isArray(entry) || entry.some(path => typeof path !== "string")) fail("INVALID_CONFIG", "Runtime read paths must be a string array");
        } else if (typeof entry !== (key === "workspace" || key === "nodeExecutable" ? "string" : "number")) fail("INVALID_CONFIG", `Invalid sandbox option: ${key}`);
      }
      return new SeatbeltProcessSandbox({ ...defaults, ...raw } as unknown as SeatbeltProcessSandboxOptions).configuration;
    },
    setup(ctx) {
      const managed = ctx.resource("seatbelt-processes", () => new SeatbeltProcessSandbox(ctx.config as unknown as SeatbeltProcessSandboxOptions), sandbox => sandbox.close());
      ctx.provide(services.sandbox, (run): SandboxService => {
        const sandbox = managed.get();
        return Object.freeze<SandboxService>({ profile: sandbox.profile, health: () => sandbox.health(),
          run: (request, io) => run.track(() => sandbox.run(request, io)),
          execute: request => run.track(() => sandbox.execute(request)),
        });
      });
    },
  };
}
