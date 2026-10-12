import { StringDecoder } from "node:string_decoder";
import { immutable } from "../json.js";
import { fail } from "../errors.js";
import type { JsonValue } from "../types.js";
import type { ToolResult } from "../tool-pipeline.js";
import type { SandboxRequest } from "./types.js";

/** Every byte from the program, including apparently well-formed control frames, is untrusted. */
export class ControlChannel {
  readonly #decoder = new StringDecoder("utf8");
  #buffer = ""; #bytes = 0; #sentBytes = 0; #closed = false;
  readonly #ids = new Set<string>(); readonly #pending = new Set<Promise<void>>();
  result: { status: "completed" | "failed"; value: JsonValue; code: string | null } | undefined;
  failure: string | undefined;
  constructor(readonly request: SandboxRequest, readonly call: (name: string, input: JsonValue) => Promise<ToolResult>, readonly write: (line: string) => void, readonly abort: () => void, readonly maxTransferBytes: number) {}
  send(value: JsonValue): void {
    if (this.#closed) return;
    const line = `${JSON.stringify(value)}\n`;
    this.#sentBytes += Buffer.byteLength(line);
    if (this.#sentBytes > this.maxTransferBytes) { this.#fail("TRANSFER_LIMIT"); return; }
    try { this.write(line); } catch { this.#fail("CHANNEL_CLOSED"); }
  }
  output(chunk: Buffer, control = true): void {
    if (this.#closed) return;
    this.#bytes += chunk.byteLength;
    if (this.#bytes > this.request.maxOutputBytes) { this.#fail("OUTPUT_LIMIT"); return; }
    // stderr is drained and counted, never interpreted as control or persisted as raw secrets.
    if (!control) return;
    this.#buffer += this.#decoder.write(chunk);
    for (;;) {
      const end = this.#buffer.indexOf("\n");
      if (end < 0 || this.#closed) break;
      const line = this.#buffer.slice(0, end); this.#buffer = this.#buffer.slice(end + 1);
      try { this.#frame(immutable(JSON.parse(line))); } catch { this.#fail("INVALID_PROTOCOL"); }
    }
  }
  #frame(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value) || this.result) fail("INVALID_PROTOCOL", "Unexpected frame");
    const frame = value as Record<string, JsonValue>;
    if (frame.type === "call") {
      if (Object.keys(frame).sort().join(",") !== "id,input,name,type" || typeof frame.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(frame.id) || this.#ids.has(frame.id) || typeof frame.name !== "string" || !this.request.bindings.includes(frame.name)) fail("INVALID_PROTOCOL", "Invalid tool frame");
      if (this.#pending.size >= this.request.concurrency) { this.#fail("PTC_LIMIT"); return; }
      this.#ids.add(frame.id);
      const work = Promise.resolve().then(() => {
        if (this.#closed) fail("CANCELLED", "Channel closed");
        return this.call(frame.name as string, frame.input!);
      }).then(result => { this.send({ type: "reply", id: frame.id!, result: result as unknown as JsonValue }); }, () => { this.#fail("HOST_CALL_FAILED"); });
      this.#pending.add(work);
      void work.finally(() => this.#pending.delete(work));
    } else if (frame.type === "result") {
      if (Object.keys(frame).sort().join(",") !== "status,type,value" || !["completed", "failed"].includes(frame.status as string)) fail("INVALID_PROTOCOL", "Invalid result frame");
      this.result = { status: frame.status as "completed" | "failed", value: frame.value!, code: frame.status === "failed" ? "PROGRAM_FAILED" : null };
    } else fail("INVALID_PROTOCOL", "Unknown frame type");
  }
  finish(): void {
    if (this.#buffer.length || this.#decoder.end().length || !this.result) this.#fail("INCOMPLETE_PROTOCOL");
    this.#closed = true;
  }
  cancel(): void { this.#closed = true; }
  #fail(code: string): void { this.failure ??= code; this.#closed = true; this.abort(); }
}

/** Runs inside the OS-isolated container. This wrapper itself is not a security boundary. */
export const programBootstrap = String.raw`
const readline = require('node:readline');
const pending = new Map(); let sequence = 0, initialized = false;
function json(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('INVALID_JSON');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('INVALID_JSON');
  seen.add(value);
  const copy = Array.isArray(value) ? Array.from(value, item => json(item, seen)) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item, seen)]));
  seen.delete(value); return copy;
}
const emit = frame => process.stdout.write(JSON.stringify(json(frame)) + '\n');
const rl = readline.createInterface({ input: process.stdin });
console.log = console.info = console.warn = console.error = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');
rl.on('line', async line => {
  let frame; try { frame = JSON.parse(line); } catch { process.exit(2); }
  if (frame.type === 'reply') {
    const accept = pending.get(frame.id); if (accept) { pending.delete(frame.id); accept(frame.result); }
    return;
  }
  if (initialized || frame.type !== 'start') return;
  initialized = true;
  const tools = Object.create(null);
  for (const name of frame.bindings) Object.defineProperty(tools, name, { value: input => {
    if (pending.size >= frame.concurrency) return Promise.reject(new Error('PTC_LIMIT'));
    const id = String(++sequence);
    return new Promise(resolve => { pending.set(id, resolve); emit({ type: 'call', id, name, input }); });
  }, enumerable: true });
  try {
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const value = await new AsyncFunction('input', 'tools', '"use strict";\n' + frame.program)(frame.input, Object.freeze(tools));
    emit({ type: 'result', status: 'completed', value });
  } catch { emit({ type: 'result', status: 'failed', value: null }); }
  // Flush stdout; do not hide unawaited calls from the Host, which cancels and settles them.
  process.stdout.write('', () => process.exit(0));
});
`;
