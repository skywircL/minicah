import { immutable } from "./json.js";
import { replay, stateView } from "./reducer.js";
import type { ContextProjection, SessionEvent, SessionState } from "./types.js";

const historyTypes = new Set([
  "user.input", "model.completed", "model.failed", "tool.planned", "permission.decided", "tool.started",
  "ptc.started", "ptc.completed", "ptc.uncertain", "pipeline.rejected", "tool.completed", "tool.uncertain", "tool.not-executed", "tool.cancelled", "budget.exited", "run.finished",
]);

/** Compression changes this projection only; the authoritative journal is untouched. */
export function projectContext(sessionId: string, events: readonly SessionEvent[]): ContextProjection {
  return contextFromState(stateView(replay(sessionId, events)), events);
}

/** Reuse the journal's committed reducer; do not replay implementation artifacts each turn. */
export function contextFromState(state: SessionState, events: readonly SessionEvent[]): ContextProjection {
  const through = state.summary?.data.type === "summary.recorded" ? state.summary.data.coverage.to : 0;
  return immutable({
    throughSeq: state.throughSeq, summary: state.summary,
    constraints: state.protected.filter(event => event.data.type === "protected.recorded" && event.data.kind === "constraint"),
    protected: state.protected.filter(event => event.data.type === "protected.recorded" && event.data.kind === "protected"),
    tasks: state.tasks, pendingCalls: state.calls.filter(call => call.terminalSeq === null),
    history: events.filter(event => event.seq > through && historyTypes.has(event.data.type)),
    surface: { ...state.surface, events: state.surface.nodes.map(seq => events[seq - 1]!) },
    toolPrunings: state.toolPrunings,
  });
}
