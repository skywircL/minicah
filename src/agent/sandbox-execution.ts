import { lstatSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { API_VERSION, type Plugin } from "../types.js";
import { services, type ExecutionService } from "../services.js";
import { fail } from "../errors.js";
import { limitConfiguration } from "../pipeline-control.js";
import { Workspace } from "./workspace.js";

interface Limits { readonly timeoutMs: number; readonly maxOutputBytes: number }
const defaults: Limits = { timeoutMs: 60_000, maxOutputBytes: 24_000 };

/** Commands see a disposable workspace copy; approved native file tools own Host writes. */
export function createSandboxExecutionPlugin(root: string, options: Partial<Limits> = {}): Plugin {
  const limits = { ...defaults, ...options };
  return { id: "sandbox-execution", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", configMode: "run",
    provides: [services.execution], requires: [services.sandbox],
    validateConfig: input => limitConfiguration(input, { ...limits }),
    setup(ctx) {
      const resource = ctx.resource("workspace-paths", () => new Workspace(root), () => {});
      ctx.provide(services.execution, run => ({ execute: request => run.track(async () => {
        const workspace = resource.get();
        if (!isAbsolute(request.cwd)) fail("WORKSPACE_PATH", "Execution cwd must be an absolute workspace directory");
        const local = relative(workspace.root, resolve(request.cwd));
        const cwd = workspace.path(local || ".");
        if (!lstatSync(cwd).isDirectory()) fail("WORKSPACE_PATH", "Execution cwd must be a directory");
        const configured = run.configuration.values[ctx.owner] as unknown as Limits;
        const result = await run.services.get(services.sandbox).execute({
          command: request.command, args: request.args,
          cwd: local ? `/workspace/${local.split(sep).join("/")}` : "/workspace",
          workspace: "snapshot", timeoutMs: configured.timeoutMs, maxOutputBytes: configured.maxOutputBytes,
          ...(request.signal ? { signal: request.signal } : {}),
        });
        if (result.cleanup !== "verified") fail("CLEANUP_UNCONFIRMED", `Sandbox ${result.id} cleanup is unconfirmed; restart required`);
        const reason: Awaited<ReturnType<ExecutionService["execute"]>>["reason"] = result.reason === "input-limit" || result.reason === "io-failed" ? "spawn-failed" : result.reason;
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, reason,
          sandbox: { id: result.id, cleanup: result.cleanup, code: result.code, profile: result.profile },
        };
      }) }));
    },
  };
}
