import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Runtime, createSessionPlugin, createToolPipelinePlugin, createPermissionPlugin, services, definition, reference, type PipelineOptions, type ToolDefinition, type RunContext, type ToolService, type SessionService, type Plugin } from "../src/index.js";
import { plugin } from "./helpers.js";
import { definitions } from "./session-helpers.js";

export async function pipelineFixture(t: TestContext, tools: readonly ToolDefinition[], options: PipelineOptions = {}, permissions = false, extraPlugins: readonly Plugin[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "minicah-pipeline-"));
  const runtime = await Runtime.create({ plugins: [plugin("test-tools", { setup(ctx) { for (const tool of tools) ctx.registerTool(tool); } }), createSessionPlugin({ directory }), createToolPipelinePlugin(options, permissions), ...extraPlugins, ...(permissions ? [createPermissionPlugin()] : [])], ...(permissions ? { config: { permissions: { workspace: directory, policyVersion: "v1", ttlMs: 60_000 } } } : {}) });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const session = await runtime.openSession("session");
  return { runtime, directory,
    run: <T>(fn: (tools: ToolService, log: SessionService, run: RunContext) => Promise<T>) => session.run(async run => {
      const tools = run.services.get(services.tool), log = run.services.get(services.session);
      const model = definitions[0]!, prompt = definitions[1]!, pluginDef = definition("plugin", "test-tools", "1.0.0", { implementation: "fixture" });
      await log.retain([model, prompt, pluginDef, ...tools.definitions()]);
      await log.start({ model: reference(model), prompt: reference(prompt), plugins: [reference(pluginDef)], tools: tools.definitions().map(reference) }, {});
      return fn(tools, log, run);
    }),
  };
}
export const echoTool: ToolDefinition = { name: "echo", description: "Read-only echo", effect: "read", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, execute: input => input };
