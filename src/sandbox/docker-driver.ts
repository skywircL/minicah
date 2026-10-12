import { spawn } from "node:child_process";

export interface DockerCommandResult { readonly code: number; readonly stdout: string }
export interface DockerAttachment {
  readonly closed: Promise<number>;
  write(data: string): void;
  endInput(): void;
  killClient(): void;
}
/** A trusted transport seam, never supplied by model programs. */
export interface DockerDriver {
  command(args: readonly string[], timeoutMs: number): Promise<DockerCommandResult>;
  attach(args: readonly string[], stdout: (chunk: Buffer) => void, stderr: (chunk: Buffer) => void): DockerAttachment;
}
export function dockerCliDriver(binary = "docker"): DockerDriver {
  return {
    command: (args, timeoutMs) => new Promise((resolve, reject) => {
      const child = spawn(binary, [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = []; let bytes = 0;
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("DOCKER_COMMAND_TIMEOUT")); }, timeoutMs);
      const drain = (chunk: Buffer, stdout: boolean) => {
        bytes += chunk.byteLength;
        if (bytes > 256 * 1024) { child.kill("SIGKILL"); reject(new Error("DOCKER_COMMAND_OUTPUT_LIMIT")); }
        else if (stdout) chunks.push(chunk);
      };
      child.stdout.on("data", chunk => drain(chunk, true)); child.stderr.on("data", chunk => drain(chunk, false));
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: Buffer.concat(chunks).toString("utf8") }); });
    }),
    attach: (args, stdout, stderr) => {
      const child = spawn(binary, [...args], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
      child.stdout.on("data", stdout); child.stderr.on("data", stderr);
      let failed = false;
      // An error or EPIPE is not evidence that the client or its container has exited.
      const closed = new Promise<number>(resolve => {
        child.on("error", () => { failed = true; });
        child.on("close", code => resolve(failed ? -1 : code ?? -1));
      });
      child.stdin.on("error", () => { failed = true; child.kill("SIGKILL"); });
      return { closed, write: data => { child.stdin.write(data); }, endInput: () => { child.stdin.end(); }, killClient: () => { child.kill("SIGKILL"); } };
    },
  };
}
