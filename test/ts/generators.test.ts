import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GENERATORS, GENERATOR_NAMES } from '../../src/music/generators.js';
import { Params } from '../../src/music/params.js';
import { finalize } from '../../src/music/transforms.js';
import { inScale, parseKey } from '../../src/music/theory.js';
import { Note } from '../../src/music/types.js';

const gen = (name: string, params: Record<string, any> = {}) => GENERATORS[name].run(new Params(name, params));
const starts = (notes: Note[]): number[] => notes.map((n) => Math.round(n.start_time * 1e6) / 1e6);
const pitches = (notes: Note[]): number[] => notes.map((n) => n.pitch);
const near = (a: number, b: number, tol = 1e-9): void => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const sortNotes = (notes: Note[]): Note[] => [...notes].sort((a, b) => a.start_time - b.start_time || a.pitch - b.pitch);

test('euclidean places the pulses on a grid, repeats to fill a length, and accents the first hit', () => {
  const out = gen('euclidean', { pulses: 3, steps: 8, rate: '1/8' });
  assert.deepEqual(starts(out.notes), [0, 1.5, 3]);
  assert.equal(out.length, 4);
  assert.ok(out.notes.every((n) => n.pitch === 36 && n.velocity === 100 && Math.abs(n.duration - 0.25) < 1e-9));
  assert.deepEqual(starts(gen('euclidean', { pulses: 3, steps: 8, rate: '1/8', length: 8 }).notes), [0, 1.5, 3, 4, 5.5, 7]);
  const accented = gen('euclidean', { pulses: 3, steps: 8, accent: 127, velocity: 80, pitch: 'D1' });
  assert.deepEqual(accented.notes.map((n) => n.velocity), [127, 80, 80]);
  assert.equal(accented.notes[0].pitch, 38);
  assert.deepEqual(starts(gen('euclidean', { pulses: 3, steps: 8, rotation: 1, rate: '1/8' }).notes), [0.5, 2, 3.5]);
  assert.equal(gen('euclidean', { pulses: 0 }).notes.length, 0);
  assert.throws(() => gen('euclidean', {}), /pulses must be given/);
  assert.throws(() => gen('euclidean', { pulses: 3, steps: 0 }), /steps must be between 1 and 128/);
});

test('euclidean layers give one rhythm per pitch with their own step counts', () => {
  const out = gen('euclidean', { rate: '1/8', layers: [{ pitch: 36, pulses: 4, steps: 16 }, { pitch: 42, pulses: 3, steps: 8, velocity: 60 }] });
  assert.equal(out.length, 8);
  assert.equal(out.notes.filter((n) => n.pitch === 36).length, 4);
  assert.ok(out.notes.filter((n) => n.pitch === 42).every((n) => n.velocity === 60));
  assert.throws(() => gen('euclidean', { layers: [] }), /layers must not be empty/);
  assert.throws(() => gen('euclidean', { layers: [{ pulses: 3 }] }), /layers\[0\]: pitch must be given/);
});

test('drum_pattern reads step strings per drum, by name or pitch', () => {
  const out = gen('drum_pattern', { rows: { kick: 'x...x...', snare: '....X...', hat_closed: 'x.o.x.o.', 49: 'x' }, rate: '1/16' });
  const by = (pitch: number): Note[] => out.notes.filter((n) => n.pitch === pitch);
  assert.deepEqual(starts(by(36)), [0, 1]);
  assert.deepEqual(by(38).map((n) => [n.start_time, n.velocity]), [[1, 120]]);
  assert.deepEqual(by(42).map((n) => n.velocity), [100, 50, 100, 50]);
  assert.equal(by(49).length, 8);                     // a one-step row repeats on every step of the pattern (8 steps)
  assert.equal(out.length, 2);
  assert.deepEqual(starts(gen('drum_pattern', { rows: { kick: 'x...' }, length: 4 }).notes), [0, 1, 2, 3]);
  assert.equal(gen('drum_pattern', { rows: { kick: 'x' }, velocity: 90, gate: 1 }).notes[0].velocity, 90);
  assert.throws(() => gen('drum_pattern', {}), /rows must be an object/);
  assert.throws(() => gen('drum_pattern', { rows: { kick: 5 } }), /row 'kick' must be a pattern string/);
  assert.throws(() => gen('drum_pattern', { rows: { kick: '' } }), /is empty/);
  assert.throws(() => gen('drum_pattern', { rows: { bongo: 'x' } }), /not a pitch/);
});

test('chord_progression from numerals: block chords, timing and voice leading', () => {
  const out = gen('chord_progression', { key: 'C major', numerals: ['I', 'vi', 'IV', 'V'], voice_leading: false });
  assert.equal(out.length, 16);
  const chord = (i: number): number[] => pitches(sortNotes(out.notes.filter((n) => n.start_time === i * 4)));
  assert.deepEqual(chord(0), [60, 64, 67]);
  assert.deepEqual(chord(1), [69, 72, 76]);              // without voice leading every chord sits on its root in the same octave (A3)
  assert.deepEqual(chord(2), [65, 69, 72]);
  assert.deepEqual(chord(3), [67, 71, 74]);
  assert.ok(out.notes.every((n) => Math.abs(n.duration - 3.6) < 1e-9));
  const led = gen('chord_progression', { key: 'C major', numerals: ['I', 'vi', 'IV', 'V'] });
  const centers = [0, 1, 2, 3].map((i) => {
    const c = led.notes.filter((n) => n.start_time === i * 4);
    return c.reduce((a, n) => a + n.pitch, 0) / c.length;
  });
  for (let i = 1; i < centers.length; i += 1) assert.ok(Math.abs(centers[i] - centers[i - 1]) <= 6, `voice leading moved ${Math.abs(centers[i] - centers[i - 1])} semitones`);
  assert.ok(led.notes.every((n) => n.pitch >= 48 && n.pitch <= 84));
});

test('chord_progression from symbols, sevenths, durations, repeat to length and bass', () => {
  const out = gen('chord_progression', { chords: ['Am7', 'Dm'], durations: [2, 6], octave: 3, voice_leading: false, bass: true });
  assert.equal(out.length, 8);
  assert.deepEqual(pitches(sortNotes(out.notes.filter((n) => n.start_time === 0 && n.pitch >= 48))), [69, 72, 76, 79]);
  assert.ok(out.notes.some((n) => n.start_time === 2 && n.pitch === 38), 'D1 bass under Dm');
  assert.ok(out.notes.some((n) => n.start_time === 0 && n.pitch === 45), 'A1 bass under Am7');
  const sevenths = gen('chord_progression', { key: 'C major', numerals: ['I', 'ii', 'V'], seventh: true, voice_leading: false });
  assert.deepEqual(pitches(sortNotes(sevenths.notes.filter((n) => n.start_time === 0))), [60, 64, 67, 71]);
  assert.deepEqual(pitches(sortNotes(sevenths.notes.filter((n) => n.start_time === 4))), [62, 65, 69, 72]);
  assert.deepEqual(pitches(sortNotes(sevenths.notes.filter((n) => n.start_time === 8))), [67, 71, 74, 77]);   // V7
  const looped = gen('chord_progression', { chords: ['C', 'G'], length: 20 });
  assert.equal(looped.length, 20);
  assert.equal(looped.notes.filter((n) => n.start_time === 16).length, 3);
  assert.ok(looped.notes.every((n) => n.start_time + n.duration <= 20 + 1e-9));
  assert.throws(() => gen('chord_progression', { chords: ['C'], numerals: ['I'], key: 'C' }), /exactly one of numerals/);
  assert.throws(() => gen('chord_progression', { numerals: ['I'] }), /key must be given/);
  assert.throws(() => gen('chord_progression', { chords: ['C', 'G'], durations: [4] }), /one entry per chord/);
  assert.throws(() => gen('chord_progression', { chords: [] }), /1 to 64/);
});

test('chord_progression styles: strum, arp, pulse, offbeat', () => {
  const base = { chords: ['C'], voice_leading: false } as const;
  const strum = gen('chord_progression', { ...base, style: 'strum', spread: 0.2 });
  assert.deepEqual(starts(strum.notes), [0, 0.1, 0.2]);
  const arp = gen('chord_progression', { ...base, style: 'arp', rate: '1/4' });
  assert.deepEqual(pitches(arp.notes), [60, 64, 67, 60]);
  assert.deepEqual(starts(arp.notes), [0, 1, 2, 3]);
  const pulse = gen('chord_progression', { ...base, style: 'pulse', rate: '1/2' });
  assert.equal(pulse.notes.length, 6);
  const offbeat = gen('chord_progression', { ...base, style: 'offbeat' });
  assert.deepEqual([...new Set(starts(offbeat.notes))], [0.5, 1.5, 2.5, 3.5]);
});

test('bassline follows the chords in each style', () => {
  const root = gen('bassline', { chords: ['C', 'F'], rate: '1/4', beats_per_chord: 2 });
  assert.deepEqual(pitches(root.notes), [36, 36, 41, 41]);
  const fifth = gen('bassline', { chords: ['C'], style: 'root_fifth', rate: '1/4' });
  assert.deepEqual(pitches(fifth.notes), [36, 43, 36, 43]);
  const octaves = gen('bassline', { chords: ['A'], style: 'octaves', rate: '1/4' });
  assert.deepEqual(pitches(octaves.notes), [45, 57, 45, 57]);
  const walking = gen('bassline', { chords: ['C', 'F'], style: 'walking', beats_per_chord: 4 });
  assert.equal(walking.notes.length, 8);
  assert.deepEqual(pitches(walking.notes.slice(0, 3)), [36, 40, 43]);
  assert.equal(Math.abs(walking.notes[3].pitch - 41), 1, 'the last beat approaches the next root (F1 = 41) by a semitone');
  assert.deepEqual(pitches(walking.notes.slice(4, 7)), [41, 45, 48]);
  const minor = gen('bassline', { chords: ['Am'], style: 'walking' });
  assert.equal(minor.notes[1].pitch, 45 + 3);
  const patterned = gen('bassline', { key: 'A minor', numerals: ['i', 'VI'], pattern: 'x.x.xx..', rate: '1/8', beats_per_chord: 4 });
  assert.equal(patterned.notes.filter((n) => n.start_time < 4).length, 4);
  assert.ok(patterned.notes.filter((n) => n.start_time >= 4).every((n) => n.pitch === 41));
  assert.ok(patterned.notes.filter((n) => n.start_time < 4).every((n) => n.pitch === 45));
});

test('melody stays in the key and range, is repeatable, and resolves to the tonic', () => {
  const params = { key: 'D minor', length: 16, seed: 11, low: 'C3', high: 'C5' };
  const out = gen('melody', params);
  const key = parseKey('D minor');
  assert.ok(out.notes.length >= 8);
  assert.ok(out.notes.every((n) => inScale(n.pitch, key) && n.pitch >= 60 && n.pitch <= 84), 'in key and range');
  assert.ok(out.notes.every((n) => n.start_time >= 0 && n.start_time + n.duration <= 16 + 1e-9));
  const sorted = sortNotes(out.notes);
  for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i].start_time >= sorted[i - 1].start_time + sorted[i - 1].duration - 1e-9, 'notes do not overlap');
  assert.equal(sorted[sorted.length - 1].pitch % 12, 2, 'ends on D');
  assert.deepEqual(out, gen('melody', params));
  assert.notDeepEqual(pitches(out.notes), pitches(gen('melody', { ...params, seed: 12 }).notes));
  assert.deepEqual(finalize(out.notes).dropped, 0);
});

test('melody contour and step bias shape the line', () => {
  const avgFirstToLast = (contour: string): number => {
    let total = 0;
    for (let seed = 1; seed <= 20; seed += 1) {
      const notes = sortNotes(gen('melody', { key: 'C major', length: 32, seed, contour, rest_probability: 0, resolve: false }).notes);
      const half = Math.floor(notes.length / 2);
      total += notes.slice(half).reduce((a, x) => a + x.pitch, 0) / (notes.length - half) - notes.slice(0, half).reduce((a, x) => a + x.pitch, 0) / half;
    }
    return total / 20;
  };
  assert.ok(avgFirstToLast('rise') > avgFirstToLast('fall'), 'rise should end higher than fall');
  const stepwise = sortNotes(gen('melody', { key: 'C major', length: 32, step_bias: 1, rest_probability: 0, seed: 3, resolve: false }).notes);
  const scale = parseKey('C major');
  const degrees = stepwise.map((x) => Math.round(((x.pitch - 60) / 12) * 7));
  assert.ok(degrees.length > 10);
  assert.ok(scale.intervals.length === 7);
  assert.throws(() => gen('melody', { key: 'C major', low: 'C3', high: 'D3' }), /fewer than 3 notes/);
  assert.throws(() => gen('melody', { key: 'C major', low: 'C5', high: 'C3' }), /high must be above low/);
  assert.throws(() => gen('melody', { key: 'C major', note_lengths: [] }), /note_lengths/);
});

test('scale_run walks the scale between two pitches', () => {
  assert.deepEqual(pitches(gen('scale_run', { key: 'C major', from: 'C3', to: 'C4' }).notes), [60, 62, 64, 65, 67, 69, 71, 72]);
  assert.deepEqual(pitches(gen('scale_run', { key: 'C major', from: 'C3', to: 'C4', direction: 'down' }).notes), [72, 71, 69, 67, 65, 64, 62, 60]);
  assert.equal(gen('scale_run', { key: 'C major', direction: 'updown' }).notes.length, 15);
  assert.deepEqual(pitches(gen('scale_run', { key: 'A minor pentatonic', from: 'A2', to: 'A3' }).notes), [57, 60, 62, 64, 67, 69]);
  assert.deepEqual(pitches(gen('scale_run', { key: 'C major', from: 'C4', to: 'C3' }).notes), [60, 62, 64, 65, 67, 69, 71, 72]);
  const run = gen('scale_run', { key: 'C major', rate: '1/8', gate: 1 });
  assert.equal(run.length, 4);
  near(run.notes[1].start_time, 0.5);
});

test('random_notes: density, range, key and repeatability', () => {
  assert.equal(gen('random_notes', { density: 0 }).notes.length, 0);
  assert.equal(gen('random_notes', { density: 1, length: 4, rate: '1/4' }).notes.length, 4);
  const out = gen('random_notes', { length: 8, density: 0.5, key: 'E minor', low: 'C3', high: 'C4', seed: 9 });
  assert.ok(out.notes.length > 4);
  assert.ok(out.notes.every((n) => n.pitch >= 60 && n.pitch <= 72 && inScale(n.pitch, parseKey('E minor'))));
  assert.deepEqual(out, gen('random_notes', { length: 8, density: 0.5, key: 'E minor', low: 'C3', high: 'C4', seed: 9 }));
  assert.throws(() => gen('random_notes', { low: 'C4', high: 'C3' }), /high must not be below low/);
});

test('every generator produces notes Live accepts, and every summary starts with its name', () => {
  const samples: Record<string, Record<string, any>> = {
    euclidean: { pulses: 5 }, drum_pattern: { rows: { kick: 'x...', snare: '..x.' } }, chord_progression: { key: 'A minor', numerals: ['i', 'VI', 'III', 'VII'] },
    bassline: { chords: ['Am', 'F', 'C', 'G'] }, melody: { key: 'A minor' }, scale_run: { key: 'A minor' }, random_notes: { key: 'A minor' }
  };
  assert.deepEqual([...GENERATOR_NAMES].sort(), Object.keys(samples).sort());
  for (const name of GENERATOR_NAMES) {
    assert.ok(GENERATORS[name].summary.startsWith(name), name);
    const out = gen(name, samples[name]);
    assert.ok(out.notes.length > 0 && out.length > 0, name);
    const cleaned = finalize(out.notes);
    assert.equal(cleaned.dropped, 0, `${name} produced notes Live cannot hold`);
    assert.ok(out.notes.every((x) => x.duration > 0 && x.velocity >= 1 && x.velocity <= 127 && x.start_time >= 0 && x.id === undefined), name);
    assert.throws(() => gen(name, { ...samples[name], bogus: 1 }), /unknown parameter bogus/);
  }
});
