#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "node:fs/promises";
import { readJournalSnapshot } from "../session/file-journal.js";
import { projectObservability } from "./project.js";
import { HarnessError, fail } from "../errors.js";

export async function observeCli(args: string[], write = (text: string) => process.stdout.write(text)): Promise<void> {
  const { values } = parseArgs({ args, options: { journal: { type: "string" }, run: { type: "string" }, trace: { type: "boolean" }, output: { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help) { write("npm run observe -- --journal PATH [--run ID] [--trace] [--output PATH]\nReads the committed journal prefix without replaying tools. JSON contains metadata only.\nOutput must be a new file in an existing directory (0600); existing files are never replaced.\n"); return; }
  if (!values.journal) fail("OBSERVE_ARGUMENT", "--journal is required");
  const snapshot = await readJournalSnapshot(resolve(values.journal));
  const report = projectObservability(snapshot.events);
  if (values.run && !report.runs.some(run => run.runId === values.run)) fail("OBSERVE_RUN_NOT_FOUND", "No recorded run matches the requested ID");
  const runs = values.run ? report.runs.filter(run => run.runId === values.run) : report.runs;
  const calls = values.run ? report.calls.filter(call => call.runId === values.run) : report.calls;
  const data = JSON.stringify({ ...report, runs, calls: values.trace ? calls : [], discardedTailBytes: snapshot.discardedTailBytes }, null, 2) + "\n";
  if (!values.output) { write(data); return; }
  const file = await open(resolve(values.output), "wx", 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  write(`Metadata exported to ${resolve(values.output)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await observeCli(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof HarnessError ? error.code : "OBSERVE_FAILED"}\n`); process.exitCode = 1; }
}
