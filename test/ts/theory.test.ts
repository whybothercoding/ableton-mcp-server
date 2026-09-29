import assert from 'node:assert/strict';
import { test } from 'node:test';
import { euclid, parsePattern, parseRate } from '../../src/music/rhythm.js';
import { seeded, shuffle } from '../../src/music/random.js';
import { Params, ParamError } from '../../src/music/params.js';
import {
  chordPitches, chordQuality, degreeOf, diatonicChord, inScale, noteNameToPitch, parseChordSymbol, parseKey, pitchOfDegree, pitchToName, romanToChord,
  snapToScale, transposeByDegrees
} from '../../src/music/theory.js';

const bits = (pattern: boolean[]): string => pattern.map((b) => (b ? 'x' : '.')).join('');

test('note names follow Ableton: C3 is 60', () => {
  assert.equal(noteNameToPitch('C3'), 60);
  assert.equal(noteNameToPitch('c#3'), 61);
  assert.equal(noteNameToPitch('Db3'), 61);
  assert.equal(noteNameToPitch('C-2'), 0);
  assert.equal(noteNameToPitch('G8'), 127);
  assert.equal(noteNameToPitch('A1'), 45);
  assert.equal(noteNameToPitch(64), 64);
  assert.equal(pitchToName(60), 'C3');
  assert.equal(pitchToName(36), 'C1');
  assert.equal(pitchToName(0), 'C-2');
  for (const bad of ['H3', 'C', 'C9', 128, -1, 60.5, {}]) assert.throws(() => noteNameToPitch(bad as any), /pitch|MIDI|note name/);
  for (let p = 0; p <= 127; p += 1) assert.equal(noteNameToPitch(pitchToName(p)), p);
});

test('keys parse from text and objects, with aliases', () => {
  const cm = parseKey('C minor');
  assert.deepEqual([cm.root, cm.scale, cm.intervals], [0, 'minor', [0, 2, 3, 5, 7, 8, 10]]);
  assert.equal(parseKey('F# dorian').root, 6);
  assert.equal(parseKey('Bb').intervals.length, 7);
  assert.equal(parseKey('A aeolian').scale, 'minor');
  assert.equal(parseKey('D major pentatonic').intervals.length, 5);
  assert.equal(parseKey({ root: 'E', scale: 'blues' }).root, 4);
  assert.equal(parseKey({ root: 14, scale: 'major' }).root, 2);
  assert.throws(() => parseKey('C wonky'), /unknown scale 'wonky'.*major/);
  assert.throws(() => parseKey(5 as any), /key is text/);
});

test('snapToScale and degrees', () => {
  const c = parseKey('C major');
  assert.equal(inScale(61, c), false);
  assert.equal(snapToScale(61, c), 62); // ties go up
  assert.equal(snapToScale(61, c, 'down'), 60);
  assert.equal(snapToScale(61, c, 'up'), 62);
  assert.equal(snapToScale(60, c), 60);
  assert.equal(snapToScale(66, c), 67);
  const pent = parseKey('C major pentatonic');
  assert.equal(snapToScale(65, pent), 64);
  assert.equal(degreeOf(60, c), 35);          // degrees count from pitch class C at MIDI 0: 60 is 5 octaves x 7
  assert.equal(pitchOfDegree(degreeOf(64, c), c), 64);
  assert.equal(transposeByDegrees(60, 2, c), 64);  // C up a third
  assert.equal(transposeByDegrees(64, -2, c), 60);
  assert.equal(transposeByDegrees(71, 1, c), 72);  // across the octave
  assert.equal(transposeByDegrees(61, 1, c), 64);  // out-of-scale note snaps (up) then moves
  const a = parseKey('A minor');
  assert.equal(transposeByDegrees(57, 7, a), 69);  // a full octave of degrees
});

test('chord symbols, qualities and voicings', () => {
  assert.deepEqual(parseChordSymbol('Am7'), { root: 9, quality: 'm7' });
  assert.deepEqual(parseChordSymbol('C'), { root: 0, quality: 'maj' });
  assert.deepEqual(parseChordSymbol('F#maj7'), { root: 6, quality: 'maj7' });
  assert.deepEqual(parseChordSymbol('Bbm'), { root: 10, quality: 'min' });
  assert.deepEqual(parseChordSymbol('Dsus4'), { root: 2, quality: 'sus4' });
  assert.deepEqual(parseChordSymbol('E5'), { root: 4, quality: '5' });
  assert.deepEqual(parseChordSymbol('Cdim'), { root: 0, quality: 'dim' });
  assert.deepEqual(parseChordSymbol('Gm7b5'), { root: 7, quality: 'm7b5' });
  assert.throws(() => parseChordSymbol('Hm'), /chord symbol/);
  assert.throws(() => parseChordSymbol('Cwobble'), /unknown chord quality/);
  assert.equal(chordQuality('m'), 'min');
  assert.deepEqual(chordPitches(60, 'maj'), [60, 64, 67]);
  assert.deepEqual(chordPitches(60, 'min7'), [60, 63, 67, 70]);
  assert.deepEqual(chordPitches(60, 'maj', 1), [64, 67, 72]);
  assert.deepEqual(chordPitches(60, 'maj', 2), [67, 72, 76]);
  assert.deepEqual(chordPitches(60, 'maj', 0, 'open'), [60, 67, 76]);
  assert.deepEqual(chordPitches(60, 'maj7', 0, 'open'), [60, 67, 76, 83]);
  assert.deepEqual(chordPitches(60, 'maj7', 0, 'drop2'), [55, 60, 64, 71]);
  assert.deepEqual(chordPitches(60, 'maj', 0, 'drop2'), [52, 60, 67]);
});

test('roman numerals and diatonic chords follow the key', () => {
  const c = parseKey('C major');
  assert.deepEqual(['I', 'ii', 'iii', 'IV', 'V', 'vi', 'viidim'].map((n) => romanToChord(n, c)), [
    { root: 0, quality: 'maj' }, { root: 2, quality: 'min' }, { root: 4, quality: 'min' }, { root: 5, quality: 'maj' },
    { root: 7, quality: 'maj' }, { root: 9, quality: 'min' }, { root: 11, quality: 'dim' }
  ]);
  assert.deepEqual(romanToChord('V7', c), { root: 7, quality: '7' });
  assert.deepEqual(romanToChord('ii7', c), { root: 2, quality: 'm7' });
  assert.deepEqual(romanToChord('Imaj7', c), { root: 0, quality: 'maj7' });
  assert.deepEqual(romanToChord('bVII', c), { root: 10, quality: 'maj' });
  assert.deepEqual(romanToChord('vi9', c), { root: 9, quality: 'm9' });
  const am = parseKey('A minor');
  assert.deepEqual(romanToChord('VI', am), { root: 5, quality: 'maj' });  // the sixth of A minor is F
  assert.deepEqual(romanToChord('i', am), { root: 9, quality: 'min' });
  assert.deepEqual(romanToChord('v', am), { root: 4, quality: 'min' });
  assert.throws(() => romanToChord('VIII', c), /roman numeral/);
  assert.deepEqual(diatonicChord(c, 0), { root: 0, quality: 'maj' });
  assert.deepEqual(diatonicChord(c, 1), { root: 2, quality: 'min' });
  assert.deepEqual(diatonicChord(c, 6), { root: 11, quality: 'dim' });
  assert.deepEqual(diatonicChord(c, 4, true), { root: 7, quality: '7' });
  assert.deepEqual(diatonicChord(c, 0, true), { root: 0, quality: 'maj7' });
  assert.deepEqual(diatonicChord(am, 0, true), { root: 9, quality: 'm7' });
});

test('rates parse as beats', () => {
  assert.equal(parseRate('1/16'), 0.25);
  assert.equal(parseRate('1/8'), 0.5);
  assert.equal(parseRate('1/4'), 1);
  assert.equal(parseRate('1/1'), 4);
  assert.equal(parseRate('1/8t'), 1 / 3);
  assert.equal(parseRate('1/4d'), 1.5);
  assert.equal(parseRate('16'), 0.25);
  assert.equal(parseRate(0.75), 0.75);
  for (const bad of ['1/7', 'fast', 0, -1, NaN, null]) assert.throws(() => parseRate(bad), /rate/);
});

test('euclidean rhythms: the classic named patterns, and maximal evenness for every steps/pulses pair', () => {
  const classics: [number, number, string][] = [
    [3, 8, 'x..x..x.'], [5, 8, 'x.xx.xx.'], [4, 9, 'x.x.x.x..'], [2, 5, 'x.x..'], [3, 7, 'x.x.x..'], [4, 7, 'x.x.x.x'],
    [5, 9, 'x.x.x.x.x'], [4, 16, 'x...x...x...x...'], [3, 5, 'x.x.x'], [4, 11, 'x..x..x..x.']
  ];
  for (const [pulses, steps, expected] of classics) assert.equal(bits(euclid(steps, pulses)), expected, `E(${pulses},${steps})`);
  assert.equal(bits(euclid(8, 0)), '........');
  assert.equal(bits(euclid(4, 9)), 'xxxx');
  assert.equal(bits(euclid(8, 3, 1)), '.x..x..x');   // rotation moves the pattern right
  assert.equal(bits(euclid(8, 3, -1)), '..x..x.x');  // and negative rotation left
  assert.equal(bits(euclid(8, 3, 8)), 'x..x..x.');
  for (let steps = 1; steps <= 32; steps += 1) {
    for (let pulses = 0; pulses <= steps; pulses += 1) {
      const pattern = euclid(steps, pulses);
      assert.equal(pattern.length, steps);
      assert.equal(pattern.filter(Boolean).length, pulses);
      if (pulses < 2) continue;
      const at = pattern.map((hit, i) => (hit ? i : -1)).filter((i) => i >= 0);
      const gaps = at.map((position, i) => (at[(i + 1) % at.length] - position + steps) % steps || steps);
      assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, `E(${pulses},${steps}) is not maximally even: gaps ${gaps}`);
      assert.equal(pattern[0], true, `E(${pulses},${steps}) starts on a pulse`);
    }
  }
  assert.throws(() => euclid(0, 1), /steps/);
  assert.throws(() => euclid(8, -1), /pulses/);
});

test('rhythm patterns read x, X, o and rests', () => {
  assert.deepEqual(parsePattern('x.Xo | -x'), ['normal', null, 'accent', 'ghost', null, 'normal']);
});

test('the seeded generator is deterministic and shuffle keeps every item', () => {
  const a = seeded(42);
  const b = seeded(42);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.notEqual(seeded(1)(), seeded(2)());
  const draws = Array.from({ length: 1000 }, seeded(7));
  assert.ok(draws.every((d) => d >= 0 && d < 1));
  const mean = draws.reduce((x, y) => x + y, 0) / draws.length;
  assert.ok(mean > 0.45 && mean < 0.55, `mean ${mean}`);
  const items = [1, 2, 3, 4, 5, 6];
  assert.deepEqual([...shuffle(items, seeded(3))].sort(), items);
  assert.deepEqual(shuffle(items, seeded(3)), shuffle(items, seeded(3)));
});

test('Params validates with messages that name the operation and the parameter', () => {
  const p = new Params('arpeggiate', { rate: '1/8', gate: 0.5, octaves: 2, style: 'up', flag: true, key: 'D minor', root: 'C3', extra: 1 });
  assert.equal(p.rate('rate'), 0.5);
  assert.equal(p.number('gate', 1, 0, 1), 0.5);
  assert.equal(p.int('octaves', 1, 1, 4), 2);
  assert.equal(p.oneOf('style', ['up', 'down'] as const), 'up');
  assert.equal(p.bool('flag', false), true);
  assert.equal(p.key().root, 2);
  assert.equal(p.pitch('root'), 60);
  assert.equal(p.number('missing', 7), 7);
  assert.throws(() => p.number('missing'), /arpeggiate: missing must be given/);
  assert.throws(() => new Params('t', { a: 'x' }).number('a'), /t: a must be a number/);
  assert.throws(() => new Params('t', { a: 1.5 }).int('a'), /a must be a whole number/);
  assert.throws(() => new Params('t', { a: 9 }).number('a', 1, 0, 5), /between 0 and 5/);
  assert.throws(() => new Params('t', { a: 'sideways' }).oneOf('a', ['up', 'down'] as const), /one of: up, down/);
  assert.throws(() => new Params('t', { a: 'yes' }).bool('a', false), /true or false/);
  assert.throws(() => new Params('t', { r: '1/7' }).rate('r'), /r: .*not a rate/);
  assert.throws(() => new Params('t', { k: 'C wonky' }).key('k'), /k: unknown scale/);
  assert.throws(() => new Params('t', { p: 'H9' }).pitch('p'), /p: /);
  assert.throws(() => p.only('rate', 'gate'), (err: any) => err instanceof ParamError && /unknown parameters octaves, style, flag, key, root, extra/.test(err.message));
  assert.doesNotThrow(() => new Params('t', { a: undefined, b: null }).only());
});
