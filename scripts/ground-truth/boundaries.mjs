// Expected results are authored from task rules, never copied from candidate outputs.
const ret = (id, args, expected) => ({ id: `gt-${id}`, args, expected });
const err = (id, args) => ({ id: `gt-${id}`, args, throws: 'RangeError' });
export const boundaries = {
  'encode-query': [
    ret('negative-fraction-exponent', [[['n', [-1, 0.5, 1e21]]]], 'n=-1&n=0.5&n=1e%2B21'),
    ret('empty-key-astral', [[['', '😀']]], '=%F0%9F%98%80'),
  ],
  'merge-config': [ret('null-base-object-patch', [{ a: null, keep: false }, { a: { b: 0 } }], { a: { b: 0 }, keep: false })],
  'migrate-user-records': [
    ret('v1-extra-fields', [[{ version: 1, id: 0, name: ' A ', extra: true }]], [{ id: '0', displayName: 'A', email: null, active: true }]),
    err('string-version', [[{ version: '1', id: 1, name: 'A' }]]),
    err('missing-version', [[{ id: 1, name: 'A' }]]),
  ],
  'sort-release-versions': [
    ret('empty', [[]], []), ret('maximum-core', [['999999.999999.999999', '999998.0.0']], ['999998.0.0', '999999.999999.999999']),
    ...['1000000.0.0', '1.0', '1.0.0.0', '1.0.0-', '1.0.0-a..b', '1.0.0-中'].map((v, i) => err(`invalid-${i}`, [[v]])),
  ],
  'collect-pages': [ret('omitted-start', [{ omitStart: true, pages: [{ cursor: null, items: [0], nextCursor: null }] }], { items: [0], requests: [null] })],
  'retry-operation': [
    ...[-1, '2', null].map((n, i) => ret(`invalid-attempt-${i}`, [{ maxAttempts: n, outcomes: [] }], { status: 'rejected', error: 'RangeError', calls: 0, sameError: false })),
    ret('zero-argument-operation', [{ maxAttempts: 1, observeArgs: true, outcomes: [{ ok: true, value: 0 }] }], { status: 'fulfilled', value: 0, calls: 1, zeroArgs: true }),
  ],
  'render-config-template': [
    ret('empty', ['', {}], ''), ret('literal', ['plain {text}', {}], 'plain {text}'),
    ret('nested-braces', ['{{{a}}}|{{a{b}}}', { a: 'X', b: 'Y' }], '{X}|{{a{b}}}'),
  ],
  'dependency-order': [
    ret('converging-dependencies', [[{ id: 'c', dependsOn: ['a', 'b'] }, { id: 'b', dependsOn: [] }, { id: 'a', dependsOn: [] }]], ['b', 'a', 'c']),
    ret('empty-and-prototype-ids', [[{ id: '__proto__', dependsOn: [''] }, { id: '', dependsOn: [] }, { id: 'constructor', dependsOn: ['__proto__'] }]], ['', '__proto__', 'constructor']),
  ],
  'reconcile-ledger': [
    err('changed-from', [[{ id: 't', type: 'transfer', from: 'a', to: 'b', cents: 1 }, { id: 't', type: 'transfer', from: 'c', to: 'b', cents: 1 }]]),
    err('changed-reversal-reference', [[{ id: 'a', type: 'transfer', from: 'x', to: 'y', cents: 1 }, { id: 'b', type: 'transfer', from: 'x', to: 'y', cents: 1 }, { id: 'r', type: 'reverse', ref: 'a' }, { id: 'r', type: 'reverse', ref: 'b' }]]),
    ret('self-transfer-reverse', [[{ id: 't', type: 'transfer', from: 'a', to: 'a', cents: 1 }, { id: 'r', type: 'reverse', ref: 't' }]], { balances: [{ account: 'a', cents: 0 }], applied: ['t', 'r'] }),
    ret('safe-integer-limit', [[{ id: 't', type: 'transfer', from: 'a', to: 'b', cents: Number.MAX_SAFE_INTEGER }]], { balances: [{ account: 'a', cents: -Number.MAX_SAFE_INTEGER }, { account: 'b', cents: Number.MAX_SAFE_INTEGER }], applied: ['t'] }),
    ret('interleaved-reverse', [[{ id: 'a', type: 'transfer', from: 'x', to: 'y', cents: 2 }, { id: 'b', type: 'transfer', from: 'y', to: 'z', cents: 1 }, { id: 'r', type: 'reverse', ref: 'a' }]], { balances: [{ account: 'x', cents: 0 }, { account: 'y', cents: -1 }, { account: 'z', cents: 1 }], applied: ['a', 'b', 'r'] }),
  ],
  'apply-text-patches': [
    err('fractional-end', ['abc', [{ start: 0, end: 1.5, text: '' }]]),
    err('string-start', ['abc', [{ start: '0', end: 1, text: '' }]]),
    err('string-end', ['abc', [{ start: 0, end: '1', text: '' }]]),
    ret('empty-input-insert', ['', [{ start: 0, end: 0, text: 'x' }]], 'x'),
    err('nested-overlap', ['abcd', [{ start: 0, end: 4, text: '' }, { start: 1, end: 3, text: '' }]]),
    err('identical-overlap', ['abcd', [{ start: 0, end: 2, text: '' }, { start: 0, end: 2, text: '' }]]),
  ],
  'map-with-concurrency': [ret('worker-input-identity', [{ jobs: [{ value: 1, ticks: 2 }, { value: 1, ticks: 0 }, { value: 1, ticks: 1 }], limit: 2, observeInputs: true }], { values: [1, 1, 1], peak: 2, calls: 3, inputIndexes: [0, 1, 2] })],
  'apply-reservations': [
    ret('committed-replay-conflict', [{ x: 3 }, [{ type: 'reserve', id: 'r', sku: 'x', quantity: 2 }, { type: 'commit', id: 'r' }, { type: 'reserve', id: 'r', sku: 'x', quantity: 2 }, { type: 'reserve', id: 'r', sku: 'x', quantity: 1 }]], { available: { x: 1 }, reservations: [{ id: 'r', sku: 'x', quantity: 2, status: 'committed' }], results: ['ok', 'ok', 'duplicate', 'conflict'] }),
    ret('failed-id-reuse', [{ x: 3 }, [{ type: 'reserve', id: 'r', sku: 'missing', quantity: 1 }, { type: 'reserve', id: 'r', sku: 'x', quantity: 0 }, { type: 'reserve', id: 'r', sku: 'x', quantity: 1 }]], { available: { x: 2 }, reservations: [{ id: 'r', sku: 'x', quantity: 1, status: 'held' }], results: ['unknown_sku', 'invalid_quantity', 'ok'] }),
    ret('empty-events', [{}, []], { available: {}, reservations: [], results: [] }),
    ret('empty-id-sku', [{ '': 1 }, [{ type: 'reserve', id: '', sku: '', quantity: 1 }]], { available: { '': 0 }, reservations: [{ id: '', sku: '', quantity: 1, status: 'held' }], results: ['ok'] }),
    ret('own-proto-sku', [JSON.parse('{"__proto__":1}'), [{ type: 'reserve', id: 'r', sku: '__proto__', quantity: 1 }]], { available: JSON.parse('{"__proto__":0}'), reservations: [{ id: 'r', sku: '__proto__', quantity: 1, status: 'held' }], results: ['ok'] }),
  ],
};

export function improveAdapter(id, files) {
  const result = structuredClone(files);
  if (id === 'collect-pages') result['src/run.cjs'] = result['src/run.cjs'].replace('await collectPages(fetchPage, spec.startCursor === undefined ? null : spec.startCursor)', 'await (spec.omitStart ? collectPages(fetchPage) : collectPages(fetchPage, spec.startCursor === undefined ? null : spec.startCursor))');
  if (id === 'retry-operation') result['src/run.cjs'] = result['src/run.cjs'].replace('let calls = 0;', 'let calls = 0; let zeroArgs = true;').replace('async () => {', 'async (...args) => {\n    zeroArgs &&= args.length === 0;').replace('spec.maxAttempts), calls };', 'spec.maxAttempts), calls, ...(spec.observeArgs ? {zeroArgs} : {}) };');
  if (id === 'map-with-concurrency') result['src/run.cjs'] = result['src/run.cjs'].replace('let calls = 0;', 'let calls = 0; const inputIndexes = [];').replace('calls++;', 'calls++; inputIndexes.push(spec.jobs.indexOf(job));').replace('worker), peak, calls };', 'worker), peak, calls, ...(spec.observeInputs ? {inputIndexes: inputIndexes.sort((a,b) => a-b)} : {}) };');
  return result;
}
