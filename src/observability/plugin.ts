import { API_VERSION, serviceToken, type Plugin } from "../types.js";
import { services } from "../services.js";
import type { SessionEvent } from "../session/types.js";
import { projectObservability } from "./project.js";
import type { ObservabilityReport, ObservabilityService } from "./types.js";

export const observabilityService = serviceToken<ObservabilityService>("ObservabilityService");

/** A read-only projection plugin. Cache only committed Session events, never UI deltas. */
export function createObservabilityPlugin(): Plugin {
  return { id: "session-observability", version: "1.0.0", apiVersion: API_VERSION, scope: "session",
    provides: [observabilityService], requires: [services.session],
    setup(ctx) {
      let tail: SessionEvent | undefined, cached: ObservabilityReport | undefined;
      ctx.provide(observabilityService, run => {
        const session = run.services.get(services.session);
        const snapshot = (): ObservabilityReport => {
          const events = session.events(), current = events.at(-1);
          if (!cached || current !== tail) { cached = projectObservability(events); tail = current; }
          return cached;
        };
        return Object.freeze({ snapshot,
          run: (runId: string) => snapshot().runs.find(item => item.runId === runId) ?? null,
          trace: (runId?: string) => runId === undefined ? snapshot().calls : Object.freeze(snapshot().calls.filter(call => call.runId === runId)),
        });
      });
    },
  };
}
