/** analyze_audio_clip: measure the audio file behind a clip (loudness, peaks, spectrum) with ffmpeg on the MCP host. */
import { analyzeAudioFile } from '../audio/analyzer.js';
import { CompositionError } from './composition.js';
import type { BridgeClient, ToolSpec } from './spec.js';

const POLL_MS = 300;
const WAIT_MS = 15_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const CLIP_FIELDS = ['name', 'file_path', 'length', 'warping', 'warp_mode', 'sample_rate', 'gain', 'gain_display_string', 'pitch_coarse', 'pitch_fine', 'is_audio_clip'];

export async function runAnalyzeAudioClip(
  args: Record<string, any>,
  client: BridgeClient,
  _specs?: unknown,
  analyze: (path: string) => Promise<unknown> = analyzeAudioFile
): Promise<unknown> {
  const kind: any = await client.sendCommand('get_properties', { address: args.address, names: ['is_audio_clip'] });
  if (kind.kind !== 'clip') throw new CompositionError(`'${kind.address}' is a ${kind.kind}: analyze_audio_clip needs an audio clip address (tracks/N/slots/M/clip)`);
  if (!kind.properties.is_audio_clip) throw new CompositionError(`'${kind.address}' is a MIDI clip: only audio clips have a file to analyze`);
  const info: any = await client.sendCommand('get_properties', { address: args.address, names: CLIP_FIELDS });
  const clip = info.properties;
  if (!clip.file_path) throw new CompositionError(`'${info.address}' has no source file (it may be a freshly recorded clip that Live has not saved yet)`);
  const { is_audio_clip: _ignored, ...described } = clip;
  void _ignored;
  return { clip: { address: info.address, ...described }, analysis: await analyze(clip.file_path) };
}

/** audio_to_midi finishes in the background in Live: wait for the track to appear, found by comparing track hashes before and after. */
export async function runConvert(args: Record<string, any>, client: BridgeClient, _specs?: unknown, pollMs = POLL_MS, waitMs = WAIT_MS): Promise<unknown> {
  const before: any = args.action === 'audio_to_midi' ? await client.sendCommand('describe_set', { include_clips: false }) : null;
  const result: any = await client.sendCommand('convert', args);
  if (!result.pending || !before) return result;
  const known = new Set<string>(before.tracks.map((t: any) => t.hash));
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    await sleep(pollMs);
    const now: any = await client.sendCommand('describe_set', { include_clips: true });
    const created = now.tracks.filter((t: any) => !known.has(t.hash));
    if (created.length) {
      const { pending: _pending, ...rest } = result;
      void _pending;
      return {
        ...rest,
        new_tracks: created.map((t: any) => ({ address: t.address, name: t.name, devices: t.devices, clips: (t.clips ?? []).map((c: any) => ({ slot: c.slot, name: c.name, kind: c.kind })) })),
        waited_ms: Date.now() - started
      };
    }
  }
  return { ...result, note: `Live had not created a track after ${waitMs / 1000} s: the clip may be too short or have nothing to convert; check describe_set later` };
}

export const AUDIO_SPECS: ToolSpec[] = [
  {
    name: 'analyze_audio_clip',
    description:
      "Analyze the source file of an audio clip (`address`: 'tracks/N/slots/M/clip') locally with ffmpeg: format metadata, integrated loudness (LUFS), sample and true peak, RMS and an approximate six-band frequency profile, " +
      "next to the clip's own settings (warping, gain, pitch). Needs ffmpeg and ffprobe on the MCP host. Compressed Ableton .aif files and REX files cannot be analyzed and say so.",
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: "An audio clip, e.g. 'tracks/2/slots/0/clip'" } },
      required: ['address']
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    bridge: { command: 'get_properties' },
    run: runAnalyzeAudioClip
  },
  {
    name: 'convert',
    description:
      "Live's audio conversions (edition dependent: Live's own refusal comes through). `action`: check (can this audio clip become MIDI?), audio_to_midi (`type` harmony|melody|drums: a new MIDI track with the extracted notes), " +
      "simpler_track (a new MIDI track with a Simpler playing the clip), drum_rack_from_clip (a new track with a Drum Rack, the clip on the first pad), pad_to_track (`address` of a drum pad: its chain becomes its own MIDI track), " +
      "slice_to_drum_rack (`address` of a Simpler in Slicing mode: every slice gets a pad). `address` is the audio clip (or pad, or Simpler). Returns the new tracks with their addresses, devices and clips; audio_to_midi finishes in the background in Live, so this waits for the new track (up to 15 s). One undo step.",
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Audio clip (check, audio_to_midi, simpler_track, drum_rack_from_clip), drum pad (pad_to_track) or Simpler device (slice_to_drum_rack)' },
        action: { type: 'string', enum: ['check', 'audio_to_midi', 'simpler_track', 'drum_rack_from_clip', 'pad_to_track', 'slice_to_drum_rack'], description: 'What to convert' },
        type: { type: 'string', enum: ['harmony', 'melody', 'drums'], description: 'audio_to_midi: what to extract' }
      },
      required: ['address', 'action']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    bridge: { command: 'convert' },
    run: runConvert
  }
];
