import assert from "node:assert/strict";
import test from "node:test";
import { baseEstimate } from "../src/agent/token-budget.js";

test("token estimation includes schemas and multilingual content without treating bytes as tokens", () => {
  const english = { messages: [{ role: "user", content: "a".repeat(3000) }] };
  const chinese = { messages: [{ role: "user", content: "中".repeat(3000) }] };
  const en = baseEstimate(english), zh = baseEstimate(chinese);
  assert.ok(zh > en);
  assert.ok(en < Buffer.byteLength(JSON.stringify(english)));
  assert.ok(zh < Buffer.byteLength(JSON.stringify(chinese)));
  assert.ok(baseEstimate({ ...english, tools: [{ description: "description ".repeat(1000) }] }) > en);
  assert.deepEqual(baseEstimate({ ...english, max_tokens: 100 }), baseEstimate({ ...english, max_tokens: 100_000 }));
});

