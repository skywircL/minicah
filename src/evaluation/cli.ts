#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEvaluationPlugin, evaluationService } from "./index.js";
import { Runtime } from "../runtime.js";
import { readSuite } from "./dataset.js";
import { createCodingTrialExecutor } from "./coding-executor.js";
import { loadCliEnvironment } from "../cli/environment.js";
import { HarnessError, fail } from "../errors.js";
import { contentHash } from "../session/json.js";
import { deepSeekConfig } from "../agent/deepseek.js";
import { piConfig, piApiKey, listPiModels, PI_API_KEY_ENV } from "../agent/pi.js";
import { createSandboxTestPackPlugin, readSandboxTestPack } from "./test-pack.js";
import { createSandboxTestPlugin } from "./sandbox-tests.js";
import type { SandboxTestPack } from "./sandbox-test-types.js";

const help = `minicah evaluation
  npm run eval -- --suite examples/evaluation-smoke.json
  npm run eval -- --suite evals/private/tasks.json --provider deepseek --model MODEL

  --suite PATH         Versioned JSON dataset (required)
  --provider NAME      fixture (offline scripted smoke, default), deepseek or pi
  --pi-provider NAME   Pi provider such as openai, anthropic or google (required for pi)
  --list-models        List the local Pi catalog; optional --pi-provider, no key/suite needed
  --mode MODE          native (default) or ptc (read-only)
  --allow-writes       Permit write_file/edit_file in the disposable trial workspace
  --sandbox MODE       PTC requires native (macOS) or docker
  --sandbox-image REF  Docker requires a digest-pinned image
  --test-pack PATH     Explicit Host test pack JSON; repeat for multiple packs
  --grader-sandbox MODE  Function test isolation: native (macOS) or docker
  --grader-image REF   Digest-pinned Docker image for grading
  --grader-timeout-ms N  Maximum duration of one function test group (default 30000)
  --grader-case-timeout-ms N  Maximum duration of each test case (default 5000)
  --model NAME         Required for Pi; DeepSeek also accepts DEEPSEEK_MODEL
  --endpoint URL       Endpoint override; direct DeepSeek also accepts DEEPSEEK_BASE_URL
  --thinking           Enable direct DeepSeek thinking
  --reasoning LEVEL    Pi reasoning level (default off; must be supported by the model)
  --context-window N   Context capacity (DeepSeek: 1000000; Pi: catalog value)
  --max-output-tokens N Single request output limit (default 4096)
  --repetitions N      Override per-case trial protocol (fallback 1)
  --concurrency N      Parallel trials (default 1)
  --timeout-ms N       Override per-case deadline (fallback 120000)
  --output PATH        Private reports (default .minicah/evals)

Function tests run fixed Node code in the selected OS sandbox; expected values stay
on the Host. No dataset shell commands are executed. Fixture scores test
the harness only. DeepSeek/Pi send public task material to the configured model API.
Ctrl-C cancels dispatch and waits for cleanup; unresolved workspaces are retained.
`;
export async function evaluationCli(args: string[]): Promise<number> {
  const { values: v } = parseArgs({ args, options: { suite: { type: "string" }, provider: { type: "string" }, mode: { type: "string" }, "allow-writes": { type: "boolean" }, sandbox: { type: "string" }, "sandbox-image": { type: "string" }, model: { type: "string" }, endpoint: { type: "string" }, "context-window": { type: "string" }, "max-output-tokens": { type: "string" }, repetitions: { type: "string" }, concurrency: { type: "string" }, "timeout-ms": { type: "string" }, output: { type: "string" }, help: { type: "boolean", short: "h" },
    "pi-provider": { type: "string" }, "list-models": { type: "boolean" }, reasoning: { type: "string" }, thinking: { type: "boolean" },
    "test-pack": { type: "string", multiple: true }, "grader-sandbox": { type: "string" }, "grader-image": { type: "string" }, "grader-timeout-ms": { type: "string" }, "grader-case-timeout-ms": { type: "string" },
  } });
  if (v.help) { process.stdout.write(help); return 0; }
  if (v["list-models"]) { process.stdout.write(JSON.stringify(listPiModels(v["pi-provider"]), null, 2) + "\n"); return 0; }
  if (!v.suite) fail("EVAL_ARGUMENT", "--suite is required");
  const provider = v.provider ?? "fixture", mode = v.mode ?? "native";
  if (provider !== "fixture" && provider !== "deepseek" && provider !== "pi" || mode !== "native" && mode !== "ptc") fail("EVAL_ARGUMENT", "Invalid provider or mode");
  if (provider !== "pi" && (v["pi-provider"] !== undefined || v.reasoning !== undefined)) fail("EVAL_ARGUMENT", "--pi-provider / --reasoning require --provider pi");
  if (provider !== "deepseek" && v.thinking !== undefined) fail("EVAL_ARGUMENT", "--thinking requires --provider deepseek");
  if (provider === "pi" && (!v["pi-provider"] || !v.model)) fail("EVAL_ARGUMENT", "Pi requires --pi-provider and --model");
  if (v.sandbox !== undefined && v.sandbox !== "native" && v.sandbox !== "docker") fail("EVAL_ARGUMENT", "Invalid sandbox");
  const sandbox = v.sandbox;
  if (mode === "ptc" && (!v.sandbox || v["allow-writes"]) || mode === "native" && (v.sandbox || v["sandbox-image"])) fail("EVAL_ARGUMENT", "PTC requires an explicit sandbox and read-only access; native mode uses only controlled file tools");
  if (v["sandbox-image"] && v.sandbox !== "docker") fail("EVAL_ARGUMENT", "--sandbox-image requires docker");
  if (provider === "fixture" && (v.model || v.endpoint)) fail("EVAL_ARGUMENT", "Model options require --provider deepseek or pi");
  const number = (value: string | undefined, fallback: number): number => {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(n) || n < 1) fail("EVAL_ARGUMENT", "Numeric options must be positive integers");
    return n;
  };
  const suite = await readSuite(resolve(v.suite));
  const hasTests = suite.tasks.some(task => task.graders.some(grader => grader.kind === "sandbox-test"));
  const graderBackend = v["grader-sandbox"];
  if (graderBackend !== undefined && graderBackend !== "native" && graderBackend !== "docker") fail("EVAL_ARGUMENT", "--grader-sandbox must be native or docker");
  if (hasTests && (!graderBackend || !v["test-pack"]?.length)) fail("EVAL_ARGUMENT", "sandbox-test graders require --test-pack and --grader-sandbox");
  if (!hasTests && (graderBackend || v["test-pack"] || v["grader-image"] || v["grader-timeout-ms"] || v["grader-case-timeout-ms"])) fail("EVAL_ARGUMENT", "Grader options require a sandbox-test in the suite");
  if (v["grader-image"] && graderBackend !== "docker") fail("EVAL_ARGUMENT", "--grader-image requires --grader-sandbox docker");
  if ((v["test-pack"]?.length ?? 0) > 16) fail("EVAL_ARGUMENT", "At most 16 test packs are supported");
  const packs: SandboxTestPack[] = [];
  for (const path of v["test-pack"] ?? []) packs.push(await readSandboxTestPack(resolve(path)));
  const availableTests = new Set(packs.flatMap(pack => pack.tests.map(test => `${pack.id}/${test.id}`)));
  for (const task of suite.tasks) for (const grader of task.graders) if (grader.kind === "sandbox-test" && !availableTests.has(grader.testId)) fail("EVAL_TEST_MISSING", "No registered test matches a grader reference");
  if (provider !== "fixture") {
    await loadCliEnvironment();
  }
  const modelConfig = provider === "pi" ? { ...piConfig({ provider: v["pi-provider"]!, model: v.model!, reasoning: v.reasoning ?? "off",
    ...(v.endpoint !== undefined ? { endpoint: v.endpoint } : {}),
    ...(v["context-window"] !== undefined ? { contextWindow: number(v["context-window"], 1) } : {}),
    ...(v["max-output-tokens"] !== undefined ? { maxOutputTokens: number(v["max-output-tokens"], 4096) } : {}),
  }) } : { ...deepSeekConfig(provider === "deepseek" ? { model: v.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-flash", endpoint: v.endpoint ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com", thinking: v.thinking ?? false, contextWindow: number(v["context-window"], 1000000), maxOutputTokens: number(v["max-output-tokens"], 4096) } : undefined) };
  if (provider !== "fixture" && !(provider === "pi" ? piApiKey(v["pi-provider"]!) : process.env.DEEPSEEK_API_KEY)) fail("MODEL_KEY_MISSING", `Set ${provider === "pi" ? PI_API_KEY_ENV[v["pi-provider"]!] : "DEEPSEEK_API_KEY"} locally`);
  const image = v["sandbox-image"] ?? process.env.MINICAH_SANDBOX_IMAGE;
  const graderImage = v["grader-image"] ?? (graderBackend === "docker" ? process.env.MINICAH_SANDBOX_IMAGE : undefined);
  if (v.sandbox === "docker" && !image) fail("SANDBOX_IMAGE_REQUIRED", "Set --sandbox-image");
  if (graderBackend === "docker" && !graderImage) fail("SANDBOX_IMAGE_REQUIRED", "Set --grader-image");
  const graderPolicy = { timeoutMs: number(v["grader-timeout-ms"], 30000), caseTimeoutMs: number(v["grader-case-timeout-ms"], 5000) };
  const repetitions = number(v.repetitions, 1), concurrency = number(v.concurrency, 1), timeoutMs = number(v["timeout-ms"], 120000);
  const controller = new AbortController(), abort = () => controller.abort();
  const runtime = await Runtime.create({ plugins: [createEvaluationPlugin({ sandboxTests: hasTests }), ...packs.map(createSandboxTestPackPlugin),
    ...(graderBackend ? [createSandboxTestPlugin({ backend: graderBackend, ...graderPolicy, ...(graderImage ? { image: graderImage } : {}) })] : []),
  ] });
  process.on("SIGINT", abort);
  try {
    const session = await runtime.openSession();
    const report = await session.run(run => run.services.get(evaluationService).run(suite, createCodingTrialExecutor({ provider, modelConfig: { ...modelConfig }, allowWrites: v["allow-writes"] ?? false, ...(sandbox ? { sandbox } : {}), ...(image ? { sandboxImage: image } : {}) }), {
      outputDirectory: resolve(v.output ?? ".minicah/evals"), mode, ...(v.repetitions ? { repetitions } : {}), concurrency, ...(v["timeout-ms"] ? { timeoutMs } : {}), signal: controller.signal,
      reference: { executor: "coding-agent-v1", model: provider === "fixture" ? "scripted-smoke-v1" : provider === "pi" ? `${v["pi-provider"]}/${modelConfig.model}` : modelConfig.model, configurationHash: contentHash({ provider, mode, allowWrites: v["allow-writes"] ?? false, model: provider !== "fixture" ? { ...modelConfig } : null, sandbox: v.sandbox ?? null, image: mode === "ptc" ? image ?? null : null,
        ...(hasTests ? { grading: { backend: graderBackend ?? null, image: graderImage ?? null, ...graderPolicy, packs: packs.map(pack => ({ id: pack.id, version: pack.version, hash: contentHash(pack) })) } } : {}),
      }) },
    }));
    process.stdout.write(JSON.stringify({ provider, ...report.aggregate, status: report.status, artifactDirectory: report.artifactDirectory }, null, 2) + "\n");
    return report.status === "cancelled" ? 130 : report.status === "completed" && report.trials.every(trial => trial.passed === true) ? 0 : 1;
  } finally { process.off("SIGINT", abort); await runtime.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await evaluationCli(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof HarnessError ? error.code : "EVAL_FAILED"}\n`); process.exitCode = 1; }
}
