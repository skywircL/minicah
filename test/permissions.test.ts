import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalAuthority, Runtime, contentHash, createPermissionPlugin, services, type ApprovalInvocation, type ApprovalReply, type JsonValue } from "../src/index.js";
import { code, deferred } from "./helpers.js";
import { definitions, journalFixture, start, toolRef } from "./session-helpers.js";
import { plugin } from "./helpers.js";

const invocation = (): ApprovalInvocation => ({
  sessionId: "session", runId: "run-1", callId: "call-1", arguments: { path: "a.txt", content: "hello" },
  workspace: "/tmp/project", policyVersion: "policy-1", tool: { name: "write-file", owner: "files", generation: 1, schemaHash: contentHash(definitions[2]!.content) },
});

test("approval replies must bind all fields; tool-name-only approval is rejected", async t => {
  for (const [field, value] of Object.entries({ approvalId: "unknown", callId: "other", argumentsHash: "0".repeat(64), workspace: "/tmp/other", policyVersion: "other", expiresAt: 99, runId: "other", sessionId: "other" })) {
    await t.test(field, () => {
      const authority = new ApprovalAuthority("policy-1", () => 10);
      const request = authority.request(invocation(), 100);
      assert.throws(() => authority.reply({ binding: { ...request.binding, [field]: value }, decision: "allow" }));
      assert.throws(() => authority.consume(request.binding.approvalId, invocation()), code("APPROVAL_REQUIRED"));
    });
  }
  const authority = new ApprovalAuthority("policy-1");
  assert.throws(() => authority.reply({ tool: "write-file", decision: "allow" } as unknown as ApprovalReply), code("INVALID_APPROVAL"));
});

test("approved replies are single-use and consumption checks current arguments, workspace, and generation", () => {
  for (const changed of [
    { ...invocation(), arguments: { path: "dangerous.txt" } },
    { ...invocation(), workspace: "/tmp/other" },
    { ...invocation(), tool: { ...invocation().tool, generation: 2 } },
  ]) {
    const authority = new ApprovalAuthority("policy-1");
    const request = authority.request(invocation(), 1000);
    authority.reply({ binding: request.binding, decision: "allow" });
    assert.throws(() => authority.consume(request.binding.approvalId, changed), code("APPROVAL_MISMATCH"));
  }
  const authority = new ApprovalAuthority("policy-1");
  const request = authority.request(invocation(), 1000);
  authority.reply({ binding: request.binding, decision: "allow" });
  authority.consume(request.binding.approvalId, invocation());
  assert.throws(() => authority.consume(request.binding.approvalId, invocation()), code("APPROVAL_REQUIRED"));
  assert.throws(() => authority.reply({ binding: request.binding, decision: "allow" }), code("APPROVAL_REPLAY"));
});

test("policy changes, replacement calls, and expiry revoke pending and already-approved requests", () => {
  let now = 100;
  const authority = new ApprovalAuthority("policy-1", () => now);
  const expiring = authority.request(invocation(), 10);
  authority.reply({ binding: expiring.binding, decision: "allow" });
  now = 110;
  assert.throws(() => authority.consume(expiring.binding.approvalId, invocation()), code("APPROVAL_EXPIRED"));
  now = 111;
  const pending = authority.request(invocation(), 100);
  authority.setPolicyVersion("policy-2");
  assert.throws(() => authority.reply({ binding: pending.binding, decision: "allow" }), code("APPROVAL_REVOKED"));
  authority.setPolicyVersion("policy-1");
  assert.throws(() => authority.reply({ binding: pending.binding, decision: "allow" }), code("APPROVAL_REVOKED"));
  const old = authority.request(invocation(), 100);
  authority.request({ ...invocation(), arguments: { path: "b.txt" } }, 100);
  assert.throws(() => authority.reply({ binding: old.binding, decision: "allow" }), code("APPROVAL_REVOKED"));
});

test("PermissionService invalidates old approvals immediately on L1 change, including old runs", async () => {
  let effects = 0;
  const permissions = { workspace: "/tmp/project", policyVersion: "1", ttlMs: 60_000 };
  const runtime = await Runtime.create({ plugins: [createPermissionPlugin(), plugin("files", { setup(ctx) {
    ctx.registerTool({ name: "write-file", description: "Write", inputSchema: { type: "object" }, execute: () => { effects++; return "done"; } });
  } })], config: { permissions } });
  const session = await runtime.openSession();
  const entered = deferred(), changed = deferred();
  const old = session.run(async run => {
    const permission = run.services.get(services.permission);
    const request = permission.request("call", "write-file", { path: "a" });
    permission.reply({ binding: request.binding, decision: "allow" });
    entered.resolve(); await changed.promise;
    await assert.rejects(permission.invokeApproved(request.binding.approvalId, "call", "write-file", { path: "a" }), code("APPROVAL_REVOKED"));
    assert.throws(() => permission.request("new", "write-file", { path: "a" }), code("STALE_POLICY"));
  });
  await entered.promise;
  await runtime.updateConfig({ permissions: { ...permissions, policyVersion: "2" } });
  changed.resolve(); await old;
  await session.run(async run => {
    const permission = run.services.get(services.permission);
    const args = { path: "a" };
    const request = permission.request("call", "write-file", args);
    permission.reply({ binding: request.binding, decision: "allow" });
    args.path = "mutated";
    await assert.rejects(permission.invokeApproved(request.binding.approvalId, "call", "write-file", args), code("APPROVAL_MISMATCH"));
    const fresh = permission.request("call", "write-file", { path: "a" });
    permission.reply({ binding: fresh.binding, decision: "allow" });
    assert.equal(await permission.invokeApproved(fresh.binding.approvalId, "call", "write-file", { path: "a" }), "done");
  });
  assert.equal(effects, 1); await runtime.close();
});

test("approved arguments are copied before scheduling execution and the grant is consumed at dispatch", async () => {
  let received: unknown;
  const runtime = await Runtime.create({ plugins: [createPermissionPlugin(), plugin("tool", { setup(ctx) {
    ctx.registerTool({ name: "capture", description: "", inputSchema: {}, execute: input => { received = input; return input; } });
  } })], config: { permissions: { workspace: "/tmp/workspace", policyVersion: "1", ttlMs: 60_000 } } });
  const session = await runtime.openSession();
  await session.run(async run => {
    const permission = run.services.get(services.permission);
    const args = { path: "original" };
    const request = permission.request("call", "capture", args);
    permission.reply({ binding: request.binding, decision: "allow" });
    const pending = permission.invokeApproved(request.binding.approvalId, "call", "capture", args);
    args.path = "changed-after-invoke";
    await pending;
  });
  assert.deepEqual(received, { path: "original" }); await runtime.close();
});

test("permission events retain full binding and reject mismatched parameter hashes", async t => {
  const fixture = await journalFixture(t);
  const { log } = await fixture.open();
  const run = await start(log);
  const current = invocation();
  await run.record([{ callId: current.callId, data: { type: "tool.planned", tool: toolRef, input: current.arguments, effect: "non-idempotent-write" } }]);
  const authority = new ApprovalAuthority("policy-1");
  const request = authority.request(current, 60_000);
  const record = (hash: string) => run.record([{ callId: current.callId, data: {
    type: "permission.decided", decision: "allow", reason: "UI replied to complete binding", approval: { ...request.binding, argumentsHash: hash },
  } }]);
  await assert.rejects(record(contentHash({ changed: true } as JsonValue)), code("APPROVAL_MISMATCH"));
  await record(request.binding.argumentsHash);
  await log.close();
  const recovered = (await fixture.open()).log.events().at(-1)!;
  assert.equal(recovered.data.type, "permission.decided");
  if (recovered.data.type === "permission.decided") assert.deepEqual(recovered.data.approval, request.binding);
});

test("newly enabled permission provider initializes against the candidate configuration", async () => {
  const runtime = await Runtime.create({ plugins: [plugin("tool", { setup(ctx) {
    ctx.registerTool({ name: "echo", description: "", inputSchema: {}, execute: input => input });
  } })] });
  const session = await runtime.openSession();
  await runtime.enablePlugin(createPermissionPlugin(), { workspace: "/tmp/work", policyVersion: "1", ttlMs: 60_000 });
  await session.run(async run => {
    const permissions = run.services.get(services.permission);
    const request = permissions.request("call", "echo", { hello: true });
    assert(request.binding.policyVersion.endsWith(run.configuration.id));
    permissions.reply({ binding: request.binding, decision: "allow" });
    assert.deepEqual(await permissions.invokeApproved(request.binding.approvalId, "call", "echo", { hello: true }), { hello: true });
  });
  await runtime.close();
});
