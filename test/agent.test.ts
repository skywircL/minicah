import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  Runtime, API_VERSION, services, createDeepSeekPlugin, createCodingToolsPlugin, createExecutionPlugin,
  createPermissionPlugin, createToolPipelinePlugin, createAgentLoopPlugin, createCompactionPlugin, createSessionPlugin, createContextPlugin,
  approvalUi, Workspace, contentHash, codingRecovery, definition, reference, type JsonValue, type RunContext, type ApprovalRequest, type Plugin,
} from "../src/index.js";
import { terminalText } from "../src/cli/plugin.js";
import { code, deferred } from "./helpers.js";

type Response = { text?: string; calls?: { id: string; name: string; args: string }[]; finish?: string; reasoning?: string; usage?: number; promptTokens?: number; omitUsage?: boolean };
function sse(res: ServerResponse, response: Response): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "provider-1", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  send({ role: "assistant", content: response.text ?? "", ...(response.reasoning ? { reasoning_content: response.reasoning } : {}) });
  for (const [index, call] of (response.calls ?? []).entries()) {
    send({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: call.args.slice(0, 3) } }] });
    send({ tool_calls: [{ index, function: { arguments: call.args.slice(3) } }] });
  }
  send({}, response.finish ?? (response.calls?.length ? "tool_calls" : "stop"));
  if (!response.omitUsage) res.write(`data: ${JSON.stringify({ id: "provider-1", choices: [], usage: { prompt_tokens: response.promptTokens ?? 50, completion_tokens: 10, total_tokens: response.usage ?? 60 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}
async function server(t: TestContext, respond: (body: any, index: number, res: ServerResponse) => void | Promise<void>) {
  const requests: any[] = [];
  const http = createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/chat/completions");
      let body = ""; for await (const chunk of req) body += String(chunk);
      const value = JSON.parse(body); requests.push(value); await respond(value, requests.length - 1, res);
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const address = http.address(); assert.ok(address && typeof address !== "string");
  return { endpoint: `http://127.0.0.1:${address.port}`, requests };
}
async function fixture(t: TestContext, respond: (body: any, index: number, res: ServerResponse) => void | Promise<void>, options: { approve?: boolean; limits?: Record<string, number>; model?: Record<string, number>; compaction?: Record<string, number | boolean>; readOnly?: boolean; extra?: Plugin[]; approveWait?: (signal: AbortSignal) => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "minicah-agent-"));
  let runtime: Runtime | undefined;
  t.after(async () => { await runtime?.close(); await rm(root, { recursive: true, force: true }); });
  const api = await server(t, respond), approvals: ApprovalRequest[] = [];
  const ui: Plugin = { id: "test-ui", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [approvalUi], requires: [], setup(ctx) {
    ctx.provide(approvalUi, () => ({ async approve(request, signal) { approvals.push(request); await options.approveWait?.(signal); return { binding: request.binding, decision: options.approve === false ? "deny" : "allow" }; } }));
  } };
  const directory = join(root, ".minicah", "sessions");
  const plugins = () => [createSessionPlugin({ directory }), createContextPlugin(), createDeepSeekPlugin({ apiKey: () => "fixture-key-never-persist" }), createExecutionPlugin(), createCodingToolsPlugin(root, options.readOnly ?? false), createPermissionPlugin(), ui, createToolPipelinePlugin({}, true, approvalUi), createCompactionPlugin(), createAgentLoopPlugin(), ...(options.extra ?? [])];
  const config = { "deepseek-model": { endpoint: api.endpoint, model: "fixture", thinking: true, ...options.model }, permissions: { workspace: root, policyVersion: "test-v1", ttlMs: 10_000 }, "coding-agent-loop": options.limits ?? {}, "context-compaction": options.compaction ?? {} };
  runtime = await Runtime.create({ plugins: plugins(), config });
  let session = await runtime.openSession("agent-test");
  return { root, api, approvals,
    run: (input = "Implement the task", signal?: AbortSignal) => session.run(run => run.services.get(services.agentLoop).run(input, signal)),
    events: () => session.run(run => run.services.get(services.session).events()),
    withRun: <T>(callback: (run: RunContext) => T | Promise<T>) => session.run(callback),
    update: (patch: Record<string, JsonValue>) => runtime!.updateConfig(patch),
    async recovery() { return session.run(run => codingRecovery(run.services.get(services.session))); },
    async reopen() { await runtime!.close(); runtime = await Runtime.create({ plugins: plugins(), config }); session = await runtime.openSession("agent-test"); },
  };
}
const call = (id: string, name: string, args: unknown) => ({ id, name, args: JSON.stringify(args) });

test("SDK → concurrent native tools → approved edit → final answer; replay only rebuilds context", async t => {
  let firstStarted = false, secondStarted = false;
  const extra: Plugin = { id: "parallel-probe", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [], requires: [], setup(ctx) {
    for (const name of ["probe_a", "probe_b"]) ctx.registerTool({ name, description: "concurrency test", effect: "read", inputSchema: { type: "object", additionalProperties: false }, async execute() {
      if (name === "probe_a") firstStarted = true; else secondStarted = true;
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.ok(firstStarted && secondStarted, "both native calls must be dispatched concurrently"); return { ok: true };
    } });
  } };
  const f = await fixture(t, (body, index, res) => {
    if (index === 0) return sse(res, { reasoning: "opaque continuation", calls: [call("p1", "probe_a", {}), call("p2", "probe_b", {}), call("read", "read_file", { path: "hello.ts" })] });
    if (index === 1) {
      const assistant = body.messages.find((message: any) => message.tool_calls);
      assert.equal(assistant.reasoning_content, "opaque continuation");
      const read = JSON.parse(body.messages.find((message: any) => message.tool_call_id === "read").content);
      assert.equal(read.value.text, "export const n = 1;\n");
      assert.equal(read.evidence, undefined);
      assert.equal(read.callId, undefined);
      assert.equal(read.status, "completed");
      return sse(res, { calls: [call("write", "edit_file", { path: "hello.ts", oldText: "n = 1", newText: "n = 2", expectedHash: read.value.hash })] });
    }
    sse(res, { text: index === 2 ? "已修改并核对。" : "已恢复历史。" });
  }, { extra: [extra] });
  await writeFile(join(f.root, "hello.ts"), "export const n = 1;\n");
  const result = await f.run(); assert.equal(result.status, "completed"); assert.equal(result.steps, 3);
  assert.equal(await readFile(join(f.root, "hello.ts"), "utf8"), "export const n = 2;\n");
  assert.equal(f.approvals.length, 1); assert.equal(f.approvals[0]!.binding.workspace, f.root);
  const events = await f.events(), serialized = JSON.stringify(events);
  assert.ok(!serialized.includes("fixture-key-never-persist"));
  assert.ok(events.some(event => event.data.type === "definition.recorded" && event.data.definition.id === "coding-agent-implementation"));
  const completed = events.filter(event => event.data.type === "tool.completed");
  assert.equal(completed.length, 4); assert.ok(completed.every(event => event.parentCallId));
  assert.ok(completed.every(event => event.data.type === "tool.completed" && (event.data.result as any).evidence));
  await f.reopen(); const resumed = await f.run("Continue from the recorded changes");
  assert.equal(resumed.status, "completed"); assert.equal((await f.events()).filter(event => event.data.type === "tool.completed").length, 4);
  assert.equal(f.approvals.length, 1);
});

test("malformed tool arguments and denied writes return durable errors without side effects", async t => {
  const f = await fixture(t, (body, index, res) => {
    if (!index) return sse(res, { calls: [{ id: "bad", name: "write_file", args: "{" }, call("denied", "write_file", { path: "new.txt", content: "hello", expectedHash: null })] });
    const results = body.messages.filter((m: any) => m.role === "tool").map((m: any) => JSON.parse(m.content));
    assert.equal(results.length, 2); assert.ok(results.every((r: any) => r.status === "failed"));
    sse(res, { text: "审批未通过。" });
  }, { approve: false });
  assert.equal((await f.run()).status, "completed"); assert.equal(f.approvals.length, 1);
  await assert.rejects(access(join(f.root, "new.txt")));
  assert.ok((await f.events()).some(event => event.data.type === "permission.decided" && event.data.decision === "deny" && event.data.approval));
});

test("uncertain side effects stop the loop and remain blocked after reopening", async t => {
  let writes = 0;
  const extra: Plugin = { id: "uncertain", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [], requires: [], setup(ctx) {
    ctx.registerTool({ name: "uncertain_write", description: "test", effect: "non-idempotent-write", inputSchema: { type: "object" }, execute() { writes++; throw new Error("after external commit"); } });
  } };
  const f = await fixture(t, (_body, _index, res) => sse(res, { calls: [call("u", "uncertain_write", {})] }), { extra: [extra] });
  assert.equal((await f.run()).status, "needs-reconciliation"); assert.equal(writes, 1); assert.equal(f.api.requests.length, 1);
  await f.reopen(); assert.equal((await f.run("continue")).status, "needs-reconciliation"); assert.equal(writes, 1); assert.equal(f.api.requests.length, 1);
  assert.equal((await f.recovery())[0]!.status, "uncertain");
});

test("truncated model output never dispatches proposed writes", async t => {
  const f = await fixture(t, (_body, _index, res) => sse(res, { calls: [call("w", "write_file", { path: "no.txt", content: "x", expectedHash: null })], finish: "length" }));
  assert.equal((await f.run()).text, "MODEL_OUTPUT_LIMIT"); assert.equal(f.approvals.length, 0); await assert.rejects(access(join(f.root, "no.txt")));
});

test("context capacity is separate from bytes and cumulative spending", async t => {
  const contextWindow = 20_000;
  const f = await fixture(t, (_body, _index, res) => sse(res, { text: "done", usage: 1_500_000 }), { model: { contextWindow } });
  const result = await f.run("const value = 12345;\n".repeat(1500));
  assert.equal(result.status, "completed", result.text); assert.equal(result.tokens, 1_500_000);
  const request = (await f.events()).find(event => event.data.type === "model.requested")!;
  if (request.data.type !== "model.requested") return assert.fail("missing request");
  const budget = request.data.budget!;
  assert.ok(budget.requestBytes > contextWindow);
  assert.ok(budget.promptTokens + budget.outputTokens <= contextWindow);
  assert.equal(budget.remainingTokens, null); assert.equal(budget.contextWindow, contextWindow);
  assert.equal(budget.outputTokens, f.api.requests[0].max_tokens);
  assert.equal(budget.requestBytes, Buffer.byteLength(JSON.stringify(request.data.request)));
  await f.reopen(); assert.deepEqual((await f.events()).find(event => event.seq === request.seq), request);
});

test("oversized current input reports context capacity without dispatch", async t => {
  const f = await fixture(t, (_body, _index, res) => sse(res, { text: "must not dispatch" }), { model: { contextWindow: 12_000 } });
  const result = await f.run("large current input ".repeat(3000));
  assert.equal(result.text, "CONTEXT_CAPACITY"); assert.equal(f.api.requests.length, 0);
  assert.ok((await f.events()).some(event => event.data.type === "context.measured"));
});

test("missing provider usage charges the recorded reservation, not bytes or zero", async t => {
  const f = await fixture(t, (_body, _index, res) => sse(res, { text: "done", omitUsage: true }));
  const result = await f.run();
  assert.equal(result.status, "completed");
  const request = (await f.events()).find(event => event.data.type === "model.requested")!;
  if (request.data.type !== "model.requested") return assert.fail("missing request");
  assert.equal(result.tokens, request.data.budget!.promptTokens + request.data.budget!.outputTokens);
});

test("matching provider anchors survive run boundaries and replay, but model changes invalidate them", async t => {
  const f = await fixture(t, (_body, index, res) => sse(res, !index
    ? { calls: [call("ls", "list_files", {})], promptTokens: 10_000, usage: 10_010 }
    : { text: "done", promptTokens: 10_000, usage: 10_010 }));
  assert.equal((await f.run()).status, "completed");
  await f.reopen(); assert.equal((await f.run("new run")).status, "completed");
  await f.update({ "deepseek-model": { endpoint: f.api.endpoint, model: "other" } });
  assert.equal((await f.run("changed model")).status, "completed");
  const requests = (await f.events()).filter(event => event.data.type === "model.requested");
  const budgets = requests.map(event => event.data.type === "model.requested" ? event.data.budget! : undefined!);
  assert.equal(budgets[0]!.anchorCallId, null);
  assert.equal(budgets[1]!.anchorCallId, requests[0]!.callId);
  assert.equal(budgets[2]!.anchorCallId, requests[1]!.callId);
  assert.equal(budgets[3]!.anchorCallId, null);
});

test("surface compaction changes future model history without repeating tools or hiding the audit transcript", async t => {
  const f = await fixture(t, (body, index, res) => {
    if (!index) return sse(res, { calls: [call("ls", "list_files", {})] });
    if (index === 1) return sse(res, { text: "Inspected files" });
    assert.ok(body.messages.some((message: any) => message.content?.includes("Recorded inspection summary")));
    assert.ok(!body.messages.some((message: any) => message.tool_calls || message.role === "tool"));
    sse(res, { text: "Continued from summary" });
  });
  assert.equal((await f.run()).status, "completed");
  const before = await f.events();
  await f.withRun(async run => {
    const log = run.services.get(services.session);
    const started = before.find(event => event.data.type === "run.started")!;
    if (started.data.type !== "run.started") return assert.fail("missing versions");
    await log.start(started.data.versions, {});
    const context = run.services.get(services.context);
    assert.strictEqual(context.build(), context.build());
    const nodes = context.build().surface.nodes;
    await log.record([{ data: { type: "surface.replaced", id: "compact", version: "1", text: "Recorded inspection summary", surfaceOp: { op: "replace", startSeq: nodes[0]!, endSeq: nodes.at(-1)! }, sourceEventSeqs: nodes } }]);
    await log.record([{ data: { type: "run.finished", status: "completed" } }]);
  });
  await f.reopen();
  assert.equal((await f.run("continue")).status, "completed");
  const after = await f.events();
  assert.deepEqual(after.slice(0, before.length), before);
  assert.equal(after.filter(event => event.data.type === "tool.completed").length, 1);
});

test("HTTP failure is not retried and cancellation closes an in-flight model request", async t => {
  const failure = await fixture(t, (_body, _index, res) => { res.writeHead(500); res.end('{"error":{"message":"fixture secret must not appear"}}'); });
  assert.equal((await failure.run()).status, "failed"); assert.equal(failure.api.requests.length, 1);
  assert.ok(!JSON.stringify(await failure.events()).includes("fixture secret"));
  const cancel = new AbortController();
  const f = await fixture(t, (_body, _index, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); cancel.abort(); });
  assert.equal((await f.run("wait", cancel.signal)).status, "cancelled");
  const events = await f.events(); assert.ok(events.some(event => event.data.type === "model.failed")); assert.equal((await f.recovery()).length, 0);
});

test("workspace tools reject stale hashes, protected paths and symlinks", async t => {
  const parent = await mkdtemp(join(tmpdir(), "minicah-files-")); t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "workspace"); await mkdir(root);
  await writeFile(join(parent, "escape"), "outside secret"); await writeFile(join(root, ".env"), "protected secret");
  await writeFile(join(root, "a.txt"), "old\n"); await symlink("a.txt", join(root, "link.txt"));
  const workspace = new Workspace(root), hash = workspace.read("a.txt").hash;
  assert.throws(() => workspace.read("../escape"), code("WORKSPACE_PATH"));
  assert.throws(() => workspace.read("link.txt"), code("WORKSPACE_SYMLINK"));
  assert.throws(() => workspace.read(".env"), code("WORKSPACE_PATH"));
  await writeFile(join(root, "a.txt"), "new\n"); assert.throws(() => workspace.write("a.txt", "lost", hash), /changed/);
  assert.throws(() => workspace.write("a.txt", "lost", null));
  workspace.write("nested/new.txt", "created", null); assert.equal(workspace.read("nested/new.txt").hash, contentHash("created"));
  await mkdir(join(root, "node_modules")); await writeFile(join(root, "node_modules", "skip"), "x");
  assert.deepEqual(workspace.files().paths.sort(), ["a.txt", "nested/new.txt"]);
});

test("managed host commands enforce timeout/output caps and do not inherit the model key", async t => {
  const root = await mkdtemp(join(tmpdir(), "minicah-exec-")); t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await Runtime.create({ plugins: [createExecutionPlugin()], config: { "host-execution": { timeoutMs: 500, killGraceMs: 20, cleanupMs: 1000, maxOutputBytes: 1000 } } });
  t.after(() => runtime.close()); const session = await runtime.openSession("exec");
  await session.run(async run => {
    const service = run.services.get(services.execution);
    const key = await service.execute({ command: process.execPath, args: ["-e", "console.log(process.env.DEEPSEEK_API_KEY === undefined)"], cwd: root });
    assert.equal(key.stdout.trim(), "true"); assert.equal(key.exitCode, 0);
    const timeout = await service.execute({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: root }); assert.equal(timeout.reason, "timeout");
    const large = await service.execute({ command: process.execPath, args: ["-e", "process.stdout.write('a'.repeat(10000))"], cwd: root });
    assert.equal(large.reason, "output-limit"); assert.ok(large.stdout.length <= 1000);
  });
});

test("CLI runs read-only task through SDK and replays without any key or model request", async t => {
  const root = await mkdtemp(join(tmpdir(), "minicah-cli-")); t.after(() => rm(root, { recursive: true, force: true }));
  const api = await server(t, (_body, index, res) => sse(res, index ? { text: "CLI OK" } : { calls: [call("ls", "list_files", {})] }));
  const cli = async (args: string[], key: boolean) => {
    const env = { ...process.env, DEEPSEEK_API_KEY: key ? "cli-fixture-key" : "" };
    const child = spawn(process.execPath, [resolve("dist/src/cli/main.js"), "--workspace", root, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => stdout += String(chunk)); child.stderr.on("data", chunk => stderr += String(chunk));
    const code = await new Promise(resolve => child.on("exit", resolve)); return { code, stdout, stderr };
  };
  const result = await cli(["--endpoint", api.endpoint, "--read-only", "--task", "List files"], true);
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /CLI OK/); assert.match(result.stderr, /已持久提交/);
  const id = /Session: (\S+)/.exec(result.stderr)![1]!;
  const replay = await cli(["--replay", id], false); assert.equal(replay.code, 0, replay.stderr); assert.match(replay.stdout, /CLI OK/); assert.equal(api.requests.length, 2);
  assert.equal(terminalText("a\x1b[2Jb\x1b]0;spoof\x07c\u202ed"), "abcd");
});

test("L1 model config takes effect on the next run; old request materials stay reconstructible", async t => {
  const f = await fixture(t, (_body, _index, res) => sse(res, { text: "done" }), { readOnly: true });
  assert.equal((await f.run()).status, "completed");
  const old = (await f.events()).find(event => event.data.type === "model.requested")!;
  await f.update({ "deepseek-model": { endpoint: f.api.endpoint, model: "new-model", thinking: false } });
  assert.equal((await f.run("another task")).status, "completed");
  assert.equal(f.api.requests[0].model, "fixture"); assert.equal(f.api.requests[1].model, "new-model");
  assert.deepEqual(f.api.requests[1].tools.map((tool: any) => tool.function.name).sort(), ["list_files", "read_file", "search_text"]);
  const reconstructed = await f.withRun(run => run.services.get(services.session).reconstructRequest(old.callId!));
  assert.deepEqual(reconstructed.request, f.api.requests[0]); assert.equal((reconstructed.request as any).model, "fixture");
  await assert.rejects(f.update({ "deepseek-model": { endpoint: "http://public.example", model: "x" } }));
});

test("pending approvals can be cancelled; a late allow cannot dispatch the write", async t => {
  const cancel = new AbortController();
  const f = await fixture(t, (_body, _index, res) => sse(res, { calls: [call("write", "write_file", { path: "cancelled.txt", content: "x", expectedHash: null })] }), {
    approveWait: async signal => {
      const aborted = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      cancel.abort(); await aborted;
    },
  });
  assert.equal((await f.run("write", cancel.signal)).status, "cancelled");
  await assert.rejects(access(join(f.root, "cancelled.txt")));
  assert.equal((await f.events()).filter(event => event.data.type === "tool.started").length, 0);
});

test("one Session rejects overlapping agent loops while its model request is active", async t => {
  let arrived!: () => void, reply!: () => void;
  const arrival = new Promise<void>(resolve => arrived = resolve), response = new Promise<void>(resolve => reply = resolve);
  const f = await fixture(t, async (_body, _index, res) => { arrived(); await response; sse(res, { text: "done" }); });
  const first = f.run(); await arrival;
  await assert.rejects(f.run("overlap"), error => (error as { code: string }).code === "AGENT_BUSY");
  reply(); assert.equal((await first).status, "completed"); assert.equal(f.api.requests.length, 1);
});

test("crash after a model batch but before tool planning is visible as not-started, never replayed", async t => {
  const f = await fixture(t, (_body, _index, res) => sse(res, { text: "must not be requested" }));
  await f.withRun(async run => {
    const log = run.services.get(services.session), model = run.services.get(services.model).definition(), tools = run.services.get(services.tool).definitions();
    const prompt = definition("prompt", "crash-test", "1.0.0", "fixture");
    await log.retain([model, prompt, ...tools]);
    await log.start({ model: reference(model), prompt: reference(prompt), tools: tools.map(reference), plugins: [] }, {});
    await log.record([{ callId: "model-crash", data: { type: "model.requested", request: { messages: [] } } },
      { callId: "model-crash", data: { type: "model.completed", text: "", childCallIds: ["missing-plan"], response: {
        format: "coding-agent-v1", completion: { message: { role: "assistant", content: null, tool_calls: [{ id: "wire", type: "function", function: { name: "write_file", arguments: "{}" } }] }, finishReason: "tool_calls", usage: null, providerId: "fixture" }, calls: [{ providerId: "wire", callId: "missing-plan" }],
      } } }]);
    await assert.rejects(log.record([{ data: { type: "summary.recorded", id: "bad", version: "1", text: "hides unstarted tool", coverage: { from: 1, to: log.state().throughSeq } } }]));
    await assert.rejects(log.record([{ data: { type: "run.finished", status: "completed" } }]));
  });
  await f.reopen(); assert.equal((await f.recovery())[0]!.status, "not-started");
  assert.equal((await f.run("continue")).status, "needs-reconciliation"); assert.equal(f.api.requests.length, 0);
});

test("protocol failures and single-request byte/deadline limits still stop dispatch", async t => {
  const duplicate = await fixture(t, (_body, _index, res) => sse(res, { calls: [call("same", "list_files", {}), call("same", "list_files", {})] }));
  assert.equal((await duplicate.run()).text, "MODEL_PROTOCOL"); assert.equal(duplicate.approvals.length, 0);
  const bytes = await fixture(t, (_body, _index, res) => sse(res, { text: "unexpected" }), { limits: { maxRequestBytes: 100 } });
  assert.equal((await bytes.run("short")).text, "REQUEST_BYTES"); assert.equal(bytes.api.requests.length, 0);
  const timeout = await fixture(t, (_body, _index, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); }, { model: { timeoutMs: 100 } });
  assert.equal((await timeout.run()).status, "failed");
  const output = await fixture(t, (_body, _index, res) => sse(res, { text: "x".repeat(3000) }));
  await output.update({ "deepseek-model": { endpoint: output.api.endpoint, model: "fixture", maxResponseBytes: 1024 } });
  assert.equal((await output.run()).text, "MODEL_OUTPUT_LIMIT");
});


test("more than twenty model requests and one million tokens do not stop a run", async t => {
  const f = await fixture(t, (_body, index, res) => sse(res, index < 21
    ? { calls: [call(`ls-${index}`, "list_files", {})], usage: 60_000 }
    : { text: "finished", usage: 60_000 }));
  const result = await f.run();
  assert.equal(result.status, "completed", result.text); assert.equal(result.steps, 22); assert.equal(result.tokens, 1_320_000);
  assert.ok(!(await f.events()).some(event => event.data.type === "budget.exited"));
});

const smallContext = { model: { contextWindow: 12_000, maxOutputTokens: 1024 }, compaction: { thresholdRatio: 0.4, retainRatio: 0, headroomTokens: 1024, maxSummaryTokens: 512 } };

test("pressure prunes long tool values while preserving structure, original evidence and replay", async t => {
  let executions = 0;
  const original = "BEGIN " + "read evidence ".repeat(1400) + " END";
  const extra: Plugin = { id: "long-read", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [], requires: [], setup(ctx) {
    ctx.registerTool({ name: "long_read", description: "read", effect: "read", inputSchema: { type: "object" }, execute() { executions++; return { text: original, hash: "a".repeat(64), count: 1400 }; } });
  } };
  const f = await fixture(t, (body, index, res) => {
    if (!index) return sse(res, { calls: [call("long", "long_read", {})] });
    const result = JSON.parse(body.messages.find((message: any) => message.role === "tool").content);
    assert.equal(result.status, "completed"); assert.equal(result.dispatched, true);
    assert.equal(result.value.hash, "a".repeat(64)); assert.equal(result.value.count, 1400);
    assert.match(result.value.text, /context text pruned/); assert.ok(result.value.text.length < 600);
    assert.ok(result.value.text.startsWith("BEGIN")); assert.ok(result.value.text.endsWith("END"));
    sse(res, { text: "done" });
  }, { ...smallContext, extra: [extra], compaction: { ...smallContext.compaction, thresholdChars: 1000, headChars: 200, tailChars: 100 } });
  assert.equal((await f.run()).status, "completed");
  const before = await f.events();
  assert.equal(before.filter(event => event.data.type === "context.tool-pruned").length, 1);
  assert.equal(before.filter(event => event.data.type === "context.compaction").length, 0);
  assert.ok(before.some(event => event.data.type === "tool.completed" && JSON.stringify(event.data.result).includes(original)));
  await f.reopen(); assert.equal((await f.run("continue")).status, "completed");
  assert.equal(executions, 1); assert.deepEqual((await f.events()).slice(0, before.length), before);
});

test("automatic summary commits a smaller surface, retains constraints and accounts for the auxiliary request", async t => {
  const f = await fixture(t, (body, index, res) => {
    if (!index) return sse(res, { text: "historical findings ".repeat(900) });
    if (index === 1) {
      assert.equal(body.tools, undefined); assert.equal(body.max_tokens, 512);
      assert.match(body.messages[1].content, /workspace|constraints/);
      return sse(res, { text: "Checked the project. Preserve constraints and continue verification.", usage: 123 });
    }
    assert.ok(body.messages.some((message: any) => message.content?.includes("Historical summary")));
    assert.ok(body.messages.some((message: any) => message.role === "system" && message.content?.includes(f.root)));
    assert.equal(body.messages.at(-1).content, index === 2 ? "next task" : "resume task");
    sse(res, { text: "done" });
  }, smallContext);
  assert.equal((await f.run("inspect")).status, "completed");
  const result = await f.run("next task");
  assert.equal(result.status, "completed", result.text); assert.equal(result.steps, 2); assert.equal(result.tokens, 183);
  const events = await f.events();
  const summary = events.find(event => event.data.type === "model.requested" && event.data.purpose === "compaction")!;
  const replacement = events.find(event => event.data.type === "surface.replaced")!;
  assert.ok(summary && replacement);
  const reconstructed = await f.withRun(run => run.services.get(services.session).reconstructRequest(summary.callId!));
  assert.ok(reconstructed.definitions.some(def => def.id === "context-summary"));
  await f.reopen(); assert.equal((await f.run("resume task")).status, "completed");
  const surface = await f.withRun(run => run.services.get(services.context).build().surface);
  assert.ok(surface.nodes.includes(replacement.seq)); assert.ok(!surface.events.some(event => event.callId === summary.callId));
});

test("confirmed context overflow retries only after a smaller committed generation", async t => {
  const f = await fixture(t, (body, index, res) => {
    if (!index) return sse(res, { text: "earlier findings ".repeat(900) });
    if (index === 1) { res.writeHead(400); return void res.end(JSON.stringify({ error: { code: "context_length_exceeded", message: "context window exceeded" } })); }
    if (index === 2) { assert.equal(body.tools, undefined); return sse(res, { text: "Earlier findings checkpoint" }); }
    assert.ok(JSON.stringify(body).length < JSON.stringify(f.api.requests[1]).length);
    sse(res, { text: "recovered" });
  });
  await f.run(); const result = await f.run("next");
  assert.equal(result.status, "completed", result.text); assert.equal(f.api.requests.length, 4);
  const events = await f.events();
  assert.equal(events.filter(event => event.data.type === "model.failed").length, 1);
  assert.ok(events.some(event => event.data.type === "context.measured" && (event.data.measurement as any).retry?.attempt === 1));
});

test("overflow without progress, unknown HTTP errors and exhausted recovery never retry unchanged input", async t => {
  for (const code of ["context_length_exceeded", "invalid_request_error"]) {
    const f = await fixture(t, (_body, _index, res) => { res.writeHead(400); res.end(JSON.stringify({ error: { code, message: code } })); });
    assert.equal((await f.run()).status, "failed"); assert.equal(f.api.requests.length, 1);
  }
  const repeated = await fixture(t, (_body, index, res) => {
    if (!index) return sse(res, { text: "old history ".repeat(1000) });
    if (index === 2) return sse(res, { text: "checkpoint" });
    res.writeHead(400); res.end(JSON.stringify({ error: { code: "context_length_exceeded", message: "context window exceeded" } }));
  });
  await repeated.run(); assert.equal((await repeated.run("next")).text, "MODEL_CONTEXT_OVERFLOW"); assert.equal(repeated.api.requests.length, 4);
});

test("failed or expanding summaries leave history intact; cancellation prevents replacement", async t => {
  for (const mode of ["larger", "http", "cancel", "tool"] as const) {
    const cancel = new AbortController();
    const f = await fixture(t, (_body, index, res) => {
      if (!index) return sse(res, { text: "old details ".repeat(1500) });
      if (index === 1) {
        if (mode === "cancel") { cancel.abort(); return sse(res, { text: "checkpoint" }); }
        if (mode === "http") { res.writeHead(500); return void res.end("failed"); }
        return sse(res, mode === "tool" ? { calls: [call("w", "write_file", { path: "no.txt", content: "x", expectedHash: null })] } : { text: "bigger summary ".repeat(2000) });
      }
      sse(res, { text: "continued without replacement" });
    }, smallContext);
    await f.run(); const result = await f.run("continue", cancel.signal);
    assert.equal(result.status, mode === "cancel" ? "cancelled" : "completed", result.text);
    const events = await f.events();
    assert.equal(events.filter(event => event.data.type === "surface.replaced").length, 0);
    assert.equal(events.filter(event => event.data.type === "tool.started").length, 0);
    assert.ok(events.some(event => event.data.type === "context.compaction" && event.data.phase === "failed"));
    assert.equal(f.api.requests.length, mode === "cancel" ? 2 : 3);
  }
});

test("automatic compaction can be disabled without reinstating cumulative limits", async t => {
  const f = await fixture(t, (_body, index, res) => sse(res, { text: index ? "done" : "old details ".repeat(1500), usage: 500_000 }), {
    ...smallContext, compaction: { ...smallContext.compaction, auto: false },
  });
  await f.run(); assert.equal((await f.run("continue")).status, "completed");
  assert.equal(f.api.requests.length, 2);
  assert.equal((await f.events()).filter(event => event.data.type === "context.compaction").length, 0);
});

// Adapted failure pattern: deepseek-ai/deepseek-harness a1271a49033b.
// This exercises minicah's real SDK adapter, dispatch, journal, and replay.
test("upstream regression: empty streaming identity deltas preserve calls and incomplete identities never dispatch", async t => {
  for (const mode of ["empty", "null", "missing"] as const) {
    const f = await fixture(t, (body, index, res) => {
      if (index) {
        const message = body.messages.find((m: any) => m.tool_calls);
        assert.equal(message.tool_calls[0].id, "identity-1");
        assert.equal(message.tool_calls[0].function.name, "list_files");
        return sse(res, { text: "done" });
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (part: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: "identity-stream", choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`);
      send({ tool_calls: [{ index: 0, ...(mode === "missing" ? {} : { id: "identity-1" }), type: "function", function: { ...(mode === "missing" ? {} : { name: "list_files" }), arguments: "{" } }] });
      send({ tool_calls: [{ index: 0, id: mode === "null" ? null : "", function: { name: mode === "null" ? null : "", arguments: "}" } }] });
      send({}, "tool_calls"); res.end("data: [DONE]\n\n");
    });
    const result = await f.run("List the workspace");
    const events = await f.events();
    assert.equal(events.filter(e => e.data.type === "tool.started").length, mode === "missing" ? 0 : 1);
    assert.equal(result.status, mode === "missing" ? "failed" : "completed");
    if (mode === "missing") assert.equal(result.text, "MODEL_PROTOCOL");
    else {
      const completed = events.filter(e => e.data.type === "model.completed");
      assert.equal(completed.length, 2);
      assert.ok(JSON.stringify(completed[0]).includes("identity-1"));
    }
    const requests = f.api.requests.length;
    await f.reopen(); assert.deepEqual(await f.events(), events);
    assert.equal(f.api.requests.length, requests);
  }
});

// Adapted from pi #10000; the accepted user input is durable before any reply.
test("upstream regression: first user input survives a failed first model request and reopening", async t => {
  const f = await fixture(t, (_body, index, res) => {
    if (!index) { res.writeHead(503); return void res.end("fixture unavailable"); }
    sse(res, { text: "continued" });
  });
  const result = await f.run("Keep this first request");
  assert.equal(result.status, "failed");
  const events = await f.events();
  assert.equal(events.filter(e => e.data.type === "user.input" && e.data.content === "Keep this first request").length, 1);
  assert.equal(events.filter(e => e.data.type === "model.completed").length, 0);
  assert.equal(events.filter(e => e.data.type === "tool.started").length, 0);
  await f.reopen(); assert.deepEqual(await f.events(), events);
  assert.equal(f.api.requests.length, 1);
  assert.equal((await f.run("Continue after the provider recovers")).status, "completed");
  assert.equal(f.api.requests.length, 2);
  assert.equal(f.api.requests[1].messages.filter((m: any) => m.role === "user" && m.content === "Keep this first request").length, 1);
});

// Adapted from pi #8920: cancellation must reach the auxiliary model request.
test("upstream regression: cancelling a live compaction closes its stream and permits a later turn", async t => {
  const cancel = new AbortController(), started = deferred(), closed = deferred();
  const f = await fixture(t, (_body, index, res) => {
    if (!index) return sse(res, { text: "old details ".repeat(1500) });
    if (index === 1) {
      res.once("close", () => closed.resolve());
      res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); started.resolve(); return;
    }
    sse(res, { text: index === 2 ? "Small valid checkpoint" : "continued" });
  }, smallContext);
  await f.run();
  const pending = f.run("Continue", cancel.signal);
  await started.promise; cancel.abort();
  assert.equal((await pending).status, "cancelled");
  await closed.promise;
  const cancelledEvents = await f.events();
  assert.equal(cancelledEvents.filter(e => e.data.type === "surface.replaced").length, 0);
  assert.equal(cancelledEvents.filter(e => e.data.type === "tool.started").length, 0);
  assert.equal(f.api.requests.length, 2);
  assert.equal((await f.run("Resume with a fresh turn")).status, "completed");
  assert.equal(f.api.requests.length, 4);
  assert.equal((await f.events()).filter(e => e.data.type === "surface.replaced").length, 1);
});
