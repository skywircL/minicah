import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { access, appendFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API_VERSION, Runtime, services, createSessionPlugin, createSessionCatalogPlugin, sessionCatalogService,
  createCliCommandsPlugin, cliCommandService, createCliPlugin, CliSessions, sessionLogPath,
  RegistryScope, commandRegistry,
  createObservabilityPlugin, createObservabilityCommandsPlugin,
  approvalUi, ApprovalAuthority,
  type CliIO, type Plugin, type Session, type AgentRunOptions,
} from "../src/index.js";
import { readJournalSnapshot } from "../src/session/file-journal.js";
import { definitions, versions } from "./session-helpers.js";
import { code } from "./helpers.js";

async function fixture(t: TestContext, answers: string[] = [], options: { registryScope?: RegistryScope; plugins?: readonly Plugin[]; commandExecutionMode?: "host" | "docker"; agentOptions?: AgentRunOptions } = {}) {
  const root = await mkdtemp(join(tmpdir(), "minicah-cli-sessions-")), directory = join(root, "sessions");
  const output: { channel: string; text: string }[] = [], prompts: { id: string; text: string }[] = [];
  const receivedAgentOptions: (AgentRunOptions | undefined)[] = [];
  let closed = false;
  const io: CliIO = {
    interactive: true,
    async question(text) { output.push({ channel: "question", text }); return answers.shift() ?? "/exit"; },
    write(channel, text) { output.push({ channel, text }); },
    onInterrupt: () => () => {}, close: () => { closed = true; },
  };
  const cli = createCliPlugin({ io, ...(options.agentOptions ? { agentOptions: options.agentOptions } : {}), ...(options.registryScope ? { runOptions: { registryScope: options.registryScope } } : {}), ...(options.commandExecutionMode ? { commandExecutionMode: options.commandExecutionMode } : {}) });
  const fakeAgent: Plugin = { id: "test-agent", version: "1.0.0", apiVersion: API_VERSION, scope: "session", provides: [services.agentLoop], requires: [services.session], setup(ctx) {
    ctx.provide(services.agentLoop, run => ({ async run(input, _signal, agentOptions) {
      receivedAgentOptions.push(agentOptions);
      const log = run.services.get(services.session);
      prompts.push({ id: run.sessionId, text: input });
      await log.retain(definitions); await log.start(versions, {});
      await log.record([{ data: { type: "user.input", content: input } }, { data: { type: "run.finished", status: "completed" } }]);
      return { status: "completed", text: `answer: ${input}`, runId: run.id, steps: 1, tokens: 1 };
    } }));
  } };
  const runtime = await Runtime.create({ plugins: [createSessionPlugin({ directory }), createSessionCatalogPlugin(directory, root), createCliCommandsPlugin(), cli.plugin, fakeAgent, ...options.plugins ?? []] });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  async function seed(id: string, text: string, workspace = root): Promise<void> {
    const session = await runtime.openSession(id);
    await session.run(async run => {
      const log = run.services.get(services.session);
      await log.retain(definitions); await log.start(versions, {});
      await log.record([
        { data: { type: "protected.recorded", id: "workspace-root", kind: "constraint", content: workspace } },
        { data: { type: "user.input", content: text } },
        { data: { type: "run.finished", status: "completed" } },
      ]);
    });
    await session.close();
  }
  const events = (session: Session) => session.run(run => run.services.get(services.session).events());
  return { root, directory, runtime, cli, seed, events, output, prompts, receivedAgentOptions, closed: () => closed,
    text: () => output.map(item => item.text).join(""),
    async open(id = "current") { return new CliSessions(runtime, await runtime.openSession(id), root); },
  };
}

test("CLI passes an immutable caller completion contract to the agent without changing task text", async t => {
  const options = { completion: { jsonTargets: [{ path: "dev.json", pointer: "/timeout", value: 10 }] } };
  const f = await fixture(t, [], { agentOptions: options });
  options.completion.jsonTargets[0]!.value = 99;
  const sessions = await f.open();
  assert.equal(await f.cli.start(sessions, "set timeout to ten"), 0);
  assert.equal(f.prompts[0]!.text, "set timeout to ten");
  assert.equal(f.receivedAgentOptions[0]!.completion!.jsonTargets![0]!.value, 10);
  assert.ok(Object.isFrozen(f.receivedAgentOptions[0]!.completion));
});

test("CLI command approval displays Docker persistence boundaries and preserves the complete approval binding", async t => {
  const f = await fixture(t, ["y"], { commandExecutionMode: "docker" });
  const sessions = await f.open();
  const authority = new ApprovalAuthority("test-policy");
  const request = authority.request({ sessionId: sessions.current.id, runId: "run", callId: "call", workspace: f.root, policyVersion: "test-policy",
    tool: { name: "run_command", owner: "coding-tools", generation: 1, schemaHash: "a".repeat(64) }, arguments: { command: "node", args: ["test.js"] },
  }, 10_000);
  const reply = await sessions.current.run(run => run.services.get(approvalUi).approve(request, new AbortController().signal));
  assert.equal(reply.decision, "allow"); assert.deepEqual(reply.binding, request.binding);
  assert.match(f.text(), /Docker 隔离.*临时工作区副本.*修改不回写/);
  assert.doesNotMatch(f.text(), /宿主机执行/);
  assert.ok(f.text().includes(request.binding.approvalId));
  assert.ok(f.text().includes(request.binding.argumentsHash));
  assert.ok(f.text().includes('"test.js"'));
});

test("CLI observability commands read committed runs without dispatching a prompt", async t => {
  const f = await fixture(t, ["/metrics", "/trace", "/metrics missing", "/help", "/exit"], { plugins: [createObservabilityPlugin(), createObservabilityCommandsPlugin()] });
  await f.seed("observed", "private task payload");
  const sessions = await f.open("observed");
  const before = await readFile(sessionLogPath(f.directory, "observed"));
  assert.equal(await f.cli.start(sessions), 0);
  assert.deepEqual(f.prompts, []);
  assert.match(f.text(), /observedTokens/);
  assert.match(f.text(), /RUN_NOT_FOUND/);
  assert.match(f.text(), /\/metrics/);
  assert.doesNotMatch(f.text(), /private task payload/);
  assert.deepEqual(await readFile(sessionLogPath(f.directory, "observed")), before);
});

test("CLI scoped commands expand into agent input and retain their view after /new", async t => {
  const scope = new RegistryScope("cli-agent"), sibling = new RegistryScope("cli-sibling");
  const commands: Plugin = { id: "scoped-command", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [], requires: [], setup(ctx) {
    ctx.register(commandRegistry, "review", { description: "局部审查", usage: "<file>", parse: file => ({ kind: "prompt", text: `Review ${file}` }) });
  } };
  const hidden: Plugin = { ...commands, id: "hidden-command", setup(ctx) {
    ctx.register(commandRegistry, "hidden", { description: "不可见", usage: "", parse: () => ({ kind: "prompt", text: "hidden" }) });
  } };
  const f = await fixture(t, ["/help", "/review a.ts", "/new", "/review b.ts", "/hidden", "/exit"], { registryScope: scope, plugins: [scope.mount(commands), sibling.mount(hidden)] });
  await f.cli.start(await f.open());
  assert.deepEqual(f.prompts.map(item => item.text), ["Review a.ts", "Review b.ts"]);
  assert.notEqual(f.prompts[0]!.id, f.prompts[1]!.id);
  assert.match(f.text(), /局部审查/); assert.doesNotMatch(f.text(), /不可见/);
});

test("interactive history selection, new and resume switch inside one CLI without sending commands to the agent", async t => {
  const f = await fixture(t, ["/history earlier", "1", "continue", "/new", "new task", "/resume earlier", "/replay", "/status", "/help", "/not-a-command", "/exit"]);
  await f.seed("earlier-session", "earlier task");
  const before = await readFile(sessionLogPath(f.directory, "earlier-session"), "utf8");
  const sessions = await f.open();
  await f.cli.start(sessions);
  assert.equal(sessions.current.id, "earlier-session");
  assert.deepEqual(f.prompts.map(item => item.text), ["continue", "new task"]);
  assert.equal(f.prompts[0]!.id, "earlier-session"); assert.notEqual(f.prompts[1]!.id, "earlier-session");
  assert.deepEqual((await f.events(sessions.current)).flatMap(event => event.data.type === "user.input" ? [event.data.content] : []), ["earlier task", "continue"]);
  assert.ok((await readFile(sessionLogPath(f.directory, "earlier-session"), "utf8")).startsWith(before));
  assert.match(f.text(), /选择编号切换/); assert.match(f.text(), /未知命令/); assert.match(f.text(), /\[用户\] earlier task/);
  await assert.rejects(access(sessionLogPath(f.directory, f.prompts[1]!.id) + ".lock"));
  await f.runtime.close(); assert.equal(f.closed(), true);
});

test("catalog reads locked journals and torn tails without opening agents, locks or repairing bytes", async t => {
  const f = await fixture(t);
  await f.seed("saved", "saved title");
  const path = sessionLogPath(f.directory, "saved");
  await appendFile(path, '{"incomplete":');
  await writeFile(path + ".lock", "another process owns this");
  const sessions = await f.open(), before = await readFile(path);
  const listing = await sessions.list();
  const row = listing.items.find(item => item.id === "saved")!;
  assert.equal(row.title, "saved title"); assert.equal(row.locked, true); assert.equal(row.status, "completed");
  assert.deepEqual(await readFile(path), before);
  assert.equal(await readFile(path + ".lock", "utf8"), "another process owns this");
  assert.equal(f.prompts.length, 0);
  await assert.rejects(sessions.resume("saved")); assert.equal(sessions.current.id, "current");
  assert.deepEqual(await readFile(path), before);
});

test("missing, corrupt, ambiguous, locked and foreign targets leave the current session usable", async t => {
  const f = await fixture(t, ["/resume busy", "/resume missing", "still working", "/exit"]);
  await f.seed("prefix-one", "one"); await f.seed("prefix-two", "two");
  await f.seed("foreign", "foreign", "/other-workspace"); await f.seed("busy", "busy"); await f.seed("broken", "broken");
  await appendFile(sessionLogPath(f.directory, "broken"), "{}\n");
  const occupied = await f.runtime.openSession("busy"), sessions = await f.open();
  await assert.rejects(sessions.resume("prefix"), code("AMBIGUOUS_SESSION"));
  await assert.rejects(sessions.resume("foreign"), code("WORKSPACE_MISMATCH"));
  await assert.rejects(sessions.resume("broken"), code("INVALID_LOG"));
  assert.equal((await sessions.list()).unavailable, 2);
  await f.cli.start(sessions);
  assert.equal(sessions.current.id, "current"); assert.deepEqual(f.prompts, [{ id: "current", text: "still working" }]);
  await assert.rejects(access(sessionLogPath(f.directory, "missing")));
  await occupied.close();
});

test("closed sessions reappear after restart and catalog ignores symlink and mismatched identities", async t => {
  const f = await fixture(t); await f.seed("saved", "persisted title");
  const original = sessionLogPath(f.directory, "saved"), copied = sessionLogPath(f.directory, "copied");
  await writeFile(copied, await readFile(original));
  await symlink(original, sessionLogPath(f.directory, "symlink"));
  await f.runtime.close();
  const restored = await Runtime.create({ plugins: [createSessionPlugin({ directory: f.directory }), createSessionCatalogPlugin(f.directory, f.root)] });
  t.after(() => restored.close());
  const session = await restored.openSession("fresh");
  const listing = await session.run(run => run.services.get(sessionCatalogService).list());
  assert.deepEqual(listing.items.map(item => item.id), ["saved"]); assert.equal(listing.unavailable, 1);
  assert.equal(listing.items[0]!.title, "persisted title");
  await assert.rejects(readJournalSnapshot(sessionLogPath(f.directory, "symlink")));
  await restored.close();
});

test("slash grammar rejects unknown commands and arguments; local browsing creates no prompt events", async t => {
  const f = await fixture(t, ["/help", "/history", "", "/replay", "/status", "/new invalid", "/unknown", "/exit"]);
  const sessions = await f.open();
  await f.cli.start(sessions);
  assert.equal(f.prompts.length, 0); assert.deepEqual(await f.events(sessions.current), []);
  await sessions.current.run(run => {
    const commands = run.services.get(cliCommandService);
    assert.deepEqual(commands.parse("/resume saved"), { kind: "resume", id: "saved" });
    assert.deepEqual(commands.parse("/resume"), { kind: "history", query: "" });
    assert.equal(commands.parse("please read /tmp/file").kind, "prompt");
    assert.equal(commands.parse("/tmp/file").kind, "error");
  });
});

test("session titles and current IDs cannot inject terminal control sequences", async t => {
  const f = await fixture(t, ["/history", "", "/exit"]);
  await f.seed("unsafe\x1b[2J-id", "title\x1b[2J\u202esecret");
  await f.cli.start(await f.open());
  assert.ok(!f.text().includes("\x1b")); assert.ok(!f.text().includes("\u202e"));
});
