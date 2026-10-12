/**
 * Fixed runner inside the OS sandbox. Expectations remain on the Host. The
 * protocol is evidence, not an OS boundary or protection against arbitrary
 * same-process debugger attacks; the OS backend provides Host isolation.
 */
export const SANDBOX_TEST_RUNNER_VERSION = "function-json-v2";
export const SANDBOX_TEST_PROTOCOL_PREFIX = "MINICAH_SANDBOX_TEST ";
export const SANDBOX_TEST_BOOTSTRAP = String.raw`
const {readFileSync, writeSync} = require('node:fs');
const {pathToFileURL} = require('node:url');
const {resolve} = require('node:path');
const parse = JSON.parse, stringify = JSON.stringify, finite = Number.isFinite;
const descriptors = Object.getOwnPropertyDescriptors, descriptorOf = Object.getOwnPropertyDescriptor, keys = Reflect.ownKeys;
const prototype = Object.getPrototypeOf, plain = Object.prototype;
const array = Array.isArray, apply = Reflect.apply, hasOwn = Object.hasOwn;
const SetType = Set, setHas = Set.prototype.has, setAdd = Set.prototype.add, setDelete = Set.prototype.delete;
const input = parse(readFileSync(0, 'utf8'));
const nonce = input.nonce, caseId = input.caseId;
const prefix = 'MINICAH_SANDBOX_TEST ';
const identity = '"nonce":' + stringify(nonce) + ',"caseId":' + stringify(caseId);
const emit = fields => writeSync(1, '\n' + prefix + '{' + identity + ',' + fields + '}\n');
const moduleUrl = pathToFileURL(resolve(process.cwd(), input.module)).href;
const commonjs = input.module.endsWith('.cjs');
// A serializer captured before candidate import rejects coercion, accessors,
// sparse arrays, nonfinite numbers, undefined, cycles and nonplain objects.
function encode(value, depth = 0, seen = new SetType(), count = {value:0}) {
  if (depth > 64 || ++count.value > 10000) throw 0;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return stringify(value);
  if (typeof value === 'number') { if (!finite(value)) throw 0; return stringify(value); }
  if (typeof value !== 'object' || apply(setHas, seen, [value])) throw 0;
  const isArray = array(value);
  if (!isArray && prototype(value) !== plain && prototype(value) !== null) throw 0;
  apply(setAdd, seen, [value]);
  const props = descriptors(value), ownKeys = keys(value);
  for (let index = 0; index < ownKeys.length; index++) if (typeof ownKeys[index] !== 'string') throw 0;
  let result = isArray ? '[' : '{', index = 0;
  if (isArray) {
    const length = props.length.value;
    for (; index < length; index++) {
      if (!hasOwn(props, index)) throw 0;
      const item = props[index];
      if (!hasOwn(item, 'value')) throw 0;
      result += (index ? ',' : '') + encode(item.value, depth + 1, seen, count);
    }
  } else for (let at = 0; at < ownKeys.length; at++) {
    const key = ownKeys[at], item = props[key];
    if (!item.enumerable) continue;
    if (!hasOwn(item, 'value')) throw 0;
    result += (index++ ? ',' : '') + stringify(key) + ':' + encode(item.value, depth + 1, seen, count);
  }
  apply(setDelete, seen, [value]);
  return result + (isArray ? ']' : '}');
}
emit('"type":"ready"');
(async () => {
  let module;
  try { module = await import(moduleUrl); }
  catch { emit('"type":"result","kind":"import-error"'); return; }
  let descriptor = descriptorOf(module, input.export);
  // Synthetic named exports miss valid module.exports assignments. Only CJS
  // gets this fallback; accessors and inherited properties are not executed.
  if (commonjs && (!descriptor || !hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function')) {
    const exported = descriptorOf(module, 'default')?.value;
    if (exported !== null && (typeof exported === 'object' || typeof exported === 'function')) descriptor = descriptorOf(exported, input.export);
  }
  if (!descriptor || !hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') { emit('"type":"result","kind":"missing-export"'); return; }
  let result;
  try { result = await apply(descriptor.value, undefined, input.args); }
  catch (error) {
    let name = '';
    try { if (error && typeof error.name === 'string' && error.name.length <= 128) name = error.name; } catch {}
    emit('"type":"result","kind":"throw","name":' + stringify(name)); return;
  }
  let encoded;
  try { encoded = encode(result); }
  catch { emit('"type":"result","kind":"invalid-return"'); return; }
  emit('"type":"result","kind":"return","value":' + encoded);
})().catch(() => { emit('"type":"result","kind":"runner-error"'); });
`;
