// Turns an API dump (docs/live-api/<version>.json) into the compact registry the Remote Script ships, and diffs dumps.

/** Classes whose properties the property engine knows about (qualified names as Live.<Module>.<Class>[.<Nested>]). */
export const INCLUDE_CLASSES = ['Live.Song.Song', 'Live.Track.Track', 'Live.Scene.Scene', 'Live.ClipSlot.ClipSlot', 'Live.Clip.Clip', 'Live.Groove.Groove', 'Live.Clip.MidiNote'];

/** Enum types referenced by property overlays (an int property has no enum type of its own). */
export const INCLUDE_ENUMS = [
  'Live.Song.Quantization', 'Live.Song.RecordingQuantization', 'Live.Clip.LaunchMode', 'Live.Clip.ClipLaunchQuantization',
  'Live.Clip.WarpMode', 'Live.Groove.Base', 'Live.Track.Track.monitoring_states'
];

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  return value;
}
export const stable = (value) => JSON.stringify(sortKeys(value), null, 1) + '\n';

/** Finds a class record by qualified name, walking nested classes. */
export function findClass(dump, qualname) {
  const [, module, cls, ...nested] = qualname.split('.');
  let record = dump.modules?.[module]?.classes?.[cls];
  for (const n of nested) record = record?.nested?.[n];
  return record ?? null;
}

/** Finds an enum table by qualified name: a module-level enum, or an enum nested in a class. */
export function findEnum(dump, qualname) {
  const parts = qualname.split('.');
  const [, module, first, ...rest] = parts;
  if (rest.length === 0) return dump.modules?.[module]?.enums?.[first] ?? null;
  let record = dump.modules?.[module]?.classes?.[first];
  for (const n of rest.slice(0, -1)) record = record?.nested?.[n];
  return record?.enums?.[rest.at(-1)] ?? null;
}

export function buildRegistry(dump) {
  const classes = {};
  for (const name of INCLUDE_CLASSES) {
    const record = findClass(dump, name);
    if (!record) throw new Error(`class ${name} is missing from the dump`);
    classes[name] = { properties: Object.fromEntries(Object.entries(record.properties).map(([p, r]) => [p, { get: r.get, set: r.set }])) };
  }
  const enums = {};
  for (const name of INCLUDE_ENUMS) {
    const table = findEnum(dump, name);
    if (!table) throw new Error(`enum ${name} is missing from the dump`);
    enums[name] = table;
  }
  return { live_version: dump.live_version, classes, enums };
}

/** Enum tables compare by content: the order Live lists members in is not part of the API. */
const enumText = (table) => `enum ${JSON.stringify(sortKeys(table))}`;

/** Flattens a dump to comparable "path -> value" entries. */
export function flattenDump(dump) {
  const out = new Map();
  const visitClass = (prefix, record) => {
    for (const [p, r] of Object.entries(record.properties ?? {})) out.set(`${prefix}.${p}`, `property get=${r.get} set=${r.set}`);
    for (const [m, r] of Object.entries(record.methods ?? {})) out.set(`${prefix}.${m}()`, r.constant !== undefined ? `constant ${r.constant}` : `method ${(r.signatures ?? []).join(' | ')}`);
    for (const [e, table] of Object.entries(record.enums ?? {})) out.set(`${prefix}.${e}`, enumText(table));
    for (const l of record.listeners ?? []) out.set(`${prefix}.<listener ${l}>`, 'listener');
    for (const [n, sub] of Object.entries(record.nested ?? {})) visitClass(`${prefix}.${n}`, sub);
  };
  for (const [module, m] of Object.entries(dump.modules ?? {})) {
    for (const [c, record] of Object.entries(m.classes)) visitClass(`Live.${module}.${c}`, record);
    for (const [e, table] of Object.entries(m.enums)) out.set(`Live.${module}.${e}`, enumText(table));
    for (const [f, r] of Object.entries(m.functions)) out.set(`Live.${module}.${f}()`, `function ${(r.signatures ?? []).join(' | ')}`);
  }
  return out;
}

export function diffDumps(committed, current) {
  const a = flattenDump(committed);
  const b = flattenDump(current);
  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const changed = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k)).map((k) => `${k}: ${a.get(k)}  ->  ${b.get(k)}`);
  return { added, removed, changed, same: !added.length && !removed.length && !changed.length };
}
