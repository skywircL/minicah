import { API_VERSION, serviceToken, type Plugin } from "../types.js";
import type { EvaluationService } from "./types.js";
import { EvaluationRunner } from "./runner.js";
import { sandboxTestService } from "./sandbox-tests.js";
export * from "./types.js";
export * from "./dataset.js";
export * from "./graders.js";
export * from "./evidence.js";
export * from "./runner.js";
export * from "./sandbox-test-types.js";
export * from "./sandbox-tests.js";

export const evaluationService = serviceToken<EvaluationService>("EvaluationService", 1);
export function createEvaluationPlugin(options: { sandboxTests?: boolean } = {}): Plugin {
  return {
    id: "evaluation", version: "1.1.0", apiVersion: API_VERSION, scope: "runtime", provides: [evaluationService], requires: options.sandboxTests ? [sandboxTestService] : [],
    setup(ctx) {
      const runner = ctx.resource("evaluation-runner", () => new EvaluationRunner(), runner => runner.close());
      ctx.provide(evaluationService, run => ({ run: (suite, executor, runOptions) => run.track(() => runner.get().run(suite, executor,
        options.sandboxTests ? { ...runOptions, sandboxTests: run.services.get(sandboxTestService) } : runOptions)), health: () => runner.get().health() }));
    },
  };
}
