import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOUNCE_TRACK_NAME, MEASURE_SPECS, runBounce, runMeasure } from '../../src/tools/measure.js';

const noWait = async () => undefined;

// ---------------------------------------------------------------- measure

test('measure starts the run and polls its status until it ends', async () => {
  const calls: any[] = [];
  const statuses = [{ state: 'running', step: 1 }, { state: 'running', step: 2 }, { state: 'done', results: [{ index: 0 }] }];
  const client = {
    sendCommand: async (type: string, params: any) => {
      calls.push({ type, params });
      return params.action === 'status' ? statuses.shift() : { state: 'running', step: 0 };
    }
  };
  const out: any = await runMeasure({ steps: [{ scene: 1 }], confirm_playback: true, wait_seconds: 5 }, client, undefined, 1);
  assert.equal(out.state, 'done');
  assert.deepEqual(calls[0], { type: 'measure', params: { steps: [{ scene: 1 }], confirm_playback: true } });      // wait settings stay in the MCP server
  assert.equal(calls.filter((c) => c.params.action === 'status').length, 3);
});

test('measure with wait: false returns at once, and status and abort pass straight through', async () => {
  const calls: string[] = [];
  const client = { sendCommand: async (_t: string, params: any) => (calls.push(params.action ?? 'start'), { state: 'running' }) };
  assert.deepEqual(await runMeasure({ steps: [], wait: false }, client, undefined, 1), { state: 'running' });
  await runMeasure({ action: 'status' }, client, undefined, 1);
  await runMeasure({ action: 'abort' }, client, undefined, 1);
  assert.deepEqual(calls, ['start', 'status', 'abort']);
});

test('measure that outlasts the wait says it is still running and how to read it', async () => {
  const client = { sendCommand: async () => ({ state: 'running' }) };
  const out: any = await runMeasure({ steps: [{ scene: 0 }], wait_seconds: 0.02 }, client, undefined, 5);
  assert.equal(out.state, 'running');
  assert.match(out.note, /action status/);
});

test('measure and bounce are advertised, audible tools that need an explicit confirmation', () => {
  const [measure, bounce] = MEASURE_SPECS;
  assert.deepEqual([measure.name, bounce.name], ['measure', 'bounce']);
  assert.match(measure.description, /confirm_playback/);
  assert.deepEqual(bounce.inputSchema.required, ['confirm_playback']);
  assert.equal(measure.annotations.readOnlyHint, false);
});

// ---------------------------------------------------------------- bounce

/** A bridge that records every command and answers like Live would; `fail` makes one command throw. */
function bounceBridge(over: { playing?: boolean; fail?: string } = {}) {
  const calls: { type: string; params: any }[] = [];
  const client = {
    sendCommand: async (type: string, params: any) => {
      calls.push({ type, params });
      if (over.fail && type === over.fail) throw new Error(`${type} failed`);
      if (type === 'get_properties') {
        if (params.address === 'song') return { properties: { tempo: 120, is_playing: over.playing ?? false } };
        if (params.address === 'tracks/5') return { properties: { name: '6' } };
        if (params.address === 'master/mixer/volume') return { properties: { value: 0.85 } };
        if (params.address.endsWith('/clip') && params.names.includes('is_recording')) return { properties: { is_recording: false } };
        if (params.address.endsWith('/clip')) return { kind: 'clip', address: params.address, properties: { is_audio_clip: true, name: 'rec', file_path: '/proj/Samples/Recorded/rec.wav', length: 16, warping: false, warp_mode: 'beats', sample_rate: 44100, gain: 0.4, gain_display_string: '0.00 dB', pitch_coarse: 0, pitch_fine: 0 } };
      }
      if (type === 'create') return { address: 'tracks/31' };
      if (type === 'routing') return { type: { display_name: params.type }, channel: { display_name: params.channel ?? '' } };
      return {};
    }
  };
  return { client, calls, types: () => calls.map((c) => c.type) };
}

const analyze = async (path: string) => ({ lufs: -14, path });

test('bounce records a track into an empty slot of a scratch track, analyzes it and cleans up', async () => {
  const { client, calls } = bounceBridge();
  const out: any = await runBounce({ source: 'tracks/5', scene: 4, beats: 8, master_volume: 0.5, confirm_playback: true }, client, undefined, analyze, 1, noWait);
  const created = calls.find((c) => c.type === 'create');
  assert.deepEqual(created!.params, { kind: 'audio_track', name: BOUNCE_TRACK_NAME });
  const routing = calls.find((c) => c.type === 'routing')!;
  assert.deepEqual([routing.params.address, routing.params.type, routing.params.channel], ['tracks/31', '6', 'Post Mixer']);      // the track is routed by its mixer name
  const monitoringOff = calls.findIndex((c) => c.params.properties?.current_monitoring_state === 'OFF');
  assert.ok(monitoringOff >= 0 && monitoringOff < calls.indexOf(routing), 'monitoring goes off before the input is routed');
  const record = calls.find((c) => c.params.record_length !== undefined)!;
  assert.deepEqual([record.params.address, record.params.record_length, record.params.quantization], ['tracks/31/slots/0', 8, 'q_no_q']);
  assert.ok(calls.findIndex((c) => c.params.address === 'scenes/4') < calls.indexOf(record), 'the scene is launched before the recording starts');
  assert.deepEqual(out.analysis, { lufs: -14, path: '/proj/Samples/Recorded/rec.wav' });
  // clean up: stop what was started, main fader back, scratch track disarmed and deleted with a name guard
  const types = calls.map((c) => c.type);
  assert.ok(types.includes('transport'), 'transport stopped because the bounce started it');
  assert.ok(calls.some((c) => c.type === 'set_properties' && c.params.address === 'master/mixer/volume' && c.params.properties.value === 0.85));
  const deleted = calls[calls.length - 1];
  assert.deepEqual([deleted.type, deleted.params.address, deleted.params.expect], ['delete', 'tracks/31', { name: BOUNCE_TRACK_NAME }]);
  assert.equal(out.scratch_track, 'deleted');
});

test('bounce of the main output records through Resampling', async () => {
  const { client, calls } = bounceBridge({ playing: true });
  await runBounce({ confirm_playback: true }, client, undefined, analyze, 1, noWait);              // nothing to launch: records what plays
  const routing = calls.find((c) => c.type === 'routing')!;
  assert.deepEqual([routing.params.type, routing.params.channel], ['Resampling', undefined]);
  assert.ok(!calls.some((c) => c.type === 'transport'), 'it did not start the transport, so it does not stop it');
  assert.ok(!calls.some((c) => c.params.action === 'song'), 'nothing was launched, so nothing is stopped');
});

test('bounce cleans up when something fails midway', async () => {
  const { client, calls } = bounceBridge({ fail: 'routing' });
  await assert.rejects(runBounce({ source: 'tracks/5', scene: 1, master_volume: 0.5, confirm_playback: true }, client, undefined, analyze, 1, noWait), /routing failed/);
  assert.ok(calls.some((c) => c.type === 'delete' && c.params.address === 'tracks/31'), 'the scratch track is deleted');
  const failedBeforeFader = !calls.some((c) => c.params.address === 'master/mixer/volume');
  assert.ok(failedBeforeFader, 'the main fader was never touched, so it is not "restored"');
});

test('bounce refuses what would surprise the user, before touching the Set', async () => {
  const idle = bounceBridge();
  await assert.rejects(runBounce({ scene: 1 }, idle.client, undefined, analyze, 1, noWait), /confirm_playback/);
  await assert.rejects(runBounce({ confirm_playback: true }, idle.client, undefined, analyze, 1, noWait), /Nothing is playing/);
  await assert.rejects(runBounce({ scene: 1, beats: 500, confirm_playback: true }, idle.client, undefined, analyze, 1, noWait), /beats must be/);
  assert.ok(!idle.types().includes('create'), 'no scratch track was created');
  const busy = bounceBridge({ playing: true });
  await assert.rejects(runBounce({ scene: 1, confirm_playback: true }, busy.client, undefined, analyze, 1, noWait), /allow_while_playing/);
  assert.ok(!busy.types().includes('create'));
});
