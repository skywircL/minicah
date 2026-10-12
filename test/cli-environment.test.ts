import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCliEnvironment } from "../src/cli/environment.js";

test("CLI dotenv uses Node parsing, preserves environment precedence and ignores unrelated variables", async t => {
  const root = await mkdtemp(join(tmpdir(), "minicah-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, ".env");
  await writeFile(path, 'DEEPSEEK_API_KEY="fixture # key"\nDEEPSEEK_MODEL=file-model\nDEEPSEEK_BASE_URL=https://api.deepseek.com\nMINICAH_SANDBOX_IMAGE=node@sha256:fixture\nNODE_OPTIONS=--inspect\nOPENAI_API_KEY=openai-fixture\nANTHROPIC_API_KEY=anthropic-fixture\nGEMINI_API_KEY=gemini-fixture\nGOOGLE_API_KEY=google-alias\nOPENROUTER_API_KEY=router-fixture\nXAI_API_KEY=xai-fixture\nGROQ_API_KEY=groq-fixture\nMISTRAL_API_KEY=mistral-fixture\nAWS_SECRET_ACCESS_KEY=ignored\n');
  const environment: NodeJS.ProcessEnv = { DEEPSEEK_MODEL: "shell-model", OPENAI_API_KEY: "shell-key" };
  await loadCliEnvironment(path, environment);
  assert.deepEqual(environment, { DEEPSEEK_API_KEY: "fixture # key", DEEPSEEK_MODEL: "shell-model", DEEPSEEK_BASE_URL: "https://api.deepseek.com", MINICAH_SANDBOX_IMAGE: "node@sha256:fixture", OPENAI_API_KEY: "shell-key", ANTHROPIC_API_KEY: "anthropic-fixture", GEMINI_API_KEY: "gemini-fixture", GOOGLE_API_KEY: "google-alias", OPENROUTER_API_KEY: "router-fixture", XAI_API_KEY: "xai-fixture", GROQ_API_KEY: "groq-fixture", MISTRAL_API_KEY: "mistral-fixture" });
  const disabled: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: "" };
  await loadCliEnvironment(path, disabled);
  assert.equal(disabled.DEEPSEEK_API_KEY, "");
  const absent: NodeJS.ProcessEnv = {};
  await loadCliEnvironment(join(root, "absent"), absent);
  assert.deepEqual(absent, {});
});
