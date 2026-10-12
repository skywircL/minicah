import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { HarnessError } from "../src/errors.js";
import { Runtime } from "../src/runtime.js";
import { RegistryScope } from "../src/scopes.js";
import { SANDBOX_TEST_BOOTSTRAP, SANDBOX_TEST_PROTOCOL_PREFIX } from "../src/evaluation/sandbox-test-bootstrap.js";
import { createSandboxTestPackPlugin, createSandboxTestPlugin, readSandboxTestPack, sandboxTestService, validateSandboxTestPack,
  type ManagedTestSandbox, type SandboxTestGrade, type SandboxTestPack, type SandboxTestService } from "../src/evaluation/sandbox-tests.js";
import type { JsonValue } from "../src/types.js";
import type { SandboxProcessIO, SandboxProcessRequest, SandboxProcessResult } from "../src/sandbox/types.js";

const pack: SandboxTestPack = { schemaVersion: 1, id: "reference", version: "1", tests: [
  { id: "sum", module: "sum.mjs", export: "sum", cases: [{ id: "simple", args: [2, 3], expected: 5 }] },
] };
const code = (expected: string) => (error: unknown): boolean => error instanceof HarnessError && error.code === expected;

test("function runner accepts equivalent CommonJS exports without invoking accessors or ESM default properties", async t => {
  const directory = await mkdtemp(join(tmpdir(), "minicah-export-forms-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const forms = [
    ["a.cjs", "exports.sum=(a,b)=>a+b", "return"],
    ["b.cjs", "module.exports={sum:(a,b)=>a+b}", "return"],
    ["c.cjs", "const name='sum'; module.exports={[name](a,b){return a+b}}", "return"],
    ["d.cjs", "module.exports={get sum(){throw new Error('getter must not run')}}", "missing-export"],
    ["e.cjs", "module.exports=Object.create({sum:(a,b)=>a+b})", "missing-export"],
    ["f.mjs", "export function sum(a,b){return a+b}", "return"],
    ["g.mjs", "export default {sum:(a,b)=>a+b}", "missing-export"],
  ];
  for (const [module, source, kind] of forms) {
    await writeFile(join(directory, module!), source!);
    const child = spawnSync(process.execPath, ["--input-type=commonjs", "-e", SANDBOX_TEST_BOOTSTRAP], { cwd: directory, encoding: "utf8", timeout: 5000,
      input: JSON.stringify({ nonce: "exports", caseId: module, module, export: "sum", args: [2, 3] }) });
    assert.equal(child.status, 0, child.stderr);
    const result = child.stdout.split("\n").filter(line => line.startsWith(SANDBOX_TEST_PROTOCOL_PREFIX)).map(line => JSON.parse(line.slice(SANDBOX_TEST_PROTOCOL_PREFIX.length))).find(frame => frame.type === "result");
    assert.equal(result?.kind, kind, module);
    if (kind === "return") assert.equal(result.value, 5);
  }
});
type FrameInput = { nonce: string; caseId: string; module: string; export: string; args: JsonValue[] };
const frame = (input: FrameInput, fields: object): string => `${SANDBOX_TEST_PROTOCOL_PREFIX}${JSON.stringify({ nonce: input.nonce, caseId: input.caseId, ...fields })}\n`;
type Script = (input: FrameInput, io: SandboxProcessIO, request: SandboxProcessRequest) => Promise<Partial<SandboxProcessResult>> | Partial<SandboxProcessResult>;
function mock(script: Script, options: { unresolved?: boolean; closeError?: boolean } = {}): ManagedTestSandbox & { calls: number; closes: number } {
  let sequence = 0;
  return { profile: { backend: "fixture-isolation" }, calls: 0, closes: 0,
    async run(request, io = {}) {
      this.calls++;
      assert.equal(request.workspace, "snapshot"); assert.equal(request.cwd, "/workspace"); assert.equal(request.command, "node");
      assert.deepEqual(request.args, ["--max-old-space-size=96", "--input-type=commonjs", "-e", SANDBOX_TEST_BOOTSTRAP]);
      let input = "";
      io.started?.({ write(value) { input += value; }, endInput() {}, terminate() {} });
      const parsed = JSON.parse(input) as FrameInput;
      assert.deepEqual(Object.keys(parsed).sort(), ["args", "caseId", "export", "module", "nonce"]);
      const result = await script(parsed, io, request);
      return { id: `mock-${++sequence}`, exitCode: 0, reason: "exit", cleanup: "verified", code: null, profile: this.profile, ...result };
    },
    async execute() { throw new Error("The grader must use explicit stdin protocol, not execute()"); },
    health() { return { active: [], unresolved: options.unresolved ? ["mock-retained"] : [], closed: this.closes > 0,
      details: options.unresolved ? [{ id: "mock-retained", pid: 42, retainedPaths: ["/private/tmp/retained-grader"] }] : [] }; },
    async close() { this.closes++; if (options.closeError) throw new HarnessError("RESTART_REQUIRED", "mock unresolved"); },
  };
}
function ready(input: FrameInput, io: SandboxProcessIO): void { io.stdout?.(Buffer.from(frame(input, { type: "ready" }))); }
function result(input: FrameInput, io: SandboxProcessIO, fields: object): void { io.stdout?.(Buffer.from(frame(input, { type: "result", ...fields }))); }
async function withService(factory: () => ManagedTestSandbox, use: (service: SandboxTestService) => Promise<void>, input = pack,
  options: { timeoutMs?: number; caseTimeoutMs?: number; cleanupMs?: number; maxOutputBytes?: number } = {}): Promise<void> {
  const runtime = await Runtime.create({ plugins: [createSandboxTestPackPlugin(input), createSandboxTestPlugin({ backend: "native", factory, ...options })] });
  try { const session = await runtime.openSession(); await session.run(run => use(run.services.get(sandboxTestService))); }
  finally { await runtime.close(); }
}

test("sandbox test packs require strict bounded JSON, safe modules and one explicit expectation", async () => {
  assert.equal(validateSandboxTestPack(pack).tests[0]!.cases[0]!.expected, 5);
  for (const value of [null, false, 0]) {
    assert.equal(validateSandboxTestPack({ ...pack, tests: [{ ...pack.tests[0], cases: [{ id: "value", args: [], expected: value }] }] }).tests[0]!.cases[0]!.expected, value);
  }
  for (const badCase of [
    { id: "bad", args: [] }, { id: "bad", args: [], expected: 1, throws: "Error" },
    { id: "bad", args: [], expected: undefined }, { id: "bad", args: [], expected: NaN },
    { id: "bad", args: [], expected: 1, command: "rm -rf /" },
  ]) assert.throws(() => validateSandboxTestPack({ ...pack, tests: [{ ...pack.tests[0], cases: [badCase] }] }));
  for (const module of ["../secret.mjs", "/secret.mjs", "C:/secret.js", "foo\\secret.js", ".env/key.js", "a/./x.js", "program.ts", "program.sh"]) {
    assert.throws(() => validateSandboxTestPack({ ...pack, tests: [{ ...pack.tests[0], module }] }));
  }
  assert.throws(() => validateSandboxTestPack({ ...pack, tests: [pack.tests[0], pack.tests[0]] }), /Duplicate/);
  assert.throws(() => validateSandboxTestPack({ ...pack, tests: [{ ...pack.tests[0], cases: Array(33).fill(pack.tests[0]!.cases[0]) }] }));
  let deep: unknown = 0; for (let index = 0; index < 70; index++) deep = [deep];
  assert.throws(() => validateSandboxTestPack({ ...pack, tests: [{ ...pack.tests[0], cases: [{ id: "deep", args: [], expected: deep }] }] }), code("EVAL_TEST_PACK_SIZE"));
  const cyclic: unknown[] = []; cyclic.push(cyclic);
  assert.throws(() => validateSandboxTestPack({ ...pack, tests: [{ ...pack.tests[0], cases: [{ id: "cycle", args: [], expected: cyclic }] }] }));
  const directory = await mkdtemp(join(tmpdir(), "minicah-test-pack-"));
  try {
    const path = join(directory, "pack.json"); await writeFile(path, JSON.stringify(pack));
    assert.equal((await readSandboxTestPack(path)).id, pack.id);
    await symlink(path, join(directory, "alias.json")); await assert.rejects(readSandboxTestPack(join(directory, "alias.json")));
    await writeFile(path, "{"); await assert.rejects(readSandboxTestPack(path), code("EVAL_TEST_PACK_PARSE"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("sandbox graders compare Host-only expectations and run each case in a fresh process", async () => {
  const nonces = new Set<string>();
  const backend = mock((input, io) => { nonces.add(input.nonce); ready(input, io); result(input, io, { kind: "return", value: input.args.reduce<number>((sum, value) => sum + Number(value), 0) }); return {}; });
  await withService(() => backend, async service => {
    const manifest = JSON.parse(JSON.stringify(service.manifest(["reference/sum", "reference/sum"])));
    assert.equal(manifest.tests.length, 1); assert.equal(manifest.tests[0].registration.generation, 1);
    assert.equal(manifest.tests[0].registration.owner, "sandbox-test-pack-reference");
    assert.equal(manifest.tests[0].definition.cases[0].expected, 5);
    assert.throws(() => service.manifest(["reference/missing"]), code("EVAL_TEST_REFERENCE"));
    const grade = await service.grade("reference/sum", "/private/tmp/trial", new AbortController().signal);
    assert.equal(grade.status, "passed"); assert.equal(grade.score, 1); assert.equal(grade.evidence.cases.length, 2);
    assert.equal(grade.cleanup, "verified"); assert.equal(nonces.size, 2); assert.equal(backend.calls, 2); assert.equal(backend.closes, 1);
  }, { ...pack, tests: [{ ...pack.tests[0]!, cases: [...pack.tests[0]!.cases, { id: "second", args: [4, 5], expected: 9 }] }] });
});

test("sandbox test registry follows run-local scope and retains the selected generation", async () => {
  const scope = new RegistryScope("private-grading"), scopedPack: SandboxTestPack = { ...pack, version: "2", tests: [{ ...pack.tests[0]!, cases: [{ id: "local", args: [], expected: null }] }] };
  const runtime = await Runtime.create({ plugins: [createSandboxTestPackPlugin(pack), scope.mount(createSandboxTestPackPlugin(scopedPack), "local-pack"), createSandboxTestPlugin({ backend: "native", factory: () => mock(() => ({})) })] });
  try {
    const session = await runtime.openSession();
    for (const [registryScope, expected] of [[undefined, "1"], [scope, "2"]] as const) await session.run(run => {
      const manifest = JSON.parse(JSON.stringify(run.services.get(sandboxTestService).manifest(["reference/sum"])));
      assert.equal(manifest.tests[0].packVersion, expected);
      assert.equal(manifest.tests[0].registration.registryScope, registryScope?.id ?? null);
      assert.equal(Object.isFrozen(run.services.get(sandboxTestService).manifest(["reference/sum"])), true);
    }, registryScope ? { registryScope } : {});
  } finally { await runtime.close(); }
});

test("candidate protocol failures stay eligible and cannot manufacture a passing grade", async () => {
  const scenarios: { name: string; run: Script; code: string }[] = [
    { name: "early exit", run(input, io) { ready(input, io); return {}; }, code: "EVAL_TEST_PROTOCOL" },
    { name: "duplicate", run(input, io) { ready(input, io); result(input, io, { kind: "return", value: 5 }); result(input, io, { kind: "return", value: 5 }); return {}; }, code: "EVAL_TEST_PROTOCOL" },
    { name: "forged passed", run(input, io) { ready(input, io); result(input, io, { kind: "return", value: 5, passed: true }); return {}; }, code: "EVAL_TEST_PROTOCOL" },
    { name: "missing ready", run(input, io) { result(input, io, { kind: "return", value: 5 }); ready(input, io); return {}; }, code: "EVAL_TEST_PROTOCOL" },
    { name: "malformed", run(input, io) { ready(input, io); io.stdout?.(Buffer.from(SANDBOX_TEST_PROTOCOL_PREFIX + "{garbage}\n")); return {}; }, code: "EVAL_TEST_PROTOCOL" },
    { name: "nonfinite JSON", run(input, io) { ready(input, io); io.stdout?.(Buffer.from(frame(input, { type: "result", kind: "return", value: "value" }).replace('"value":"value"', '"value":1e999'))); return {}; }, code: "EVAL_TEST_PROTOCOL" },
    { name: "deep JSON", run(input, io) { ready(input, io); let value: unknown = 5; for (let index = 0; index < 66; index++) value = [value]; result(input, io, { kind: "return", value }); return {}; }, code: "EVAL_TEST_PROTOCOL" },
    { name: "wrong result", run(input, io) { ready(input, io); result(input, io, { kind: "return", value: "5" }); return {}; }, code: "EVAL_TEST_RETURN_MISMATCH" },
    { name: "nonzero exit", run(input, io) { ready(input, io); result(input, io, { kind: "return", value: 5 }); return { exitCode: 1 }; }, code: "EVAL_TEST_PROCESS_FAILED" },
    { name: "deadline", run(input, io) { ready(input, io); return { reason: "timeout", exitCode: null }; }, code: "EVAL_TEST_DEADLINE" },
    { name: "output limit", run(input, io) { ready(input, io); return { reason: "output-limit", exitCode: null }; }, code: "EVAL_TEST_OUTPUT_LIMIT" },
  ];
  for (const scenario of scenarios) await withService(() => mock(scenario.run), async service => {
    const grade = await service.grade("reference/sum", "/private/tmp/trial", new AbortController().signal);
    assert.equal(grade.status, "failed", scenario.name); assert.equal(grade.errorCode, null, scenario.name);
    assert.equal(grade.evidence.cases[0]!.code, scenario.code, scenario.name);
  });
});

test("only errors thrown by target invocation satisfy throws expectations", async () => {
  const throwing: SandboxTestPack = { ...pack, tests: [{ ...pack.tests[0]!, cases: [{ id: "throws", args: [], throws: "TypeError" }] }] };
  for (const [kind, expected] of [["throw", "passed"], ["import-error", "failed"], ["missing-export", "failed"], ["invalid-return", "failed"]] as const) {
    await withService(() => mock((input, io) => { ready(input, io); result(input, io, { kind, ...(kind === "throw" ? { name: "TypeError" } : {}) }); return {}; }), async service => {
      const grade = await service.grade("reference/sum", "/private/tmp/trial", new AbortController().signal);
      assert.equal(grade.status, expected);
    }, throwing);
  }
});

test("exhausting the shared test deadline between cases is an eligible task failure", async () => {
  const backend = mock((input, io) => {
    ready(input, io); result(input, io, { kind: "return", value: 5 });
    // Keep the timer queued until the next loop boundary to exercise that branch deterministically.
    const until = Date.now() + 12; while (Date.now() < until) { /* bounded clock advance */ }
    return {};
  });
  await withService(() => backend, async service => {
    const grade = await service.grade("reference/sum", "/private/tmp/trial", new AbortController().signal);
    assert.equal(grade.status, "failed"); assert.equal(grade.errorCode, null); assert.equal(backend.calls, 1);
    assert.equal(grade.evidence.cases[1]!.code, "EVAL_TEST_DEADLINE");
  }, { ...pack, tests: [{ ...pack.tests[0]!, cases: [...pack.tests[0]!.cases, { id: "second", args: [], expected: 5 }] }] }, { timeoutMs: 5, caseTimeoutMs: 5 });
});

test("backend preparation failure is excluded and diagnostics are bounded and redacted", async () => {
  await withService(() => mock((_input, io) => { io.stderr?.(Buffer.from("api_key=abcdef012345 " + "x".repeat(2000))); return { reason: "spawn-failed", code: "ISOLATION_UNAVAILABLE" }; }), async service => {
    const grade = await service.grade("reference/sum", "/private/tmp/trial", new AbortController().signal);
    assert.equal(grade.status, "error"); assert.equal(grade.errorCode, "ISOLATION_UNAVAILABLE");
    const diagnostic = grade.evidence.cases[0]!.diagnostics!;
    assert.equal(diagnostic.truncated, true); assert.ok(Buffer.byteLength(JSON.stringify(diagnostic.value)) <= 512);
    assert.equal(JSON.stringify(diagnostic).includes("abcdef012345"), false);
  });
});

test("cancellation waits for settled backend cleanup before returning", async () => {
  const controller = new AbortController(); let termination = false;
  const backend = mock(async (input, io, request) => {
    ready(input, io);
    await new Promise<void>(resolve => { request.signal!.addEventListener("abort", () => { termination = true; resolve(); }, { once: true }); controller.abort(); });
    return { reason: "cancelled" };
  });
  await withService(() => backend, async service => {
    const grade = await service.grade("reference/sum", "/private/tmp/trial", controller.signal);
    assert.equal(termination, true); assert.equal(backend.closes, 1); assert.equal(grade.cancelled, true);
    assert.equal(grade.status, "error"); assert.equal(grade.cleanup, "verified");
  });
});

test("unconfirmed process cleanup overrides correct output and retains recovery coordinates", async () => {
  const backend = mock((input, io) => { ready(input, io); result(input, io, { kind: "return", value: 5 }); return { cleanup: "unconfirmed" }; }, { unresolved: true, closeError: true });
  const runtime = await Runtime.create({ plugins: [createSandboxTestPackPlugin(pack), createSandboxTestPlugin({ backend: "native", factory: () => backend })] });
  const session = await runtime.openSession();
  await session.run(async run => {
    const service = run.services.get(sandboxTestService), grade = await service.grade("reference/sum", "/private/tmp/trial", new AbortController().signal);
    assert.equal(grade.status, "error"); assert.equal(grade.cleanup, "unconfirmed"); assert.equal(grade.errorCode, "CLEANUP_UNCONFIRMED");
    assert.deepEqual(grade.evidence.retainedPaths, ["/private/tmp/retained-grader"]);
    const next = await service.grade("reference/sum", "/private/tmp/next", new AbortController().signal);
    assert.equal(next.errorCode, "RESTART_REQUIRED"); assert.equal(backend.calls, 1);
  });
  await assert.rejects(runtime.close());
});

test("a backend which never settles has a bounded uncertain result and cannot admit more tests", async () => {
  const backend = mock((input, io) => { ready(input, io); return new Promise(() => {}); });
  const runtime = await Runtime.create({ plugins: [createSandboxTestPackPlugin(pack), createSandboxTestPlugin({ backend: "native", factory: () => backend, caseTimeoutMs: 5, cleanupMs: 5 })] });
  const session = await runtime.openSession();
  await session.run(async run => {
    const service = run.services.get(sandboxTestService), grade = await service.grade("reference/sum", "/private/tmp/trial", new AbortController().signal);
    assert.equal(grade.cleanup, "unconfirmed"); assert.equal(grade.status, "error");
    assert.equal((await service.grade("reference/sum", "/private/tmp/next", new AbortController().signal)).errorCode, "RESTART_REQUIRED");
    assert.equal(backend.calls, 1);
  });
  await assert.rejects(runtime.close());
});

test("native sandbox grader rejects early exits/non-JSON/import failures and preserves Host workspace", { skip: process.platform !== "darwin" || process.env.MINICAH_NATIVE_TEST !== "1" }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "minicah-grader-native-")));
  const sources = {
    good: "export function sum(a,b){process.stdout.write('progress without newline');return a+b}",
    patched: "import fs from 'node:fs'; JSON.stringify=()=>'{\\\"passed\\\":true}'; fs.writeSync=()=>0; export function sum(a,b){return a+b}",
    early: "process.exit(0); export function sum(){return 5}",
    nonfinite: "export function sum(){return NaN}",
    undefined: "export function sum(){}",
    syntax: "export function sum( {",
    pollution: "Object.prototype.sum={value:()=>5}; export const other=1",
    sparse: "export function sum(){Object.prototype['0']={value:5}; return new Array(1)}",
    writes: "import fs from 'node:fs'; export function sum(a,b){fs.writeFileSync('marker.txt','changed'); return a+b}",
  };
  try {
    for (const [name, source] of Object.entries(sources)) {
      await writeFile(join(directory, "sum.mjs"), source); await writeFile(join(directory, "marker.txt"), "original");
      const runtime = await Runtime.create({ plugins: [createSandboxTestPackPlugin(pack), createSandboxTestPlugin({ backend: "native" })] });
      let grade!: SandboxTestGrade;
      try { const session = await runtime.openSession(); grade = await session.run(run => run.services.get(sandboxTestService).grade("reference/sum", directory, new AbortController().signal)); }
      finally { await runtime.close(); }
      assert.equal(grade.status, ["good", "patched", "writes"].includes(name) ? "passed" : "failed", `${name}: ${JSON.stringify(grade)}`);
      assert.equal(grade.cleanup, "verified"); assert.equal(await readFile(join(directory, "marker.txt"), "utf8"), "original");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
