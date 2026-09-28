// MCP-layer test: spawns dist/index.js and drives the automation/ramp tools through a real MCP client,
// so tool schemas, argument handling and error reporting are exercised end to end. Needs a running Live.
//
//   npm run build && node test/mcp-tools.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = new Client({ name: 'mcp-tools-test', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: 'node', args: [path.join(root, 'dist', 'index.js')], stderr: 'ignore' }));

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const near = (a, b, tol, label) => assert(Math.abs(a - b) <= tol, `${label}: expected ${b} ± ${tol}, got ${a}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tool(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* plain-text error */
  }
  return { isError: Boolean(result.isError), data, text };
}
async function ok(name, args) {
  const r = await tool(name, args);
  assert(!r.isError, `${name} failed: ${r.text}`);
  return r.data;
}
async function fails(name, args, fragment) {
  const r = await tool(name, args);
  assert(r.isError, `${name} should have failed`);
  assert(r.text.includes(fragment), `${name}: expected "${fragment}" in "${r.text}"`);
}

// discovery through the public tools
const session = await ok('get_bulk_session_structure');
let T, S, D, P;
for (const track of session.tracks) {
  if (!track.is_midi_track || track.device_count < 1) continue;
  const detail = await ok('get_track_detail', { track_index: track.index });
  const free = detail.clip_slots.find((slot) => !slot.has_clip);
  const params = (await ok('get_device_parameters', { track_index: track.index, device_index: 0 })).parameters;
  const p = params.find((x) => x.index > 0 && x.max > x.min && !/\bon\b|type|mode|sync/i.test(x.name) && !Number.isInteger(x.value));
  if (free && p) {
    [T, S, D, P] = [track.index, free.index, 0, p];
    break;
  }
}
assert(T !== undefined, 'no MIDI track with a device and a free slot');
const original = P.value;
const span = P.max - P.min;
const target = { track_index: T, device_index: D, parameter_index: P.index };
console.log(`Track ${T}, parameter "${P.name}", scratch slot ${S}\n`);

try {
  await ok('create_clip', { track_index: T, clip_index: S, length: 4, name: 'MCP TOOL TEST' });

  console.log('Tool listing');
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await check('all four new tools are listed exactly once with object schemas', async () => {
    assert(new Set(tools.map((t) => t.name)).size === tools.length, 'duplicate tool names');
    for (const name of ['draw_automation', 'clear_automation', 'ramp_parameter', 'cancel_ramps']) {
      assert(byName[name], `${name} missing`);
      assert(byName[name].inputSchema.type === 'object', `${name} schema is not an object`);
      assert(byName[name].description.length > 40, `${name} has no useful description`);
    }
  });
  await check('required arguments are declared', async () => {
    assert(JSON.stringify(byName.draw_automation.inputSchema.required) === JSON.stringify(['track_index', 'clip_index', 'points']), 'draw_automation.required');
    assert(JSON.stringify(byName.clear_automation.inputSchema.required) === JSON.stringify(['track_index', 'clip_index']), 'clear_automation.required');
    assert(JSON.stringify(byName.ramp_parameter.inputSchema.required) === JSON.stringify(['track_index', 'to']), 'ramp_parameter.required');
    assert(byName.cancel_ramps.inputSchema.required === undefined, 'cancel_ramps takes no required args');
  });
  await check('point schema and curve enums are exposed', async () => {
    const point = byName.draw_automation.inputSchema.properties.points.items;
    assert(JSON.stringify(point.required) === JSON.stringify(['time', 'value']), 'point.required');
    assert(byName.draw_automation.inputSchema.properties.curve.enum.includes('step'), 'draw curve enum');
    assert(!byName.ramp_parameter.inputSchema.properties.curve.enum.includes('step'), 'ramp curve must not offer step');
  });

  console.log('\nTool calls');
  await check('draw_automation via MCP with a device parameter', async () => {
    const out = await ok('draw_automation', {
      ...target, clip_index: S, points: [{ time: 0, value: P.min + 0.2 * span }, { time: 4, value: P.min + 0.8 * span }], curve: 'smooth'
    });
    assert(out.parameter === P.name && out.steps > 10 && out.mode === 'replace', JSON.stringify(out));
    for (const row of out.readback) near(row.actual, row.expected, 1e-4 * span, `readback @${row.time}`);
  });
  await check('draw_automation via MCP on the mixer, optional device fields omitted', async () => {
    const out = await ok('draw_automation', { track_index: T, clip_index: S, mixer_parameter: 'volume', points: [{ time: 0, value: 0.4 }, { time: 4, value: 0.7 }] });
    assert(out.parameter === 'Volume' || /vol/i.test(out.parameter), out.parameter);
    assert(out.target.mixer_parameter === 'volume', JSON.stringify(out.target));
  });
  await check('draw_automation merge and hold=false through MCP', async () => {
    const out = await ok('draw_automation', {
      ...target, clip_index: S, mode: 'merge', hold: false, curve: 'step',
      points: [{ time: 1, value: P.min + 0.5 * span }, { time: 3, value: P.min + 0.5 * span }]
    });
    assert(out.mode === 'merge', JSON.stringify(out));
  });
  await check('clear_automation via MCP: one parameter, then everything', async () => {
    const one = await ok('clear_automation', { ...target, clip_index: S });
    assert(one.had_envelope === true && one.cleared === P.name, JSON.stringify(one));
    const all = await ok('clear_automation', { track_index: T, clip_index: S });
    assert(all.cleared === 'all' && all.clip_has_envelopes === false, JSON.stringify(all));
  });
  await check('ramp_parameter via MCP in beats, with optional fields omitted', async () => {
    const out = await ok('ramp_parameter', { ...target, to: P.min + 0.9 * span, from: P.min + 0.1 * span, beats: 0.5, curve: 'ease_out' });
    assert(out.curve === 'ease_out' && out.seconds > 0 && out.active_ramps >= 1, JSON.stringify(out));
    await sleep(out.seconds * 1000 + 300);
    const now = await ok('get_device_parameters', { track_index: T, device_index: D });
    near(now.parameters.find((x) => x.index === P.index).value, P.min + 0.9 * span, 1e-6 * span, 'landed on target');
  });
  await check('cancel_ramps via MCP with and without arguments', async () => {
    await ok('ramp_parameter', { ...target, to: P.max, from: P.min, seconds: 5 });
    const one = await ok('cancel_ramps', target);
    assert(one.cancelled === 1, JSON.stringify(one));
    await ok('ramp_parameter', { ...target, to: P.max, from: P.min, seconds: 5 });
    const all = await ok('cancel_ramps');
    assert(all.cancelled === 1 && all.active_ramps === 0, JSON.stringify(all));
  });
  await check('errors come back as tool errors with the reason', async () => {
    await fails('draw_automation', { ...target, clip_index: S }, 'non-empty');
    await fails('draw_automation', { ...target, clip_index: S, points: [{ time: 99, value: 0 }] }, 'outside the clip');
    await fails('draw_automation', { track_index: 999, clip_index: S, mixer_parameter: 'volume', points: [{ time: 0, value: 0.5 }] }, 'Track index out of range');
    await fails('draw_automation', { ...target, clip_index: S + 1, points: [{ time: 0, value: P.min }] }, 'empty');
    await fails('clear_automation', { track_index: T }, 'clip_index');
    await fails('ramp_parameter', { ...target, to: P.max }, 'exactly one');
    await fails('ramp_parameter', { ...target, seconds: 1 }, 'to must');
    await fails('ramp_parameter', { ...target, to: P.max + 1000, seconds: 1 }, 'to must');
  });
  await check('get_health lists the new capabilities', async () => {
    const health = await ok('get_health');
    for (const c of ['draw_automation', 'clear_automation', 'ramp_parameter', 'cancel_ramps']) assert(health.capabilities.includes(c), `${c} missing`);
  });
  await check('an ordinary tool still works after all of that', async () => {
    const info = await ok('get_session_info');
    assert(typeof info.tempo === 'number', 'no tempo');
  });
} finally {
  await tool('cancel_ramps');
  await tool('clear_automation', { track_index: T, clip_index: S });
  await tool('delete_clip', { track_index: T, clip_index: S });
  await tool('set_device_parameter', { ...target, value: original });
  await client.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
