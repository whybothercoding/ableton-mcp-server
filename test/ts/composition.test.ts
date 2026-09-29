import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateNotes, transformNotes } from '../../src/tools/composition.js';
import { ToolHandler } from '../../src/tools/handlers.js';
import { TOOL_SPEC_BY_NAME, validateArgs } from '../../src/tools/spec.js';
import { Note } from '../../src/music/types.js';

/** An in-memory stand-in for the bridge's note commands (enough of get_notes / write_notes / edit_notes). */
class FakeBridge {
  notes: Note[];
  calls: { type: string; params: Record<string, any> }[] = [];
  private nextId = 100;
  constructor(notes: Note[] = [], public loopEnd = 4) {
    this.notes = notes.map((n, i) => ({ id: i + 1, ...n }));
  }
  private clip() {
    return { length: this.loopEnd, loop_start: 0, loop_end: this.loopEnd };
  }
  private inRange(n: Note, p: Record<string, any>): boolean {
    const from = p.from_time ?? -1e5;
    const span = p.time_span ?? 2e5;
    const lo = p.from_pitch ?? 0;
    const pspan = p.pitch_span ?? 128;
    return n.start_time >= from && n.start_time < from + span && n.pitch >= lo && n.pitch < lo + pspan;
  }
  async sendCommand(type: string, params: Record<string, any> = {}): Promise<any> {
    this.calls.push({ type, params });
    if (type === 'get_notes') {
      const picked = params.ids ? this.notes.filter((n) => params.ids.includes(n.id)) : this.notes.filter((n) => this.inRange(n, params));
      const limit = params.limit ?? 2000;
      return { address: params.address, count: picked.length, truncated: picked.length > limit, notes: picked.slice(0, limit).map((n) => ({ ...n })), clip: this.clip() };
    }
    if (type === 'write_notes') {
      const ids = params.notes.map((n: Note) => {
        const id = this.nextId++;
        this.notes.push({ ...n, id });
        return id;
      });
      return { written: ids.length, ids, note_count: this.notes.length, clip: this.clip() };
    }
    if (type === 'edit_notes' && params.action === 'modify') {
      for (const change of params.changes) Object.assign(this.notes.find((n) => n.id === change.id) as Note, change);
      return { modified: params.changes.length, note_count: this.notes.length, clip: this.clip() };
    }
    if (type === 'edit_notes' && params.action === 'replace') {
      const doomed = this.notes.filter((n) => this.inRange(n, params));
      this.notes = this.notes.filter((n) => !doomed.includes(n));
      const ids = params.notes.map((n: Note) => {
        const id = this.nextId++;
        this.notes.push({ ...n, id });
        return id;
      });
      return { removed: doomed.length, written: ids.length, ids, note_count: this.notes.length, clip: this.clip() };
    }
    throw new Error(`unexpected bridge call ${type}`);
  }
  writes() {
    return this.calls.filter((c) => c.type !== 'get_notes');
  }
}

const n = (pitch: number, start: number, duration = 1, velocity = 100): Note => ({ pitch, start_time: start, duration, velocity });
const ADDR = 'tracks/0/slots/0/clip';

test('an in-place transform sends one modify with only the fields that changed', async () => {
  const bridge = new FakeBridge([n(60, 0), n(64, 1)]);
  const result: any = await transformNotes({ address: ADDR, transform: 'transpose', params: { semitones: 2 } }, bridge);
  assert.equal(bridge.writes().length, 1);
  assert.deepEqual(bridge.writes()[0].params, { address: ADDR, action: 'modify', changes: [{ id: 1, pitch: 62 }, { id: 2, pitch: 66 }] });
  assert.deepEqual(bridge.notes.map((x) => x.pitch), [62, 66]);
  assert.equal(result.changed, 2);
  assert.equal(result.kind, 'modify');
  assert.equal(result.note_count, 2);
  assert.equal(result.preview[0].note, 'D3');
});

test('a transform that changes nothing writes nothing', async () => {
  const bridge = new FakeBridge([n(60, 0)]);
  const result: any = await transformNotes({ address: ADDR, transform: 'fit_to_scale', params: { key: 'C major' } }, bridge);
  assert.equal(bridge.writes().length, 0);
  assert.equal(result.changed, 0);
});

test('dry_run previews without writing, for every kind', async () => {
  for (const [transform, params] of [['transpose', { semitones: 1 }], ['arpeggiate', {}], ['stack', { intervals: [4] }]] as const) {
    const bridge = new FakeBridge([n(60, 0), n(64, 0)]);
    const result: any = await transformNotes({ address: ADDR, transform, params, dry_run: true }, bridge);
    assert.equal(bridge.writes().length, 0, transform);
    assert.equal(result.dry_run, true);
    assert.ok(result.preview.length > 0);
  }
});

test('ids are passed on for in-place transforms and refused for rebuilds', async () => {
  const bridge = new FakeBridge([n(60, 0), n(64, 1), n(67, 2)]);
  await transformNotes({ address: ADDR, transform: 'transpose', params: { semitones: 12 }, ids: [2] }, bridge);
  assert.deepEqual(bridge.calls[0].params.ids, [2]);
  assert.deepEqual(bridge.notes.map((x) => x.pitch), [60, 76, 67]);
  await assert.rejects(transformNotes({ address: ADDR, transform: 'arpeggiate', ids: [1] }, bridge), /builds new notes.*range or the whole clip, not on ids/);
  await assert.rejects(transformNotes({ address: ADDR, transform: 'transpose', params: { semitones: 1 }, ids: [1], from_time: 0 }, bridge), /ids or with a range \(from_time\/time_span\/from_pitch\/pitch_span\), not both/);
});

test('a rebuild replaces the selected range atomically and sends notes without ids', async () => {
  const bridge = new FakeBridge([n(60, 0), n(64, 0), n(67, 0), n(72, 8)]);
  const result: any = await transformNotes({ address: ADDR, transform: 'arpeggiate', params: { rate: '1/4', gate: 1 }, from_time: 0, time_span: 4 }, bridge);
  const write = bridge.writes()[0];
  assert.equal(write.type, 'edit_notes');
  assert.equal(write.params.action, 'replace');
  assert.deepEqual([write.params.from_time, write.params.time_span], [0, 4]);
  assert.ok(write.params.notes.every((x: any) => !('id' in x)));
  assert.equal(result.replaced, 3);
  assert.ok(bridge.notes.some((x) => x.pitch === 72), 'the note outside the range stays');
  assert.equal(result.written, 1);   // one chord of one beat at a quarter-note rate
});

test('an additive transform uses write_notes and keeps the originals', async () => {
  const bridge = new FakeBridge([n(60, 0)]);
  const result: any = await transformNotes({ address: ADDR, transform: 'stack', params: { chord: 'maj' } }, bridge);
  assert.equal(bridge.writes()[0].type, 'write_notes');
  assert.deepEqual(bridge.notes.map((x) => x.pitch).sort(), [60, 64, 67]);
  assert.equal(result.added, 2);
});

test('transform errors are readable and leave the clip untouched', async () => {
  const bridge = new FakeBridge([n(120, 0), n(60, 1)]);
  await assert.rejects(transformNotes({ address: ADDR, transform: 'wobble' }, bridge), /Unknown transform 'wobble'. Transforms: transpose, /);
  await assert.rejects(transformNotes({ address: ADDR, transform: 'transpose', params: { semitones: 12 } }, bridge), /would move 1 note\(s\) outside the MIDI range.*nothing was changed/);
  await assert.rejects(transformNotes({ address: ADDR, transform: 'transpose', params: { semitones: 'up' } }, bridge), /transpose: semitones must be a whole number/);
  await assert.rejects(transformNotes({ address: ADDR, transform: 'transpose', params: { semitones: 1, colour: 1 } }, bridge), /unknown parameter colour/);
  await assert.rejects(transformNotes({ address: ADDR, transform: 'transpose', params: { semitones: 1 }, from_time: 50 }, bridge), /no notes in that selection/);
  await assert.rejects(transformNotes({ address: ADDR, transform: 'shift', params: { beats: -5 } }, new FakeBridge([n(60, 1)])), /before the start of the clip/);
  assert.equal(bridge.writes().length, 0);
});

test('a selection larger than one call can carry is refused instead of truncated', async () => {
  const bridge = new FakeBridge(Array.from({ length: 5001 }, (_, i) => n(60, i * 0.01)));
  await assert.rejects(transformNotes({ address: ADDR, transform: 'transpose', params: { semitones: 1 } }, bridge), /more than 5000 notes: narrow it/);
});

test('expect is forwarded to the write', async () => {
  const bridge = new FakeBridge([n(60, 0)]);
  await transformNotes({ address: ADDR, transform: 'transpose', params: { semitones: 1 }, expect: { name: 'Riff' } }, bridge);
  assert.deepEqual(bridge.writes()[0].params.expect, { name: 'Riff' });
});

test('generate_notes adds by default, offsets the music, and previews', async () => {
  const bridge = new FakeBridge([n(36, 0)], 8);
  const result: any = await generateNotes({ address: ADDR, generator: 'euclidean', params: { pulses: 3, steps: 8, rate: '1/8' }, start_time: 2 }, bridge);
  assert.equal(bridge.writes()[0].type, 'write_notes');
  assert.deepEqual(bridge.writes()[0].params.notes.map((x: any) => x.start_time), [2, 3.5, 5]);
  assert.equal(result.notes, 3);
  assert.equal(result.length, 4);
  assert.equal(result.note_count, 4);
  assert.equal(result.warning, undefined);
  assert.equal(result.preview[0].note, 'C1');
});

test('generate_notes replace modes send the right range', async () => {
  const bridge = new FakeBridge([n(60, 0), n(60, 3), n(60, 6)], 8);
  await generateNotes({ address: ADDR, generator: 'euclidean', params: { pulses: 1, steps: 4, rate: '1/4' }, mode: 'replace_span', start_time: 2 }, bridge);
  assert.deepEqual([bridge.writes()[0].params.from_time, bridge.writes()[0].params.time_span], [2, 4]);
  assert.deepEqual(bridge.notes.map((x) => x.start_time).sort((a, b) => a - b), [0, 2, 6]);      // the note at 3 was inside the span, 6 was outside
  const all = new FakeBridge([n(60, 0), n(60, 3)], 8);
  await generateNotes({ address: ADDR, generator: 'euclidean', params: { pulses: 1 }, mode: 'replace_all' }, all);
  assert.equal('from_time' in all.writes()[0].params, false);
  assert.equal(all.notes.length, 1);
});

test('generate_notes warns when the music runs past the clip loop, also in a dry run', async () => {
  const bridge = new FakeBridge([], 4);
  const dry: any = await generateNotes({ address: ADDR, generator: 'chord_progression', params: { chords: ['C', 'G'] }, dry_run: true }, bridge);
  assert.match(dry.warning, /runs to beat 7\.6 but the clip loops at 4/);
  assert.equal(bridge.writes().length, 0);
  const real: any = await generateNotes({ address: ADDR, generator: 'chord_progression', params: { chords: ['C', 'G'] } }, bridge);
  assert.match(real.warning, /loop_end and end_marker/);
  assert.equal(bridge.notes.length, 6);
});

test('generate_notes errors are readable', async () => {
  const bridge = new FakeBridge([]);
  await assert.rejects(generateNotes({ address: ADDR, generator: 'jazz' }, bridge), /Unknown generator 'jazz'. Generators: euclidean, /);
  await assert.rejects(generateNotes({ address: ADDR, generator: 'euclidean', mode: 'merge', params: { pulses: 3 } }, bridge), /mode must be one of/);
  await assert.rejects(generateNotes({ address: ADDR, generator: 'euclidean', start_time: -1, params: { pulses: 3 } }, bridge), /start_time/);
  await assert.rejects(generateNotes({ address: ADDR, generator: 'euclidean', params: {} }, bridge), /pulses must be given/);
  await assert.rejects(generateNotes({ address: ADDR, generator: 'euclidean', params: { pulses: 0 } }, bridge), /produced no notes/);
  assert.equal(bridge.writes().length, 0);
});

test('the tools are declared with schemas, annotations and the bridge commands they need', () => {
  for (const name of ['transform_notes', 'generate_notes']) {
    const spec = TOOL_SPEC_BY_NAME[name];
    assert.ok(spec.run, `${name} runs its own code`);
    assert.ok(spec.requires?.length);
    assert.equal(spec.annotations.destructiveHint, true);
  }
  const transform = TOOL_SPEC_BY_NAME.transform_notes;
  assert.ok(transform.inputSchema.properties.transform.enum.includes('arpeggiate'));
  assert.ok(transform.description.includes('arpeggiate') && transform.description.includes("'help'"));
  assert.deepEqual(transform.inputSchema.required, ['transform']);
  assert.deepEqual(TOOL_SPEC_BY_NAME.generate_notes.inputSchema.required, ['generator']);
  assert.equal(validateArgs(transform.inputSchema, { address: ADDR, transform: 'nope' }), 'transform must be one of: ' + transform.inputSchema.properties.transform.enum.join(', '));
  assert.equal(validateArgs(transform.inputSchema, { transform: 'help' }), null);
  assert.equal(validateArgs(TOOL_SPEC_BY_NAME.generate_notes.inputSchema, { address: ADDR, generator: 'euclidean', mode: 'bogus' }) !== null, true);
});

test('through the tool handler, composition errors are plain messages and success is JSON', async () => {
  const bridge = new FakeBridge([n(60, 0)]);
  const client: any = {
    ensureCapability: () => undefined,
    sendCommand: (type: string, params: Record<string, any>) => bridge.sendCommand(type, params)
  };
  const handler = new ToolHandler(client);
  const ok = await handler.handleToolCall('transform_notes', { address: ADDR, transform: 'transpose', params: { semitones: 7 } });
  assert.equal(ok.isError, undefined);
  assert.equal(JSON.parse((ok.content[0] as any).text).changed, 1);
  const bad = await handler.handleToolCall('transform_notes', { address: ADDR, transform: 'nope' });
  assert.equal(bad.isError, true);
  assert.match((bad.content[0] as any).text, /^Invalid arguments for 'transform_notes': transform must be one of/);
  const failed = await handler.handleToolCall('generate_notes', { address: ADDR, generator: 'euclidean', params: {} });
  assert.equal(failed.isError, true);
  assert.equal((failed.content[0] as any).text, 'euclidean: pulses must be given (a whole number)');
});

test('help lists every transform and generator with its parameters and needs no clip', async () => {
  const bridge = new FakeBridge([]);
  const transforms: any = await transformNotes({ transform: 'help' }, bridge);
  assert.equal(bridge.calls.length, 0);
  assert.ok(Object.keys(transforms.transforms).length >= 19);
  assert.match(transforms.transforms.arpeggiate.usage, /^arpeggiate\(style=up/);
  assert.equal(transforms.transforms.stack.kind, 'add');
  const generators: any = await generateNotes({ generator: 'help' }, bridge);
  assert.ok(Object.keys(generators.generators).length >= 7);
  assert.match(generators.generators.chord_progression, /numerals=/);
  await assert.rejects(transformNotes({ transform: 'transpose', params: { semitones: 1 } }, bridge), /address is required/);
  await assert.rejects(generateNotes({ generator: 'euclidean', params: { pulses: 3 } }, bridge), /address is required/);
});
