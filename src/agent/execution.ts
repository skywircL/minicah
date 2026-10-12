import { spawn } from "node:child_process";
import { API_VERSION, type Plugin } from "../types.js";
import { services, type ExecutionService } from "../services.js";
import { fail } from "../errors.js";
import { limitConfiguration } from "../pipeline-control.js";

type Result = Awaited<ReturnType<ExecutionService["execute"]>>;
interface Limits { timeoutMs: number; killGraceMs: number; cleanupMs: number; maxOutputBytes: number }
const defaults: Limits = { timeoutMs: 60_000, killGraceMs: 500, cleanupMs: 2500, maxOutputBytes: 24_000 };
class HostExecution {
  readonly #active = new Set<Promise<Result>>();
  readonly #unresolved = new Set<number>();
  #closed = false;
  execute(request: Parameters<ExecutionService["execute"]>[0], limits: Limits): Promise<Result> {
    if (this.#closed) fail("EXECUTION_CLOSED", "Execution service closed");
    if (this.#unresolved.size) fail("RESTART_REQUIRED", "A prior command still has unconfirmed cleanup");
    if (process.platform === "win32") fail("UNSUPPORTED_PLATFORM", "Host command cleanup requires POSIX process groups");
    const work = this.#execute(request, limits);
    this.#active.add(work);
    void work.then(() => this.#active.delete(work), () => this.#active.delete(work));
    return work;
  }
  async #execute(request: Parameters<ExecutionService["execute"]>[0], limits: Limits): Promise<Result> {
    if (request.signal?.aborted) return { exitCode: null, stdout: "", stderr: "", reason: "cancelled" };
    // Explicit allow-list avoids leaking model/API credentials to subprocesses.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "LANG", "LC_ALL", "SYSTEMROOT"]) if (process.env[key] !== undefined) env[key] = process.env[key];
    const child = spawn(request.command, [...request.args], { cwd: request.cwd, env, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", size = 0, reason: Result["reason"] = "exit", stopping = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined;
    const groupAlive = () => {
      if (!child.pid) return false;
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    };
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") this.#unresolved.add(child.pid); }
    };
    let rejectCleanup: (error: Error) => void = () => {};
    const stop = (why: Result["reason"]) => {
      if (stopping) return;
      stopping = true; reason = why; kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), limits.killGraceMs);
      closeTimer = setTimeout(() => { if (child.pid) this.#unresolved.add(child.pid); rejectCleanup(new Error("CLEANUP_UNCONFIRMED")); }, limits.cleanupMs);
    };
    const abort = () => stop("cancelled");
    const timeout = setTimeout(() => stop("timeout"), limits.timeoutMs);
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    const collect = (channel: "stdout" | "stderr", chunk: Buffer) => {
      const available = Math.max(0, limits.maxOutputBytes - size), text = chunk.subarray(0, available).toString("utf8");
      size += chunk.length;
      if (channel === "stdout") stdout += text; else stderr += text;
      if (size > limits.maxOutputBytes) stop("output-limit");
    };
    child.stdout.on("data", chunk => collect("stdout", chunk)); child.stderr.on("data", chunk => collect("stderr", chunk));
    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        rejectCleanup = reject;
        child.once("error", () => { reason = "spawn-failed"; });
        child.once("close", code => resolve(code));
      });
      // A reaped leader is not proof that children exited. Stop its managed process group too.
      if (groupAlive()) {
        kill("SIGTERM");
        const deadline = Date.now() + limits.cleanupMs, forceAt = Date.now() + limits.killGraceMs;
        while (groupAlive() && Date.now() < deadline) {
          if (Date.now() >= forceAt) kill("SIGKILL");
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      if (groupAlive()) { if (child.pid) this.#unresolved.add(child.pid); throw new Error("CLEANUP_UNCONFIRMED"); }
      if (child.pid) this.#unresolved.delete(child.pid);
      return { exitCode, stdout, stderr, reason };
    } finally {
      clearTimeout(timeout); clearTimeout(killTimer); clearTimeout(closeTimer); request.signal?.removeEventListener("abort", abort);
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#active]);
    if (this.#unresolved.size) fail("CLEANUP_UNCONFIRMED", "Managed command cleanup is unconfirmed; restart required");
  }
}
export function createExecutionPlugin(): Plugin {
  return { id: "host-execution", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", configMode: "run",
    provides: [services.execution], requires: [], validateConfig: value => {
      const limits = limitConfiguration(value, { ...defaults });
      if (limits.cleanupMs! <= limits.killGraceMs!) fail("INVALID_CONFIG", "cleanupMs must exceed killGraceMs");
      return limits;
    },
    setup(ctx) {
      const executor = ctx.resource("host-processes", () => new HostExecution(), executor => executor.close());
      ctx.provide(services.execution, run => ({ execute: request => run.track(() => executor.get().execute(request, run.configuration.values[ctx.owner] as unknown as Limits)) }));
    },
  };
}
