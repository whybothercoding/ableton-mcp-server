import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain .mjs script without type declarations
import { INCLUDE_CLASSES, INCLUDE_ENUMS, buildRegistry, diffDumps, findClass, findEnum, flattenDump, stable } from '../../scripts/registry-lib.mjs';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const registryFile = path.join(root, 'remote-script', 'AbletonMCP', 'registry_data.json');
const dumpDir = path.join(root, 'docs', 'live-api');
const newestDump = () => JSON.parse(fs.readFileSync(path.join(dumpDir, fs.readdirSync(dumpDir).filter((f) => f.endsWith('.json')).sort().at(-1)!), 'utf8'));

test('the committed registry is exactly what the newest API dump produces', () => {
  assert.equal(fs.readFileSync(registryFile, 'utf8'), stable(buildRegistry(newestDump())));
});

test('every class and enum the property engine relies on is in the dump and the registry', () => {
  const dump = newestDump();
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  for (const name of INCLUDE_CLASSES) {
    assert.ok(findClass(dump, name), `${name} missing from the dump`);
    assert.ok(Object.keys(registry.classes[name].properties).length > 5, name);
  }
  for (const name of INCLUDE_ENUMS) {
    assert.ok(findEnum(dump, name), `${name} missing from the dump`);
    assert.ok(Object.keys(registry.enums[name]).length > 1, name);
  }
});

test('buildRegistry fails loudly when a needed class or enum disappears from the dump', () => {
  const dump = structuredClone(newestDump());
  delete dump.modules.Clip.classes.Clip;
  assert.throws(() => buildRegistry(dump), /Live\.Clip\.Clip is missing/);
  const other = structuredClone(newestDump());
  delete other.modules.Song.enums.Quantization;
  assert.throws(() => buildRegistry(other), /Live\.Song\.Quantization is missing/);
});

test('findEnum reads both module-level enums and enums nested in a class', () => {
  const dump = newestDump();
  assert.ok(findEnum(dump, 'Live.Clip.LaunchMode'));
  assert.ok(findEnum(dump, 'Live.Track.Track.monitoring_states'));
  assert.equal(findEnum(dump, 'Live.Clip.NoSuchEnum'), null);
});

test('diffDumps reports added, removed and changed entries, and nothing for identical dumps', () => {
  const base = newestDump();
  assert.equal(diffDumps(base, structuredClone(base)).same, true);

  const moved = structuredClone(base);
  const clip = moved.modules.Clip.classes.Clip;
  delete clip.properties.muted;
  clip.properties.brand_new = { get: 'int', set: null, doc: '' };
  clip.properties.looping = { ...clip.properties.looping, set: 'str' };
  const diff = diffDumps(base, moved);
  assert.equal(diff.same, false);
  assert.deepEqual(diff.added, ['Live.Clip.Clip.brand_new']);
  assert.deepEqual(diff.removed, ['Live.Clip.Clip.muted']);
  assert.equal(diff.changed.length, 1);
  assert.match(diff.changed[0], /^Live\.Clip\.Clip\.looping: property get=\w+ set=\w+ {2}-> {2}property get=\w+ set=str$/);
});

test('flattenDump ignores docs, so a reworded docstring is not drift', () => {
  const base = newestDump();
  const reworded = structuredClone(base);
  reworded.modules.Clip.classes.Clip.properties.muted.doc = 'something else entirely';
  assert.equal(diffDumps(base, reworded).same, true);
  assert.ok(flattenDump(base).size > 1000);
});

test('the order Live lists enum members in is not drift, but a changed value is', () => {
  const base = newestDump();
  const reordered = structuredClone(base);
  const table = reordered.modules.Song.enums.Quantization;
  reordered.modules.Song.enums.Quantization = Object.fromEntries(Object.entries(table).reverse());
  assert.equal(diffDumps(base, reordered).same, true);
  reordered.modules.Song.enums.Quantization.q_bar = 99;
  assert.deepEqual(diffDumps(base, reordered).changed.map((c: string) => c.split(':')[0]), ['Live.Song.Quantization']);
});
