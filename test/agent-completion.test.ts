import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Runtime, API_VERSION, services, approvalUi, definition, contentHash,
  createSessionPlugin, createContextPlugin, createExecutionPlugin, createCodingToolsPlugin,
  createPermissionPlugin, createToolPipelinePlugin, createCompactionPlugin, createAgentLoopPlugin,
  type Plugin, type JsonValue, type Message, type ToolInfo, type ModelCompletion, type CompletionContract,
} from "../src/index.js";

interface Request { messages: Message[]; tools: ToolInfo[] }
function response(text: string): ModelCompletion { return { message: { role: "assistant", content: text }, finishReason: "stop", usage: { prompt: 20, completion: 5, total: 25 }, providerId: "fixture" }; }
function call(name: string, args: unknown, raw = false): ModelCompletion {
  return { ...response(""), finishReason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "provider-call", type: "function", function: { name, arguments: raw ? String(args) : JSON.stringify(args) } }] } };
}
const completed = '{"status":"completed"}', denied = '{"status":"denied"}';
const responseContract: CompletionContract = {
  responseSchema: { type: "object", additionalProperties: false, required: ["status"], properties: { status: { type: "string", enum: ["completed", "denied"] } } },
  responseStatus: { pointer: "/status", completed: "completed", denied: "denied" },
};
async function fixture(t: TestContext, replies: (request: Request, index: number) => ModelCompletion, options: { deny?: boolean; extra?: Plugin[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "minicah-completion-")), requests: Request[] = [], streaming: boolean[] = [];
  let approvals = 0;
  const model: Plugin = { id: "completion-model", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [services.model], requires: [], setup(ctx) {
    ctx.provide(services.model, () => ({
      definition: () => definition("model", "completion-fixture", "1.0.0", { provider: "fixture" }),
      limits: () => ({ contextWindow: 1_000_000, maxOutputTokens: 4096 }),
      prepare: (messages, tools) => JSON.parse(JSON.stringify({ messages, tools })) as JsonValue,
      async complete(request, modelOptions) { requests.push(request as unknown as Request); streaming.push(!!modelOptions?.onText); return replies(request as unknown as Request, requests.length - 1); },
    }));
  } };
  const ui: Plugin = { id: "completion-ui", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [approvalUi], requires: [], setup(ctx) {
    ctx.provide(approvalUi, () => ({ async approve(request) { approvals++; return { binding: request.binding, decision: options.deny ? "deny" : "allow" }; } }));
  } };
  const runtime = await Runtime.create({ plugins: [createSessionPlugin({ directory: join(root, ".minicah", "sessions") }), createContextPlugin(), model, createExecutionPlugin(), createCodingToolsPlugin(root), createPermissionPlugin(), ui, createToolPipelinePlugin({}, true, approvalUi), createCompactionPlugin(), createAgentLoopPlugin(), ...(options.extra ?? [])], config: {
    permissions: { workspace: root, policyVersion: "completion-test", ttlMs: 10_000 }, "context-compaction": { auto: false },
  } });
  const session = await runtime.openSession("completion");
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { root, requests, streaming, approvals: () => approvals,
    run: (completion?: CompletionContract) => session.run(run => run.services.get(services.agentLoop).run("Perform the public task and reply with the requested JSON.", undefined, completion === undefined ? undefined : { completion })),
    events: () => session.run(run => run.services.get(services.session).events()),
  };
}
function checks(events: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["events"]>>) {
  return events.flatMap(event => event.data.type === "context.measured" && (event.data.measurement as any).kind === "completion-contract-v1" ? [event.data.measurement as any] : []);
}

test("contract mode repairs a premature completion using public state, preserving first proposal and all costs", async t => {
  const original = '{"port":80,"enabled":true}', target = '{"port":0,"enabled":false}';
  const f = await fixture(t, (request, index) => {
    if (index === 0) return response(completed);
    if (index === 1) {
      assert.match(request.messages.at(-1)!.content!, /TARGET_MISMATCH/);
      assert.match(request.messages.at(-1)!.content!, /"actual":80/);
      return call("read_file", { path: "config.json" });
    }
    if (index === 2) return call("write_file", { path: "config.json", content: target, expectedHash: contentHash(original) });
    return response(completed);
  });
  await writeFile(join(f.root, "config.json"), original);
  const result = await f.run({ ...responseContract, jsonTargets: [{ path: "config.json", pointer: "/port", value: 0 }, { path: "config.json", pointer: "/enabled", value: false }] });
  assert.equal(result.status, "completed"); assert.equal(result.steps, 4); assert.equal(result.tokens, 100);
  assert.equal(await readFile(join(f.root, "config.json"), "utf8"), target); assert.equal(f.approvals(), 1);
  assert.ok(f.streaming.every(value => !value));
  const recorded = checks(await f.events()), candidates = recorded.filter(event => event.phase === "candidate");
  assert.equal(candidates.length, 2); assert.equal(candidates[0].firstProposal, true); assert.equal(candidates[0].check.passed, false); assert.equal(candidates[0].candidateText, completed);
  assert.equal(candidates[1].check.passed, true); assert.equal(recorded.filter(event => event.phase === "continue").length, 1);
});

test("no contract preserves existing behavior; a satisfied public target allows a no-write no-op", async t => {
  const f = await fixture(t, () => response(completed));
  assert.equal((await f.run()).status, "completed"); assert.equal(f.streaming[0], true);
  await writeFile(join(f.root, "config.json"), '{"port":0}');
  assert.equal((await f.run({ ...responseContract, jsonTargets: [{ path: "config.json", pointer: "/port", value: 0 }], preservePaths: ["missing.json"] })).status, "completed");
  assert.equal(f.requests.length, 2); assert.equal(f.approvals(), 0); assert.equal(f.streaming[1], false);
});

test("persistent premature completion is bounded and rejected rather than returned as completed", async t => {
  const f = await fixture(t, () => response(completed));
  const result = await f.run({ ...responseContract, jsonTargets: [{ path: "missing.json", pointer: "/value", value: 1 }] });
  assert.equal(result.status, "failed"); assert.equal(result.text, "COMPLETION_RESPONSE_INVALID"); assert.equal(f.requests.length, 2);
  assert.equal(checks(await f.events()).filter(event => event.phase === "continue").length, 1);
});

test("response repair removes tools, does not repeat completed writes, and charges the extra request", async t => {
  const f = await fixture(t, (request, index) => {
    if (index === 0) return call("write_file", { path: "done.json", content: '{"value":1}', expectedHash: null });
    if (index === 1) return response(`Done!\n\`\`\`json\n${completed}\n\`\`\``);
    assert.deepEqual(request.tools, []); assert.match(request.messages.at(-1)!.content!, /Reply correction only/); return response(completed);
  });
  const result = await f.run({ ...responseContract, jsonTargets: [{ path: "done.json", pointer: "/value", value: 1 }] });
  assert.equal(result.status, "completed"); assert.equal(result.tokens, 75); assert.equal(f.approvals(), 1);
  assert.equal(checks(await f.events()).filter(event => event.phase === "response-repair").length, 1);
});

test("a tool call hallucinated during reply repair is rejected without dispatch and leaves no pending recovery", async t => {
  const f = await fixture(t, (_request, index) => index === 0 ? response("not JSON") : index === 1 ? call("write_file", { path: "bad.json", content: "{}", expectedHash: null }) : response(completed));
  assert.equal((await f.run(responseContract)).text, "COMPLETION_RESPONSE_ONLY"); assert.equal(f.approvals(), 0);
  await assert.rejects(readFile(join(f.root, "bad.json")));
  const events = await f.events(); assert.ok(events.some(event => event.data.type === "pipeline.rejected" && event.data.code === "COMPLETION_RESPONSE_ONLY"));
  // Reopening the loop in the same session must not see unaccounted proposed calls.
  const next = await f.run({ ...responseContract, maxContinuations: 0 }); assert.notEqual(next.status, "needs-reconciliation");
});

test("parameter rejection is not a denial and can be corrected by one real successful write", async t => {
  const f = await fixture(t, (_request, index) => {
    if (index === 0) return call("write_file", { path: "fixed.json", oldText: "bad", content: "{}", expectedHash: null });
    if (index === 1) return response(denied);
    if (index === 2) return call("write_file", { path: "fixed.json", content: '{"value":1}', expectedHash: null });
    return response(completed);
  });
  const result = await f.run(responseContract);
  assert.equal(result.status, "completed"); assert.equal(f.approvals(), 1);
  const candidates = checks(await f.events()).filter(event => event.phase === "candidate");
  assert.equal(candidates[0].check.facts.parameterErrors, 1); assert.deepEqual(candidates[0].check.facts.denied, []);
  assert.ok(candidates[0].check.responseIssues.some((issue: any) => issue.code === "RESPONSE_DENIAL_UNSUPPORTED"));
  assert.equal(candidates[1].check.facts.unresolvedErrors, 0);
});

test("a real denial enters response-only mode and cannot be followed by another write", async t => {
  const f = await fixture(t, (request, index) => {
    if (index === 0) return call("write_file", { path: "denied.json", content: "{}", expectedHash: null });
    assert.deepEqual(request.tools, []); return call("write_file", { path: "other.json", content: "{}", expectedHash: null });
  }, { deny: true });
  assert.equal((await f.run(responseContract)).status, "failed"); assert.equal(f.approvals(), 1); assert.equal(f.requests.length, 2);
  await assert.rejects(readFile(join(f.root, "denied.json"))); await assert.rejects(readFile(join(f.root, "other.json")));
});

test("public expected denial requires a real matching attempt; unrelated prior-run denial does not satisfy it", async t => {
  const f = await fixture(t, (_request, index) => index === 0 ? call("write_file", { path: "./denied.json", content: "{}", expectedHash: null }) : response(denied), { deny: true });
  const contract: CompletionContract = { ...responseContract, expectedDenial: { tool: "write_file", path: "denied.json" }, preservePaths: ["denied.json"] };
  assert.equal((await f.run(contract)).status, "completed"); assert.equal(f.approvals(), 1);
  const second = await f.run({ ...contract, maxContinuations: 0 }); assert.equal(second.status, "failed");
  const last = checks(await f.events()).filter(event => event.phase === "candidate").at(-1)!;
  assert.ok(last.check.goalIssues.some((issue: any) => issue.code === "EXPECTED_DENIAL_MISSING"));
});

test("protected-path changes stop immediately and never trigger automatic restorative writes", async t => {
  const f = await fixture(t, () => call("write_file", { path: "prod.json", content: '{"timeout":99}', expectedHash: contentHash('{"timeout":60}') }));
  await writeFile(join(f.root, "prod.json"), '{"timeout":60}');
  const result = await f.run({ ...responseContract, preservePaths: ["prod.json"] });
  assert.equal(result.status, "failed"); assert.equal(result.text, "COMPLETION_PROTECTED_CHANGED"); assert.equal(f.requests.length, 1); assert.equal(f.approvals(), 1);
});

test("unknown tool execution stops without a completion retry", async t => {
  let writes = 0;
  const extra: Plugin = { id: "uncertain-completion-tool", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [], requires: [], setup(ctx) {
    ctx.registerTool({ name: "uncertain_write", description: "test", effect: "non-idempotent-write", inputSchema: { type: "object" }, execute() { writes++; throw new Error("effect may have happened"); } });
  } };
  const f = await fixture(t, () => call("uncertain_write", {}), { extra: [extra] });
  assert.equal((await f.run(responseContract)).status, "needs-reconciliation"); assert.equal(writes, 1); assert.equal(f.requests.length, 1);
});

test("explicit readPaths need a current-run complete tool snapshot, not the verifier's own file read", async t => {
  const f = await fixture(t, (_request, index) => index === 0 ? response(completed) : index === 1 ? call("read_file", { path: "./config.json" }) : response(completed));
  await writeFile(join(f.root, "config.json"), '{"port":0}');
  const result = await f.run({ ...responseContract, jsonTargets: [{ path: "config.json", pointer: "/port", value: 0 }], readPaths: ["config.json"] });
  assert.equal(result.status, "completed"); assert.equal(f.requests.length, 3); assert.equal(f.approvals(), 0);
  const first = checks(await f.events()).find(event => event.phase === "candidate");
  assert.ok(first.check.goalIssues.some((issue: any) => issue.code === "READ_SNAPSHOT_MISSING"));
});

test("invalid public contracts reject external paths and asynchronous schemas before invoking the model", async t => {
  const f = await fixture(t, () => response(completed));
  assert.equal((await f.run({ preservePaths: ["../outside.json"] })).text, "WORKSPACE_PATH");
  assert.equal((await f.run({ responseSchema: { $async: true, type: "object" } })).text, "COMPLETION_CONTRACT_INVALID");
  for (const invalid of [null, false, 0, "disabled", []]) {
    assert.equal((await f.run(invalid as unknown as CompletionContract)).text, "COMPLETION_CONTRACT_INVALID");
  }
  assert.equal(f.requests.length, 0);
});

test("a truthful approval denial is a valid conditional terminal state without meeting the unwritten JSON target", async t => {
  const original = '{"port":80}';
  const f = await fixture(t, (_request, index) => index === 0 ? call("read_file", { path: "config.json" })
    : index === 1 ? call("write_file", { path: "config.json", content: '{"port":0}', expectedHash: contentHash(original) }) : response(denied), { deny: true });
  await writeFile(join(f.root, "config.json"), original);
  const result = await f.run({ ...responseContract, jsonTargets: [{ path: "config.json", pointer: "/port", value: 0 }], readPaths: ["config.json"], preserveJsonOtherFields: true, allowedChanges: ["config.json"] });
  assert.equal(result.status, "completed"); assert.equal(result.text, denied); assert.equal(f.approvals(), 1);
  assert.equal(await readFile(join(f.root, "config.json"), "utf8"), original);
  assert.equal(checks(await f.events()).filter(event => event.phase === "continue").length, 0);
});

test("a denied code edit can finish truthfully without a JSON file target or exposing the hidden approval policy", async t => {
  const original = "export const value = 1;\n";
  const f = await fixture(t, (_request, index) => index === 0 ? call("read_file", { path: "main.ts" })
    : index === 1 ? call("edit_file", { path: "main.ts", oldText: "1", newText: "2", expectedHash: contentHash(original) }) : response(denied), { deny: true });
  await writeFile(join(f.root, "main.ts"), original);
  assert.equal((await f.run({ ...responseContract, readPaths: ["main.ts"], allowedChanges: ["main.ts"] })).status, "completed");
  assert.equal(await readFile(join(f.root, "main.ts"), "utf8"), original); assert.equal(f.approvals(), 1);
  const configured = checks(await f.events()).find(event => event.phase === "configured"); assert.equal(configured.contract.expectedDenial, undefined);
});

test("denial of an unrelated path cannot stand in for a denied target write", async t => {
  const f = await fixture(t, (_request, index) => index === 0 ? call("write_file", { path: "unrelated.json", content: "{}", expectedHash: null }) : response(denied), { deny: true });
  await writeFile(join(f.root, "config.json"), '{"port":80}');
  const result = await f.run({ ...responseContract, jsonTargets: [{ path: "config.json", pointer: "/port", value: 0 }], allowedChanges: ["config.json"] });
  assert.equal(result.status, "failed"); assert.equal(f.approvals(), 1);
});

test("a successful write to B does not erase an unresolved write failure for A", async t => {
  const f = await fixture(t, (_request, index) => index === 0 ? call("write_file", { path: "a.ts", content: "A2", expectedHash: null })
    : index === 1 ? call("write_file", { path: "b.ts", content: "B", expectedHash: null }) : response(completed));
  await writeFile(join(f.root, "a.ts"), "A1");
  assert.equal((await f.run({ ...responseContract, maxContinuations: 0 })).status, "failed");
  const candidate = checks(await f.events()).find(event => event.phase === "candidate");
  assert.equal(candidate.check.facts.successfulWrites, 1); assert.equal(candidate.check.facts.unresolvedErrors, 1);
});

test("changing the correct JSON key while dropping another field remains a scored failure", async t => {
  const original = '{"port":80,"feature":false,"name":"keep"}';
  const f = await fixture(t, () => call("write_file", { path: "config.json", content: '{"port":0}', expectedHash: contentHash(original) }));
  await writeFile(join(f.root, "config.json"), original);
  const result = await f.run({ ...responseContract, jsonTargets: [{ path: "config.json", pointer: "/port", value: 0 }], preserveJsonOtherFields: true });
  assert.equal(result.status, "failed"); assert.equal(result.text, "COMPLETION_PROTECTED_CHANGED"); assert.equal(f.requests.length, 1);
  const check = checks(await f.events()).find(event => event.phase === "tool-check").check;
  assert.ok(check.unsafeIssues.some((issue: any) => issue.code === "JSON_OTHER_FIELDS_CHANGED"));
});

test("allowedChanges accepts the target edit but catches creation of unrelated visible files", async t => {
  const f = await fixture(t, () => call("write_file", { path: "unrelated.json", content: "{}", expectedHash: null }));
  const result = await f.run({ ...responseContract, allowedChanges: ["config.json"] });
  assert.equal(result.status, "failed"); assert.equal(result.text, "COMPLETION_PROTECTED_CHANGED");
  assert.ok(checks(await f.events()).find(event => event.phase === "tool-check").check.unsafeIssues.some((issue: any) => issue.code === "UNAUTHORIZED_PATH_CHANGED"));
});

test("repeated invalid replies get only one repair and a truncated read is not a complete snapshot", async t => {
  const f = await fixture(t, (_request, index) => index === 0 ? call("read_file", { path: "long.txt", lineCount: 1 }) : response("not JSON"));
  await writeFile(join(f.root, "long.txt"), "first\nsecond\n");
  const result = await f.run({ ...responseContract, readPaths: ["long.txt"], maxContinuations: 0 });
  assert.equal(result.status, "failed"); assert.equal(f.requests.length, 2);
  assert.ok(checks(await f.events()).find(event => event.phase === "candidate").check.goalIssues.some((issue: any) => issue.code === "READ_SNAPSHOT_MISSING"));
  const g = await fixture(t, () => response("not JSON"));
  assert.equal((await g.run(responseContract)).status, "failed"); assert.equal(g.requests.length, 2);
});

test("a confirmed protected mutation stays failed even when a sibling tool has an unknown result", async t => {
  const original = '{"timeout":60}';
  const extra: Plugin = { id: "uncertain-sibling", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [], requires: [], setup(ctx) {
    ctx.registerTool({ name: "uncertain_write", description: "test", effect: "non-idempotent-write", inputSchema: { type: "object" }, execute() { throw new Error("unknown commit"); } });
  } };
  const f = await fixture(t, () => {
    const first = call("write_file", { path: "prod.json", content: '{"timeout":99}', expectedHash: contentHash(original) });
    const second = call("uncertain_write", {}).message.tool_calls![0]!;
    return { ...first, message: { ...first.message, tool_calls: [...first.message.tool_calls!, { ...second, id: "unknown-sibling" }] } };
  }, { extra: [extra] });
  await writeFile(join(f.root, "prod.json"), original);
  const result = await f.run({ ...responseContract, preservePaths: ["prod.json"] });
  assert.equal(result.status, "failed"); assert.equal(result.text, "COMPLETION_PROTECTED_CHANGED"); assert.equal(f.requests.length, 1);
  const events = await f.events(); assert.ok(events.some(event => event.data.type === "tool.uncertain"));
  assert.ok(checks(events).some(event => event.phase === "tool-check" && event.check.unsafeIssues.some((issue: any) => issue.code === "PROTECTED_PATH_CHANGED")));
});

test("a denied branch snapshots allowed targets even when there is no readPaths or JSON target", async t => {
  let targetPath = "";
  const extra: Plugin = { id: "external-change-fixture", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [], requires: [], setup(ctx) {
    // Simulate a concurrent external writer without a successful agent write event.
    ctx.registerTool({ name: "observe_external_change", description: "test", effect: "read", inputSchema: { type: "object" }, async execute() { await writeFile(targetPath, "externally changed"); return { ok: true }; } });
  } };
  const f = await fixture(t, (_request, index) => index === 0 ? call("observe_external_change", {})
    : index === 1 ? call("write_file", { path: "main.ts", content: "new content", expectedHash: contentHash("externally changed") }) : response(denied), { deny: true, extra: [extra] });
  targetPath = join(f.root, "main.ts"); await writeFile(targetPath, "initial content");
  const result = await f.run({ ...responseContract, allowedChanges: ["main.ts"] });
  assert.equal(result.status, "failed"); assert.equal(result.text, "COMPLETION_PROTECTED_CHANGED"); assert.equal(f.requests.length, 2);
  assert.ok(checks(await f.events()).some(event => event.phase === "tool-check" && event.check.unsafeIssues.some((issue: any) => issue.code === "DENIAL_STATE_CHANGED")));
});

test("continuation feedback follows settled tools without weakening denial, protection or unknown-state stops", async t => {
  const original = '{"port":4100}', target = '{"port":0}', protectedFile = '{"port":7000}';
  const prefix = "Trusted Host completion check: ";
  const feedback = (request: Request) => request.messages.filter(message => message.role === "system" && message.content?.startsWith(prefix));
  const feedbackCheck = (request: Request) => {
    const messages = feedback(request);
    assert.equal(messages.length, 1);
    return JSON.parse(messages[0]!.content!.slice(prefix.length).split("\n")[0]!);
  };
  for (const mode of ["success", "denied", "protected", "unknown"] as const) await t.test(mode, async subtest => {
    const extra: Plugin = { id: "feedback-uncertain-tool", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [], requires: [], setup(ctx) {
      ctx.registerTool({ name: "uncertain_write", description: "test", effect: "non-idempotent-write", inputSchema: { type: "object" }, execute() { throw new Error("unknown write outcome"); } });
    } };
    const f = await fixture(subtest, (request, index) => {
      if (index === 0) return response(completed);
      if (index === 1) {
        const check = feedbackCheck(request);
        assert.ok(check.goalIssues.some((issue: any) => issue.code === "TARGET_MISMATCH" && issue.actual === 4100));
        assert.equal(check.facts.attempts, 0);
        return call("read_file", { path: "dev.json" });
      }
      if (index === 2) {
        const check = feedbackCheck(request);
        // This request follows the read: the original proposal had no tool facts.
        assert.equal(check.facts.attempts, 1); assert.deepEqual(check.facts.reads, ["dev.json"]);
        assert.equal(check.facts.successfulWrites, 0);
        assert.deepEqual(check.responseIssues, []);
        if (mode === "unknown") return call("uncertain_write", {});
        return call("write_file", mode === "protected"
          ? { path: "prod.json", content: target, expectedHash: contentHash(protectedFile) }
          : { path: "dev.json", content: target, expectedHash: contentHash(original) });
      }
      assert.equal(index, 3, "No redundant read, write or continuation is needed");
      assert.ok(mode === "success" || mode === "denied", "Unsafe or unknown state must stop before another model request");
      if (mode === "denied") {
        assert.deepEqual(request.tools, []);
        const check = feedbackCheck(request);
        assert.equal(check.facts.denied.length, 1); assert.equal(check.facts.denied[0].kind, "approval");
        assert.match(feedback(request)[0]!.content!, /Reply correction only/);
        return response(denied);
      }
      // The write met the target. A stale authoritative mismatch must not
      // contradict its successful tool result or send the model back to reading.
      assert.deepEqual(feedback(request), []);
      assert.ok(request.tools.length > 0, "Successful work does not activate denial's response-only restriction");
      return response(completed);
    }, { deny: mode === "denied", ...(mode === "unknown" ? { extra: [extra] } : {}) });
    await writeFile(join(f.root, "dev.json"), original);
    await writeFile(join(f.root, "prod.json"), protectedFile);
    const result = await f.run({ ...responseContract, jsonTargets: [{ path: "dev.json", pointer: "/port", value: 0 }],
      readPaths: ["dev.json"], preservePaths: ["prod.json"], preserveJsonOtherFields: true, allowedChanges: ["dev.json"] });
    const expectedCalls = mode === "success" || mode === "denied" ? 4 : 3;
    assert.equal(f.requests.length, expectedCalls); assert.equal(result.steps, expectedCalls); assert.equal(result.tokens, expectedCalls * 25);
    assert.equal(f.approvals(), 1);
    assert.equal(checks(await f.events()).filter(event => event.phase === "continue").length, 1);
    if (mode === "success" || mode === "denied") {
      assert.equal(result.status, "completed"); assert.equal(result.text, mode === "success" ? completed : denied);
      assert.equal(await readFile(join(f.root, "dev.json"), "utf8"), mode === "success" ? target : original);
    } else if (mode === "protected") {
      assert.equal(result.status, "failed"); assert.equal(result.text, "COMPLETION_PROTECTED_CHANGED");
    } else assert.equal(result.status, "needs-reconciliation");
  });
});
