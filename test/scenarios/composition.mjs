// Scenario (MCP tools only): compose on a scratch track, transform the result, undo, and leave the Set exactly as it was.
//
//   npm run build && node test/scenarios/composition.mjs      (needs a running Live with the bridge deployed)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const client = new Client({ name: 'composition-scenario', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: 'node', args: [path.join(root, 'dist', 'index.js')], stderr: 'ignore' }));

let passed = 0;
const failures = [];
async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
async function tool(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* plain-text error */
  }
  return { isError: Boolean(result.isError), data, text };
}
async function ok(name, args) {
  const r = await tool(name, args);
  assert(!r.isError, `${name} failed: ${r.text}`);
  return r.data;
}
async function fails(name, args, fragment) {
  const r = await tool(name, args);
  assert(r.isError && r.text.includes(fragment), `${name}: expected an error containing "${fragment}", got ${r.isError ? r.text : 'success'}`);
}

const before = await ok('describe_set');
const trackName = 'MCP SCENARIO';
let trackAddress = null;
try {
  const track = await ok('create', { kind: 'midi_track', name: trackName });
  trackAddress = track.address;
  const chordClip = (await ok('create', { kind: 'midi_clip', address: `${trackAddress}/slots/0`, length: 8, name: 'chords' })).address;
  const bassClip = (await ok('create', { kind: 'midi_clip', address: `${trackAddress}/slots/1`, length: 8, name: 'bass' })).address;
  const drumClip = (await ok('create', { kind: 'midi_clip', address: `${trackAddress}/slots/2`, length: 4, name: 'drums' })).address;
  const notesOf = async (address, params = {}) => (await ok('get_notes', { address, ...params })).notes;
  const A_MINOR = new Set([9, 11, 0, 2, 4, 5, 7]);

  console.log('Compose');
  await step('a dry run shows the music without touching the clip', async () => {
    const dry = await ok('generate_notes', { address: chordClip, generator: 'chord_progression', params: { key: 'A minor', numerals: ['i', 'VI'], beats_per_chord: 4 }, dry_run: true });
    assert(dry.dry_run === true && dry.notes === 6 && dry.preview.length === 6, JSON.stringify(dry).slice(0, 200));
    assert((await notesOf(chordClip)).length === 0, 'a dry run wrote notes');
  });
  await step('chord_progression writes two triads in the key with voice leading, one undo step', async () => {
    const result = await ok('generate_notes', { address: chordClip, generator: 'chord_progression', params: { key: 'A minor', numerals: ['i', 'VI'], beats_per_chord: 4 } });
    assert(result.written === 6 && result.note_count === 6 && result.warning === undefined, JSON.stringify(result).slice(0, 200));
    const notes = await notesOf(chordClip);
    assert(notes.every((n) => A_MINOR.has(n.pitch % 12)), 'a chord tone is outside A minor');
    assert(notes.filter((n) => n.start_time === 0).map((n) => n.pitch % 12).sort((a, b) => a - b).join() === '0,4,9', 'the first chord should be A minor (A, C, E)');
    assert(notes.filter((n) => n.start_time === 4).map((n) => n.pitch % 12).sort((a, b) => a - b).join() === '0,5,9', 'the second chord should be F major (F, A, C)');
  });
  await step('the bassline follows the chords and the drum pattern lands on the grid', async () => {
    await ok('generate_notes', { address: bassClip, generator: 'bassline', params: { key: 'A minor', numerals: ['i', 'VI'], beats_per_chord: 4, style: 'root_fifth' } });
    const bass = await notesOf(bassClip);
    assert(bass.length === 16 && bass.filter((n) => n.start_time < 4).every((n) => [9, 4].includes(n.pitch % 12)), 'the bass should alternate A and E over the A minor chord');
    await ok('generate_notes', { address: drumClip, generator: 'drum_pattern', params: { rows: { kick: 'x...x...x...x...', snare: '....x.......x...', hat_closed: 'x.x.x.x.x.x.x.x.' } } });
    const drums = await notesOf(drumClip);
    assert(drums.filter((n) => n.pitch === 36).length === 4 && drums.filter((n) => n.pitch === 38).length === 2 && drums.filter((n) => n.pitch === 42).length === 8, 'drum hit counts');
  });
  await step('a generator that runs past the clip warns instead of silently truncating', async () => {
    const dry = await ok('generate_notes', { address: drumClip, generator: 'chord_progression', params: { chords: ['C', 'G'] }, dry_run: true });
    assert(/notes after that will not play/.test(dry.warning), JSON.stringify(dry).slice(0, 200));
  });

  console.log('\nTransform');
  await step('humanize keeps every note id and only changes timing and velocity', async () => {
    const before = Object.fromEntries((await notesOf(chordClip)).map((n) => [n.id, n]));
    const result = await ok('transform_notes', { address: chordClip, transform: 'humanize', params: { timing: 0.03, velocity: 10, seed: 7 } });
    assert(result.kind === 'modify' && result.changed === 6, JSON.stringify(result).slice(0, 200));
    const after = await notesOf(chordClip);
    assert(after.length === 6 && after.every((n) => before[n.id] && n.pitch === before[n.id].pitch), 'ids and pitches must survive');
    assert(after.some((n) => Math.abs(n.start_time - before[n.id].start_time) > 1e-6), 'no timing changed');
    assert(after.every((n) => Math.abs(n.start_time - before[n.id].start_time) <= 0.03 + 1e-6 || before[n.id].start_time < 0.03), 'timing moved further than asked');
    assert(after.every((n) => Math.abs(n.velocity - before[n.id].velocity) <= 10 + 1), 'velocity moved further than asked');
  });
  await step('quantize pulls the humanized notes back onto the grid', async () => {
    await ok('transform_notes', { address: chordClip, transform: 'quantize', params: { grid: '1/16' } });
    const starts = (await notesOf(chordClip)).map((n) => n.start_time);
    assert(starts.every((t) => Math.abs(t * 4 - Math.round(t * 4)) < 1e-4), `not on the sixteenth grid: ${starts}`);
  });
  await step('arpeggiate rebuilds the chords as runs, and a single undo brings the chords back', async () => {
    const chords = await notesOf(chordClip);
    const result = await ok('transform_notes', { address: chordClip, transform: 'arpeggiate', params: { style: 'updown', rate: '1/8', gate: 0.9 } });
    assert(result.kind === 'rebuild' && result.input_notes === 6 && result.output_notes >= 12, JSON.stringify(result).slice(0, 200));
    const arp = await notesOf(chordClip);
    assert(new Set(arp.map((n) => n.start_time)).size === arp.length, 'an arpeggio plays one note at a time');
    assert(arp.every((n) => A_MINOR.has(n.pitch % 12)), 'the arpeggio left the key');
    await ok('history', { action: 'undo' });
    const back = await notesOf(chordClip);
    assert(back.length === chords.length && back.every((n, i) => n.pitch === chords[i].pitch), 'one undo should restore the chords');
  });
  await step('transpose by scale degrees stays in the key; fit_to_scale repairs a chromatic transposition', async () => {
    await ok('transform_notes', { address: chordClip, transform: 'transpose', params: { degrees: 2, key: 'A minor' } });
    assert((await notesOf(chordClip)).every((n) => A_MINOR.has(n.pitch % 12)), 'a degree transposition left the key');
    await ok('transform_notes', { address: chordClip, transform: 'transpose', params: { semitones: 1 } });
    assert((await notesOf(chordClip)).some((n) => !A_MINOR.has(n.pitch % 12)), 'a semitone move should leave the key');
    const fixed = await ok('transform_notes', { address: chordClip, transform: 'fit_to_scale', params: { key: 'A minor' } });
    assert(fixed.changed > 0 && (await notesOf(chordClip)).every((n) => A_MINOR.has(n.pitch % 12)), 'fit_to_scale did not put every note back in the key');
  });
  await step('stack adds thirds without touching the melody, and a bad request changes nothing', async () => {
    const count = (await notesOf(bassClip)).length;
    const added = await ok('transform_notes', { address: bassClip, transform: 'stack', params: { degrees: [2], key: 'A minor' }, from_time: 0, time_span: 4 });
    assert(added.kind === 'add' && (await notesOf(bassClip)).length > count, JSON.stringify(added).slice(0, 200));
    const snapshot = JSON.stringify(await notesOf(bassClip));
    await fails('transform_notes', { address: bassClip, transform: 'transpose', params: { semitones: 100 } }, 'outside the MIDI range');
    await fails('transform_notes', { address: bassClip, transform: 'arpeggiate', params: { style: 'sideways' } }, 'style must be one of');
    await fails('transform_notes', { address: bassClip, transform: 'transpose', params: { semitones: 1 }, from_time: 500 }, 'no notes in that selection');
    assert(JSON.stringify(await notesOf(bassClip)) === snapshot, 'a rejected transform changed the clip');
  });
  await step('generate_notes in replace_all mode swaps the whole clip in one step and undo restores it', async () => {
    const before = JSON.stringify(await notesOf(drumClip));
    await ok('generate_notes', { address: drumClip, generator: 'euclidean', mode: 'replace_all', params: { layers: [{ pitch: 36, pulses: 4, steps: 16 }, { pitch: 42, pulses: 7, steps: 16 }] } });
    const notes = await notesOf(drumClip);
    assert(notes.filter((n) => n.pitch === 36).length === 4 && notes.filter((n) => n.pitch === 42).length === 7 && !notes.some((n) => n.pitch === 38), 'euclidean layers');
    await ok('history', { action: 'undo' });
    assert(JSON.stringify(await notesOf(drumClip)) === before, 'undo should bring the drum pattern back');
  });
  await step('a melody is repeatable: the same seed gives the same notes', async () => {
    const params = { key: 'A minor', length: 8, seed: 21 };
    const a = await ok('generate_notes', { address: chordClip, generator: 'melody', params, dry_run: true });
    const b = await ok('generate_notes', { address: chordClip, generator: 'melody', params, dry_run: true });
    assert(JSON.stringify(a.preview) === JSON.stringify(b.preview) && a.notes > 4, 'the same seed must give the same melody');
    const c = await ok('generate_notes', { address: chordClip, generator: 'melody', params: { ...params, seed: 22 }, dry_run: true });
    assert(JSON.stringify(a.preview) !== JSON.stringify(c.preview), 'a different seed should give a different melody');
  });
} finally {
  if (trackAddress) {
    const name = (await tool('get_properties', { address: trackAddress, names: ['name'] })).data?.properties?.name;
    if (name === trackName) await tool('delete', { address: trackAddress, expect: { name: trackName } });
  }
  const after = await ok('describe_set');
  await step('the Set is exactly as it was before the scenario (fingerprint invariant)', async () => {
    assert(after.fingerprint === before.fingerprint, `fingerprint ${before.fingerprint} -> ${after.fingerprint}`);
  });
  await client.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
