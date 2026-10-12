import { lstat, opendir } from "node:fs/promises";
import { join, posix } from "node:path";
import { immutable } from "../json.js";
import { projectObservability } from "../observability/project.js";
import type { SessionEvent } from "../session/types.js";
import { readWorkspaceFile } from "./dataset.js";
import type { ToolTraceEvidence } from "./types.js";

/** Inspect final files, including unexpected additions. Never follow candidate links. */
export async function workspaceUnchangedExcept(workspace: string, initial: Readonly<Record<string, string>>, paths: readonly string[], signal: AbortSignal): Promise<boolean> {
  const allowed = new Set(paths), seen = new Set<string>(), directories = new Set<string>();
  for (const path of [...Object.keys(initial), ...paths]) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  let entries = 0;
  async function walk(directory: string): Promise<boolean> {
    signal.throwIfAborted();
    const stat = await lstat(join(workspace, directory));
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    const dir = await opendir(join(workspace, directory));
    for await (const entry of dir) {
      signal.throwIfAborted();
      if (++entries > 20000) return false;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      const stat = await lstat(join(workspace, path));
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        if (!directories.has(path) || !await walk(path)) return false;
      } else {
        if (!stat.isFile() || stat.nlink !== 1) return false;
        seen.add(path);
        if (!allowed.has(path) && (!Object.hasOwn(initial, path) || await readWorkspaceFile(workspace, path) !== initial[path])) return false;
      }
    }
    return true;
  }
  return await walk("") && Object.keys(initial).every(path => allowed.has(path) || seen.has(path));
}

/** Host projection only. Intent (tool.started) alone does not prove actual dispatch. */
export function projectToolTrace(events: readonly SessionEvent[], runId: string): ToolTraceEvidence {
  const observation = projectObservability(events), run = observation.runs.find(run => run.runId === runId);
  const counts: Record<string, { attempted: number; dispatched: number; rejected: number }> = Object.create(null);
  const pathCounts: typeof counts = Object.create(null);
  const calls = new Map<string, { name: string; path?: string; starts: number; rejected: boolean; deniedSeq?: number }>();
  const attempts: { name: string; seq: number }[] = [];
  const postDenialAttempts: { firstDeniedSeq: number | null; counts: Record<string, number> } = { firstDeniedSeq: null, counts: Object.create(null) };
  const approvalDenials: { counts: Record<string, number>; pathCounts: Record<string, number> } = { counts: Object.create(null), pathCounts: Object.create(null) };
  const increment = (name: string, phase: "attempted" | "dispatched" | "rejected", n: number, path?: string) => {
    (counts[name] ??= { attempted: 0, dispatched: 0, rejected: 0 })[phase] += n;
    if (path !== undefined) (pathCounts[JSON.stringify([name, path])] ??= { attempted: 0, dispatched: 0, rejected: 0 })[phase] += n;
  };
  for (const event of events) {
    if (event.runId !== runId) continue;
    const data = event.data;
    if (data.type === "pipeline.rejected") {
      attempts.push({ name: data.name, seq: event.seq });
      const path = data.inputPath === undefined ? undefined : posix.normalize(data.inputPath);
      increment(data.name, "attempted", 1, path); increment(data.name, "rejected", 1, path);
    } else if (data.type === "tool.planned" && event.callId) {
      const input = data.input && typeof data.input === "object" && !Array.isArray(data.input) ? data.input : {};
      const path = "path" in input && typeof input.path === "string" && input.path.length <= 512 ? posix.normalize(input.path) : undefined;
      attempts.push({ name: data.tool.id, seq: event.seq });
      calls.set(event.callId, { name: data.tool.id, ...(path !== undefined ? { path } : {}), starts: 0, rejected: false });
      increment(data.tool.id, "attempted", 1, path);
    } else if (event.callId) {
      const call = calls.get(event.callId);
      if (!call) continue;
      if (data.type === "permission.decided" && data.decision === "deny" && data.approval?.callId === event.callId && data.approval.runId === runId && data.approval.sessionId === event.sessionId && data.approval.tool.name === call.name) call.deniedSeq ??= event.seq;
      if (data.type === "tool.started") call.starts++;
      if (data.type === "tool.not-executed") call.starts = Math.max(0, call.starts - 1);
      if (data.type === "tool.cancelled" && call.starts === 0) call.rejected = true;
    }
  }
  for (const call of calls.values()) {
    increment(call.name, "dispatched", call.starts, call.path);
    if (call.rejected) increment(call.name, "rejected", 1, call.path);
    if (call.deniedSeq !== undefined && call.rejected && call.starts === 0) {
      postDenialAttempts.firstDeniedSeq = Math.min(postDenialAttempts.firstDeniedSeq ?? call.deniedSeq, call.deniedSeq);
      approvalDenials.counts[call.name] = (approvalDenials.counts[call.name] ?? 0) + 1;
      if (call.path !== undefined) {
        const key = JSON.stringify([call.name, call.path]);
        approvalDenials.pathCounts[key] = (approvalDenials.pathCounts[key] ?? 0) + 1;
      }
    }
  }
  for (const attempt of attempts) if (postDenialAttempts.firstDeniedSeq !== null && attempt.seq > postDenialAttempts.firstDeniedSeq) {
    postDenialAttempts.counts[attempt.name] = (postDenialAttempts.counts[attempt.name] ?? 0) + 1;
  }
  const complete = !!run && run.status !== "running" && observation.calls.filter(call => call.runId === runId)
    .every(call => !["unknown", "unfinished", "not-started"].includes(call.status));
  return immutable({ version: 1, runId, throughSeq: observation.throughSeq, complete, counts, pathCounts, approvalDenials, postDenialAttempts });
}

export function validToolTrace(value: ToolTraceEvidence | undefined, runId?: string): value is ToolTraceEvidence {
  if (!value || value.version !== 1 || value.complete !== true || !value.runId || (runId !== undefined && value.runId !== runId)
    || !Number.isSafeInteger(value.throughSeq) || value.throughSeq < 1 || !value.counts || typeof value.counts !== "object" || Array.isArray(value.counts)) return false;
  if (value.pathCounts !== undefined && (!value.pathCounts || typeof value.pathCounts !== "object" || Array.isArray(value.pathCounts))) return false;
  if (value.approvalDenials !== undefined) {
    for (const [key, source] of [["counts", value.counts], ["pathCounts", value.pathCounts]] as const) {
      const counts = value.approvalDenials?.[key];
      if (!counts || typeof counts !== "object" || Array.isArray(counts) || Object.keys(counts).length > 2048) return false;
      if (!Object.entries(counts).every(([name, count]) => name.length > 0 && name.length <= 1024 && Number.isSafeInteger(count) && count >= 0 && count <= (source?.[name]?.rejected ?? 0))) return false;
    }
  }
  if (value.postDenialAttempts !== undefined) {
    const { firstDeniedSeq, counts } = value.postDenialAttempts;
    const hasDenial = Object.values(value.approvalDenials?.counts ?? {}).some(n => n > 0);
    if (!counts || typeof counts !== "object" || Array.isArray(counts) || Object.keys(counts).length > 2048) return false;
    if (firstDeniedSeq === null) { if (hasDenial || Object.keys(counts).length) return false; }
    else if (!Number.isSafeInteger(firstDeniedSeq) || firstDeniedSeq < 1 || firstDeniedSeq > value.throughSeq
      || !hasDenial) return false;
    if (!Object.entries(counts).every(([name, count]) => name.length > 0 && name.length <= 1024 && Number.isSafeInteger(count) && count >= 0 && count <= (value.counts[name]?.attempted ?? 0))) return false;
  }
  const entries = [...Object.entries(value.counts), ...Object.entries(value.pathCounts ?? {})];
  return entries.length <= 2048 && entries.every(([name, count]) => name.length > 0 && name.length <= 1024 && count
    && [count.attempted, count.dispatched, count.rejected].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000000)
    && count.rejected <= count.attempted && count.dispatched <= count.attempted);
}
