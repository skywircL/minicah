import { fail } from "../errors.js";
import { canonical } from "./json.js";
import type { CallState, SessionEvent } from "./types.js";

export interface SurfaceState { nodes: number[]; generation: number }

/** Original log bounds represented by a node, including nested replacements. */
function bounds(seq: number, events: readonly SessionEvent[]): [number, number] {
  let from = seq, to = seq;
  const pending = [seq], visited = new Set<number>();
  while (pending.length) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const data = events[current - 1]!.data;
    if (data.type === "surface.replaced") pending.push(...data.sourceEventSeqs);
    else if (data.type === "summary.recorded") { from = Math.min(from, 1); to = Math.max(to, data.coverage.to); }
    else { from = Math.min(from, current); to = Math.max(to, current); }
  }
  return [from, to];
}

function assertSettled(node: SessionEvent, calls: ReadonlyMap<string, CallState>, events: readonly SessionEvent[]): void {
  if (node.data.type !== "model.completed") return;
  for (const id of node.data.childCallIds ?? []) {
    const child = calls.get(id);
    if (child?.terminalSeq !== null && child?.terminalSeq !== undefined && child.parentCallId === node.callId) continue;
    if (events.some(event => event.runId === node.runId && event.data.type === "pipeline.rejected" && event.data.rejectedCallId === id && event.data.parentCallId === node.callId)) continue;
    fail("UNSETTLED_COVERAGE", `Surface replacement would hide unsettled model child ${id}`);
  }
}

/** Fold only admitted events. SessionLog owns the candidate state until persistence succeeds. */
export function applySurface(state: SurfaceState, event: SessionEvent, events: readonly SessionEvent[], calls: ReadonlyMap<string, CallState>): void {
  const data = event.data;
  if (data.type === "context.tool-pruned") { state.generation++; return; }
  if (data.type === "model.completed") {
    const request = calls.get(event.callId!)?.planned.data;
    if (request?.type === "model.requested" && request.purpose === "compaction") return;
  }
  if (data.type === "user.input" || data.type === "model.completed") {
    state.nodes.push(event.seq);
    return;
  }
  if (data.type === "summary.recorded") {
    const retained: number[] = [];
    for (const seq of state.nodes) {
      const node = events[seq - 1]!;
      // A legacy prefix summary supersedes the previous prefix summary even if
      // that summary was appended after its own coverage boundary.
      if (node.data.type === "summary.recorded" && node.data.coverage.to <= data.coverage.to) continue;
      if (seq <= data.coverage.to) continue;
      const [from, to] = bounds(seq, events);
      if (from <= data.coverage.to) {
        if (to > data.coverage.to) fail("INVALID_COVERAGE", "Prefix summary would split a surface replacement; cover its event too");
        continue;
      }
      retained.push(seq);
    }
    state.nodes = [event.seq, ...retained];
    state.generation++;
    return;
  }
  if (data.type !== "surface.replaced") return;
  if (data.expectedThroughSeq !== undefined && data.expectedThroughSeq !== event.seq - 1) fail("SURFACE_CHANGED", "Session changed before compaction commit");
  if (data.expectedSurface !== undefined && canonical(data.expectedSurface) !== canonical(state)) fail("SURFACE_CHANGED", "Surface changed during compaction");
  const op = data.surfaceOp;
  if (!op || op.op !== "replace" || Object.keys(op).length !== 3 || ![op.startSeq, op.endSeq].every(seq => Number.isSafeInteger(seq) && seq > 0 && seq < event.seq)) {
    fail("INVALID_SURFACE", "Replacement requires existing startSeq/endSeq surface nodes");
  }
  const start = state.nodes.indexOf(op.startSeq), end = state.nodes.indexOf(op.endSeq);
  if (start < 0 || end < start) fail("INVALID_SURFACE", "Replacement range must follow the current surface order");
  const shadowed = state.nodes.slice(start, end + 1);
  if (!Array.isArray(data.sourceEventSeqs) || data.sourceEventSeqs.length !== shadowed.length || new Set(data.sourceEventSeqs).size !== shadowed.length || shadowed.some(seq => !data.sourceEventSeqs.includes(seq))) {
    fail("INVALID_SURFACE", "Sources must identify every replaced surface node exactly once");
  }
  let from = event.seq, to = 0;
  for (const seq of shadowed) {
    assertSettled(events[seq - 1]!, calls, events);
    const range = bounds(seq, events);
    from = Math.min(from, range[0]); to = Math.max(to, range[1]);
  }
  for (const call of calls.values()) {
    if (call.firstSeq >= from && call.firstSeq <= to && call.terminalSeq === null) fail("UNSETTLED_COVERAGE", `Surface replacement would hide pending call ${call.callId}`);
  }
  state.nodes.splice(start, end - start + 1, event.seq);
  state.generation++;
}
