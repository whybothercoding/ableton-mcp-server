/**
 * transform_notes and generate_notes: the composition tools. The music itself is pure code in src/music; this file reads
 * notes from Live, runs a transform or generator, and writes the result back with the fewest, safest bridge calls:
 * modify (ids kept) for in-place transforms, one atomic replace for rebuilds, write_notes for additions.
 */
import { GENERATORS, GENERATOR_NAMES } from '../music/generators.js';
import { Params, ParamError } from '../music/params.js';
import { pitchToName } from '../music/theory.js';
import { TRANSFORMS, TRANSFORM_NAMES, finalize } from '../music/transforms.js';
import { EPS, Note } from '../music/types.js';
import type { BridgeClient, ToolSpec } from './spec.js';

const MAX_NOTES = 5000;
const PREVIEW = 24;
const NOTE_FIELDS = ['pitch', 'start_time', 'duration', 'velocity', 'mute', 'probability', 'velocity_deviation', 'release_velocity'] as const;
const RANGE_KEYS = ['from_time', 'time_span', 'from_pitch', 'pitch_span'] as const;

/** A tool-level failure that should reach the caller as a plain message. */
export class CompositionError extends Error {}

const forBridge = (note: Note): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const field of NOTE_FIELDS) if (note[field] !== undefined) out[field] = note[field];
  return out;
};

const preview = (notes: Note[]) =>
  [...notes]
    .sort((a, b) => a.start_time - b.start_time || a.pitch - b.pitch)
    .slice(0, PREVIEW)
    .map((n) => ({ note: pitchToName(n.pitch), pitch: n.pitch, start_time: n.start_time, duration: n.duration, velocity: n.velocity }));

const selectionOf = (args: Record<string, any>): Record<string, any> => {
  const selection: Record<string, any> = {};
  for (const key of RANGE_KEYS) if (args[key] !== undefined && args[key] !== null) selection[key] = args[key];
  return selection;
};

function unknown(kind: string, name: unknown, names: string[]): CompositionError {
  return new CompositionError(`Unknown ${kind} '${String(name)}'. ${kind === 'transform' ? 'Transforms' : 'Generators'}: ${names.join(', ')}`);
}

/** Runs pure music code, turning its parameter errors into readable tool errors. */
function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ParamError || err instanceof Error) throw new CompositionError((err as Error).message);
    throw err;
  }
}

const differs = (a: unknown, b: unknown): boolean => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) > 1e-6 : a !== b);

export async function transformNotes(args: Record<string, any>, client: BridgeClient): Promise<unknown> {
  const spec = TRANSFORMS[args.transform];
  if (!spec) throw unknown('transform', args.transform, TRANSFORM_NAMES);
  const address: string = args.address;
  const ids: number[] | undefined = args.ids;
  const range = selectionOf(args);
  if (ids && Object.keys(range).length) throw new CompositionError('Select notes with ids or with a range (from_time/time_span/from_pitch/pitch_span), not both');
  if (ids && spec.kind !== 'modify') {
    throw new CompositionError(`'${args.transform}' builds new notes, so it works on a range or the whole clip, not on ids. Use from_time/time_span (and from_pitch/pitch_span) to choose the notes.`);
  }
  const fetched = await client.sendCommand('get_notes', { address, ...(ids ? { ids } : range), limit: MAX_NOTES });
  if (fetched.truncated) throw new CompositionError(`The selection holds more than ${MAX_NOTES} notes: narrow it with from_time/time_span`);
  const notes: Note[] = fetched.notes;
  if (!notes.length) throw new CompositionError('There are no notes in that selection: nothing to transform');

  const raw = guarded(() => spec.run(notes, new Params(args.transform, args.params ?? {})));
  const { notes: result, dropped } = finalize(raw);
  const summary = { address, transform: args.transform, kind: spec.kind, input_notes: notes.length, output_notes: result.length, dropped, dry_run: Boolean(args.dry_run) };

  if (spec.kind === 'modify') {
    if (dropped) {
      throw new CompositionError(`${args.transform} would move ${dropped} note(s) outside the MIDI range or before the start of the clip: nothing was changed. Use a smaller amount or select fewer notes.`);
    }
    const before = new Map(notes.map((n) => [n.id, n]));
    const changes = result
      .map((after) => {
        const was = before.get(after.id) as Note;
        const changed: Record<string, unknown> = { id: after.id };
        for (const field of NOTE_FIELDS) if (differs(after[field], was[field])) changed[field] = after[field];
        return changed;
      })
      .filter((c) => Object.keys(c).length > 1);
    if (!changes.length) return { ...summary, changed: 0, note: 'The transform left every note as it was', preview: preview(result) };
    if (args.dry_run) return { ...summary, changed: changes.length, preview: preview(result) };
    const applied = await client.sendCommand('edit_notes', { address, action: 'modify', changes, ...(args.expect ? { expect: args.expect } : {}) });
    return { ...summary, changed: changes.length, note_count: applied.note_count, clip: applied.clip, preview: preview(result) };
  }

  if (!result.length) throw new CompositionError(`${args.transform} produced no notes (${dropped} fell outside the MIDI range or before the clip start): nothing was changed`);
  if (args.dry_run) return { ...summary, preview: preview(result) };
  const expect = args.expect ? { expect: args.expect } : {};
  if (spec.kind === 'add') {
    const applied = await client.sendCommand('write_notes', { address, notes: result.map(forBridge), ...expect });
    return { ...summary, added: applied.written, note_count: applied.note_count, clip: applied.clip, preview: preview(result) };
  }
  const applied = await client.sendCommand('edit_notes', { address, action: 'replace', notes: result.map(forBridge), ...range, ...expect });
  return { ...summary, replaced: applied.removed, written: applied.written, note_count: applied.note_count, clip: applied.clip, preview: preview(result) };
}

export async function generateNotes(args: Record<string, any>, client: BridgeClient): Promise<unknown> {
  const spec = GENERATORS[args.generator];
  if (!spec) throw unknown('generator', args.generator, GENERATOR_NAMES);
  const address: string = args.address;
  const offset = args.start_time ?? 0;
  const mode: string = args.mode ?? 'add';
  if (!['add', 'replace_span', 'replace_all'].includes(mode)) throw new CompositionError('mode must be one of: add, replace_span, replace_all');
  if (typeof offset !== 'number' || offset < 0) throw new CompositionError('start_time must be a number of beats from 0');
  const head = await client.sendCommand('get_notes', { address, limit: 1 });   // also checks that this is a MIDI clip
  const { notes: generated, length } = guarded(() => spec.run(new Params(args.generator, args.params ?? {})));
  const { notes: result, dropped } = finalize(generated.map((n) => ({ ...n, start_time: n.start_time + offset })));
  if (!result.length) throw new CompositionError(`${args.generator} produced no notes with these parameters: nothing was changed`);
  const end = Math.max(...result.map((n) => n.start_time + n.duration));
  const summary: Record<string, unknown> = {
    address, generator: args.generator, mode, notes: result.length, start_time: offset, length, dropped, dry_run: Boolean(args.dry_run)
  };
  const loopEnd: number = head.clip.loop_end;
  const warn = (clip: { loop_end: number }): string | undefined =>
    end > clip.loop_end + EPS
      ? `The music runs to beat ${Math.round(end * 1000) / 1000} but the clip loops at ${clip.loop_end}: notes after that will not play. Lengthen the clip with set_properties (loop_end and end_marker), or generate less.`
      : undefined;
  if (args.dry_run) return { ...summary, warning: warn({ loop_end: loopEnd }), preview: preview(result) };
  const expect = args.expect ? { expect: args.expect } : {};
  let applied: any;
  if (mode === 'add') applied = await client.sendCommand('write_notes', { address, notes: result.map(forBridge), ...expect });
  else applied = await client.sendCommand('edit_notes', {
    address, action: 'replace', notes: result.map(forBridge), ...(mode === 'replace_span' ? { from_time: offset, time_span: length } : {}), ...expect
  });
  return { ...summary, removed: applied.removed ?? 0, written: applied.written, note_count: applied.note_count, clip: applied.clip, warning: warn(applied.clip), preview: preview(result) };
}

const catalog = (entries: Record<string, { summary: string }>): string => Object.values(entries).map((e) => e.summary).join(' | ');

const SELECTION_PROPERTIES = {
  from_time: { type: 'number', description: 'Only notes starting at or after this beat' },
  time_span: { type: 'number', description: 'Length of the time range in beats' },
  from_pitch: { type: 'number', description: 'Lowest pitch of the range' },
  pitch_span: { type: 'number', description: 'Number of pitches in the range' }
};

export const COMPOSITION_SPECS: ToolSpec[] = [
  {
    name: 'transform_notes',
    description:
      "Change notes already in a MIDI clip with a music transform: reads the notes, transforms them, writes the result in ONE undo step. `address`: a MIDI clip. `transform` + `params` (times in beats; rates like '1/16', '1/8t' triplet; " +
      "keys like 'C minor'; pitches as numbers or Ableton names where C3 = 60). Select notes with a range (from_time/time_span/from_pitch/pitch_span) or, for in-place transforms, `ids` from get_notes; default is every note. " +
      "`dry_run` previews without writing. In-place transforms keep note ids and settings; others replace the selected notes or add new ones. Notes that would land outside MIDI range or before beat 0 refuse in-place transforms. " +
      "Transforms: " + catalog(TRANSFORMS),
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: "A MIDI clip, e.g. 'tracks/2/slots/0/clip'" },
        transform: { type: 'string', enum: TRANSFORM_NAMES, description: 'Which transform' },
        params: { type: 'object', description: "The transform's parameters (see the list in the tool description)" },
        ids: { type: 'array', items: { type: 'number' }, description: 'Only these note ids (in-place transforms)' },
        ...SELECTION_PROPERTIES,
        dry_run: { type: 'boolean', description: 'Preview the result without changing the clip' },
        expect: { type: 'object', description: 'Guard: {"name": "..."} must match the clip' }
      },
      required: ['address', 'transform']
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    bridge: { command: 'edit_notes' },
    requires: ['get_notes', 'write_notes'],
    run: transformNotes
  },
  {
    name: 'generate_notes',
    description:
      "Compose notes into a MIDI clip from a generator, in one undo step. `address`: a MIDI clip (create one with create kind midi_clip; the clip must be long enough: the result warns if the music runs past its loop end). " +
      "`generator` + `params` (beats; rates like '1/16'; keys like 'C minor'; chords by roman numeral with a key, or symbols like Am7; pitches as numbers or names where C3 = 60; `seed` makes random choices repeatable). " +
      "`start_time` offsets everything (beats). `mode`: add (default; keeps existing notes), replace_span (replaces notes inside the generated span) or replace_all. `dry_run` previews. " +
      "Generators: " + catalog(GENERATORS),
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: "A MIDI clip, e.g. 'tracks/2/slots/0/clip'" },
        generator: { type: 'string', enum: GENERATOR_NAMES, description: 'Which generator' },
        params: { type: 'object', description: "The generator's parameters (see the list in the tool description)" },
        start_time: { type: 'number', description: 'Beat where the generated music starts (default 0)' },
        mode: { type: 'string', enum: ['add', 'replace_span', 'replace_all'], description: 'Default add' },
        dry_run: { type: 'boolean', description: 'Preview the result without changing the clip' },
        expect: { type: 'object', description: 'Guard: {"name": "..."} must match the clip' }
      },
      required: ['address', 'generator']
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    bridge: { command: 'write_notes' },
    requires: ['get_notes', 'edit_notes'],
    run: generateNotes
  }
];
