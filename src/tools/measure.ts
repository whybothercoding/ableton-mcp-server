/**
 * measure: sample the output meters while scenes or clips play (a state machine inside Live, restored when it ends).
 * bounce: record what a track or the main output plays into a scratch audio track and analyze that audio (loudness, true peak, spectrum).
 */
import { analyzeAudioFile, type AnalyzeOptions } from '../audio/analyzer.js';
import { CompositionError } from './composition.js';
import { runAnalyzeAudioClip } from './audio.js';
import type { BridgeClient, ToolSpec } from './spec.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const POLL_MS = 500;
const MEASURE_WAIT_SECONDS = 240;
export const BOUNCE_TRACK_NAME = 'MCP BOUNCE';
const MAX_BOUNCE_BEATS = 128;

/** Starts a measurement and, unless `wait` is false, polls until it ends (or `wait_seconds` pass: then it keeps running and status reads it). */
export async function runMeasure(args: Record<string, any>, client: BridgeClient, _specs?: unknown, pollMs = POLL_MS): Promise<unknown> {
  const { wait, wait_seconds: waitSeconds, ...params } = args;
  if ((params.action ?? 'start') !== 'start') return client.sendCommand('measure', params);
  const started: any = await client.sendCommand('measure', params);
  if (wait === false) return started;
  const limit = Date.now() + (typeof waitSeconds === 'number' ? waitSeconds : MEASURE_WAIT_SECONDS) * 1000;
  let status: any = started;
  while (status.state === 'running') {
    if (Date.now() >= limit) {
      return { ...status, note: 'Still running after the wait: read it later with action status (or stop it with action abort); the Set is restored when it ends.' };
    }
    await sleep(pollMs);
    status = await client.sendCommand('measure', { action: 'status' });
  }
  return status;
}

interface Bounce {
  track?: string;
  masterFader?: number;
  startedPlayback: boolean;
}

/** Records into an empty slot of a scratch audio track (nothing existing can be overwritten) and analyzes the new clip. */
export async function runBounce(
  args: Record<string, any>,
  client: BridgeClient,
  _specs?: unknown,
  analyze: (path: string, options?: AnalyzeOptions) => Promise<unknown> = analyzeAudioFile,
  pollMs = POLL_MS,
  wait: (ms: number) => Promise<unknown> = sleep
): Promise<unknown> {
  const beats = args.beats ?? 16;
  const settleBeats = args.settle_beats ?? 4;
  if (typeof beats !== 'number' || beats < 1 || beats > MAX_BOUNCE_BEATS) throw new CompositionError(`beats must be a number from 1 to ${MAX_BOUNCE_BEATS}`);
  if (typeof settleBeats !== 'number' || settleBeats < 0 || settleBeats > 64) throw new CompositionError('settle_beats must be a number from 0 to 64');
  if (args.confirm_playback !== true) throw new CompositionError('bounce plays the Set through its outputs and creates a scratch track: warn the user, then pass confirm_playback: true');
  const launches: string[] = [];
  if (args.scene !== undefined) launches.push(`scenes/${args.scene}`);
  for (const clip of args.clips ?? []) launches.push(clip.endsWith('/clip') ? clip.slice(0, -5) : clip);
  const song: any = await client.sendCommand('get_properties', { address: 'song', names: ['tempo', 'is_playing'] });
  const tempo = Number(song.properties.tempo) || 120;
  if (!launches.length && !song.properties.is_playing) {
    throw new CompositionError('Nothing is playing: give scene or clips to launch, or start playback first');
  }
  if (launches.length && song.properties.is_playing && args.allow_while_playing !== true) {
    throw new CompositionError('The transport is playing: launching a scene or clips here would replace what is playing, and bounce stops clips when it ends. Stop first, leave scene and clips out to record what plays now, or pass allow_while_playing: true');
  }
  const secondsFor = (b: number) => (b * 60) / tempo;

  // Which routing to record from: a track's output (by its name as the mixer shows it) or the whole main output.
  let routingType = 'Resampling';
  let routingChannel: string | undefined;
  if (args.source !== undefined && args.source !== 'master') {
    const source: any = await client.sendCommand('get_properties', { address: args.source, names: ['name'] });
    routingType = String(source.properties.name);
    routingChannel = args.channel ?? 'Post Mixer';
  }

  const state: Bounce = { startedPlayback: !song.properties.is_playing };
  const analysis: { clip?: unknown; track?: string; error?: unknown } = {};
  try {
    const created: any = await client.sendCommand('create', { kind: 'audio_track', name: BOUNCE_TRACK_NAME });
    state.track = created.address;
    await client.sendCommand('set_properties', { address: state.track, properties: { current_monitoring_state: 'OFF' } });
    const routed: any = await client.sendCommand('routing', {
      address: state.track,
      direction: 'input',
      action: 'set',
      type: routingType,
      ...(routingChannel ? { channel: routingChannel } : {}),
      allow_feedback: true // monitoring is Off; recording from the main output through Resampling cannot loop back
    });
    if (routingType !== 'Resampling' && routed.type?.display_name !== routingType) {
      throw new CompositionError(`Could not route the scratch track's input from '${routingType}' (got '${routed.type?.display_name}')`);
    }
    await client.sendCommand('set_properties', { address: state.track, properties: { arm: true } });
    if (typeof args.master_volume === 'number') {
      const fader: any = await client.sendCommand('get_properties', { address: 'master/mixer/volume', names: ['value'] });
      state.masterFader = fader.properties.value;
      await client.sendCommand('set_properties', { address: 'master/mixer/volume', properties: { value: args.master_volume } });
    }
    for (const address of launches) await client.sendCommand('launch', { address, ...(address.startsWith('scenes/') ? { select: false } : {}) });
    // The launch waits for the next bar of the global quantization (at most 4 beats), then the transient settles.
    await wait(secondsFor((launches.length ? 4 : 0) + settleBeats) * 1000 + 300);
    const slot = `${state.track}/slots/0`;
    await client.sendCommand('launch', { address: slot, record_length: beats, quantization: 'q_no_q' });
    await wait(secondsFor(beats) * 1000);
    const deadline = Date.now() + 20_000;
    for (;;) {
      const clip: any = await client.sendCommand('get_properties', { address: `${slot}/clip`, names: ['is_recording'] }).catch(() => null);
      if (clip && !clip.properties.is_recording) break;
      if (Date.now() > deadline) throw new CompositionError('The recording did not finish within 20 s of its planned length');
      await wait(pollMs);
    }
    if (launches.length || state.startedPlayback) {
      await client.sendCommand('launch', { address: 'song', action: 'stop', quantized: false });
      if (state.startedPlayback) await client.sendCommand('transport', { action: 'stop' });
    }
    analysis.clip = await runAnalyzeAudioClip({ address: `${slot}/clip`, curve: args.curve === true }, client, undefined, analyze);
  } finally {
    // Always leave the Set as it was: master fader back, scratch track gone (the recorded file stays in the project's Samples/Recorded).
    const cleanup = async (command: string, params: Record<string, any>) => {
      try {
        await client.sendCommand(command, params);
      } catch (error) {
        analysis.error = analysis.error ?? `cleanup ${command} failed: ${(error as Error).message}`;
      }
    };
    if (state.masterFader !== undefined) await cleanup('set_properties', { address: 'master/mixer/volume', properties: { value: state.masterFader } });
    if (state.track && args.keep_track !== true) {
      await cleanup('set_properties', { address: state.track, properties: { arm: false } });
      await cleanup('delete', { address: state.track, expect: { name: BOUNCE_TRACK_NAME } });
    }
  }
  return {
    ...(analysis.clip as object),
    source: args.source ?? 'master',
    ...(routingChannel ? { channel: routingChannel } : {}),
    played: launches.length ? launches : 'whatever was already playing',
    beats,
    scratch_track: args.keep_track === true ? state.track : 'deleted',
    note: 'The recorded audio file stays in the project folder (Samples/Recorded); delete it there if you do not need it.',
    ...(analysis.error ? { cleanup_problem: analysis.error } : {})
  };
}

export const MEASURE_SPECS: ToolSpec[] = [
  {
    name: 'measure',
    description:
      "AUDIBLE: plays scenes or clips and samples output meters, then restores what it changed. Warn the user (Live must be in front), pass confirm_playback: true. " +
      "`steps`: [{scene: N} | {clip: 'tracks/N/slots/M'} | {clips: [...]}, set?: [{address, value|display}] before the launch]. " +
      "Gives peak and mean per target in Live's meter units (0.85 = 0 dB; compare steps). `bypass` turns devices off meanwhile (a limiter). wait: false returns at once; then action status or abort.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'status', 'abort'] },
        steps: { type: 'array', items: { type: 'object' } },
        targets: { type: 'array', items: { type: 'string' } },
        settle_beats: { type: 'number' },
        measure_beats: { type: 'number' },
        master_volume: { type: 'number' },
        crossfader: { type: 'number' },
        bypass: { type: 'array', items: { type: 'string' } },
        stop_after: { type: 'boolean' },
        confirm_playback: { type: 'boolean' },
        allow_while_playing: { type: 'boolean' },
        wait: { type: 'boolean' },
        wait_seconds: { type: 'number' }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    bridge: { command: 'measure' },
    run: runMeasure
  },
  {
    name: 'bounce',
    description:
      "AUDIBLE: records a track or the main output into a scratch track 'MCP BOUNCE' and analyzes it with ffmpeg (LUFS, true peak, spectrum), then deletes the track (the file stays in Samples/Recorded). " +
      "`source`: 'master' (default) or a track address, `channel` 'Post Mixer' (default), 'Post FX', 'Pre FX'. Launches scene or clips, else records what plays. Warn the user, pass confirm_playback: true.",
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        channel: { type: 'string' },
        scene: { type: 'number' },
        clips: { type: 'array', items: { type: 'string' } },
        beats: { type: 'number' },
        settle_beats: { type: 'number' },
        master_volume: { type: 'number' },
        keep_track: { type: 'boolean' },
        curve: { type: 'boolean' },
        allow_while_playing: { type: 'boolean' },
        confirm_playback: { type: 'boolean' }
      },
      required: ['confirm_playback']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    bridge: { command: 'launch' },
    requires: ['create', 'routing', 'set_properties', 'get_properties', 'delete', 'transport'],
    run: runBounce
  }
];
