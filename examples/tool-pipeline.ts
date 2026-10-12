import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API_VERSION, Runtime, createDockerSandboxPlugin, createSessionPlugin, createToolPipelinePlugin, createPtcPlugin,
  services, definition, reference, projectPtcOutput, type ModelResponse, type Plugin,
} from "../src/index.js";

// The same explicit read-only tool is available to native batches and PTC bindings.
const tools: Plugin = {
  id: "demo-read-tools", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [], requires: [],
  setup(ctx) { ctx.registerTool({
    name: "lookup", description: "Read an entry in a fixed in-memory table", effect: "read",
    inputSchema: { type: "object", properties: { key: { type: "string", enum: ["a", "b"] } }, required: ["key"], additionalProperties: false },
    execute(input) { return { value: (input as { key: string }).key === "a" ? 10 : 20 }; },
  }); },
};
const model = definition("model", "fixture-model", "1", { algorithm: "return two independent lookup calls" });
const prompt = definition("prompt", "fixture-prompt", "1", "Find a and b, then sum their values.");
const toolPlugin = definition("plugin", tools.id, tools.version, { data: { a: 10, b: 20 }, algorithm: "validated lookup in a fixed table" });
const directory = await mkdtemp(join(tmpdir(), "minicah-pipeline-demo-"));
const image = process.env.MINICAH_SANDBOX_IMAGE ?? process.env.MINICAH_PTC_IMAGE;
const runtime = await Runtime.create({ plugins: [tools, createSessionPlugin({ directory }), createToolPipelinePlugin({ concurrency: 4 }), ...(image ? [createDockerSandboxPlugin({ image }), createPtcPlugin()] : [])] });
try {
  const session = await runtime.openSession("pipeline-demo");
  await session.run(async run => {
    const pipeline = run.services.get(services.tool), log = run.services.get(services.session);
    await log.retain([model, prompt, toolPlugin, ...pipeline.definitions()]);
    await log.start({ model: reference(model), prompt: reference(prompt), tools: pipeline.definitions().map(reference), plugins: [reference(toolPlugin)] }, {});
    const response: ModelResponse = { text: "Looking up both entries", toolCalls: [
      { callId: "lookup-a", name: "lookup", arguments: { key: "a" } },
      { callId: "lookup-b", name: "lookup", arguments: { key: "b" } },
    ] };
    await log.record([
      { callId: "model-response", data: { type: "model.requested", request: { prompt: prompt.content, tools: pipeline.list().map(tool => ({ name: tool.name, inputSchema: tool.inputSchema })) } } },
      { callId: "model-response", data: { type: "model.completed", response: { text: response.text, toolCalls: response.toolCalls.map(call => ({ ...call })) }, text: response.text } },
    ]);
    const native = await pipeline.invokeMany(response.toolCalls, { parentCallId: "model-response" });
    console.log("Native:", JSON.stringify(native.map(result => result.value)));
    if (image) {
      const result = await run.services.get(services.ptcRuntime).evaluate({ input: ["a", "b"], bindings: ["lookup"], program: `
        const results = await Promise.all(input.map(key => tools.lookup({ key })));
        let total = 0;
        for (const result of results) {
          if (result.status !== 'completed') throw new Error('lookup failed');
          total += result.value.value;
        }
        return { total };
      ` });
      console.log("PTC:", JSON.stringify(projectPtcOutput(result)));
      if (result.status !== "completed") throw new Error(`PTC ended with ${result.status}: ${result.code}`);
    } else console.log("PTC skipped: set MINICAH_SANDBOX_IMAGE (or MINICAH_PTC_IMAGE) to a locally provisioned Node image@sha256:digest");
    await log.record([{ data: { type: "run.finished", status: "completed" } }]);
  });
} finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
