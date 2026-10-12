import assert from "node:assert/strict";
import test from "node:test";
import { Runtime } from "../src/runtime.js";
import { services } from "../src/services.js";
import { piConfig, createPiPlugin, listPiModels } from "../src/agent/pi.js";
import type { JsonValue } from "../src/types.js";
import { code, deferred } from "./helpers.js";

test("Pi rejects unrecordable credentials, unknown models, unsafe endpoints and unsupported capacities", () => {
  const base = { provider: "openai", model: "gpt-4.1" };
  for (const extra of [
    { apiKey: "secret" }, { provider: "openai-codex" }, { model: "nonexistent-model" },
    { endpoint: "https://key:secret@example.com" }, { endpoint: "https://example.com?key=secret" },
    { endpoint: "http://example.com" }, { contextWindow: 100_000_000 }, { maxOutputTokens: 1_000_000 }, { reasoning: "high" },
  ]) assert.throws(() => piConfig({ ...base, ...extra }), code("INVALID_CONFIG"));
  const configs = listPiModels();
  assert.equal(new Set(configs.map(model => model.provider)).size, 8);
  assert.ok(configs.some(model => model.api === "mistral-conversations"));
  assert.ok(Object.isFrozen(configs));
});

test("Pi provider switches affect subsequent runs while an active run retains its route and request", async () => {
  const first = { provider: "openai", model: "gpt-4.1", maxOutputTokens: 2048 };
  const runtime = await Runtime.create({ plugins: [createPiPlugin({ apiKey: () => "private-fixture-key" })], config: { "pi-model": first } });
  const session = await runtime.openSession(), entered = deferred(), release = deferred();
  let before: JsonValue | undefined;
  const old = session.run(async run => {
    const model = run.services.get(services.model);
    before = model.prepare([{ role: "user", content: "Read the project" }], []);
    entered.resolve(); await release.promise;
    assert.equal(model, run.services.get(services.model));
    assert.deepEqual(model.prepare([{ role: "user", content: "Read the project" }], []), before);
    assert.equal((before as Record<string, JsonValue>).provider, "openai");
    assert.doesNotMatch(JSON.stringify([before, model.definition(), run.configuration]), /private-fixture-key/);
  });
  try {
    await entered.promise;
    await runtime.updateConfig({ "pi-model": { provider: "google", model: "gemini-2.5-flash", maxOutputTokens: 4096 } });
    await session.run(run => {
      const model = run.services.get(services.model), request = model.prepare([{ role: "user", content: "Read the project" }], []) as Record<string, JsonValue>;
      assert.equal(request.provider, "google");
      assert.equal(model.limits!().maxOutputTokens, 4096);
      assert.notEqual(request.route, (before as Record<string, JsonValue>).route);
    });
    await assert.rejects(runtime.updateConfig({ "pi-model": { provider: "google", model: "gemini-2.5-flash", reasoning: "high", maxOutputTokens: 1024 } }), code("INVALID_CONFIG"));
  } finally { release.resolve(); await old; await runtime.close(); }
});
