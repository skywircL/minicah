import assert from 'node:assert/strict';
import { Ajv } from 'ajv';
import { validateSuite } from '../../dist/src/evaluation/dataset.js';
import { allCapabilities } from './common.mjs';

const string = { type: 'string', minLength: 1 };
const strings = { type: 'array', minItems: 1, uniqueItems: true, items: string };
const object = { type: 'object' };
const seedId = { type: 'string', pattern: '^GS-(?:A[1-6]|H[1-6]|P[1-4])-[0-9]{2}$' };
const assertion = { type: 'object', additionalProperties: false, required: ['id', 'predicate', 'sourceIds', 'oracleIds'], properties: { id: string, predicate: string, sourceIds: strings, oracleIds: strings } };
export const seedSchema = { type: 'object', additionalProperties: false, required: [
  'case_id','seed_id','family_id','title','capability_id','track','mutation_type','split','risk_level','sources','provenance','user_goal','user_input','conversation','initial_state','user_permissions','available_tools','tool_state','expected_state','outcome_assertions','required_invariants','allowed_actions','forbidden_actions','response_rubric','trial_protocol','reset_fixture','version_bundle','reference_execution','negative_cases','execution','limitations','review',
], properties: {
  case_id: seedId, seed_id: seedId, family_id: seedId, title: string, capability_id: { enum: allCapabilities },
  track: { enum: ['agent-task','harness-contract','platform-contract'] }, mutation_type: { const: 'NONE' }, split: { const: 'gold_dev' }, risk_level: { enum: ['low','medium','high'] },
  sources: { type: 'array', minItems: 2, items: { type: 'object', additionalProperties: false, required: ['id','reference','statement'], properties: { id: string, reference: string, statement: string } } },
  provenance: { type: 'object', additionalProperties: false, required: ['origin','sourceIds','upstreamFamily','adaptation','upstreamReproduction'], properties: {
    origin: { enum: ['project-contract','project-contract-corroborated','upstream-regression','benchmark-derived'] },
    sourceIds: { type: 'array', uniqueItems: true, items: string }, upstreamFamily: { type: ['string','null'] }, adaptation: string,
    upstreamReproduction: { enum: ['not-run','not-applicable'] },
  } },
  user_goal: string, user_input: string, conversation: { type: 'array', items: object }, initial_state: object, user_permissions: object,
  available_tools: strings, tool_state: object, expected_state: object,
  outcome_assertions: { type: 'array', minItems: 1, items: assertion }, required_invariants: { type: 'array', minItems: 1, items: assertion },
  allowed_actions: strings, forbidden_actions: strings, response_rubric: object, trial_protocol: object, reset_fixture: object, version_bundle: object,
  reference_execution: object, negative_cases: { type: 'array', minItems: 1, items: object }, execution: object, limitations: strings,
  review: { type: 'object', additionalProperties: false, required: ['status','authorKind'], properties: { status: { const: 'pending' }, authorKind: { const: 'AI-assisted' } } },
} };
const validate = new Ajv({ strict: true }).compile(seedSchema);
export function validateSeeds(seeds) {
  const ids = new Set();
  for (const s of seeds) {
    assert.ok(validate(s), `Invalid ${s.case_id}: ${JSON.stringify(validate.errors)}`);
    assert.ok(!ids.has(s.case_id), 'Duplicate seed'); ids.add(s.case_id);
    assert.equal(s.seed_id, s.case_id, 'Gold seeds must not be derived mutations');
    assert.equal(s.case_id.split('-')[1],s.capability_id,'Case namespace must match its capability');
    assert.equal(s.track, s.capability_id.startsWith('A') ? 'agent-task' : s.capability_id.startsWith('H') ? 'harness-contract' : 'platform-contract');
    const sourceIds = new Set(s.sources.map(r => r.id)), oracleIds = new Set();
    assert.equal(sourceIds.size, s.sources.length, 'Duplicate source');
    if (s.provenance.origin === 'project-contract') {
      assert.equal(s.provenance.sourceIds.length, 0); assert.equal(s.provenance.upstreamFamily, null);
      assert.equal(s.provenance.upstreamReproduction, 'not-applicable');
    } else {
      assert.ok(s.provenance.sourceIds.length && s.provenance.upstreamFamily);
      assert.equal(s.provenance.upstreamReproduction, 'not-run');
      assert.ok(s.provenance.sourceIds.every(id => sourceIds.has(`upstream-${id}`)), 'Unlinked upstream provenance');
    }
    assert.ok(s.reference_execution.steps.length > 0 && s.reference_execution.origin === 'AI-authored-reference', 'Do not fabricate human reference execution');
    assert.ok(s.trial_protocol.referenceTrials === 1 && s.trial_protocol.timeoutMs > 0);
    if (s.execution.kind === 'coding' || s.execution.kind === 'conversation') {
      assert.equal(s.track, 'agent-task');
      assert.ok(s.execution.tasks.length > 0);
      assert.equal(s.execution.tasks.length, s.execution.references.length);
      if (s.execution.kind === 'conversation') assert.ok(s.execution.tasks.length > 1);
      validateSuite({ schemaVersion: 1, id: 'gold-validate', version: '2', split: 'capability', tasks: s.execution.tasks });
      for(const n of s.negative_cases) {
        const task=s.execution.tasks[n.override?.stage ?? 0];
        assert.ok(task && n.override?.expectedFailedGraders?.length,'Every counterexample must declare its failed oracles');
        const declared=[...n.override.expectedFailedGraders,...(n.override.expectedPassedGraders ?? []),...(n.override.expectedErroredGraders ?? [])];
        for(const id of declared) assert.ok(task.graders.some(g=>g.id===id),'Unknown counterexample oracle');
        assert.equal(new Set(declared).size,declared.length,'An oracle cannot have contradictory expected results');
      }
      assert.deepEqual(s.initial_state.files, s.execution.tasks[0].files);
      for (const [i,t] of s.execution.tasks.entries()) {
        for (const g of t.graders) oracleIds.add(`${i}/${g.id}`);
        assert.equal(t.contract.capabilityId, s.capability_id);
        assert.ok(t.graders.some(g => g.kind === 'workspace-unchanged-except'));
        assert.ok(t.graders.some(g => g.kind === 'tool-call-count' && g.phase === 'attempted' && g.tools.includes('run_command') && g.max === 0));
        // The public input cannot contain private oracle, future user turns or reference implementation fields.
        assert.equal(t.contract.seedId, s.seed_id);
      }
    } else {
      assert.equal(s.execution.kind, 'node-test'); assert.notEqual(s.track, 'agent-task');
      assert.ok(s.execution.checks.length > 0);
      for (const [i,c] of s.execution.checks.entries()) {
        assert.match(c.file, /^test\/[a-z0-9-]+\.test\.ts$/); assert.ok(c.name);
        oracleIds.add(`fixture/${i}`);
      }
    }
    const assertions = [...s.outcome_assertions, ...s.required_invariants];
    assert.equal(new Set(assertions.map(a => a.id)).size, assertions.length, 'Duplicate assertion');
    for (const a of assertions) {
      assert.ok(a.sourceIds.every(id => sourceIds.has(id)), 'Unsourced assertion');
      assert.ok(a.oracleIds.every(id => oracleIds.has(id)), 'Missing executable oracle');
    }
    const linked = new Set(assertions.flatMap(a => a.oracleIds));
    for (const id of oracleIds) assert.ok(linked.has(id), `Unmapped grader ${id}`);
    for (const n of s.negative_cases) assert.ok(n.violates.length && n.violates.every(id => assertions.some(a => a.id === id)), 'Negative case needs a real assertion');
  }
  return seeds;
}
