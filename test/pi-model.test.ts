import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { piConfig, piModel, createPiPlugin } from "../src/agent/pi.js";
import { deepSeekConfig, deepSeekModel } from "../src/agent/deepseek.js";
import type { Message } from "../src/agent/contracts.js";
import { Runtime, services, createSessionPlugin, createContextPlugin, createCodingToolsPlugin, createToolPipelinePlugin, createCompactionPlugin, createAgentLoopPlugin, type ToolInfo } from "../src/index.js";
import { code } from "./helpers.js";

const KEY = "pi-fixture-key-must-never-be-recorded";
const tool: ToolInfo = { owner: "fixture", generation: 1, scope: "runtime", sessionId: undefined, name: "read_file", description: "Read one file", effect: "read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } };
const initial: Message[] = [{ role: "system", content: "Inspect the workspace." }, { role: "user", content: "Read hello.ts and summarize." }];
interface Request { path: string; body: any; authorization: string | undefined }

async function server(t: TestContext, respond: (request: Request, index: number, res: ServerResponse) => unknown | Promise<unknown>) {
  const requests: Request[] = [];
  const failures: unknown[] = [];
  const http = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += String(chunk);
      const request = { path: req.url ?? "", body: JSON.parse(raw), authorization: req.headers.authorization };
      requests.push(request); await respond(request, requests.length - 1, res);
    } catch (error) { failures.push(error); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); assert.deepEqual(failures, []); });
  const address = http.address(); assert.ok(address && typeof address !== "string");
  return { endpoint: `http://127.0.0.1:${address.port}`, requests };
}
function events(res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  return (event: any) => res.write(`${event.type ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`);
}
function chat(res: ServerResponse, options: { text?: string; args?: string; finish?: string; usage?: boolean; incomplete?: boolean } = {}) {
  const send = events(res);
  const chunk = (delta: unknown, finish_reason: string | null = null) => send({ id: "chat_fixture", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason }] });
  chunk({ role: "assistant", content: options.text ?? "", reasoning_content: "opaque private reasoning" });
  if (options.args !== undefined) {
    chunk({ tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "read_file", arguments: options.args.slice(0, 4) } }] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: options.args.slice(4) } }] });
  }
  if (options.incomplete) return res.end();
  chunk({}, options.finish ?? (options.args !== undefined ? "tool_calls" : "stop"));
  if (options.usage !== false) send({ id: "chat_fixture", choices: [], usage: { prompt_tokens: 24, completion_tokens: 6, total_tokens: 30, prompt_tokens_details: { cached_tokens: 8 } } });
  res.end("data: [DONE]\n\n");
}
function anthropic(res: ServerResponse, withTool: boolean) {
  const send = events(res);
  send({ type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 } } });
  if (withTool) {
    send({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
    send({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "private anthropic reasoning" } });
    send({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed-thinking-fixture" } });
    send({ type: "content_block_stop", index: 0 });
    send({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_fixture", name: "read_file", input: {} } });
    send({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"hello.ts"}' } });
    send({ type: "content_block_stop", index: 1 });
  } else {
    send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Read complete." } });
    send({ type: "content_block_stop", index: 0 });
  }
  send({ type: "message_delta", delta: { stop_reason: withTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  send({ type: "message_stop" }); res.end();
}
function responses(res: ServerResponse, withTool: boolean, finalArguments = '{"path":"hello.ts"}') {
  const send = events(res);
  send({ type: "response.created", response: { id: "resp_fixture", status: "in_progress" } });
  const reasoning = { type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "private response reasoning" }], encrypted_content: "opaque-encrypted-reasoning" };
  if (withTool) {
    send({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_fixture", summary: [] } });
    send({ type: "response.output_item.done", output_index: 0, item: reasoning });
  }
  const index = withTool ? 1 : 0;
  const item = withTool
    ? { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "read_file", arguments: finalArguments, status: "completed" }
    : { type: "message", id: "msg_final", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Read complete.", annotations: [] }] };
  send({ type: "response.output_item.added", output_index: index, item: withTool ? { ...item, arguments: "" } : { ...item, content: [] } });
  send(withTool
    ? { type: "response.function_call_arguments.delta", output_index: index, item_id: "fc_fixture", delta: '{"path":"hello.ts"}' }
    : { type: "response.output_text.delta", output_index: index, item_id: "msg_final", content_index: 0, delta: "Read complete." });
  send({ type: "response.output_item.done", output_index: index, item });
  send({ type: "response.completed", response: { id: "resp_fixture", status: "completed", output: withTool ? [reasoning, item] : [item], usage: { input_tokens: 24, output_tokens: 6, total_tokens: 30, input_tokens_details: { cached_tokens: 8 } } } });
  res.end();
}
function continueWith(message: Message): Message[] {
  assert.equal(message.tool_calls?.length, 1);
  return [...initial, message, { role: "tool", tool_call_id: message.tool_calls[0]!.id, content: '{"status":"completed","value":{"text":"export const n = 1;"}}' }];
}

test("Pi Chat Completions preserves tools, continuation, usage and excludes credentials from durable requests", async t => {
  const api = await server(t, (_request, index, res) => chat(res, index ? { text: "Read complete." } : { args: '{"path":"hello.ts"}' }));
  const model = piModel(piConfig({ provider: "deepseek", model: "deepseek-flash", endpoint: api.endpoint }), KEY);
  const request = model.prepare(initial, [tool]);
  assert.ok(!JSON.stringify([request, model.definition()]).includes(KEY));
  const text: string[] = [];
  const first = await model.complete(request, { onText: value => text.push(value) });
  assert.equal(first.finishReason, "tool_calls");
  assert.equal(first.message.tool_calls?.[0]?.function.arguments, '{"path":"hello.ts"}');
  assert.deepEqual(first.usage, { prompt: 24, completion: 6, total: 30 });
  assert.ok(first.message.providerReplay);
  assert.ok(!text.join("").includes("opaque private reasoning"));
  const final = await model.complete(model.prepare(continueWith(first.message), [tool]), { onText: value => text.push(value) });
  assert.equal(final.message.content, "Read complete."); assert.equal(text.join(""), "Read complete.");
  assert.equal(api.requests[0]!.path, "/chat/completions");
  assert.equal(api.requests[0]!.authorization, `Bearer ${KEY}`);
  const wire = api.requests[1]!.body;
  assert.equal(wire.messages.find((message: any) => message.role === "assistant").tool_calls[0].id, "call_read");
  assert.equal(wire.messages.find((message: any) => message.role === "tool").tool_call_id, "call_read");
  assert.ok(!JSON.stringify(wire).includes("providerReplay"));
});

test("Pi Mistral maps its output budget and preserves tool result identifiers", async t => {
  const api = await server(t, (_request, index, res) => chat(res, index ? { text: "Read complete." } : { args: '{"path":"hello.ts"}' }));
  const model = piModel(piConfig({ provider: "mistral", model: "devstral-latest", endpoint: api.endpoint, maxOutputTokens: 2048 }), KEY);
  const first = await model.complete(model.prepare(initial, [tool]));
  const final = await model.complete(model.prepare(continueWith(first.message), [tool]));
  assert.equal(final.message.content, "Read complete.");
  assert.match(api.requests[0]!.path, /chat\/completions$/);
  assert.equal(api.requests[0]!.body.max_tokens, 2048);
  const messages = api.requests[1]!.body.messages;
  const call = messages.find((message: any) => message.role === "assistant").tool_calls[0];
  const result = messages.find((message: any) => message.role === "tool");
  assert.equal(result.tool_call_id, call.id);
  assert.equal(call.id, first.message.tool_calls![0]!.id);
});

test("Pi Anthropic preserves signed thinking for same route and strips replay from other providers", async t => {
  const api = await server(t, (_request, index, res) => anthropic(res, index === 0));
  const model = piModel(piConfig({ provider: "anthropic", model: "claude-sonnet-4-5", endpoint: api.endpoint, reasoning: "low" }), KEY);
  const text: string[] = [];
  const first = await model.complete(model.prepare(initial, [tool]), { onText: value => text.push(value) });
  assert.deepEqual(first.usage, { prompt: 30, completion: 5, total: 35 });
  assert.ok(first.message.providerReplay); assert.equal(text.join(""), "");
  const history = continueWith(first.message);
  assert.throws(() => model.prepare(continueWith({ ...first.message, content: "altered public content" }), [tool]), code("MODEL_PROTOCOL"));
  for (const field of ["thinking", "thinkingSignature"]) {
    const changed = JSON.parse(JSON.stringify(first.message));
    const originalPublicHash = changed.providerReplay.publicHash;
    const block = changed.providerReplay.message.content.find((part: any) => part.type === "thinking");
    block[field] = "altered private replay content";
    assert.equal(changed.providerReplay.publicHash, originalPublicHash);
    assert.throws(() => model.prepare(continueWith(changed), [tool]), code("MODEL_PROTOCOL"));
  }
  const final = await model.complete(model.prepare(history, [tool]));
  assert.equal(final.message.content, "Read complete.");
  const wire = api.requests[1]!.body;
  assert.match(api.requests[1]!.path, /^\/v1\/messages/);
  const assistant = wire.messages.find((message: any) => message.role === "assistant");
  assert.ok(assistant.content.some((block: any) => block.type === "thinking" && block.signature === "signed-thinking-fixture"));
  assert.ok(wire.messages.some((message: any) => Array.isArray(message.content) && message.content.some((block: any) => block.type === "tool_result" && block.tool_use_id === "toolu_fixture")));
  const other = piModel(piConfig({ provider: "deepseek", model: "deepseek-flash", endpoint: api.endpoint }), KEY);
  assert.ok(!JSON.stringify(other.prepare(history, [tool])).includes("signed-thinking-fixture"));
  const direct = deepSeekModel(deepSeekConfig({ model: "deepseek-flash", endpoint: api.endpoint }), KEY);
  const directRequest = JSON.stringify(direct.prepare(history, [tool]));
  assert.ok(!directRequest.includes("providerReplay")); assert.ok(!directRequest.includes("signed-thinking-fixture"));
});

test("Pi OpenAI Responses round-trips tool result IDs and encrypted reasoning", async t => {
  const api = await server(t, (_request, index, res) => responses(res, index === 0));
  const model = piModel(piConfig({ provider: "openai", model: "gpt-5", endpoint: api.endpoint, reasoning: "low" }), KEY);
  const first = await model.complete(model.prepare(initial, [tool]));
  assert.equal(first.finishReason, "tool_calls"); assert.deepEqual(first.usage, { prompt: 24, completion: 6, total: 30 });
  const final = await model.complete(model.prepare(continueWith(first.message), [tool]));
  assert.equal(final.message.content, "Read complete."); assert.equal(api.requests[0]!.path, "/responses");
  const input = api.requests[1]!.body.input;
  assert.ok(input.some((item: any) => item.type === "function_call_output" && item.call_id === "call_fixture"));
  assert.ok(input.some((item: any) => item.type === "reasoning" && item.encrypted_content === "opaque-encrypted-reasoning"));
});

test("Pi Responses uses authoritative final arguments when provider corrects streamed arguments", async t => {
  const api = await server(t, (_request, _index, res) => responses(res, true, '{"path":"corrected.ts"}'));
  const model = piModel(piConfig({ provider: "openai", model: "gpt-5", endpoint: api.endpoint, reasoning: "low" }), KEY);
  const result = await model.complete(model.prepare(initial, [tool]));
  assert.equal(result.message.tool_calls?.[0]?.function.arguments, '{"path":"corrected.ts"}');
});

test("Pi Anthropic thinking stays within the harness output reservation", async t => {
  const api = await server(t, (_request, _index, res) => anthropic(res, false));
  const model = piModel(piConfig({ provider: "anthropic", model: "claude-sonnet-4-5", endpoint: api.endpoint, reasoning: "high", maxOutputTokens: 4096 }), KEY);
  await model.complete(model.prepare(initial, [tool], 2048));
  const request = api.requests[0]!.body;
  assert.equal(request.max_tokens, 2048);
  assert.equal(request.thinking.type, "enabled");
  assert.equal(request.thinking.budget_tokens, 1024);
  assert.throws(() => model.prepare(initial, [tool], 1024), code("INVALID_CONFIG"));
});

test("Pi Google preserves function signatures and excludes private thought text from streaming", async t => {
  const signature = Buffer.from("google-signed-fixture").toString("base64");
  const api = await server(t, (_request, index, res) => {
    const send = events(res);
    const parts = index ? [{ text: "Read complete." }] : [{ text: "private google thought", thought: true }, { functionCall: { id: "google_read", name: "read_file", args: { path: "hello.ts" } }, thoughtSignature: signature }];
    send({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 24, candidatesTokenCount: 4, thoughtsTokenCount: 2, totalTokenCount: 30, cachedContentTokenCount: 8 }, modelVersion: "gemini-2.5-flash", responseId: "google_fixture" });
    res.end();
  });
  const model = piModel(piConfig({ provider: "google", model: "gemini-2.5-flash", endpoint: api.endpoint }), KEY);
  const text: string[] = [];
  const first = await model.complete(model.prepare(initial, [tool]), { onText: value => text.push(value) });
  assert.deepEqual(first.usage, { prompt: 24, completion: 6, total: 30 });
  assert.equal(first.finishReason, "tool_calls"); assert.equal(text.join(""), "");
  const final = await model.complete(model.prepare(continueWith(first.message), [tool]));
  assert.equal(final.message.content, "Read complete."); assert.match(api.requests[0]!.path, /models\/gemini-2\.5-flash:streamGenerateContent/);
  const contents = api.requests[1]!.body.contents;
  assert.ok(contents.some((message: any) => message.parts.some((part: any) => part.functionCall && part.thoughtSignature === signature)));
  assert.ok(contents.some((message: any) => message.parts.some((part: any) => part.functionResponse?.name === "read_file")));
});

test("Pi Google rejects an undersized thinking reservation before any request", () => {
  const config = { provider: "google", model: "gemini-2.5-flash", reasoning: "low" };
  assert.throws(() => piModel(piConfig({ ...config, maxOutputTokens: 1024 }), KEY), code("INVALID_CONFIG"));
  const model = piModel(piConfig(config), KEY);
  assert.throws(() => model.prepare(initial, [tool], 1024), code("INVALID_CONFIG"));
});

test("Pi preserves malformed raw tool JSON for rejection by the harness", async t => {
  const raw = '{"path":"hello.ts"';
  const api = await server(t, (_request, _index, res) => chat(res, { args: raw }));
  const model = piModel(piConfig({ provider: "deepseek", model: "deepseek-flash", endpoint: api.endpoint }), KEY);
  const completed = await model.complete(model.prepare(initial, [tool]));
  assert.equal(completed.message.tool_calls?.[0]?.function.arguments, raw);
  assert.throws(() => JSON.parse(completed.message.tool_calls![0]!.function.arguments));
});

test("Pi incomplete streams cannot produce an admitted tool call", async t => {
  const api = await server(t, (_request, _index, res) => chat(res, { args: '{"path":"hello.ts"}', incomplete: true }));
  const model = piModel(piConfig({ provider: "deepseek", model: "deepseek-flash", endpoint: api.endpoint }), KEY);
  await assert.rejects(model.complete(model.prepare(initial, [tool])), code("MODEL_PROVIDER_ERROR"));
  assert.equal(api.requests.length, 1);
});

test("Pi HTTP errors are sanitized and never retried", async t => {
  const api = await server(t, (_request, _index, res) => { res.writeHead(429, { "content-type": "application/json" }); res.end('{"error":{"message":"provider-side-secret","type":"rate_limit_error"}}'); });
  const model = piModel(piConfig({ provider: "deepseek", model: "deepseek-flash", endpoint: api.endpoint }), KEY);
  await assert.rejects(model.complete(model.prepare(initial, [tool])), error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes("provider-side-secret")); assert.ok(!error.message.includes(KEY)); return code("MODEL_HTTP_429")(error);
  });
  assert.equal(api.requests.length, 1);
});

test("Pi only admits context recovery for an explicit pre-stream capacity rejection", async t => {
  for (const status of [400, 429]) await t.test(String(status), async t => {
    const api = await server(t, (_request, _index, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end('{"error":{"message":"maximum context length exceeded","code":"context_length_exceeded","type":"invalid_request_error"}}'); });
    const model = piModel(piConfig({ provider: "deepseek", model: "deepseek-flash", endpoint: api.endpoint }), KEY);
    await assert.rejects(model.complete(model.prepare(initial, [tool])), code(status === 400 ? "MODEL_CONTEXT_OVERFLOW" : "MODEL_HTTP_429"));
    assert.equal(api.requests.length, 1);
  });
});

test("Pi absent provider usage remains unknown for harness reservation accounting", async t => {
  const api = await server(t, (_request, _index, res) => chat(res, { text: "Read complete.", usage: false }));
  const model = piModel(piConfig({ provider: "deepseek", model: "deepseek-flash", endpoint: api.endpoint }), KEY);
  assert.equal((await model.complete(model.prepare(initial, [tool]))).usage, null);
});

test("Pi timeout and response byte limits terminate active streams", async t => {
  await t.test("timeout", async t => {
    const api = await server(t, (_request, _index, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); });
    const model = piModel(piConfig({ provider: "deepseek", model: "deepseek-flash", endpoint: api.endpoint, timeoutMs: 50 }), KEY);
    await assert.rejects(model.complete(model.prepare(initial, [tool])), code("MODEL_TIMEOUT"));
    assert.equal(api.requests.length, 1);
  });
  await t.test("cancellation", async t => {
    const controller = new AbortController();
    const api = await server(t, (_request, _index, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); controller.abort(); });
    const model = piModel(piConfig({ provider: "deepseek", model: "deepseek-flash", endpoint: api.endpoint }), KEY);
    await assert.rejects(model.complete(model.prepare(initial, [tool]), { signal: controller.signal }), error => error === controller.signal.reason);
    assert.equal(api.requests.length, 1);
  });
  await t.test("output limit", async t => {
    const api = await server(t, (_request, _index, res) => chat(res, { text: "x".repeat(20_000) }));
    const model = piModel(piConfig({ provider: "deepseek", model: "deepseek-flash", endpoint: api.endpoint, maxResponseBytes: 1024 }), KEY);
    await assert.rejects(model.complete(model.prepare(initial, [tool])), code("MODEL_OUTPUT_LIMIT"));
  });
});

test("Pi plugin runs a real tool loop and restores native replay after reopening the session", async t => {
  const api = await server(t, (_request, index, res) => {
    if (index === 0) {
      const send = events(res);
      send({ id: "loop_fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "list_call", type: "function", function: { name: "list_files", arguments: "{}" } }] }, finish_reason: null }] });
      send({ id: "loop_fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
      return res.end("data: [DONE]\n\n");
    }
    chat(res, { text: index === 1 ? "Files inspected." : "History restored." });
  });
  const root = await mkdtemp(join(tmpdir(), "minicah-pi-loop-"));
  let runtime: Runtime | undefined;
  t.after(async () => { await runtime?.close(); await rm(root, { recursive: true, force: true }); });
  const options = () => ({ plugins: [createSessionPlugin({ directory: join(root, "sessions") }), createContextPlugin(), createPiPlugin({ apiKey: () => KEY }), createCodingToolsPlugin(root, true), createToolPipelinePlugin(), createCompactionPlugin(), createAgentLoopPlugin()], config: { "pi-model": { provider: "deepseek", model: "deepseek-flash", endpoint: api.endpoint } } });
  runtime = await Runtime.create(options());
  let session = await runtime.openSession("pi-loop");
  const first = await session.run(run => run.services.get(services.agentLoop).run("List workspace files."));
  assert.equal(first.status, "completed", first.text); assert.equal(first.steps, 2);
  const before = await session.run(run => run.services.get(services.session).events());
  assert.ok(JSON.stringify(before).includes("providerReplay")); assert.ok(!JSON.stringify(before).includes(KEY));
  assert.equal(before.filter(event => event.data.type === "tool.completed").length, 1);
  await runtime.close(); runtime = await Runtime.create(options()); session = await runtime.openSession("pi-loop");
  const resumed = await session.run(run => run.services.get(services.agentLoop).run("Continue."));
  assert.equal(resumed.status, "completed", resumed.text);
  const after = await session.run(run => run.services.get(services.session).events());
  assert.equal(after.filter(event => event.data.type === "tool.completed").length, 1);
  assert.ok(api.requests[2]!.body.messages.some((message: any) => message.role === "tool" && message.tool_call_id === "list_call"));
});

test("Pi loop rejects repaired JSON and truncated tool batches before dispatch", async t => {
  for (const kind of ["malformed", "truncated"] as const) await t.test(kind, async t => {
    const api = await server(t, (_request, index, res) => chat(res, index
      ? { text: "The tool was rejected." }
      : { args: kind === "malformed" ? '{"path":"hello.ts"' : '{"path":"hello.ts"}', ...(kind === "truncated" ? { finish: "length" } : {}) }));
    const root = await mkdtemp(join(tmpdir(), "minicah-pi-rejection-"));
    let runtime: Runtime | undefined;
    t.after(async () => { await runtime?.close(); await rm(root, { recursive: true, force: true }); });
    runtime = await Runtime.create({ plugins: [createSessionPlugin({ directory: join(root, "sessions") }), createContextPlugin(), createPiPlugin({ apiKey: () => KEY }), createCodingToolsPlugin(root, true), createToolPipelinePlugin(), createCompactionPlugin(), createAgentLoopPlugin()], config: { "pi-model": { provider: "deepseek", model: "deepseek-flash", endpoint: api.endpoint } } });
    const session = await runtime.openSession("pi-rejection");
    const result = await session.run(run => run.services.get(services.agentLoop).run("Read hello.ts."));
    const recorded = await session.run(run => run.services.get(services.session).events());
    assert.equal(recorded.filter(event => event.data.type === "tool.completed").length, 0);
    if (kind === "truncated") {
      assert.equal(result.status, "failed"); assert.equal(result.text, "MODEL_OUTPUT_LIMIT"); assert.equal(api.requests.length, 1);
    } else {
      assert.equal(result.status, "completed", result.text);
      assert.ok(recorded.some(event => event.data.type === "pipeline.rejected"));
      const toolResult = api.requests[1]!.body.messages.find((message: any) => message.role === "tool");
      assert.equal(JSON.parse(toolResult.content).status, "failed");
    }
  });
});
