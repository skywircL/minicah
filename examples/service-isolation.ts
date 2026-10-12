import { API_VERSION, Runtime, ServiceScope, createIsolationKey, serviceToken, type Plugin } from "../src/index.js";

// Local deterministic services: no model API or external side effects.
const model = serviceToken<{ reply(input: string): string }>("DemoModelService");
const agent = serviceToken<{ run(input: string): string }>("DemoAgentService");
const modelPlugin: Plugin = {
  id: "demo-model", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [model], requires: [],
  setup(ctx) { ctx.provide(model, () => ({ reply: input => `${String(ctx.config)}: ${input}` })); },
};
const agentPlugin: Plugin = {
  id: "demo-agent", version: "1.0.0", apiVersion: API_VERSION, scope: "session", provides: [agent], requires: [model],
  setup(ctx) { ctx.provide(agent, run => ({ run: input => run.services.get(model).reply(input) })); },
};
function composition(id: string) {
  const key = createIsolationKey(id);
  return new ServiceScope().isolate(model, key).isolate(agent, key);
}
const planner = composition("planner"), reviewer = composition("reviewer");
const runtime = await Runtime.create({ plugins: [
  planner.mount(modelPlugin, "planner.model"), planner.mount(agentPlugin, "planner.agent"),
  reviewer.mount(modelPlugin, "reviewer.model"), reviewer.mount(agentPlugin, "reviewer.agent"),
], config: { "planner.model": "planner-v1", "reviewer.model": "reviewer-v1" } });
try {
  const session = await runtime.openSession();
  const execute = (scope: ServiceScope) => session.run(run => run.services.get(agent).run("inspect workspace"), scope);
  console.log(await execute(planner));
  console.log(await execute(reviewer));
  await runtime.replacePlugin(planner.mount({ ...modelPlugin, version: "2.0.0" }, "planner.model"), "planner-v2");
  console.log(await execute(planner));
  console.log(await execute(reviewer));
} finally { await runtime.close(); }
