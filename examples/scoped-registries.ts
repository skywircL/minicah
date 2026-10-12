import {
  API_VERSION, Runtime, RegistryScope, createCliCommandsPlugin, cliCommandService, commandRegistry,
  createSkillRegistryPlugin, skillRegistry, skillRegistryService, type Plugin,
} from "../src/index.js";

const preset = new RegistryScope("coding-preset");
const reviewer = preset.child("reviewer");
const writer = preset.child("writer");

function contribution(label: string): Plugin {
  return { id: "coding-contributions", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [], requires: [],
    setup(ctx) {
      ctx.registerTool({ name: "inspect", description: label, effect: "read", inputSchema: {}, execute: () => label });
      ctx.register(commandRegistry, "review", { usage: "<file>", description: label, parse: file => ({ kind: "prompt", text: `${label}: ${file}` }) });
      ctx.register(skillRegistry, "review", { version: "1", description: label, content: `${label}: inspect changes and report findings.`, resources: { "checklist.txt": `${label}: correctness, tests` } });
    },
  };
}

const runtime = await Runtime.create({ plugins: [
  createCliCommandsPlugin(), createSkillRegistryPlugin(),
  preset.mount(contribution("inherited"), "preset.contributions"),
  reviewer.mount(contribution("reviewer-v1"), "reviewer.contributions"),
] });
try {
  const session = await runtime.openSession();
  const show = (scope: RegistryScope) => session.run(async run => ({
    scope: scope.id,
    tool: await run.tools.invoke("inspect", {}),
    command: run.services.get(cliCommandService).parse("/review src/main.ts"),
    skill: run.services.get(skillRegistryService).get("review")!.value.content,
    resource: run.services.get(skillRegistryService).readResource("review", "checklist.txt"),
    generation: run.tools.list()[0]!.generation,
  }), { registryScope: scope });
  console.log(await show(reviewer));
  console.log(await show(writer));
  await runtime.replacePlugin(reviewer.mount(contribution("reviewer-v2"), "reviewer.contributions"));
  console.log(await show(reviewer));
  await runtime.disablePlugin("reviewer.contributions");
  console.log(await show(reviewer)); // Parent contributions become visible again.
  await session.run(run => console.log({ globalTools: run.tools.list().map(tool => tool.name) }));
} finally { await runtime.close(); }
