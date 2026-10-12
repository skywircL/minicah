import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { codingMessages, projectContext, type RunEventInput } from "../src/index.js";
import { journalFixture, start } from "./session-helpers.js";

// Independent minicah fixture for pi #2608. Surface positions, rather than
// physical journal ordering, determine which messages a second summary covers.
test("upstream regression: repeated compaction retains earlier kept messages until explicitly covered", async t => {
  const f = await journalFixture(t), { log } = await f.open(), run = await start(log);
  await run.record([{ data: { type: "protected.recorded", id: "guard", kind: "constraint", content: "Keep production unchanged" } }]);
  await run.record(["A-old", "B-retained", "C-retained"].map(content => ({ data: { type: "user.input" as const, content } })));
  const [a, b, c] = log.state().surface.nodes;
  const original = await readFile(f.path, "utf8");
  const replace = (nodes: number[], version: string, text: string): RunEventInput => ({ data: {
    type: "surface.replaced", id: "checkpoint", version, text,
    surfaceOp: { op: "replace", startSeq: nodes[0]!, endSeq: nodes.at(-1)! }, sourceEventSeqs: nodes,
  } });
  const first = await run.record([replace([a!], "1", "A summarized")]);
  await run.record([{ data: { type: "user.input", content: "D-new" } }]);
  const d = log.state().surface.nodes.at(-1)!;
  const second = await run.record([replace([first.toSeq], "2", "A summarized again")]);
  assert.deepEqual(log.state().surface.nodes, [second.toSeq, b, c, d]);
  const messages = codingMessages(projectContext(log.sessionId, log.events()));
  for (const text of ["B-retained", "C-retained", "D-new"]) assert.equal(messages.filter(m => m.content === text).length, 1);
  assert.ok(messages.some(m => m.content?.includes("Keep production unchanged")));
  const third = await run.record([replace([second.toSeq, b!], "3", "A and B summarized")]);
  assert.deepEqual(log.state().surface.nodes, [third.toSeq, c, d]);
  assert.equal(log.state().surface.generation, 3);
  assert.ok((await readFile(f.path, "utf8")).startsWith(original));
  const expected = projectContext(log.sessionId, log.events());
  await log.close();
  const restored = (await f.open()).log;
  assert.deepEqual(projectContext(restored.sessionId, restored.events()), expected);
});
