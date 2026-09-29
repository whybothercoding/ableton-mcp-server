import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAnalyzeAudioClip, runConvert } from '../../src/tools/audio.js';

const clipReply = (over: Record<string, any> = {}) => ({
  address: 'tracks/3/slots/1/clip',
  properties: { name: 'Loop', file_path: '/music/loop.wav', length: 4, warping: true, warp_mode: 'beats', sample_rate: 44100, gain: 0.4, gain_display_string: '0.00 dB', pitch_coarse: 0, pitch_fine: 0, is_audio_clip: true, ...over }
});

test('the clip settings and the file analysis come back together', async () => {
  const calls: any[] = [];
  const client = { sendCommand: async (type: string, params: any) => (calls.push({ type, params }), params.names.length === 1 ? { kind: 'clip', address: 'tracks/3/slots/1/clip', properties: { is_audio_clip: true } } : clipReply()) };
  const out: any = await runAnalyzeAudioClip({ address: 'tracks/3/slots/1/clip' }, client, undefined, async (path) => ({ analyzed: path }));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].type, 'get_properties');
  assert.deepEqual(calls[0].params.names, ['is_audio_clip']);            // a MIDI clip has no file_path: ask about the kind first
  assert.equal(calls[1].params.address, 'tracks/3/slots/1/clip');
  assert.ok(calls[1].params.names.includes('file_path'));
  assert.deepEqual(out.analysis, { analyzed: '/music/loop.wav' });
  assert.equal(out.clip.address, 'tracks/3/slots/1/clip');
  assert.equal(out.clip.gain_display_string, '0.00 dB');
  assert.equal('is_audio_clip' in out.clip, false);
});

test('MIDI clips and clips without a file say so instead of failing inside ffmpeg', async () => {
  const analyze = async () => {
    throw new Error('must not be called');
  };
  const reply = (over: Record<string, any>) => async (_type: string, params: any) => (params.names.length === 1 ? { kind: 'clip', address: 'a', properties: { is_audio_clip: over.is_audio_clip ?? true } } : clipReply(over));
  await assert.rejects(runAnalyzeAudioClip({ address: 'a' }, { sendCommand: reply({ is_audio_clip: false }) }, undefined, analyze), /is a MIDI clip/);
  await assert.rejects(runAnalyzeAudioClip({ address: 'a' }, { sendCommand: reply({ file_path: '' }) }, undefined, analyze), /has no source file/);
  await assert.rejects(runAnalyzeAudioClip({ address: 'tracks/0' }, { sendCommand: async () => ({ kind: 'track', address: 'tracks/0', properties: { is_audio_clip: undefined } }) }, undefined, analyze), /is a track: analyze_audio_clip needs an audio clip/);
});

test('an analysis error reaches the caller unchanged', async () => {
  await assert.rejects(
    runAnalyzeAudioClip({ address: 'a' }, { sendCommand: async (_t: string, p: any) => (p.names.length === 1 ? { kind: 'clip', address: 'a', properties: { is_audio_clip: true } } : clipReply()) }, undefined, async () => {
      throw new Error('ffmpeg is not installed');
    }),
    /ffmpeg is not installed/
  );
});

/** A bridge whose set gains a track `appearsAfter` describe_set calls after convert. */
function convertBridge(appearsAfter: number | null, pending = true) {
  let polls = 0;
  let converted = false;
  const calls: string[] = [];
  const base = [{ address: 'tracks/0', name: 'Loops', hash: 'h0', devices: [], clips: [] }];
  return {
    calls,
    async sendCommand(type: string, params: any) {
      calls.push(type);
      if (type === 'describe_set') {
        if (converted) polls += 1;
        const grown = converted && appearsAfter !== null && polls > appearsAfter;
        return { tracks: grown ? [...base, { address: 'tracks/1', name: 'Drums to MIDI', hash: 'h1', devices: ['Drum Rack'], clips: [{ slot: 0, name: 'Drums', kind: 'midi', length: 4 }] }] : base };
      }
      converted = true;
      return { action: params.action, source: params.address, new_tracks: [], ...(pending ? { pending: true } : {}) };
    }
  };
}

test('an audio-to-MIDI conversion waits for Live to create the track and returns it', async () => {
  const bridge = convertBridge(2);
  const out: any = await runConvert({ action: 'audio_to_midi', address: 'tracks/0/slots/0/clip', type: 'drums' }, bridge, undefined, 1, 5000);
  assert.deepEqual(out.new_tracks, [{ address: 'tracks/1', name: 'Drums to MIDI', devices: ['Drum Rack'], clips: [{ slot: 0, name: 'Drums', kind: 'midi' }] }]);
  assert.equal(out.pending, undefined);
  assert.ok(out.waited_ms >= 0);
  assert.equal(bridge.calls[0], 'describe_set');      // the tracks are noted before converting
});

test('a conversion that never produces a track says so after the wait', async () => {
  const out: any = await runConvert({ action: 'audio_to_midi', address: 'a', type: 'melody' }, convertBridge(null), undefined, 1, 30);
  assert.deepEqual(out.new_tracks, []);
  assert.match(out.note, /had not created a track/);
});

test('other conversions are one bridge call with no waiting', async () => {
  const bridge = convertBridge(0, false);
  const out: any = await runConvert({ action: 'simpler_track', address: 'a' }, bridge, undefined, 1, 30);
  assert.deepEqual(bridge.calls, ['convert']);
  assert.equal(out.action, 'simpler_track');
  const sync = convertBridge(0, false);
  await runConvert({ action: 'audio_to_midi', address: 'a', type: 'drums' }, sync, undefined, 1, 30);
  assert.deepEqual(sync.calls, ['describe_set', 'convert']);    // finished at once: nothing to wait for
});
