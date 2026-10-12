import assert from 'node:assert/strict';
import { aggregateTrials } from '../../dist/src/evaluation/index.js';

export function wilson(successes, total, z = 1.959963984540054) {
  assert.ok(Number.isInteger(total) && Number.isInteger(successes) && successes >= 0 && successes <= total);
  if (!total) return null;
  const p = successes / total, d = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / d;
  const radius = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / d;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

export function quantile(values, p) {
  assert.ok(p >= 0 && p <= 1);
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * p, lo = Math.floor(position), hi = Math.ceil(position);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (position - lo);
}

export function distribution(values) {
  const available = values.filter(Number.isFinite);
  return { samples: available.length, missing: values.length - available.length,
    total: available.length ? available.reduce((a, b) => a + b, 0) : null,
    mean: available.length ? available.reduce((a, b) => a + b, 0) / available.length : null,
    p50: quantile(available, 0.5), p95: quantile(available, 0.95) };
}

/** Resample whole parent families, keeping every dependent variant together.
 * This describes sensitivity across these selected families, not a deployment CI. */
export function familyBootstrap(cases, samples = 10000, seed = 20261003) {
  const groups = [...new Set(cases.map(c => c.family))].map(f => cases.filter(c => c.family === f && c.passAt1 !== null));
  if (groups.length < 2 || groups.some(g => !g.length)) return null;
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 2 ** 32; };
  const caseMeans = [], familyMeans = [];
  for (let i = 0; i < samples; i++) {
    const selected = groups.map(() => groups[Math.floor(random() * groups.length)]);
    const rows = selected.flat();
    caseMeans.push(rows.reduce((n, c) => n + c.passAt1, 0) / rows.length);
    familyMeans.push(selected.reduce((n, g) => n + g.reduce((m, c) => m + c.passAt1, 0) / g.length, 0) / groups.length);
  }
  return { method: 'whole-family percentile bootstrap', level: 0.95, families: groups.length, samples, seed,
    caseMacro: [quantile(caseMeans, 0.025), quantile(caseMeans, 0.975)],
    familyMacro: [quantile(familyMeans, 0.025), quantile(familyMeans, 0.975)],
    limitation: 'Selected gold_dev families are not a random deployment sample; shared provider/cache and time effects remain uncontrolled.' };
}

export function repeatedStatistics(metadata, trials) {
  const cases = aggregateTrials(trials, [1, 3, 7]).cases.map(c => {
    const meta = metadata.find(m => m.caseId === c.taskId); assert.ok(meta);
    return { ...c, family: meta.family, risk: meta.risk, repetitions: meta.repetitions,
      wilson95: wilson(c.passedTrials, c.eligibleTrials), confidenceAssumption: 'IID Bernoulli conditional on this fixed case; exclusions may bias estimates' };
  });
  const stability = [...new Set(cases.map(c => c.repetitions))].sort((a, b) => a - b).map(k => {
    const selected = cases.filter(c => c.repetitions === k), complete = selected.filter(c => c.empiricalAllTrials !== null);
    return { k, cases: selected.length, complete: complete.length, incomplete: selected.length - complete.length,
      allPassed: complete.filter(c => c.empiricalAllTrials).length, atLeastOne: complete.filter(c => c.empiricalAtLeastOne).length,
      observedAllKRate: complete.length ? complete.filter(c => c.empiricalAllTrials).length / complete.length : null };
  });
  const complete3 = cases.filter(c => c.passPowerK['3'] !== null);
  return { cases, stability, macroPassPower3: complete3.length ? complete3.reduce((n, c) => n + c.passPowerK['3'], 0) / complete3.length : null,
    bootstrap: familyBootstrap(cases) };
}

/** Wall-time union avoids counting simultaneous tool operations twice. */
export function intervalUnion(intervals) {
  const sorted = intervals.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a).sort((a, b) => a[0] - b[0]);
  let total = 0, end = -Infinity;
  for (const [a, b] of sorted) { total += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
  return total;
}

export function toolTiming(events) {
  const starts = new Map(), intervals = []; let unmatched = 0;
  for (const e of events) {
    if (e.data.type === 'tool.started') starts.set(e.callId, Date.parse(e.timestamp));
    if (['tool.completed', 'tool.cancelled'].includes(e.data.type)) {
      if (starts.has(e.callId)) { intervals.push([starts.get(e.callId), Date.parse(e.timestamp)]); starts.delete(e.callId); }
      else unmatched++;
    }
  }
  return { unionMs: intervalUnion(intervals), sumMs: intervals.reduce((n, [a, b]) => n + b - a, 0), measuredCalls: intervals.length, unfinishedCalls: starts.size, unmatchedTerminalEvents: unmatched };
}
