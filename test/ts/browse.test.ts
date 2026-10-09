import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { clearBrowserIndex, findPathByUri, indexRoot, loadItemParams, runBrowse, searchIndex } from '../../src/tools/browse.js';
import { TOOL_SPEC_BY_NAME, validateArgs } from '../../src/tools/spec.js';

type Node = { name: string; uri?: string; loadable?: boolean; device?: boolean; children?: Node[] };
const TREE: Record<string, Node> = {
  instruments: { name: 'Instruments', children: [
    { name: 'Drift', uri: 'query:Synths#Drift', loadable: true, device: true, children: [
      { name: 'Bass', children: [{ name: 'Sub Pulse', uri: 'u:sub', loadable: true }, { name: 'Deep Wobble', uri: 'u:wobble', loadable: true }] },
      { name: 'Lead', children: [{ name: 'Glass Bass', uri: 'u:glass', loadable: true }] }] },
    { name: 'Wavetable', uri: 'query:Synths#Wavetable', loadable: true, device: true, children: [{ name: 'Bass Drop', uri: 'u:drop', loadable: true }] }] },
  audio_effects: { name: 'Audio Effects', children: [{ name: 'EQ Eight', uri: 'u:eq', loadable: true, device: true }, { name: 'Bass Enhancer', uri: 'u:enh', loadable: true }] },
  samples: { name: 'Samples', children: [{ name: 'Bass Loop 01', uri: 'u:loop', loadable: true }] }
};

/** A bridge that serves browser_walk over TREE in slices of `slice` items, like the Remote Script does. */
class FakeBridge {
  calls: { type: string; params: any }[] = [];
  walks = new Map<string, { stack: { node: Node; path: string }[] }>();
  private counter = 0;
  constructor(private readonly slice = 4) {}
  async sendCommand(type: string, params: any = {}): Promise<any> {
    this.calls.push({ type, params });
    if (type === 'browse') return { path: params.path ?? '', items: [] };
    if (type !== 'browser_walk') throw new Error(`unexpected ${type}`);
    let token = params.token as string | undefined;
    if (!token) {
      token = `w${this.counter++}`;
      this.walks.set(token, { stack: params.roots.reverse().map((r: string) => ({ node: TREE[r], path: r })) });
    }
    const state = this.walks.get(token)!;
    const items: any[] = [];
    while (state.stack.length && items.length < this.slice) {
      const { node, path } = state.stack.pop()!;
      items.push({ name: node.name, path, uri: node.uri ?? null, is_folder: !!node.children?.length && !node.loadable, is_device: !!node.device, is_loadable: !!node.loadable });
      for (const child of [...(node.children ?? [])].reverse()) state.stack.push({ node: child, path: `${path}/${child.name}` });
    }
    return { token, done: state.stack.length === 0, visited: items.length, pending: state.stack.length, items };
  }
  walkCalls() {
    return this.calls.filter((c) => c.type === 'browser_walk').length;
  }
}

beforeEach(() => clearBrowserIndex());

test('indexing walks a root in slices until done and stores every node with its path', async () => {
  const bridge = new FakeBridge(4);
  const result = await indexRoot(bridge, 'instruments');
  assert.equal(result.items, 9);
  assert.ok(bridge.walkCalls() >= 3, 'the walk arrives in several slices');
  assert.equal(bridge.calls[0].params.roots[0], 'instruments');
  assert.ok(bridge.calls.slice(1).every((c) => c.params.token && !c.params.roots));
  assert.equal(findPathByUri('u:sub'), 'instruments/Drift/Bass/Sub Pulse');
  assert.equal(findPathByUri('nope'), null);
});

test('search needs every word in the path, ranks exact and prefix name matches first, and defaults to loadable items', async () => {
  const bridge = new FakeBridge(50);
  const out: any = await runBrowse({ action: 'search', query: 'bass', roots: ['instruments', 'audio_effects'] }, bridge);
  assert.equal(out.total_matches, 5);
  assert.deepEqual(out.results.slice(0, 2).map((r: any) => r.name), ['Bass Enhancer', 'Bass Drop']);      // name starts with the word; the shorter path wins the tie
  assert.ok(out.results.every((r: any) => r.is_loadable));
  assert.deepEqual(Object.keys(out.indexed_now).sort(), ['audio_effects', 'instruments']);
  const narrow: any = await runBrowse({ action: 'search', query: 'drift bass sub', roots: ['instruments'] }, bridge);
  assert.deepEqual(narrow.results.map((r: any) => r.path), ['instruments/Drift/Bass/Sub Pulse']);
  const exact = searchIndex('eq eight', ['audio_effects'], 'all', 5);
  assert.equal(exact.results[0].name, 'EQ Eight');
  assert.equal(searchIndex('nothing here', ['instruments'], 'all', 5).total, 0);
});

test('kind filters and the result limit apply', async () => {
  const bridge = new FakeBridge(50);
  await runBrowse({ action: 'index', roots: ['instruments'] }, bridge);
  assert.deepEqual(searchIndex('drift', ['instruments'], 'devices', 10).results.map((r) => r.name), ['Drift']);
  assert.ok(searchIndex('bass', ['instruments'], 'folders', 10).results.every((r) => r.name === 'Bass'));
  assert.equal(searchIndex('bass', ['instruments'], 'all', 2).results.length, 2);
  assert.equal(searchIndex('bass', ['instruments'], 'all', 2).total, 5);
});

test('the index is built once and reused; refresh rebuilds it; new roots are added on demand', async () => {
  const bridge = new FakeBridge(50);
  await runBrowse({ action: 'search', query: 'bass', roots: ['instruments'] }, bridge);
  const first = bridge.walkCalls();
  const again: any = await runBrowse({ action: 'search', query: 'wobble', roots: ['instruments'] }, bridge);
  assert.equal(bridge.walkCalls(), first, 'no new walk for a cached root');
  assert.equal(again.indexed_now, undefined);
  await runBrowse({ action: 'search', query: 'bass', roots: ['instruments', 'samples'] }, bridge);
  assert.ok(bridge.walkCalls() > first, 'the new root was walked');
  const walked = bridge.walkCalls();
  await runBrowse({ action: 'search', query: 'bass', roots: ['instruments'], refresh: true }, bridge);
  assert.ok(bridge.walkCalls() > walked, 'refresh walks again');
  const summary: any = await runBrowse({ action: 'index', roots: ['instruments'] }, bridge);
  assert.deepEqual(summary.roots.map((r: any) => r.root).sort(), ['instruments', 'samples']);
});

test('list passes paging arguments through to the bridge, and errors are readable', async () => {
  const bridge = new FakeBridge();
  await runBrowse({ path: 'instruments/Drift', kind: 'loadable', limit: 5, offset: 10 }, bridge);
  assert.deepEqual(bridge.calls[0], { type: 'browse', params: { path: 'instruments/Drift', kind: 'loadable', limit: 5, offset: 10 } });
  await runBrowse({}, bridge);
  assert.deepEqual(bridge.calls[1].params, {});
  await assert.rejects(runBrowse({ action: 'search' }, bridge), /search needs a query/);
  await assert.rejects(runBrowse({ action: 'search', query: 'x', roots: ['nowhere'] }, bridge), /Unknown roots nowhere/);
  for (const root of ['user_folders', 'colors', 'legacy_libraries']) {
    await assert.doesNotReject(runBrowse({ action: 'index', roots: [root] }, { sendCommand: async () => ({ done: true, items: [], token: 't', visited: 0, pending: 0 }) } as any), root);
  }
  await assert.rejects(runBrowse({ action: 'search', query: 'x', roots: ['nowhere'] }, bridge), /Roots: .*user_folders, colors, legacy_libraries/);
  await assert.rejects(runBrowse({ action: 'dance' }, bridge), /action must be one of: list, search, index/);
});

test('indexing gives up with a clear message when a root takes too long', async () => {
  const bridge = new FakeBridge(1);
  let clock = 0;
  await assert.rejects(indexRoot(bridge, 'instruments', () => (clock += 40_000)), /took longer than 90 s/);
});

test('load_item turns an indexed uri into a path, leaves unknown uris alone, and is a plain batchable bridge call', async () => {
  await indexRoot(new FakeBridge(50), 'instruments');
  await indexRoot(new FakeBridge(50), 'audio_effects');
  assert.deepEqual(loadItemParams({ uri: 'u:sub', target: 'tracks/0' }), { path: 'instruments/Drift/Bass/Sub Pulse', target: 'tracks/0' });
  assert.deepEqual(loadItemParams({ uri: 'u:unknown', target: 'tracks/0' }), { uri: 'u:unknown', target: 'tracks/0' });
  assert.deepEqual(loadItemParams({ path: 'instruments/Drift', uri: 'u:sub', target: 'tracks/0' }), { path: 'instruments/Drift', uri: 'u:sub', target: 'tracks/0' });
  const spec = TOOL_SPEC_BY_NAME.load_item;
  assert.equal(spec.run, undefined);
  assert.equal(spec.annotations.destructiveHint, false);
  assert.deepEqual(spec.bridge.params!({ uri: 'u:eq', target: 'master' }), { path: 'audio_effects/EQ Eight', target: 'master' });
});

test('the browse and load_item schemas', () => {
  const browse = TOOL_SPEC_BY_NAME.browse;
  assert.equal(browse.annotations.readOnlyHint, true);
  assert.deepEqual(browse.requires, ['browser_walk']);
  assert.match(validateArgs(browse.inputSchema, { action: 'dance' }) ?? '', /action must be one of: list, search, index/);
  assert.equal(validateArgs(browse.inputSchema, { action: 'search', query: 'bass', roots: ['instruments'] }), null);
  assert.match(validateArgs(browse.inputSchema, { roots: 'instruments' }) ?? '', /roots must be an array/);
  assert.match(validateArgs(TOOL_SPEC_BY_NAME.load_item.inputSchema, { action: 'rewind' }) ?? '', /action must be one of: load, preview, stop_preview/);
});
