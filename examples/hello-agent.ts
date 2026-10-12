import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API_VERSION, Runtime, createContextPlugin, createSessionPlugin, definition, reference, services, serviceToken,
  type Definition, type Message, type Plugin,
} from "../src/index.js";

const modelDefinition = serviceToken<Definition>("HelloModelDefinition");
const prompt = definition("prompt", "hello", "1.0.0", "Greet the user by echoing their name.");
const tool = definition("tool", "greet", "1.0.0", {
  description: "Build a greeting", inputSchema: { type: "string" },
});
const agentDefinition = definition("plugin", "hello-agent", "1.0.0", {
  algorithm: "record user input; invoke greet; build context; record model request; generate; commit response",
});

const model: Plugin = {
  id: "hello-model", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime",
  provides: [services.model, modelDefinition], requires: [],
  setup(ctx) {
    ctx.provide(modelDefinition, () => definition("model", "mock-greeter", "1.0.0", {
      label: "hello-model-v1", algorithm: "greeting + ' ' + last message content",
    }));
    ctx.provide(services.model, () => ({
      definition: () => definition("model", "mock-greeter", "1.0.0", { label: "hello-model-v1", algorithm: "label + ': ' + last message content" }),
      prepare: (messages: readonly Message[]) => ({ messages: messages.map(message => ({ role: message.role, content: message.content })), temperature: 0 }),
      async complete(request: unknown) {
        const messages = (request as { messages: { content: string }[] }).messages;
        return {
          message: { role: "assistant" as const, content: `Hello, ${messages.at(-1)?.content ?? "world"}!` },
          finishReason: "stop", usage: null, providerId: "mock",
        };
      },
    }));
  },
};

const tools: Plugin = {
  id: "hello-tools", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime",
  provides: [], requires: [],
  setup(ctx) {
    ctx.registerTool({
      name: "greet", description: "Return the name unchanged", inputSchema: { type: "string" },
      execute(input) {
        if (typeof input !== "string") throw new TypeError("greet expects a string");
        return input.trim();
      },
    });
  },
};

const agent: Plugin = {
  id: "hello-agent", version: "1.0.0", apiVersion: API_VERSION, scope: "session",
  provides: [services.agentLoop],
  requires: [services.model, modelDefinition, services.session, services.context],
  setup(ctx) {
    ctx.provide(services.agentLoop, run => {
      const model = run.services.get(services.model);
      const modelDef = run.services.get(modelDefinition);
      const session = run.services.get(services.session);
      const context = run.services.get(services.context);
      const tools = run.tools;
      return {
        async run(input: string, signal?: AbortSignal) {
          await session.retain([modelDef, prompt, tool, agentDefinition]);
          await session.start({
            model: reference(modelDef), prompt: reference(prompt), tools: [reference(tool)],
            plugins: [reference(agentDefinition)],
          }, { temperature: 0 });
          const toolCall = `${run.id}/greet`, modelCall = `${run.id}/model`;
          await session.record([
            { data: { type: "user.input", content: input } },
            { callId: toolCall, data: { type: "tool.planned", tool: reference(tool), input, effect: "read" } },
            { callId: toolCall, data: { type: "permission.decided", decision: "allow", reason: "Local greet has no external effects" } },
          ]);
          await session.executeTool(toolCall, async ({ input }) => ({
            outcome: "success", result: String(await tools.invoke("greet", input)),
          }));
          const messages: Message[] = [];
          for (const event of context.build().history) {
            if (event.data.type === "user.input") messages.push({ role: "user", content: event.data.content });
            if (event.data.type === "model.completed") messages.push({ role: "assistant", content: event.data.text });
          }
          const request = model.prepare(messages, []);
          await session.record([{ callId: modelCall, data: { type: "model.requested", request } }]);
          const response = await model.complete(request, signal ? { signal } : {});
          const answer = response.message.content ?? "";
          await session.record([
            { callId: modelCall, data: { type: "model.completed", response: { text: answer }, text: answer } },
            { data: { type: "run.finished", status: "completed" } },
          ]);
          return { status: "completed" as const, text: answer, runId: run.id, steps: 1, tokens: 0 };
        },
      };
    });
  },
};

const directory = await mkdtemp(join(tmpdir(), "minicah-hello-"));
const plugins = () => [agent, tools, createSessionPlugin({ directory }), createContextPlugin(), model];
try {
  const runtime = await Runtime.create({ plugins: plugins() });
  try {
    const session = await runtime.openSession("hello");
    const result = await session.run(run => run.services.get(services.agentLoop).run("Agent"));
    console.log(result.text);
    console.log(`run: ${result.runId} status: ${result.status}`);
  } finally {
    await runtime.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
