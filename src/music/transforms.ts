/**
 * Note transforms: pure functions from a list of notes to a list of notes (beats are quarter notes).
 *
 * Each transform has a kind that decides how the result reaches Live:
 *   modify   the same notes with changed fields (ids are kept, so per-note events survive; applied with edit_notes modify)
 *   rebuild  a new set of notes that replaces the input (applied with edit_notes replace over the selected range)
 *   add      only new notes, the input stays (applied with write_notes)
 */
import { Params } from './params.js';
import { seeded, shuffle } from './random.js';
import { chordPitches, snapToScale, transposeByDegrees } from './theory.js';
import { EPS, MAX_PITCH, MIN_DURATION, MIN_PITCH, Note, clamp } from './types.js';

export type TransformKind = 'modify' | 'rebuild' | 'add';

export interface TransformSpec {
  kind: TransformKind;
  /** One line for tool descriptions: name(parameters) and what it does. */
  summary: string;
  run(notes: Note[], params: Params): Note[];
}

const SAME_START = 1e-3;

/** Notes that start together (a chord), in time order; notes inside a group are sorted by pitch. */
export function groupByStart(notes: Note[]): Note[][] {
  const sorted = [...notes].sort((a, b) => a.start_time - b.start_time || a.pitch - b.pitch);
  const groups: Note[][] = [];
  for (const note of sorted) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last[0].start_time - note.start_time) < SAME_START) last.push(note);
    else groups.push([note]);
  }
  return groups;
}

const withFields = (note: Note, changes: Partial<Note>): Note => ({ ...note, ...changes });
/** A new note based on an existing one: it has no id yet. */
const fresh = (note: Note, changes: Partial<Note>): Note => {
  const { id: _id, ...rest } = note;
  void _id;
  return { ...rest, ...changes };
};
const endOf = (note: Note): number => note.start_time + note.duration;
const span = (notes: Note[]): { start: number; end: number } => ({
  start: Math.min(...notes.map((n) => n.start_time)),
  end: Math.max(...notes.map(endOf))
});

/** Rounds noise, clamps what Live would refuse and drops what cannot exist (pitch outside 0-127, start before 0). */
export function finalize(notes: Note[]): { notes: Note[]; dropped: number } {
  const out: Note[] = [];
  let dropped = 0;
  for (const note of notes) {
    if (note.pitch < MIN_PITCH || note.pitch > MAX_PITCH || note.start_time < -EPS) {
      dropped += 1;
      continue;
    }
    const cleaned: Note = {
      ...note,
      pitch: Math.round(note.pitch),
      start_time: Math.max(0, Math.round(note.start_time * 1e6) / 1e6),
      duration: Math.max(MIN_DURATION, Math.round(note.duration * 1e6) / 1e6),
      velocity: clamp(Math.round(note.velocity), 1, 127)
    };
    if (note.probability !== undefined) cleaned.probability = clamp(note.probability, 0, 1);
    if (note.velocity_deviation !== undefined) cleaned.velocity_deviation = clamp(Math.round(note.velocity_deviation), -127, 127);
    if (note.release_velocity !== undefined) cleaned.release_velocity = clamp(Math.round(note.release_velocity), 0, 127);
    out.push(cleaned);
  }
  return { notes: out, dropped };
}

const need = (notes: Note[], name: string): void => {
  if (!notes.length) throw new Error(`${name}: there are no notes to work on (check the range or ids you gave)`);
};

export const TRANSFORMS: Record<string, TransformSpec> = {
  transpose: {
    kind: 'modify',
    summary: 'transpose(semitones | degrees+key): move pitches by semitones, or by scale degrees within a key',
    run(notes, p) {
      p.only('semitones', 'degrees', 'key');
      if (p.has('semitones') === p.has('degrees')) throw new Error('transpose: give exactly one of semitones or degrees');
      if (p.has('semitones')) {
        const semitones = p.int('semitones', undefined, -127, 127);
        return notes.map((n) => withFields(n, { pitch: n.pitch + semitones }));
      }
      const degrees = p.int('degrees', undefined, -70, 70);
      const key = p.key();
      return notes.map((n) => withFields(n, { pitch: transposeByDegrees(n.pitch, degrees, key) }));
    }
  },

  fit_to_scale: {
    kind: 'modify',
    summary: 'fit_to_scale(key, direction=nearest|up|down): snap every pitch into the scale',
    run(notes, p) {
      p.only('key', 'direction');
      const key = p.key();
      const direction = p.oneOf('direction', ['nearest', 'up', 'down'] as const, 'nearest');
      return notes.map((n) => withFields(n, { pitch: snapToScale(n.pitch, key, direction) }));
    }
  },

  invert: {
    kind: 'modify',
    summary: 'invert(axis?, key?): mirror pitches around an axis pitch (default: the middle of the range); key snaps the result into a scale',
    run(notes, p) {
      p.only('axis', 'key');
      need(notes, 'invert');
      const lowest = Math.min(...notes.map((n) => n.pitch));
      const highest = Math.max(...notes.map((n) => n.pitch));
      const axis2 = p.has('axis') ? 2 * p.pitch('axis') : lowest + highest;
      const key = p.has('key') ? p.key() : null;
      return notes.map((n) => {
        const mirrored = axis2 - n.pitch;
        return withFields(n, { pitch: key ? snapToScale(mirrored, key) : mirrored });
      });
    }
  },

  reverse: {
    kind: 'modify',
    summary: 'reverse(): play the selected notes backwards in time',
    run(notes, p) {
      p.only();
      need(notes, 'reverse');
      const { start, end } = span(notes);
      return notes.map((n) => withFields(n, { start_time: start + end - endOf(n) }));
    }
  },

  stretch: {
    kind: 'modify',
    summary: 'stretch(factor, anchor?): scale start times and durations (2 = twice as slow) around an anchor in beats (default: first note)',
    run(notes, p) {
      p.only('factor', 'anchor');
      need(notes, 'stretch');
      const factor = p.number('factor', undefined, 0.01, 100);
      const anchor = p.number('anchor', Math.min(...notes.map((n) => n.start_time)));
      return notes.map((n) => withFields(n, { start_time: anchor + (n.start_time - anchor) * factor, duration: n.duration * factor }));
    }
  },

  shift: {
    kind: 'modify',
    summary: 'shift(beats): move notes in time (negative goes earlier; notes cannot go before 0)',
    run(notes, p) {
      p.only('beats');
      const beats = p.number('beats');
      return notes.map((n) => withFields(n, { start_time: n.start_time + beats }));
    }
  },

  humanize: {
    kind: 'modify',
    summary: 'humanize(timing=0.02, velocity=8, duration=0, seed=1): random but repeatable timing (beats), velocity and length (fraction) jitter',
    run(notes, p) {
      p.only('timing', 'velocity', 'duration', 'seed');
      const timing = p.number('timing', 0.02, 0, 1);
      const velocity = p.number('velocity', 8, 0, 127);
      const duration = p.number('duration', 0, 0, 1);
      const random = seeded(p.int('seed', 1));
      const jitter = (amount: number): number => (random() * 2 - 1) * amount;
      const draws = new Map<Note, [number, number, number]>();
      for (const n of [...notes].sort((a, b) => a.start_time - b.start_time || a.pitch - b.pitch)) draws.set(n, [jitter(timing), jitter(velocity), jitter(duration)]);
      return notes.map((n) => {
        const [dt, dv, dd] = draws.get(n) as [number, number, number];
        return withFields(n, { start_time: Math.max(0, n.start_time + dt), velocity: n.velocity + dv, duration: n.duration * (1 + dd) });
      });
    }
  },

  swing: {
    kind: 'modify',
    summary: 'swing(amount, grid=1/8): delay the off-beat notes of a grid by amount x grid (0.33 is triplet swing)',
    run(notes, p) {
      p.only('amount', 'grid');
      const amount = p.number('amount', undefined, 0, 1);
      const grid = p.rate('grid', '1/8');
      return notes.map((n) => {
        const position = n.start_time / grid;
        const nearest = Math.round(position);
        const offBeat = Math.abs(position - nearest) < 0.25 && nearest % 2 !== 0;
        return offBeat ? withFields(n, { start_time: n.start_time + amount * grid }) : n;
      });
    }
  },

  quantize: {
    kind: 'modify',
    summary: 'quantize(grid=1/16, strength=1, ends=false): pull note starts (and optionally ends) toward a grid',
    run(notes, p) {
      p.only('grid', 'strength', 'ends');
      const grid = p.rate('grid', '1/16');
      const strength = p.number('strength', 1, 0, 1);
      const ends = p.bool('ends', false);
      const pull = (value: number): number => value + (Math.round(value / grid) * grid - value) * strength;
      return notes.map((n) => {
        const start = pull(n.start_time);
        const end = ends ? pull(endOf(n)) : start + n.duration;
        return withFields(n, { start_time: start, duration: Math.max(MIN_DURATION, end - start) });
      });
    }
  },

  legato: {
    kind: 'modify',
    summary: 'legato(overlap=0, max_gap?): lengthen each note (chord) up to the next one; max_gap only bridges gaps up to that many beats',
    run(notes, p) {
      p.only('overlap', 'max_gap');
      const overlap = p.number('overlap', 0, 0, 4);
      const maxGap = p.has('max_gap') ? p.number('max_gap', undefined, 0) : Infinity;
      const starts = groupByStart(notes).map((g) => g[0].start_time);
      return notes.map((n) => {
        const next = starts.find((s) => s > n.start_time + SAME_START);
        if (next === undefined || next - endOf(n) > maxGap + EPS) return n;
        return withFields(n, { duration: Math.max(MIN_DURATION, next - n.start_time + overlap) });
      });
    }
  },

  gate: {
    kind: 'modify',
    summary: 'gate(factor | length): multiply note lengths (0.5 = staccato) or set them to a fixed length in beats',
    run(notes, p) {
      p.only('factor', 'length');
      if (p.has('factor') === p.has('length')) throw new Error('gate: give exactly one of factor or length');
      if (p.has('factor')) {
        const factor = p.number('factor', undefined, 0.01, 16);
        return notes.map((n) => withFields(n, { duration: n.duration * factor }));
      }
      const length = p.rate('length');
      return notes.map((n) => withFields(n, { duration: length }));
    }
  },

  velocity_shape: {
    kind: 'modify',
    summary: 'velocity_shape(mode=ramp|accent|scale|compress|set, ...): ramp(from,to) over time; accent(grid=1,amount=20,soften=0,offset=0) boosts notes on a grid; scale(factor); compress(factor,center=64); set(value)',
    run(notes, p) {
      p.only('mode', 'from', 'to', 'grid', 'amount', 'soften', 'offset', 'factor', 'center', 'value');
      const mode = p.oneOf('mode', ['ramp', 'accent', 'scale', 'compress', 'set'] as const, 'ramp');
      need(notes, 'velocity_shape');
      if (mode === 'ramp') {
        const from = p.number('from', undefined, 1, 127);
        const to = p.number('to', undefined, 1, 127);
        const { start, end } = span(notes);
        const total = end - start || 1;
        return notes.map((n) => withFields(n, { velocity: from + ((to - from) * (n.start_time - start)) / total }));
      }
      if (mode === 'accent') {
        const grid = p.rate('grid', 1);
        const amount = p.number('amount', 20, -126, 126);
        const soften = p.number('soften', 0, 0, 126);
        const offset = p.number('offset', 0);
        return notes.map((n) => {
          const position = (n.start_time - offset) / grid;
          return withFields(n, { velocity: Math.abs(position - Math.round(position)) * grid < 0.02 ? n.velocity + amount : n.velocity - soften });
        });
      }
      if (mode === 'scale') {
        const factor = p.number('factor', undefined, 0, 4);
        return notes.map((n) => withFields(n, { velocity: n.velocity * factor }));
      }
      if (mode === 'compress') {
        const factor = p.number('factor', undefined, 0, 4);
        const center = p.number('center', 64, 1, 127);
        return notes.map((n) => withFields(n, { velocity: center + (n.velocity - center) * factor }));
      }
      const value = p.number('value', undefined, 1, 127);
      return notes.map((n) => withFields(n, { velocity: value }));
    }
  },

  strum: {
    kind: 'modify',
    summary: 'strum(spread=0.1, direction=up|down|alternate, keep_end=true): stagger the notes of each chord over `spread` beats',
    run(notes, p) {
      p.only('spread', 'direction', 'keep_end');
      const spread = p.number('spread', 0.1, 0, 4);
      const direction = p.oneOf('direction', ['up', 'down', 'alternate'] as const, 'up');
      const keepEnd = p.bool('keep_end', true);
      const changes = new Map<Note, Note>();
      groupByStart(notes).forEach((group, index) => {
        const ordered = direction === 'down' || (direction === 'alternate' && index % 2 === 1) ? [...group].reverse() : group;
        ordered.forEach((n, i) => {
          const offset = ordered.length > 1 ? (spread * i) / (ordered.length - 1) : 0;
          changes.set(n, withFields(n, { start_time: n.start_time + offset, duration: keepEnd ? Math.max(MIN_DURATION, n.duration - offset) : n.duration }));
        });
      });
      return notes.map((n) => changes.get(n) ?? n);
    }
  },

  recombine: {
    kind: 'modify',
    summary: 'recombine(what=pitch|velocity|duration|start, seed=1): shuffle one attribute among the notes',
    run(notes, p) {
      p.only('what', 'seed');
      const what = p.oneOf('what', ['pitch', 'velocity', 'duration', 'start'] as const, 'pitch');
      const random = seeded(p.int('seed', 1));
      const order = [...notes].sort((a, b) => a.start_time - b.start_time || a.pitch - b.pitch);
      const field = what === 'start' ? 'start_time' : what;
      const values = shuffle(order.map((n) => n[field]), random);
      const assigned = new Map(order.map((n, i) => [n, values[i]] as const));
      return notes.map((n) => withFields(n, { [field]: assigned.get(n) } as Partial<Note>));
    }
  },

  arpeggiate: {
    kind: 'rebuild',
    summary: 'arpeggiate(style=up|down|updown|downup|converge|diverge|random|played, rate=1/16, gate=0.8, octaves=1, seed=1): turn each chord into a run of single notes for as long as the chord lasts',
    run(notes, p) {
      p.only('style', 'rate', 'gate', 'octaves', 'seed');
      need(notes, 'arpeggiate');
      const style = p.oneOf('style', ['up', 'down', 'updown', 'downup', 'converge', 'diverge', 'random', 'played'] as const, 'up');
      const rate = p.rate('rate', '1/16');
      const gate = p.number('gate', 0.8, 0.05, 4);
      const octaves = p.int('octaves', 1, 1, 4);
      const random = seeded(p.int('seed', 1));
      const out: Note[] = [];
      for (const group of groupByStart(notes)) {
        const start = group[0].start_time;
        const end = Math.max(...group.map(endOf));
        const source = style === 'played' ? notes.filter((n) => group.includes(n)) : group;
        const pool: Note[] = [];
        for (let octave = 0; octave < octaves; octave += 1) {
          for (const n of source) pool.push(withFields(n, { pitch: n.pitch + 12 * octave }));
        }
        const ascending = [...pool].sort((a, b) => a.pitch - b.pitch);
        const descending = [...ascending].reverse();
        const converge: Note[] = [];
        for (let lo = 0, hi = ascending.length - 1; lo <= hi; lo += 1, hi -= 1) {
          converge.push(ascending[lo]);
          if (hi !== lo) converge.push(ascending[hi]);
        }
        const sequences: Record<string, Note[]> = {
          up: ascending,
          down: descending,
          updown: ascending.concat(descending.slice(1, -1)),
          downup: descending.concat(ascending.slice(1, -1)),
          converge,
          diverge: [...converge].reverse(),
          played: pool,
          random: pool
        };
        let sequence = sequences[style];
        if (!sequence.length) sequence = ascending;
        for (let step = 0, t = start; t < end - EPS; step += 1, t = start + step * rate) {
          if (style === 'random' && step % sequence.length === 0) sequence = shuffle(pool, random);
          const src = sequence[step % sequence.length];
          out.push(withFields(src, { start_time: t, duration: Math.min(rate * gate, end - t) }));
        }
      }
      return out;
    }
  },

  chop: {
    kind: 'rebuild',
    summary: 'chop(divisions=2 | rate, gate=0.9, pattern?): cut every note into equal pieces (or pieces of one rate); pattern like "x.xx" mutes pieces, repeating',
    run(notes, p) {
      p.only('divisions', 'rate', 'gate', 'pattern');
      need(notes, 'chop');
      if (p.has('divisions') && p.has('rate')) throw new Error('chop: give divisions or rate, not both');
      const gate = p.number('gate', 0.9, 0.05, 1);
      const pattern = p.has('pattern') ? [...p.string('pattern').replace(/\s/g, '')].map((c) => c !== '.' && c !== '-') : null;
      if (pattern && !pattern.some(Boolean)) throw new Error('chop: pattern needs at least one x');
      const byRate = p.has('rate') ? p.rate('rate') : null;
      const divisions = p.int('divisions', 2, 2, 64);
      const out: Note[] = [];
      for (const n of notes) {
        const pieces = byRate ? Math.max(1, Math.ceil(n.duration / byRate - EPS)) : divisions;
        const length = byRate ?? n.duration / divisions;
        for (let i = 0; i < pieces; i += 1) {
          if (pattern && !pattern[i % pattern.length]) continue;
          const start = n.start_time + i * length;
          const room = Math.min(length, endOf(n) - start);
          if (room < MIN_DURATION) continue;
          out.push(withFields(n, { start_time: start, duration: room * gate }));
        }
      }
      return out;
    }
  },

  stack: {
    kind: 'add',
    summary: 'stack(intervals=[4,7] | chord=maj7 | degrees=[2,4]+key, velocity_factor=0.9): add voices above (or below) every note',
    run(notes, p) {
      p.only('intervals', 'chord', 'degrees', 'key', 'velocity_factor');
      const given = ['intervals', 'chord', 'degrees'].filter((name) => p.has(name));
      if (given.length !== 1) throw new Error('stack: give exactly one of intervals, chord or degrees');
      const factor = p.number('velocity_factor', 0.9, 0, 2);
      const key = p.has('key') ? p.key() : null;
      let offsets: (pitch: number) => number[];
      if (p.has('chord')) {
        const quality = p.string('chord');
        offsets = (pitch) => chordPitches(pitch, quality).slice(1);
      } else if (p.has('degrees')) {
        if (!key) throw new Error('stack: degrees need a key');
        const degrees = (p.array('degrees') ?? []).map((d) => Number(d));
        if (!degrees.length || degrees.some((d) => !Number.isInteger(d))) throw new Error('stack: degrees must be a list of whole numbers');
        offsets = (pitch) => degrees.map((d) => transposeByDegrees(pitch, d, key));
      } else {
        const intervals = (p.array('intervals') ?? []).map((i) => Number(i));
        if (!intervals.length || intervals.some((i) => !Number.isInteger(i))) throw new Error('stack: intervals must be a list of whole semitone numbers');
        offsets = (pitch) => intervals.map((i) => (key ? snapToScale(pitch + i, key) : pitch + i));
      }
      const out: Note[] = [];
      for (const n of notes) {
        const seen = new Set<number>([n.pitch]);
        for (const pitch of offsets(n.pitch)) {
          if (seen.has(pitch)) continue;
          seen.add(pitch);
          out.push(fresh(n, { pitch, velocity: n.velocity * factor }));
        }
      }
      return out;
    }
  },

  grace_notes: {
    kind: 'add',
    summary: 'grace_notes(interval=-1 | degrees+key, length=1/32, velocity_factor=0.7): add a short note just before every note',
    run(notes, p) {
      p.only('interval', 'degrees', 'key', 'length', 'velocity_factor');
      if (p.has('interval') && p.has('degrees')) throw new Error('grace_notes: give interval or degrees, not both');
      const length = p.rate('length', '1/32');
      const factor = p.number('velocity_factor', 0.7, 0, 2);
      const key = p.has('key') ? p.key() : null;
      const degrees = p.has('degrees') ? p.int('degrees', undefined, -14, 14) : null;
      if (degrees !== null && !key) throw new Error('grace_notes: degrees need a key');
      const interval = p.int('interval', -1, -24, 24);
      const out: Note[] = [];
      for (const n of notes) {
        if (n.start_time < length - EPS) continue;
        const pitch = degrees !== null && key ? transposeByDegrees(n.pitch, degrees, key) : key ? snapToScale(n.pitch + interval, key) : n.pitch + interval;
        out.push(fresh(n, { pitch, start_time: n.start_time - length, duration: length, velocity: n.velocity * factor }));
      }
      return out;
    }
  },

  trill: {
    kind: 'rebuild',
    summary: 'trill(interval=2 | degrees+key, rate=1/16, min_length=0.5): replace long notes with a trill between the note and the one above it',
    run(notes, p) {
      p.only('interval', 'degrees', 'key', 'rate', 'min_length');
      need(notes, 'trill');
      const rate = p.rate('rate', '1/16');
      const minLength = p.rate('min_length', 0.5);
      const key = p.has('key') ? p.key() : null;
      const degrees = p.has('degrees') ? p.int('degrees', undefined, -14, 14) : null;
      if (degrees !== null && !key) throw new Error('trill: degrees need a key');
      const interval = p.int('interval', 2, -24, 24);
      const out: Note[] = [];
      for (const n of notes) {
        if (n.duration < minLength - EPS) {
          out.push(n);
          continue;
        }
        const upper = degrees !== null && key ? transposeByDegrees(n.pitch, degrees, key) : key ? snapToScale(n.pitch + interval, key) : n.pitch + interval;
        for (let step = 0, t = n.start_time; t < endOf(n) - EPS; step += 1, t = n.start_time + step * rate) {
          out.push(withFields(n, { pitch: step % 2 === 0 ? n.pitch : upper, start_time: t, duration: Math.min(rate, endOf(n) - t) }));
        }
      }
      return out;
    }
  },

  repeat: {
    kind: 'add',
    summary: 'repeat(length, times=1, transpose_each=0, decay=1): copy the notes `times` more times, `length` beats apart, optionally transposing and fading each copy',
    run(notes, p) {
      p.only('length', 'times', 'transpose_each', 'decay');
      const length = p.number('length', undefined, 0.01);
      const times = p.int('times', 1, 1, 64);
      const each = p.int('transpose_each', 0, -24, 24);
      const decay = p.number('decay', 1, 0, 2);
      const out: Note[] = [];
      for (let copy = 1; copy <= times; copy += 1) {
        for (const n of notes) {
          out.push(fresh(n, { start_time: n.start_time + copy * length, pitch: n.pitch + copy * each, velocity: n.velocity * decay ** copy }));
        }
      }
      return out;
    }
  }
};

export const TRANSFORM_NAMES = Object.keys(TRANSFORMS);
