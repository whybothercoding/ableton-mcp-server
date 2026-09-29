import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Params } from '../../src/music/params.js';
import { TRANSFORMS, finalize, groupByStart } from '../../src/music/transforms.js';
import { Note } from '../../src/music/types.js';

const n = (pitch: number, start: number, duration = 1, velocity = 100, id?: number): Note => ({ pitch, start_time: start, duration, velocity, ...(id !== undefined ? { id } : {}) });
const run = (name: string, notes: Note[], params: Record<string, any> = {}): Note[] => TRANSFORMS[name].run(notes, new Params(name, params));
const near = (a: number, b: number, tol = 1e-9): void => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const pitches = (notes: Note[]): number[] => notes.map((x) => x.pitch);
const starts = (notes: Note[]): number[] => notes.map((x) => Math.round(x.start_time * 1e6) / 1e6);

test('transpose by semitones or by scale degrees keeps ids and other fields', () => {
  const notes = [n(60, 0, 1, 90, 7), n(64, 1, 0.5, 80, 8)];
  const up = run('transpose', notes, { semitones: 5 });
  assert.deepEqual(pitches(up), [65, 69]);
  assert.deepEqual(up.map((x) => x.id), [7, 8]);
  assert.deepEqual(up.map((x) => x.velocity), [90, 80]);
  assert.deepEqual(pitches(run('transpose', notes, { degrees: 2, key: 'C major' })), [64, 67]);
  assert.deepEqual(pitches(run('transpose', notes, { degrees: -1, key: 'C major' })), [59, 62]);
  assert.throws(() => run('transpose', notes, {}), /exactly one of semitones or degrees/);
  assert.throws(() => run('transpose', notes, { semitones: 1, degrees: 1, key: 'C major' }), /exactly one/);
  assert.throws(() => run('transpose', notes, { degrees: 1 }), /key must be given/);
  assert.throws(() => run('transpose', notes, { semitones: 2.5 }), /whole number/);
  assert.throws(() => run('transpose', notes, { semitones: 1, colour: 'red' }), /unknown parameter colour/);
});

test('finalize drops notes that cannot exist and cleans the rest', () => {
  const result = finalize(run('transpose', [n(120, 0), n(60, 1)], { semitones: 12 }));
  assert.equal(result.dropped, 1);
  assert.deepEqual(pitches(result.notes), [72]);
  const cleaned = finalize([{ pitch: 60.2, start_time: 0.1 + 0.2, duration: 0, velocity: 300, probability: 4, velocity_deviation: -500, release_velocity: 999 }]).notes[0];
  assert.deepEqual([cleaned.pitch, cleaned.start_time, cleaned.velocity, cleaned.probability, cleaned.velocity_deviation, cleaned.release_velocity], [60, 0.3, 127, 1, -127, 127]);
  assert.ok(cleaned.duration > 0);
  assert.equal(finalize([n(60, -1)]).dropped, 1);
  assert.equal(finalize([n(60, -1e-9)]).notes[0].start_time, 0);
});

test('fit_to_scale snaps into the key in the chosen direction', () => {
  const notes = [n(61, 0), n(63, 1), n(66, 2)];
  assert.deepEqual(pitches(run('fit_to_scale', notes, { key: 'C major' })), [62, 64, 67]);
  assert.deepEqual(pitches(run('fit_to_scale', notes, { key: 'C major', direction: 'down' })), [60, 62, 65]);
  assert.deepEqual(pitches(run('fit_to_scale', [n(60, 0)], { key: 'C major' })), [60]);
  assert.throws(() => run('fit_to_scale', notes, {}), /key must be given/);
  assert.throws(() => run('fit_to_scale', notes, { key: 'C major', direction: 'sideways' }), /one of: nearest, up, down/);
});

test('invert mirrors around the middle of the range or a chosen axis', () => {
  const notes = [n(60, 0), n(64, 1), n(67, 2)];
  assert.deepEqual(pitches(run('invert', notes)), [67, 63, 60]);
  assert.deepEqual(pitches(run('invert', notes, { axis: 'C3' })), [60, 56, 53]);
  assert.deepEqual(pitches(run('invert', notes, { axis: 60, key: 'C major' })), [60, 57, 53]);   // 56 is between G and A: ties go up
  assert.throws(() => run('invert', [], {}), /no notes/);
});

test('reverse plays the notes backwards inside their own span', () => {
  const out = run('reverse', [n(60, 0, 1), n(62, 1, 1), n(64, 2, 2)]);
  assert.deepEqual(starts(out), [3, 2, 0]);
  assert.deepEqual(out.map((x) => x.duration), [1, 1, 2]);
  assert.deepEqual(starts(run('reverse', run('reverse', [n(60, 0.5, 0.25), n(62, 3, 1)]))), [0.5, 3]);
});

test('stretch and shift move time', () => {
  const notes = [n(60, 1, 1), n(62, 3, 0.5)];
  const slow = run('stretch', notes, { factor: 2 });
  assert.deepEqual(starts(slow), [1, 5]);
  assert.deepEqual(slow.map((x) => x.duration), [2, 1]);
  assert.deepEqual(starts(run('stretch', notes, { factor: 0.5, anchor: 0 })), [0.5, 1.5]);
  assert.deepEqual(starts(run('shift', notes, { beats: 0.25 })), [1.25, 3.25]);
  assert.equal(finalize(run('shift', notes, { beats: -2 })).dropped, 1);   // 1 - 2 < 0 cannot exist
  assert.throws(() => run('stretch', notes, { factor: 0 }), /between 0.01 and 100/);
});

test('humanize is repeatable, bounded and keeps the input order', () => {
  const notes = Array.from({ length: 16 }, (_, i) => n(60 + (i % 4), i * 0.25, 0.25, 100, i));
  const a = run('humanize', notes, { seed: 5 });
  const b = run('humanize', notes, { seed: 5 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, run('humanize', notes, { seed: 6 }));
  assert.deepEqual(a.map((x) => x.id), notes.map((x) => x.id));
  a.forEach((x, i) => {
    assert.ok(Math.abs(x.start_time - notes[i].start_time) <= 0.02 + 1e-9 || notes[i].start_time < 0.02);
    assert.ok(Math.abs(x.velocity - 100) <= 8 + 1e-9);
    assert.equal(x.duration, 0.25);
  });
  assert.ok(a.some((x, i) => x.start_time !== notes[i].start_time), 'timing should actually change');
  assert.deepEqual(run('humanize', notes, { timing: 0, velocity: 0 }).map((x) => x.velocity), notes.map((x) => x.velocity));
});

test('swing delays the off-beat notes of the grid', () => {
  const notes = [n(60, 0), n(60, 0.5), n(60, 1), n(60, 1.5), n(60, 0.75)];
  const out = run('swing', notes, { amount: 0.5, grid: '1/8' });
  assert.deepEqual(starts(out), [0, 0.75, 1, 1.75, 0.75]);   // 0.75 is between grid points: untouched
  assert.deepEqual(starts(run('swing', notes, { amount: 0 })), starts(notes));
  near(run('swing', [n(60, 0.5)], { amount: 1 / 3 })[0].start_time, 0.5 + 0.5 / 3);
});

test('quantize pulls toward a grid by strength, optionally the ends too', () => {
  const notes = [n(60, 0.1, 0.4), n(62, 0.62, 0.3)];
  assert.deepEqual(starts(run('quantize', notes, { grid: '1/4' })), [0, 1]);
  assert.deepEqual(starts(run('quantize', notes, { grid: '1/8', strength: 1 })), [0, 0.5]);
  near(run('quantize', notes, { grid: '1/8', strength: 0.5 })[0].start_time, 0.05);
  const withEnds = run('quantize', notes, { grid: '1/8', ends: true });
  near(withEnds[0].duration, 0.5);
  near(run('quantize', notes, { grid: '1/8' })[0].duration, 0.4);
});

test('legato lengthens notes up to the next chord, with optional overlap and max gap', () => {
  const notes = [n(60, 0, 0.5), n(64, 0, 0.5), n(62, 1, 0.5), n(65, 3, 0.5)];
  const out = run('legato', notes);
  assert.deepEqual(out.map((x) => x.duration), [1, 1, 2, 0.5]);
  assert.deepEqual(run('legato', notes, { overlap: 0.1 }).map((x) => x.duration), [1.1, 1.1, 2.1, 0.5]);
  assert.deepEqual(run('legato', notes, { max_gap: 0.25 }).map((x) => x.duration), [0.5, 0.5, 0.5, 0.5]);
  assert.deepEqual(run('legato', notes, { max_gap: 1.5 }).map((x) => x.duration), [1, 1, 2, 0.5]);
});

test('gate scales or fixes note lengths', () => {
  const notes = [n(60, 0, 1), n(62, 1, 0.5)];
  assert.deepEqual(run('gate', notes, { factor: 0.5 }).map((x) => x.duration), [0.5, 0.25]);
  assert.deepEqual(run('gate', notes, { length: '1/16' }).map((x) => x.duration), [0.25, 0.25]);
  assert.throws(() => run('gate', notes, {}), /exactly one of factor or length/);
});

test('velocity_shape: ramp, accent, scale, compress, set', () => {
  const notes = [n(60, 0, 1, 50), n(60, 1, 1, 50), n(60, 2, 1, 50), n(60, 3, 1, 50)];
  const ramp = run('velocity_shape', notes, { mode: 'ramp', from: 20, to: 80 });
  assert.equal(ramp[0].velocity, 20);
  assert.ok(ramp[3].velocity > ramp[2].velocity && ramp[2].velocity > ramp[1].velocity);
  assert.deepEqual(run('velocity_shape', notes, { mode: 'accent', grid: 2, amount: 30, soften: 10 }).map((x) => x.velocity), [80, 40, 80, 40]);
  assert.deepEqual(run('velocity_shape', notes, { mode: 'scale', factor: 2 }).map((x) => x.velocity), [100, 100, 100, 100]);
  assert.deepEqual(run('velocity_shape', [n(60, 0, 1, 100), n(60, 1, 1, 28)], { mode: 'compress', factor: 0.5 }).map((x) => x.velocity), [82, 46]);
  assert.deepEqual(run('velocity_shape', notes, { mode: 'set', value: 77 }).map((x) => x.velocity), [77, 77, 77, 77]);
  assert.throws(() => run('velocity_shape', notes, { mode: 'ramp', from: 20 }), /to must be given/);
  assert.throws(() => run('velocity_shape', notes, { mode: 'wobble' }), /one of: ramp/);
});

test('strum staggers each chord over the spread and keeps the chord end', () => {
  const chord = [n(60, 0, 2, 100, 1), n(64, 0, 2, 100, 2), n(67, 0, 2, 100, 3)];
  const up = run('strum', chord, { spread: 0.3 });
  assert.deepEqual(starts(up), [0, 0.15, 0.3]);
  near(up[1].duration, 1.85);
  near(up[2].start_time + up[2].duration, 2);
  assert.deepEqual(up.map((x) => x.id), [1, 2, 3]);
  assert.deepEqual(starts(run('strum', chord, { spread: 0.3, direction: 'down' })), [0.3, 0.15, 0]);
  assert.deepEqual(run('strum', chord, { spread: 0.3, keep_end: false }).map((x) => x.duration), [2, 2, 2]);
  const twoChords = [...chord, n(62, 4, 1), n(65, 4, 1)];
  assert.deepEqual(starts(run('strum', twoChords, { spread: 0.2, direction: 'alternate' })), [0, 0.1, 0.2, 4.2, 4]);
  assert.deepEqual(starts(run('strum', [n(60, 1)], { spread: 1 })), [1]);
});

test('recombine shuffles one attribute among the notes and is repeatable', () => {
  const notes = Array.from({ length: 8 }, (_, i) => n(60 + i, i * 0.5, 0.5, 60 + i * 5, i + 1));
  const out = run('recombine', notes, { what: 'pitch', seed: 3 });
  assert.deepEqual([...pitches(out)].sort(), pitches(notes));
  assert.deepEqual(out.map((x) => x.start_time), notes.map((x) => x.start_time));
  assert.deepEqual(out, run('recombine', notes, { what: 'pitch', seed: 3 }));
  assert.notDeepEqual(pitches(out), pitches(notes));
  const velocities = run('recombine', notes, { what: 'velocity', seed: 9 });
  assert.deepEqual(velocities.map((x) => x.velocity).sort(), notes.map((x) => x.velocity).sort());
  assert.deepEqual([...starts(run('recombine', notes, { what: 'start', seed: 2 }))].sort((a, b) => a - b), starts(notes));
});

test('arpeggiate turns chords into runs in every style', () => {
  const chord = [n(64, 0, 1, 90), n(60, 0, 1, 100), n(67, 0, 1, 80)];
  const seq = (style: string, extra: Record<string, any> = {}, notes = chord): number[] => pitches(run('arpeggiate', notes, { style, rate: '1/8', gate: 1, ...extra }));
  assert.deepEqual(seq('up'), [60, 64]);
  assert.deepEqual(pitches(run('arpeggiate', chord, { rate: '1/16' })), [60, 64, 67, 60]);
  assert.deepEqual(pitches(run('arpeggiate', chord, { style: 'down', rate: '1/16' })), [67, 64, 60, 67]);
  assert.deepEqual(pitches(run('arpeggiate', chord, { style: 'updown', rate: '1/16' })), [60, 64, 67, 64]);
  assert.deepEqual(pitches(run('arpeggiate', chord, { style: 'downup', rate: '1/16' })), [67, 64, 60, 64]);
  assert.deepEqual(pitches(run('arpeggiate', chord, { style: 'converge', rate: '1/16' })), [60, 67, 64, 60]);
  assert.deepEqual(pitches(run('arpeggiate', chord, { style: 'diverge', rate: '1/16' })), [64, 67, 60, 64]);
  assert.deepEqual(pitches(run('arpeggiate', chord, { style: 'played', rate: '1/16' })), [64, 60, 67, 64]);
  assert.deepEqual(pitches(run('arpeggiate', chord, { octaves: 2, rate: '1/16', gate: 1 })).slice(0, 4), [60, 64, 67, 72]);
  assert.equal(seq('random', { seed: 4 }).length, 2);
  const random = pitches(run('arpeggiate', chord, { style: 'random', rate: '1/32', seed: 4 }));
  assert.deepEqual(random, pitches(run('arpeggiate', chord, { style: 'random', rate: '1/32', seed: 4 })));
  const out = run('arpeggiate', chord, { rate: '1/16', gate: 0.5 });
  assert.deepEqual(starts(out), [0, 0.25, 0.5, 0.75]);
  assert.ok(out.every((x) => Math.abs(x.duration - 0.125) < 1e-9));
  assert.deepEqual(out.map((x) => x.velocity), [100, 90, 80, 100]);   // each note keeps its own velocity
});

test('arpeggiate handles several chords, single notes and never runs past the chord', () => {
  const notes = [n(60, 0, 1), n(64, 0, 1), n(62, 2, 0.5), n(65, 2, 0.5)];
  const out = run('arpeggiate', notes, { rate: '1/4', gate: 1 });
  assert.deepEqual(starts(out), [0, 2]);            // one step per chord at a quarter-note rate
  assert.deepEqual(pitches(out), [60, 62]);
  const single = run('arpeggiate', [n(60, 0, 1)], { rate: '1/8' });
  assert.deepEqual(pitches(single), [60, 60]);
  for (const x of out) assert.ok(x.start_time + x.duration <= 2.5 + 1e-9);
  assert.throws(() => run('arpeggiate', [], {}), /no notes/);
});

test('chop cuts notes into pieces, by count or rate, with an on/off pattern', () => {
  const out = run('chop', [n(60, 0, 1)], { divisions: 4, gate: 0.5 });
  assert.deepEqual(starts(out), [0, 0.25, 0.5, 0.75]);
  assert.ok(out.every((x) => Math.abs(x.duration - 0.125) < 1e-9));
  assert.deepEqual(starts(run('chop', [n(60, 0, 1)], { divisions: 4, pattern: 'x.' })), [0, 0.5]);
  const byRate = run('chop', [n(60, 1, 1.1)], { rate: '1/8', gate: 1 });
  assert.equal(byRate.length, 3);
  near(byRate[2].duration, 0.1);
  assert.throws(() => run('chop', [n(60, 0)], { divisions: 2, rate: '1/8' }), /divisions or rate, not both/);
  assert.throws(() => run('chop', [n(60, 0)], { pattern: '...' }), /at least one x/);
});

test('stack adds voices and never touches the originals', () => {
  const notes = [n(60, 0, 1, 100, 1), n(62, 1, 1, 80, 2)];
  const thirds = run('stack', notes, { intervals: [4, 7], velocity_factor: 0.5 });
  assert.deepEqual(pitches(thirds), [64, 67, 66, 69]);
  assert.deepEqual(thirds.map((x) => x.velocity), [50, 50, 40, 40]);
  assert.ok(thirds.every((x) => x.id === undefined));
  assert.deepEqual(pitches(run('stack', [n(60, 0)], { chord: 'maj7' })), [64, 67, 71]);
  assert.deepEqual(pitches(run('stack', [n(60, 0), n(62, 1)], { degrees: [2, 4], key: 'C major' })), [64, 67, 65, 69]);
  assert.deepEqual(pitches(run('stack', [n(60, 0)], { intervals: [3], key: 'C major' })), [64]);   // snapped into the key
  assert.deepEqual(pitches(run('stack', [n(60, 0)], { intervals: [0, 12] })), [72]);                // the same pitch is not doubled
  assert.throws(() => run('stack', notes, {}), /exactly one of intervals, chord or degrees/);
  assert.throws(() => run('stack', notes, { degrees: [2] }), /degrees need a key/);
  assert.throws(() => run('stack', notes, { intervals: [] }), /list of whole semitone/);
});

test('grace_notes add a short note before each note that has room for it', () => {
  const notes = [n(60, 0, 1), n(64, 1, 1, 100)];
  const out = run('grace_notes', notes, { interval: -2, length: '1/16' });
  assert.equal(out.length, 1);            // the first note starts at 0: no room
  assert.deepEqual([out[0].pitch, out[0].start_time, out[0].duration, out[0].velocity], [62, 0.75, 0.25, 70]);
  assert.equal(run('grace_notes', [n(65, 1)], { degrees: -1, key: 'C major' })[0].pitch, 64);
  assert.throws(() => run('grace_notes', notes, { degrees: 1 }), /degrees need a key/);
  assert.throws(() => run('grace_notes', notes, { interval: 1, degrees: 1, key: 'C major' }), /interval or degrees, not both/);
});

test('trill alternates between the note and the one above for long notes only', () => {
  const out = run('trill', [n(60, 0, 1), n(72, 2, 0.25)], { rate: '1/16', interval: 2 });
  assert.deepEqual(pitches(out), [60, 62, 60, 62, 72]);
  assert.deepEqual(starts(out), [0, 0.25, 0.5, 0.75, 2]);
  assert.deepEqual(pitches(run('trill', [n(60, 0, 1)], { rate: '1/8', degrees: 1, key: 'C major' })), [60, 62]);
});

test('repeat copies the notes forward with optional transposition and fade', () => {
  const out = run('repeat', [n(60, 0, 1, 100, 1)], { length: 4, times: 3, transpose_each: 2, decay: 0.5 });
  assert.deepEqual(starts(out), [4, 8, 12]);
  assert.deepEqual(pitches(out), [62, 64, 66]);
  assert.deepEqual(out.map((x) => Math.round(x.velocity)), [50, 25, 13]);
  assert.ok(out.every((x) => x.id === undefined));
  assert.throws(() => run('repeat', [n(60, 0)], {}), /length must be given/);
});

test('groupByStart groups chords and sorts them', () => {
  const groups = groupByStart([n(67, 1), n(60, 0), n(64, 0.0004), n(62, 2)]);
  assert.deepEqual(groups.map((g) => pitches(g)), [[60, 64], [67], [62]]);
});

test('every "modify" transform keeps the number of notes and their ids; every kind is declared', () => {
  const notes = Array.from({ length: 12 }, (_, i) => n(60 + ((i * 5) % 12), i * 0.5, 0.4, 70 + i, i + 1));
  const samples: Record<string, Record<string, any>> = {
    transpose: { semitones: 3 }, fit_to_scale: { key: 'C major' }, invert: {}, reverse: {}, stretch: { factor: 1.5 }, shift: { beats: 1 },
    humanize: { seed: 2 }, swing: { amount: 0.3 }, quantize: { grid: '1/8' }, legato: {}, gate: { factor: 0.7 }, velocity_shape: { mode: 'ramp', from: 30, to: 100 },
    strum: {}, recombine: { what: 'pitch' }
  };
  for (const [name, spec] of Object.entries(TRANSFORMS)) {
    assert.ok(['modify', 'rebuild', 'add'].includes(spec.kind), name);
    assert.ok(spec.summary.startsWith(name), `${name}'s summary should start with its name`);
    if (spec.kind !== 'modify') continue;
    assert.ok(samples[name], `no sample parameters for modify transform ${name}`);
    const out = run(name, notes, samples[name]);
    assert.equal(out.length, notes.length, name);
    assert.deepEqual(out.map((x) => x.id), notes.map((x) => x.id), `${name} must keep ids`);
    assert.equal(finalize(out).dropped, 0, name);
  }
});
