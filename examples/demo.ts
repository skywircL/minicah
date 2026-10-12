import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API_VERSION, Runtime, createContextPlugin, createSessionPlugin, definition, reference, services, serviceToken,
  type Definition, type Message, type Plugin,
} from "../src/index.js";

const modelDefinition = serviceToken<Definition>("DemoModelDefinition");
const prompt = definition("prompt", "demo", "1.0.0", "Echo the last user message with the model label.");
const tool = definition("tool", "echo", "1.0.0", { description: "Return text unchanged", inputSchema: { type: "string" } });
const agentDefinition = definition("plugin", "demo-agent", "1.0.0", {
  algorithm: "record user input; invoke echo; build context; record model request; generate; commit response and run completion",
});

const model = (version: number): Plugin => ({
  id: "demo-model", version: `${version}.0.0`, apiVersion: API_VERSION, scope: "runtime",
  provides: [services.model, modelDefinition], requires: [],
  setup(ctx) {
    ctx.provide(modelDefinition, () => definition("model", "mock-echo", `${version}.0.0`, { label: `model-v${version}`, algorithm: "label + ': ' + last message content" }));
    ctx.provide(services.model, () => ({
      definition: () => definition("model", "mock-echo", `${version}.0.0`, { label: `model-v${version}`, algorithm: "label + ': ' + last message content" }),
      prepare: messages => ({ messages: messages.map(message => ({ role: message.role, content: message.content })), temperature: 0 }),
      async complete(request) {
        const messages = (request as { messages: { content: string }[] }).messages;
        return { message: { role: "assistant", content: `model-v${version}: ${messages.at(-1)?.content ?? ""}` }, finishReason: "stop", usage: null, providerId: "mock" };
      },
    }));
  },
});

const tools: Plugin = {
  id: "tools", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime",
  provides: [], requires: [],
  setup(ctx) {
    ctx.registerTool({
      name: "echo", description: "Return the supplied text", inputSchema: { type: "string" },
      execute(input) {
        if (typeof input !== "string") throw new TypeError("echo expects a string");
        return input;
      },
    });
  },
};

const agent: Plugin = {
  id: "agent", version: "1.0.0", apiVersion: API_VERSION, scope: "session",
  provides: [services.agentLoop], requires: [services.model, modelDefinition, services.session, services.context],
  setup(ctx) {
    ctx.provide(services.agentLoop, run => {
      const model = run.services.get(services.model);
      const modelDef = run.services.get(modelDefinition);
      const session = run.services.get(services.session);
      const context = run.services.get(services.context);
      const tools = run.tools;
      return {
        async run(input, signal) {
          await session.retain([modelDef, prompt, tool, agentDefinition]);
          await session.start({ model: reference(modelDef), prompt: reference(prompt), tools: [reference(tool)], plugins: [reference(agentDefinition)] }, { temperature: 0 });
          const toolCall = `${run.id}/echo`, modelCall = `${run.id}/model`;
          await session.record([
            { data: { type: "user.input", content: input } },
            { callId: toolCall, data: { type: "tool.planned", tool: reference(tool), input, effect: "read" } },
            { callId: toolCall, data: { type: "permission.decided", decision: "allow", reason: "Local echo has no external effects" } },
          ]);
          await session.executeTool(toolCall, async ({ input }) => ({ outcome: "success", result: String(await tools.invoke("echo", input)) }));
          const messages: Message[] = [];
          for (const event of context.build().history) {
            if (event.data.type === "user.input") messages.push({ role: "user", content: event.data.content });
            if (event.data.type === "model.completed") messages.push({ role: "assistant", content: event.data.text });
          }
          // Retain the actual JSON request body and its versioned definitions.
          const request = model.prepare(messages, []);
          await session.record([{ callId: modelCall, data: { type: "model.requested", request } }]);
          const response = await model.complete(request, signal ? { signal } : {});
          const answer = response.message.content ?? "";
          await session.record([
            { callId: modelCall, data: { type: "model.completed", response: { text: answer }, text: answer } },
            { data: { type: "run.finished", status: "completed" } },
          ]);
          return { status: "completed", text: answer, runId: run.id, steps: 1, tokens: 0 };
        },
      };
    });
  },
};

const directory = await mkdtemp(join(tmpdir(), "minicah-demo-"));
const plugins = () => [agent, tools, createSessionPlugin({ directory }), createContextPlugin(), model(1)];
try {
  const runtime = await Runtime.create({ plugins: plugins() });
  try {
    const session = await runtime.openSession("demo");
    console.log((await session.run(run => run.services.get(services.agentLoop).run("Inspect the workspace"))).text);
    const result = await runtime.replacePlugin(model(2));
    console.log(`Provider generation: ${result.generation}`);
    console.log((await session.run(run => run.services.get(services.agentLoop).run("Continue with the new provider"))).text);
  } finally { await runtime.close(); }
  const recovered = await Runtime.create({ plugins: plugins() });
  try {
    const session = await recovered.openSession("demo");
    await session.run(run => {
      const log = run.services.get(services.session);
      const messages = run.services.get(services.context).build().history.filter(event => ["user.input", "model.completed"].includes(event.data.type));
      console.log(`Recovered messages: ${messages.length}`);
      console.log(`Confirmed calls: ${log.recovery().filter(call => call.status === "confirmed-complete").length}`);
    });
  } finally { await recovered.close(); }
} finally { await rm(directory, { recursive: true, force: true }); }
