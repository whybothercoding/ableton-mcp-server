/** Notes, scales and chords. Note names follow Ableton: C3 is MIDI 60 (middle C), C-2 is 0. */
import { mod } from './types.js';

export const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LETTERS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 'C', 'c#', 'Db', 'F##' -> 0..11 */
export function parsePitchClass(name: string): number {
  const match = /^([A-Ga-g])([#b]{0,2})$/.exec(name.trim());
  if (!match) throw new Error(`'${name}' is not a note name (use C, C#, Db, ...)`);
  let value = LETTERS[match[1].toUpperCase()];
  for (const accidental of match[2]) value += accidental === '#' ? 1 : -1;
  return mod(value, 12);
}

/** 'C3' -> 60, 'F#2' -> 54, 'Bb-1' -> 22; numbers 0-127 pass through. */
export function noteNameToPitch(input: unknown): number {
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input < 0 || input > 127) throw new Error('a MIDI pitch is a whole number from 0 to 127');
    return input;
  }
  if (typeof input !== 'string') throw new Error("a pitch is a MIDI number or a note name like 'C3'");
  const match = /^([A-Ga-g][#b]{0,2})(-?\d+)$/.exec(input.trim());
  if (!match) throw new Error(`'${input}' is not a pitch: use a MIDI number or a note name with an octave, like 'C3' (C3 is 60)`);
  const pitch = parsePitchClass(match[1]) + 12 * (Number(match[2]) + 2);
  if (pitch < 0 || pitch > 127) throw new Error(`'${input}' is outside the MIDI range (C-2 to G8)`);
  return pitch;
}

export function pitchToName(pitch: number): string {
  return `${PITCH_CLASS_NAMES[mod(pitch, 12)]}${Math.floor(pitch / 12) - 2}`;
}

// ---- scales

export const SCALES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
  melodic_minor: [0, 2, 3, 5, 7, 9, 11],
  phrygian_dominant: [0, 1, 4, 5, 7, 8, 10],
  hungarian_minor: [0, 2, 3, 6, 7, 8, 11],
  major_pentatonic: [0, 2, 4, 7, 9],
  minor_pentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  whole_tone: [0, 2, 4, 6, 8, 10],
  diminished: [0, 2, 3, 5, 6, 8, 9, 11],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
};
const SCALE_ALIASES: Record<string, string> = {
  ionian: 'major', aeolian: 'minor', natural_minor: 'minor', maj: 'major', min: 'minor', pentatonic: 'major_pentatonic',
  minor_blues: 'blues', whole_half_diminished: 'diminished', half_whole_diminished: 'diminished'
};

const scaleKey = (name: string): string => name.trim().toLowerCase().replace(/[\s-]+/g, '_');

export function scaleIntervals(name: string): number[] {
  const key = scaleKey(name);
  const found = SCALES[SCALE_ALIASES[key] ?? key];
  if (!found) throw new Error(`unknown scale '${name}'. Scales: ${Object.keys(SCALES).join(', ')}`);
  return found;
}

export interface Key {
  root: number; // pitch class 0-11
  scale: string;
  intervals: number[];
}

/** 'C minor', 'F# dorian', 'Bb major pentatonic', {root: 'C', scale: 'minor'} or {root: 0, scale: 'minor'}. */
export function parseKey(input: unknown): Key {
  let rootText: unknown;
  let scaleText: string;
  if (typeof input === 'string') {
    const parts = input.trim().split(/\s+/);
    rootText = parts[0];
    scaleText = parts.slice(1).join(' ') || 'major';
  } else if (input && typeof input === 'object') {
    rootText = (input as any).root;
    scaleText = (input as any).scale ?? 'major';
  } else {
    throw new Error("a key is text like 'C minor' or an object {root, scale}");
  }
  const root = typeof rootText === 'number' ? mod(rootText, 12) : parsePitchClass(String(rootText));
  const intervals = scaleIntervals(scaleText);
  return { root, scale: (SCALE_ALIASES[scaleKey(scaleText)] ?? scaleKey(scaleText)), intervals };
}

export const pitchClassesOf = (key: Key): number[] => key.intervals.map((i) => mod(key.root + i, 12));
export const inScale = (pitch: number, key: Key): boolean => pitchClassesOf(key).includes(mod(pitch, 12));

/** The nearest scale pitch (ties go up), or the nearest one above/below. */
export function snapToScale(pitch: number, key: Key, direction: 'nearest' | 'up' | 'down' = 'nearest'): number {
  if (inScale(pitch, key)) return pitch;
  for (let distance = 1; distance <= 12; distance += 1) {
    const up = inScale(pitch + distance, key);
    const down = inScale(pitch - distance, key);
    if (direction === 'up' && up) return pitch + distance;
    if (direction === 'down' && down) return pitch - distance;
    if (direction === 'nearest' && (up || down)) return up ? pitch + distance : pitch - distance;
  }
  return pitch;
}

/** Scale degree (0-based, counted from the root, may be negative or beyond one octave) of an in-scale pitch. */
export function degreeOf(pitch: number, key: Key): number {
  const relative = pitch - key.root;
  const octave = Math.floor(relative / 12);
  const index = key.intervals.indexOf(mod(relative, 12));
  if (index < 0) throw new Error(`pitch ${pitch} is not in ${key.scale}`);
  return octave * key.intervals.length + index;
}

/** The pitch of a scale degree, counting degree 0 as the key's root pitch class placed at `rootPitch` (default: 0-11 range). */
export function pitchOfDegree(degree: number, key: Key, rootPitch: number = key.root): number {
  const n = key.intervals.length;
  return rootPitch + 12 * Math.floor(degree / n) + key.intervals[mod(degree, n)];
}

/** The pitch of the key's root at or below `pitch`. */
export const rootBelow = (pitch: number, key: Key): number => pitch - mod(pitch - key.root, 12);

/** Moves a pitch by scale degrees (snapping it into the scale first). */
export function transposeByDegrees(pitch: number, steps: number, key: Key): number {
  const inKey = snapToScale(pitch, key);
  return pitchOfDegree(degreeOf(inKey, key) + steps, key);
}

// ---- chords

export const CHORDS: Record<string, number[]> = {
  maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7], '5': [0, 7],
  '6': [0, 4, 7, 9], m6: [0, 3, 7, 9], '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], m7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9], mmaj7: [0, 3, 7, 11], '7sus4': [0, 5, 7, 10], add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14],
  '9': [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], '11': [0, 4, 7, 10, 14, 17], m11: [0, 3, 7, 10, 14, 17],
  '13': [0, 4, 7, 10, 14, 21], maj13: [0, 4, 7, 11, 14, 21], m13: [0, 3, 7, 10, 14, 21]
};
const CHORD_ALIASES: Record<string, string> = {
  '': 'maj', M: 'maj', major: 'maj', m: 'min', minor: 'min', '-': 'min', '°': 'dim', o: 'dim', '+': 'aug', dom7: '7', '7th': '7',
  M7: 'maj7', '△7': 'maj7', '-7': 'm7', min7: 'm7', ø: 'm7b5', ø7: 'm7b5', '°7': 'dim7', mM7: 'mmaj7', sus: 'sus4', 'm7♭5': 'm7b5',
  add2: 'add9', min9: 'm9', M9: 'maj9', min11: 'm11', min13: 'm13', M13: 'maj13', min6: 'm6', 'm(maj7)': 'mmaj7'
};

export function chordQuality(name: string): string {
  const key = CHORD_ALIASES[name] ?? name;
  if (!CHORDS[key]) throw new Error(`unknown chord quality '${name}'. Qualities: ${Object.keys(CHORDS).join(', ')}`);
  return key;
}

/** 'Am7' -> {root: 9, quality: 'm7'}; 'F#maj7', 'Bbm', 'C', 'G7', 'Dsus4', 'E5', 'Cdim'. */
export function parseChordSymbol(symbol: string): { root: number; quality: string } {
  const match = /^\s*([A-Ga-g][#b]?)(.*?)\s*$/.exec(symbol);
  if (!match) throw new Error(`'${symbol}' is not a chord symbol (examples: C, Am7, F#maj7, Bbm, G7, Dsus4)`);
  return { root: parsePitchClass(match[1]), quality: chordQuality(match[2]) };
}

export type Voicing = 'close' | 'open' | 'drop2';

/** Chord pitches above `rootPitch`. inversion moves the lowest notes up an octave; open spreads alternate notes; drop2 lowers the second note from the top. */
export function chordPitches(rootPitch: number, quality: string, inversion = 0, voicing: Voicing = 'close'): number[] {
  let pitches = CHORDS[chordQuality(quality)].map((i) => rootPitch + i);
  for (let i = 0; i < inversion; i += 1) pitches = [...pitches.slice(1), pitches[0] + 12];
  if (voicing === 'open') pitches = pitches.map((p, i) => (i % 2 === 1 ? p + 12 : p));
  if (voicing === 'drop2' && pitches.length >= 3) {
    const sorted = [...pitches].sort((a, b) => a - b);
    sorted[sorted.length - 2] -= 12;
    pitches = sorted;
  }
  return pitches.sort((a, b) => a - b);
}

/** A pitch class placed in an Ableton octave: (9, 3) is A3 = 57. */
export const placeInOctave = (pitchClass: number, octave: number): number => pitchClass + 12 * (octave + 2);

const NUMERALS: Record<string, number> = { i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6 };

/**
 * Roman numerals in a key: 'I', 'vi', 'IV', 'V7', 'bVII', 'viidim', 'ii7'. Upper case is major, lower case minor (unless a quality
 * follows). The degree counts along the key's own scale, so 'VI' in A minor is F (the sixth of A minor).
 */
export function romanToChord(numeral: string, key: Key): { root: number; quality: string } {
  const match = /^([b#]?)(VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)(?![IViv])(.*)$/.exec(numeral.trim());
  if (!match) throw new Error(`'${numeral}' is not a roman numeral chord (examples: I, vi, IV, V7, bVII, ii7, viidim)`);
  const scale = key.intervals.length === 7 ? key.intervals : scaleIntervals(key.intervals[2] === 3 ? 'minor' : 'major');
  const degree = NUMERALS[match[2].toLowerCase()];
  const accidental = match[1] === 'b' ? -1 : match[1] === '#' ? 1 : 0;
  const root = mod(key.root + scale[degree] + accidental, 12);
  const minor = match[2] === match[2].toLowerCase();
  const suffix = match[3];
  let quality: string;
  if (suffix === '') quality = minor ? 'min' : 'maj';
  else if (suffix === '7') quality = minor ? 'm7' : '7';
  else if (suffix === 'maj7' || suffix === 'M7') quality = minor ? 'mmaj7' : 'maj7';
  else if (suffix === 'add9') quality = minor ? 'madd9' : 'add9';
  else if (['dim', '°', 'dim7', '°7', 'ø', 'ø7', 'm7b5', 'aug', '+', 'sus2', 'sus4', '7sus4', '5'].includes(suffix)) quality = chordQuality(suffix);
  else quality = chordQuality(minor ? `m${suffix}` : suffix); // 6, 9, 11, 13 follow the numeral's case
  return { root, quality };
}

/** The diatonic triad (or seventh chord) on a scale degree, built by stacking thirds in the key. */
export function diatonicChord(key: Key, degree: number, seventh = false): { root: number; quality: string } {
  const n = key.intervals.length;
  const at = (d: number): number => key.root + 12 * Math.floor(d / n) + key.intervals[mod(d, n)];
  const root = at(degree);
  const stack = [0, at(degree + 2) - root, at(degree + 4) - root].concat(seventh ? [at(degree + 6) - root] : []);
  const found = Object.entries(CHORDS).find(([name, intervals]) => intervals.length === stack.length && intervals.every((v, i) => v === stack[i]) && name !== '5');
  return { root: mod(root, 12), quality: found ? found[0] : 'maj' };
}
