import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Runtime, API_VERSION, services, definition, contentHash,
  createSessionPlugin, createContextPlugin, createExecutionPlugin, createCodingToolsPlugin,
  createPermissionPlugin, createToolPipelinePlugin, createCompactionPlugin, createAgentLoopPlugin,
  type Plugin, type JsonValue, type ModelCompletion, type CompletionContract, type SessionEvent,
} from "../src/index.js";
import type { CompletionCheck } from "../src/agent/completion.js";

const completed = '{"status":"completed"}', denied = '{"status":"denied"}';
const contract: CompletionContract = {
  maxContinuations: 0,
  responseSchema: { type: "object", additionalProperties: false, required: ["status"], properties: { status: { enum: ["completed", "denied"] } } },
  responseStatus: { pointer: "/status", completed: "completed", denied: "denied" },
};
const response = (text = completed): ModelCompletion => ({ message: { role: "assistant", content: text }, finishReason: "stop", usage: { prompt: 1, completion: 1, total: 2 }, providerId: "read-error-fixture" });
const call = (name: string, args: JsonValue): ModelCompletion => ({ ...response(), finishReason: "tool_calls", message: { role: "assistant", content: null,
  tool_calls: [{ id: "tool-call", type: "function", function: { name, arguments: JSON.stringify(args) } }] } });

async function fixture(t: TestContext, replies: ModelCompletion[], options: { deny?: boolean; extra?: Plugin } = {}) {
  const root = await mkdtemp(join(tmpdir(), "completion-read-errors-"));
  let index = 0, events: readonly SessionEvent[] = [];
  const model: Plugin = { id: "read-error-model", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [services.model], requires: [], setup(ctx) {
    ctx.provide(services.model, () => ({ definition: () => definition("model", "read-error-fixture", "1.0.0", {}),
      limits: () => ({ contextWindow: 100000, maxOutputTokens: 4096 }),
      prepare: (messages, tools) => JSON.parse(JSON.stringify({ messages, tools })) as JsonValue,
      async complete() { const result = replies[index++]; assert.ok(result, "Unexpected model continuation"); return result; },
    }));
  } };
  const runtime = await Runtime.create({ plugins: [createSessionPlugin({ directory: join(root, ".minicah", "sessions") }), createContextPlugin(), model,
    createExecutionPlugin(), createCodingToolsPlugin(root), createPermissionPlugin(), createToolPipelinePlugin({
      approve: async request => ({ binding: request.binding, decision: options.deny ? "deny" : "allow" }),
    }, true), createCompactionPlugin(), createAgentLoopPlugin(), ...(options.extra ? [options.extra] : [])],
    config: { permissions: { workspace: root, policyVersion: "read-errors", ttlMs: 10000 }, "context-compaction": { auto: false } } });
  const session = await runtime.openSession("read-errors");
  t.after(async () => {
    try { await runtime.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  return { root, calls: () => index, events: () => events,
    run: (conditions: CompletionContract = {}) => session.run(async run => {
      try {
        const result = await run.services.get(services.agentLoop).run("Complete the public file task and report its actual status.", undefined, { completion: { ...contract, ...conditions } });
        assert.ok(index > 0, `Fixture did not reach the model: ${JSON.stringify(result)}`);
        return result;
      }
      finally { events = run.services.get(services.session).events(); }
    }),
  };
}
function lastCheck(events: readonly SessionEvent[]): CompletionCheck {
  const checks = events.flatMap(event => event.data.type === "context.measured" ? [event.data.measurement as unknown as { kind?: string; check?: CompletionCheck }] : [])
    .filter(event => event.kind === "completion-contract-v1" && event.check);
  return checks.at(-1)!.check!;
}

test("a failed single-file search remains diagnostic after required reads and a verified write", async t => {
  const before = "old\n", after = "new\n";
  const f = await fixture(t, [call("read_file", { path: "lib/consumer.txt" }), call("read_file", { path: "lib/target.txt" }),
    call("search_text", { path: "lib/consumer.txt", query: "use" }), call("search_text", { path: "lib", query: "use" }),
    call("write_file", { path: "lib/target.txt", content: after, expectedHash: contentHash(before) }), call("read_file", { path: "lib/target.txt" }), response()]);
  await mkdir(join(f.root, "lib")); await writeFile(join(f.root, "lib/consumer.txt"), "use target\n"); await writeFile(join(f.root, "lib/target.txt"), before);
  const result = await f.run({ readPaths: ["lib/consumer.txt", "lib/target.txt"], allowedChanges: ["lib/target.txt"] });
  assert.equal(result.status, "completed"); assert.equal(f.calls(), 7); assert.equal(await readFile(join(f.root, "lib/target.txt"), "utf8"), after);
  const facts = lastCheck(f.events()).facts;
  assert.equal(facts.executionErrors, 1); assert.equal(facts.unresolvedErrors, 0);
  const error = facts.toolErrors[0]!;
  assert.equal(error.tool, "search_text"); assert.equal(error.path, "lib/consumer.txt"); assert.equal(error.code, "ENOTDIR"); assert.equal(error.effect, "read"); assert.equal(error.disposition, "diagnostic");
  assert.ok(f.events().some(event => event.seq === error.seq && event.callId === error.callId && event.data.type === "tool.completed"));
});

test("mistaking a directory for a file does not invalidate successful public read obligations", async t => {
  const f = await fixture(t, [call("read_file", { path: "lib/required.txt" }), call("read_file", { path: "lib" }), call("list_files", { path: "lib" }), response()]);
  await mkdir(join(f.root, "lib")); await writeFile(join(f.root, "lib/required.txt"), "required content");
  assert.equal((await f.run({ readPaths: ["lib/required.txt"], allowedChanges: [] })).status, "completed");
  assert.equal(lastCheck(f.events()).facts.toolErrors[0]!.code, "FILE_LIMIT");
  assert.equal(lastCheck(f.events()).facts.toolErrors[0]!.disposition, "diagnostic");
});

test("missing or truncated required reads still block despite harmless exploratory failures", async t => {
  for (const truncated of [false, true]) await t.test(String(truncated), async t => {
    const f = await fixture(t, [call("read_file", { path: "unavailable.txt" }),
      call("read_file", { path: "required.txt", ...(truncated ? { lineCount: 1 } : {}) }), response()]);
    if (truncated) await writeFile(join(f.root, "required.txt"), "first\nsecond\n");
    assert.equal((await f.run({ readPaths: ["required.txt"] })).status, "failed");
    const check = lastCheck(f.events());
    assert.ok(check.goalIssues.some(issue => issue.code === "READ_SNAPSHOT_MISSING" && issue.path === "required.txt"));
    assert.equal(check.facts.unresolvedErrors, 0);
  });
});

test("schema errors are classified using the pinned tool effect without satisfying a required read", async t => {
  for (const required of [false, true]) await t.test(String(required), async t => {
    const f = await fixture(t, [call("read_file", { path: "required.txt", unexpected: true }), response()]);
    await writeFile(join(f.root, "required.txt"), "content");
    assert.equal((await f.run(required ? { readPaths: ["required.txt"] } : {})).status, required ? "failed" : "completed");
    const facts = lastCheck(f.events()).facts;
    assert.equal(facts.parameterErrors, 1); assert.deepEqual(facts.reads, []);
    assert.equal(facts.toolErrors[0]!.code, "INVALID_ARGUMENTS"); assert.equal(facts.toolErrors[0]!.effect, "read"); assert.equal(facts.toolErrors[0]!.disposition, "diagnostic");
  });
});

test("a rejected write is never discharged by a successful read or an unrelated write", async t => {
  const f = await fixture(t, [call("write_file", { path: "needed.txt", content: "needed", expectedHash: null, unexpected: true }),
    call("read_file", { path: "evidence.txt" }), call("write_file", { path: "other.txt", content: "other", expectedHash: null }), response()]);
  await writeFile(join(f.root, "evidence.txt"), "evidence");
  assert.equal((await f.run()).status, "failed");
  const check = lastCheck(f.events()); assert.equal(check.facts.unresolvedErrors, 1);
  assert.equal(check.facts.toolErrors[0]!.effect, "write"); assert.equal(check.facts.toolErrors[0]!.disposition, "blocking");
  assert.ok(check.goalIssues.some(issue => issue.code === "TOOL_ERRORS_UNRESOLVED"));
});

test("correcting the same write retains the rejection and its explicit resolution evidence", async t => {
  const f = await fixture(t, [call("write_file", { path: "needed.txt", content: "needed", expectedHash: null, unexpected: true }),
    call("write_file", { path: "needed.txt", content: "needed", expectedHash: null }), response()]);
  assert.equal((await f.run()).status, "completed");
  const error = lastCheck(f.events()).facts.toolErrors[0]!;
  assert.equal(error.disposition, "resolved"); assert.ok(error.resolvedBy && error.resolvedBy.seq > error.seq);
  assert.ok(f.events().some(event => event.callId === error.resolvedBy!.callId && event.seq === error.resolvedBy!.seq && event.data.type === "tool.completed"));
});

test("a public JSON target proves only the matching file's state, never an unrelated failed write", async t => {
  for (const samePath of [false, true]) await t.test(String(samePath), async t => {
    const path = samePath ? "config.json" : "other.json";
    const f = await fixture(t, [call("write_file", { path, content: '{"value":1}', expectedHash: null }), response()]);
    await writeFile(join(f.root, "config.json"), '{"value":1}'); await writeFile(join(f.root, "other.json"), '{"value":0}');
    assert.equal((await f.run({ jsonTargets: [{ path: "config.json", pointer: "/value", value: 1 }] })).status, samePath ? "completed" : "failed");
    assert.equal(lastCheck(f.events()).facts.toolErrors[0]!.code, "FILE_CONFLICT");
  });
});

test("unknown tools and workspace access violations remain blocking", async t => {
  for (const request of [call("not_a_tool", {}), call("read_file", { path: "../outside.txt" })]) await t.test(request.message.tool_calls![0]!.function.name, async t => {
    const f = await fixture(t, [request, response()]);
    assert.equal((await f.run()).status, "failed"); assert.equal(lastCheck(f.events()).facts.unresolvedErrors, 1);
    assert.equal(lastCheck(f.events()).facts.toolErrors[0]!.disposition, "blocking");
  });
});

test("an uncertain read cannot be treated as a completed exploratory miss", async t => {
  const plugin: Plugin = { id: "uncertain-reader", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [], requires: [], setup(ctx) {
    ctx.registerTool({ name: "uncertain_read", description: "fixture", effect: "read", inputSchema: { type: "object" }, execute() { throw new Error("read did not settle"); } });
  } };
  const f = await fixture(t, [call("uncertain_read", {})], { extra: plugin });
  assert.equal((await f.run()).status, "needs-reconciliation"); assert.equal(f.calls(), 1);
  assert.equal(lastCheck(f.events()).facts.uncertainCalls, 1);
  assert.ok(lastCheck(f.events()).unsafeIssues.some(issue => issue.code === "COMPLETION_TOOL_UNCERTAIN"));
});

test("a real denial stays a denial even when a prior read error was only diagnostic", async t => {
  const f = await fixture(t, [call("read_file", { path: "missing.txt" }), call("write_file", { path: "target.txt", content: "new", expectedHash: null }), response(denied)], { deny: true });
  assert.equal((await f.run({ allowedChanges: ["target.txt"] })).status, "completed");
  const check = lastCheck(f.events()); assert.equal(check.facts.denied.length, 1); assert.equal(check.facts.successfulWrites, 0);
  assert.equal(check.facts.toolErrors[0]!.disposition, "diagnostic");
  await assert.rejects(readFile(join(f.root, "target.txt")), { code: "ENOENT" });
});
