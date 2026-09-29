/** Note generators: pure functions from parameters to notes (beats are quarter notes; nothing here talks to Live). */
import { Params } from './params.js';
import { pick, seeded } from './random.js';
import { euclid, parsePattern } from './rhythm.js';
import {
  Key, chordPitches, degreeOf, noteNameToPitch, parseChordSymbol, pitchOfDegree, placeInOctave, romanToChord, snapToScale
} from './theory.js';
import { EPS, MIN_DURATION, Note, clamp } from './types.js';

export interface GeneratorResult {
  notes: Note[];
  /** The span of the pattern in beats (where the next bar would start). */
  length: number;
}

export interface GeneratorSpec {
  /** One line for tool descriptions. */
  summary: string;
  run(params: Params): GeneratorResult;
}

const note = (pitch: number, start: number, duration: number, velocity: number): Note => ({
  pitch, start_time: start, duration: Math.max(MIN_DURATION, duration), velocity
});

/** General MIDI / Drum Rack default layout (C1 = 36 is the first pad). */
export const DRUM_NAMES: Record<string, number> = {
  kick: 36, rim: 37, snare: 38, clap: 39, tom_low: 41, hat_closed: 42, closed_hat: 42, hh: 42, hat_pedal: 44, tom_mid: 45, hat_open: 46,
  open_hat: 46, oh: 46, tom_high: 48, crash: 49, ride: 51, tambourine: 54, cowbell: 56, shaker: 70
};

function drumPitch(name: string): number {
  if (name in DRUM_NAMES) return DRUM_NAMES[name];
  if (/^\d+$/.test(name)) return noteNameToPitch(Number(name));
  return noteNameToPitch(name);
}

// ---- chords shared by chord_progression and bassline

interface ChordSlot {
  root: number; // pitch class
  quality: string;
  start: number;
  length: number;
  label: string;
}

function readChords(p: Params): { chords: ChordSlot[]; total: number } {
  const numerals = p.array('numerals');
  const symbols = p.array('chords');
  if (!numerals === !symbols) throw new Error('chord input: give exactly one of numerals (with key) or chords');
  const seventh = p.bool('seventh', false);
  const beats = p.number('beats_per_chord', 4, 0.25, 64);
  const durations = p.array('durations');
  const names = (numerals ?? symbols) as unknown[];
  if (!names.length || names.length > 64 || names.some((n) => typeof n !== 'string')) throw new Error('chord input: numerals/chords must be a list of 1 to 64 strings');
  if (durations && durations.length !== names.length) throw new Error('chord input: durations must have one entry per chord');
  const key = numerals ? p.key() : null;
  const slots: ChordSlot[] = [];
  let at = 0;
  names.forEach((raw, i) => {
    const label = raw as string;
    let chord = numerals && key ? romanToChord(label, key) : parseChordSymbol(label);
    if (seventh && chord.quality === 'maj') chord = { ...chord, quality: numerals && /^V(?![IV])/.test(label) ? '7' : 'maj7' };
    else if (seventh && chord.quality === 'min') chord = { ...chord, quality: 'm7' };
    else if (seventh && chord.quality === 'dim') chord = { ...chord, quality: 'm7b5' };
    const length = durations ? Number(durations[i]) : beats;
    if (!Number.isFinite(length) || length <= 0) throw new Error('chord input: durations must be positive numbers of beats');
    slots.push({ ...chord, start: at, length, label });
    at += length;
  });
  return { chords: slots, total: at };
}

/** Repeats a progression's slots until `length` beats are filled (the last chord is cut short). */
function fill(chords: ChordSlot[], total: number, length: number | null): ChordSlot[] {
  if (length === null || length <= total + EPS) return length === null ? chords : cut(chords, length);
  const out: ChordSlot[] = [];
  for (let offset = 0; offset < length - EPS; offset += total) out.push(...chords.map((c) => ({ ...c, start: c.start + offset })));
  return cut(out, length);
}

function cut(chords: ChordSlot[], length: number): ChordSlot[] {
  return chords.filter((c) => c.start < length - EPS).map((c) => ({ ...c, length: Math.min(c.length, length - c.start) }));
}

/** Picks the inversion/octave of each chord that moves least from the previous voicing (voice leading). */
function voiceLead(chords: ChordSlot[], octave: number, voicing: 'close' | 'open' | 'drop2', lead: boolean): number[][] {
  const voiced: number[][] = [];
  chords.forEach((c, index) => {
    const root = placeInOctave(c.root, octave);
    if (!lead || index === 0) {
      voiced.push(chordPitches(root, c.quality, 0, voicing));
      return;
    }
    const previous = voiced[index - 1];
    const center = previous.reduce((a, b) => a + b, 0) / previous.length;
    let best: number[] = [];
    let bestCost = Infinity;
    for (let inversion = 0; inversion < chordPitches(root, c.quality).length; inversion += 1) {
      for (const shift of [-12, 0, 12]) {
        const candidate = chordPitches(root + shift, c.quality, inversion, voicing);
        const cost = Math.abs(candidate.reduce((a, b) => a + b, 0) / candidate.length - center);
        if (cost < bestCost - EPS) {
          bestCost = cost;
          best = candidate;
        }
      }
    }
    voiced.push(best);
  });
  return voiced;
}

export const GENERATORS: Record<string, GeneratorSpec> = {
  euclidean: {
    summary: 'euclidean(pulses, steps=16, rotation=0, pitch=C1, rate=1/16, velocity=100, accent?, gate=0.5, length?, layers?): evenly spread hits; layers = [{pitch, pulses, steps?, rotation?, velocity?}] for several rhythms at once',
    run(p) {
      p.only('pulses', 'steps', 'rotation', 'pitch', 'rate', 'velocity', 'accent', 'gate', 'length', 'layers');
      const rate = p.rate('rate', '1/16');
      const gate = p.number('gate', 0.5, 0.05, 1);
      const layers = p.array('layers');
      const defaults = { steps: p.int('steps', 16, 1, 128), rotation: p.int('rotation', 0, -128, 128), velocity: p.number('velocity', 100, 1, 127) };
      const accent = p.has('accent') ? p.number('accent', undefined, 1, 127) : null;
      const specs = layers
        ? layers.map((l, i) => {
            const lp = new Params(`euclidean layers[${i}]`, l);
            lp.only('pitch', 'pulses', 'steps', 'rotation', 'velocity', 'accent');
            return {
              pitch: lp.pitch('pitch'), pulses: lp.int('pulses', undefined, 0, 128), steps: lp.int('steps', defaults.steps, 1, 128),
              rotation: lp.int('rotation', 0, -128, 128), velocity: lp.number('velocity', defaults.velocity, 1, 127),
              accent: lp.has('accent') ? lp.number('accent', undefined, 1, 127) : accent
            };
          })
        : [{ pitch: p.pitch('pitch', 36), pulses: p.int('pulses', undefined, 0, 128), steps: defaults.steps, rotation: defaults.rotation, velocity: defaults.velocity, accent }];
      if (!specs.length) throw new Error('euclidean: layers must not be empty');
      const length = p.has('length') ? p.number('length', undefined, rate) : Math.max(...specs.map((s) => s.steps)) * rate;
      const notes: Note[] = [];
      for (const spec of specs) {
        const pattern = euclid(spec.steps, spec.pulses, spec.rotation);
        let firstPulse = true;
        for (let step = 0; step * rate < length - EPS; step += 1) {
          if (!pattern[step % spec.steps]) continue;
          const isFirst = firstPulse;
          firstPulse = false;
          notes.push(note(spec.pitch, step * rate, rate * gate, isFirst && spec.accent !== null ? spec.accent : spec.velocity));
        }
      }
      return { notes, length };
    }
  },

  drum_pattern: {
    summary: 'drum_pattern(rows={kick:"x...x...", snare:"....x..."}, rate=1/16, length?, velocity=100, accent=120, ghost=50, gate=0.5): step patterns per drum (x hit, X accent, o ghost, . rest); names kick/snare/clap/hat_closed/hat_open/... or pitches; each row repeats over `length`',
    run(p) {
      p.only('rows', 'rate', 'length', 'velocity', 'accent', 'ghost', 'gate');
      const rows = p.raw('rows');
      if (!rows || typeof rows !== 'object' || Array.isArray(rows) || !Object.keys(rows).length) throw new Error('drum_pattern: rows must be an object like {"kick": "x...x...", "snare": "....x..."}');
      const rate = p.rate('rate', '1/16');
      const velocities = { normal: p.number('velocity', 100, 1, 127), accent: p.number('accent', 120, 1, 127), ghost: p.number('ghost', 50, 1, 127) };
      const gate = p.number('gate', 0.5, 0.05, 1);
      const parsed = Object.entries(rows).map(([name, text]) => {
        if (typeof text !== 'string') throw new Error(`drum_pattern: row '${name}' must be a pattern string`);
        const steps = parsePattern(text);
        if (!steps.length) throw new Error(`drum_pattern: row '${name}' is empty`);
        return { pitch: drumPitch(name), steps };
      });
      const length = p.has('length') ? p.number('length', undefined, rate) : Math.max(...parsed.map((r) => r.steps.length)) * rate;
      const notes: Note[] = [];
      for (const row of parsed) {
        for (let step = 0; step * rate < length - EPS; step += 1) {
          const hit = row.steps[step % row.steps.length];
          if (hit) notes.push(note(row.pitch, step * rate, rate * gate, velocities[hit]));
        }
      }
      return { notes, length };
    }
  },

  chord_progression: {
    summary: 'chord_progression(key + numerals=["I","vi","IV","V"] | chords=["Am7","F"], beats_per_chord=4, durations?, octave=3, voicing=close|open|drop2, voice_leading=true, style=block|strum|arp|pulse|offbeat, rate=1/8, gate=0.9, velocity=90, seventh=false, bass=false, length?)',
    run(p) {
      p.only('key', 'numerals', 'chords', 'beats_per_chord', 'durations', 'octave', 'voicing', 'voice_leading', 'style', 'rate', 'gate', 'velocity', 'seventh', 'bass', 'length', 'spread');
      const { chords: base, total } = readChords(p);
      const octave = p.int('octave', 3, -2, 8);
      const voicing = p.oneOf('voicing', ['close', 'open', 'drop2'] as const, 'close');
      const style = p.oneOf('style', ['block', 'strum', 'arp', 'pulse', 'offbeat'] as const, 'block');
      const rate = p.rate('rate', '1/8');
      const gate = p.number('gate', 0.9, 0.05, 1);
      const velocity = p.number('velocity', 90, 1, 127);
      const spread = p.number('spread', 0.08, 0, 1);
      const bass = p.bool('bass', false);
      const length = p.has('length') ? p.number('length', undefined, 0.25) : null;
      const chords = fill(base, total, length);
      const voiced = voiceLead(chords, octave, voicing, p.bool('voice_leading', true));
      const notes: Note[] = [];
      chords.forEach((c, index) => {
        const pitches = voiced[index];
        const end = c.start + c.length;
        if (style === 'block') {
          for (const pitch of pitches) notes.push(note(pitch, c.start, c.length * gate, velocity));
        } else if (style === 'strum') {
          pitches.forEach((pitch, i) => {
            const offset = pitches.length > 1 ? (spread * i) / (pitches.length - 1) : 0;
            notes.push(note(pitch, c.start + offset, c.length * gate - offset, velocity));
          });
        } else if (style === 'arp') {
          for (let step = 0; c.start + step * rate < end - EPS; step += 1) {
            const t = c.start + step * rate;
            notes.push(note(pitches[step % pitches.length], t, Math.min(rate * gate, end - t), velocity));
          }
        } else if (style === 'pulse') {
          for (let step = 0; c.start + step * rate < end - EPS; step += 1) {
            const t = c.start + step * rate;
            for (const pitch of pitches) notes.push(note(pitch, t, Math.min(rate * gate, end - t), velocity));
          }
        } else {
          for (let t = c.start + 0.5; t < end - EPS; t += 1) {
            for (const pitch of pitches) notes.push(note(pitch, t, Math.min(0.5 * gate, end - t), velocity));
          }
        }
        if (bass) notes.push(note(placeInOctave(c.root, octave - 2), c.start, c.length * gate, clamp(velocity + 10, 1, 127)));
      });
      return { notes, length: Math.max(...chords.map((c) => c.start + c.length)) };
    }
  },

  bassline: {
    summary: 'bassline(key + numerals | chords, beats_per_chord=4, octave=1, style=root|root_fifth|octaves|walking, rate=1/8, pattern?, gate=0.9, velocity=100, length?): a bass part that follows the chords',
    run(p) {
      p.only('key', 'numerals', 'chords', 'beats_per_chord', 'durations', 'octave', 'style', 'rate', 'pattern', 'gate', 'velocity', 'seventh', 'length');
      const { chords: base, total } = readChords(p);
      const octave = p.int('octave', 1, -2, 6);
      const style = p.oneOf('style', ['root', 'root_fifth', 'octaves', 'walking'] as const, 'root');
      const rate = p.rate('rate', style === 'walking' ? '1/4' : '1/8');
      const gate = p.number('gate', 0.9, 0.05, 1);
      const velocity = p.number('velocity', 100, 1, 127);
      const pattern = p.has('pattern') ? parsePattern(p.string('pattern')) : null;
      const length = p.has('length') ? p.number('length', undefined, 0.25) : null;
      const chords = fill(base, total, length);
      const notes: Note[] = [];
      chords.forEach((c, index) => {
        const root = placeInOctave(c.root, octave);
        const next = chords[index + 1];
        const third = root + (/^(min|m(?!aj)|dim)/.test(c.quality) ? 3 : 4);       // minor-type chords (not maj) have a minor third
        for (let step = 0; c.start + step * rate < c.start + c.length - EPS; step += 1) {
          if (pattern && !pattern[step % pattern.length]) continue;
          const t = c.start + step * rate;
          const room = Math.min(rate * gate, c.start + c.length - t);
          let pitch = root;
          if (style === 'root_fifth') pitch = step % 2 === 0 ? root : root + 7;
          else if (style === 'octaves') pitch = step % 2 === 0 ? root : root + 12;
          else if (style === 'walking') {
            const beatsLeft = Math.round((c.start + c.length - t) / rate);
            if (beatsLeft === 1 && next) pitch = placeInOctave(next.root, octave) + (step % 2 === 0 ? -1 : 1);       // approach the next root
            else pitch = [root, third, root + 7, third][step % 4];
          }
          notes.push(note(pitch, t, room, step === 0 ? clamp(velocity + 10, 1, 127) : velocity));
        }
      });
      return { notes, length: Math.max(...chords.map((c) => c.start + c.length)) };
    }
  },

  melody: {
    summary: 'melody(key, length=8, rate=1/8, low=C3, high=C5, seed=1, rest_probability=0.15, step_bias=0.7, contour=free|arch|rise|fall, note_lengths=[1,1,2], velocity=90, resolve=true): a repeatable random melody inside a scale',
    run(p) {
      p.only('key', 'length', 'rate', 'low', 'high', 'seed', 'rest_probability', 'step_bias', 'contour', 'note_lengths', 'velocity', 'resolve', 'start');
      const key = p.key();
      const length = p.number('length', 8, 0.25, 256);
      const rate = p.rate('rate', '1/8');
      const low = p.pitch('low', 60);
      const high = p.pitch('high', 84);
      if (high <= low) throw new Error('melody: high must be above low');
      const random = seeded(p.int('seed', 1));
      const rests = p.number('rest_probability', 0.15, 0, 1);
      const stepBias = p.number('step_bias', 0.7, 0, 1);
      const contour = p.oneOf('contour', ['free', 'arch', 'rise', 'fall'] as const, 'free');
      const multipliers = (p.array('note_lengths') ?? [1, 1, 2]).map((m) => Number(m));
      if (!multipliers.length || multipliers.some((m) => !(m > 0))) throw new Error('melody: note_lengths must be a list of positive numbers');
      const velocity = p.number('velocity', 90, 1, 127);
      const resolve = p.bool('resolve', true);
      const scale: number[] = [];
      for (let degree = degreeOf(snapToScale(low, key, 'up'), key); ; degree += 1) {
        const pitch = pitchOfDegree(degree, key);
        if (pitch > high) break;
        if (pitch >= low) scale.push(pitch);
      }
      if (scale.length < 3) throw new Error('melody: the range holds fewer than 3 notes of the scale; widen low/high');
      const startPitch = p.has('start') ? snapToScale(p.pitch('start'), key) : snapToScale(Math.round((low + high) / 2), key);
      let index = scale.reduce((best, pitch, i) => (Math.abs(pitch - startPitch) < Math.abs(scale[best] - startPitch) ? i : best), 0);
      const notes: Note[] = [];
      for (let t = 0; t < length - EPS;) {
        const first = notes.length === 0;
        if (!first && random() < rests) {
          t += rate;
          continue;
        }
        const duration = Math.min(rate * pick(multipliers, random), length - t);
        const progress = t / length;
        const up = contour === 'rise' ? 0.75 : contour === 'fall' ? 0.25 : contour === 'arch' ? (progress < 0.5 ? 0.7 : 0.3) : 0.5;
        if (!first) {
          const stepSize = random() < stepBias ? 1 : 2 + Math.floor(random() * 3);
          index += random() < up ? stepSize : -stepSize;
          if (index < 0) index = -index;
          if (index > scale.length - 1) index = 2 * (scale.length - 1) - index;
          index = clamp(index, 0, scale.length - 1);
        }
        const accent = Math.abs(t - Math.round(t)) < EPS ? 10 : 0;
        notes.push(note(scale[index], t, duration * 0.95, clamp(velocity + accent + Math.round((random() - 0.5) * 12), 1, 127)));
        t += duration;
      }
      if (resolve && notes.length) {
        const last = notes[notes.length - 1];
        const tonics = scale.filter((pitch) => (pitch - key.root) % 12 === 0 || (pitch - key.root + 120) % 12 === 0);
        if (tonics.length) last.pitch = tonics.reduce((best, pitch) => (Math.abs(pitch - last.pitch) < Math.abs(best - last.pitch) ? pitch : best), tonics[0]);
      }
      return { notes, length };
    }
  },

  scale_run: {
    summary: 'scale_run(key, from=C3, to=C4, rate=1/16, direction=up|down|updown, gate=0.9, velocity=90): every scale note between two pitches',
    run(p) {
      p.only('key', 'from', 'to', 'rate', 'direction', 'gate', 'velocity');
      const key: Key = p.key();
      const from = p.pitch('from', 60);
      const to = p.pitch('to', 72);
      const rate = p.rate('rate', '1/16');
      const direction = p.oneOf('direction', ['up', 'down', 'updown'] as const, 'up');
      const gate = p.number('gate', 0.9, 0.05, 1);
      const velocity = p.number('velocity', 90, 1, 127);
      const low = Math.min(from, to);
      const high = Math.max(from, to);
      const pitches: number[] = [];
      for (let degree = degreeOf(snapToScale(low, key, 'up'), key); pitchOfDegree(degree, key) <= high; degree += 1) {
        if (pitchOfDegree(degree, key) >= low) pitches.push(pitchOfDegree(degree, key));
      }
      if (!pitches.length) throw new Error('scale_run: no scale notes between from and to');
      const run = direction === 'up' ? pitches : direction === 'down' ? [...pitches].reverse() : pitches.concat([...pitches].reverse().slice(1));
      return { notes: run.map((pitch, i) => note(pitch, i * rate, rate * gate, velocity)), length: run.length * rate };
    }
  },

  random_notes: {
    summary: 'random_notes(length=4, rate=1/16, density=0.4, low=C3, high=C5, key?, seed=1, velocity=90, velocity_range=15, note_lengths=[1,2]): scattered notes on a grid, optionally inside a scale',
    run(p) {
      p.only('length', 'rate', 'density', 'low', 'high', 'key', 'seed', 'velocity', 'velocity_range', 'note_lengths');
      const length = p.number('length', 4, 0.25, 256);
      const rate = p.rate('rate', '1/16');
      const density = p.number('density', 0.4, 0, 1);
      const low = p.pitch('low', 60);
      const high = p.pitch('high', 84);
      if (high < low) throw new Error('random_notes: high must not be below low');
      const key = p.has('key') ? p.key() : null;
      const random = seeded(p.int('seed', 1));
      const velocity = p.number('velocity', 90, 1, 127);
      const range = p.number('velocity_range', 15, 0, 126);
      const multipliers = (p.array('note_lengths') ?? [1, 2]).map((m) => Number(m));
      if (!multipliers.length || multipliers.some((m) => !(m > 0))) throw new Error('random_notes: note_lengths must be a list of positive numbers');
      const notes: Note[] = [];
      for (let step = 0; step * rate < length - EPS; step += 1) {
        if (random() >= density) continue;
        let pitch = low + Math.floor(random() * (high - low + 1));
        if (key) pitch = snapToScale(pitch, key, random() < 0.5 ? 'up' : 'down');
        if (pitch < low || pitch > high) continue;
        const t = step * rate;
        notes.push(note(pitch, t, Math.min(rate * pick(multipliers, random), length - t) * 0.95, clamp(Math.round(velocity + (random() * 2 - 1) * range), 1, 127)));
      }
      return { notes, length };
    }
  }
};

export const GENERATOR_NAMES = Object.keys(GENERATORS);
