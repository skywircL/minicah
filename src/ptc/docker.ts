import { immutable } from "../json.js";
import { positive } from "../pipeline-control.js";
import { DockerProcessSandbox, type DockerProcessSandboxOptions } from "../sandbox/docker.js";
import { dockerCliDriver, type DockerDriver } from "../sandbox/docker-driver.js";
import type { SandboxProcessControl, SandboxProcessResult, SandboxService } from "../sandbox/types.js";
import type { IsolationBackend, SandboxRequest, SandboxResult } from "./types.js";
import { ControlChannel, programBootstrap } from "./protocol.js";

export { dockerCliDriver } from "../sandbox/docker-driver.js";
export type { DockerDriver, DockerAttachment, DockerCommandResult } from "../sandbox/docker-driver.js";

export interface SandboxPtcOptions {
  readonly maxTransferBytes?: number;
  /** This limits V8 old generation; the sandbox owns the complete process memory limit. */
  readonly maxOldGenerationSizeMb?: number;
}

/** PTC protocol consumer. The shared sandbox owns isolation and process cleanup. */
export class SandboxPtcBackend implements IsolationBackend {
  readonly id: string = "sandbox-ptc-v1";
  readonly #maxTransferBytes: number;
  readonly #maxOldGenerationSizeMb: number;
  constructor(readonly sandbox: SandboxService, options: SandboxPtcOptions = {}) {
    this.#maxTransferBytes = options.maxTransferBytes ?? 1024 * 1024;
    this.#maxOldGenerationSizeMb = options.maxOldGenerationSizeMb ?? 64;
    positive(this.#maxTransferBytes, "maxTransferBytes");
    positive(this.#maxOldGenerationSizeMb, "maxOldGenerationSizeMb");
  }
  get profile() {
    return immutable({ sandbox: this.sandbox.profile, workspace: "none", protocol: "ptc-json-lines-v1", maxOldGenerationSizeMb: this.#maxOldGenerationSizeMb });
  }
  // A per-run adapter borrows the provider pinned by the run; its owner disposes it.
  async close(): Promise<void> {}
  async run(request: SandboxRequest, host: Parameters<IsolationBackend["run"]>[1]): Promise<SandboxResult> {
    let process: SandboxProcessControl | undefined;
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      channel.cancel();
      host.cancel();
      process?.terminate();
    };
    const channel = new ControlChannel(request, host.call, line => {
      if (!process) throw new Error("CHANNEL_NOT_STARTED");
      process.write(line);
    }, stop, this.#maxTransferBytes);
    host.signal.addEventListener("abort", stop, { once: true });
    if (host.signal.aborted) stop();
    try {
      const result = await this.sandbox.run({
        command: "node", args: [`--max-old-space-size=${this.#maxOldGenerationSizeMb}`, "-e", programBootstrap],
        cwd: "/tmp", workspace: "none", signal: host.signal,
        maxOutputBytes: request.maxOutputBytes,
      }, {
        started(control) {
          process = control;
          if (stopping || host.signal.aborted) { control.terminate(); return; }
          channel.send({ type: "start", program: request.program, input: request.input, bindings: request.bindings, concurrency: request.concurrency });
        },
        stdout: chunk => channel.output(chunk), stderr: chunk => channel.output(chunk, false),
        stopped: stop,
      });
      if (result.reason === "exit") channel.finish();
      const code = channel.failure ?? processFailure(result) ?? channel.result?.code ?? null;
      return {
        status: result.cleanup === "unconfirmed" ? "unknown" : code ? "failed" : channel.result?.status ?? "failed",
        value: channel.result?.value ?? null,
        code: result.cleanup === "unconfirmed" ? "CLEANUP_UNCONFIRMED" : code,
        cleanup: result.cleanup,
        execution: { id: result.id, profile: result.profile },
      };
    } finally {
      channel.cancel();
      host.signal.removeEventListener("abort", stop);
    }
  }
}

function processFailure(result: SandboxProcessResult): string | null {
  if (result.code) return result.code;
  switch (result.reason) {
    case "exit": return result.exitCode === 0 ? null : "PROGRAM_EXIT";
    case "cancelled": return "CANCELLED";
    case "timeout": return "DEADLINE";
    case "output-limit": return "OUTPUT_LIMIT";
    case "input-limit": return "TRANSFER_LIMIT";
    case "spawn-failed": return "ISOLATION_UNAVAILABLE";
    case "io-failed": return "CHANNEL_CLOSED";
  }
}

/** Backward-compatible standalone PTC backend. New plugins share SandboxService. */
export interface DockerSandboxOptions extends DockerProcessSandboxOptions {
  readonly maxTransferBytes?: number;
}
export class DockerSandbox extends SandboxPtcBackend {
  override readonly id = "docker-restricted-v1";
  readonly #owned: DockerProcessSandbox;
  constructor(options: DockerSandboxOptions, readonly driver: DockerDriver = dockerCliDriver()) {
    const owned = new DockerProcessSandbox(options, driver);
    super(owned, { maxTransferBytes: options.maxTransferBytes ?? 1024 * 1024, maxOldGenerationSizeMb: Math.max(16, Math.floor((options.memoryMiB ?? 128) / 2)) });
    this.#owned = owned;
  }
  health() {
    const health = this.#owned.health();
    return Object.freeze({ active: health.active.length > 0, unresolved: health.unresolved });
  }
  override close(): Promise<void> { return this.#owned.close(); }
}
