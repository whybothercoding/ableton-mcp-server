/**
 * browse and load_item. Live's browser has no search, so `search` runs over an index the MCP server builds by walking the
 * browser in short slices (the bridge's browser_walk keeps each call to a few milliseconds, so Live stays responsive) and
 * keeps in memory until `refresh` or a restart.
 */
import { CompositionError } from './composition.js';
import type { BridgeClient, ToolSpec } from './spec.js';

export const DEFAULT_ROOTS = ['instruments', 'audio_effects', 'midi_effects', 'drums', 'sounds', 'max_for_live', 'user_library', 'packs'];
const ALL_ROOTS = ['instruments', 'sounds', 'drums', 'audio_effects', 'midi_effects', 'samples', 'user_library', 'current_project', 'clips', 'packs', 'plugins', 'max_for_live', 'user_folders', 'colors', 'legacy_libraries'];
const INDEX_TIME_LIMIT_MS = 90_000;

interface IndexedItem {
  path: string;
  name: string;
  uri: string | null;
  is_folder: boolean;
  is_device: boolean;
  is_loadable: boolean;
  lower: string;
  nameLower: string;
}

/** Items by root, plus when each root was indexed. Module state: one Live, one index. */
const index = new Map<string, { items: IndexedItem[]; builtAt: number; ms: number }>();

export function clearBrowserIndex(): void {
  index.clear();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function indexRoot(client: BridgeClient, root: string, now: () => number = Date.now): Promise<{ items: number; ms: number }> {
  const started = now();
  const items: IndexedItem[] = [];
  let token: string | undefined;
  for (;;) {
    if (now() - started > INDEX_TIME_LIMIT_MS) throw new CompositionError(`Indexing '${root}' took longer than ${INDEX_TIME_LIMIT_MS / 1000} s: index fewer or smaller roots`);
    const slice: any = await client.sendCommand('browser_walk', token ? { token } : { roots: [root], budget_ms: 25, max_items: 1500 });
    token = slice.token;
    for (const it of slice.items) {
      items.push({ ...it, lower: it.path.toLowerCase(), nameLower: it.name.toLowerCase() });
    }
    if (slice.done) break;
    await sleep(2);
  }
  index.set(root, { items, builtAt: started, ms: now() - started });
  return { items: items.length, ms: now() - started };
}

async function ensureIndexed(client: BridgeClient, roots: string[], refresh: boolean): Promise<{ built: Record<string, { items: number; ms: number }> }> {
  const built: Record<string, { items: number; ms: number }> = {};
  for (const root of roots) {
    if (refresh || !index.has(root)) built[root] = await indexRoot(client, root);
  }
  return { built };
}

export function searchIndex(query: string, roots: string[], kind: string, limit: number): { total: number; results: any[] } {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new CompositionError('query must contain something to look for');
  const scored: { score: number; item: IndexedItem }[] = [];
  for (const root of roots) {
    for (const item of index.get(root)?.items ?? []) {
      if (kind === 'loadable' && !item.is_loadable) continue;
      if (kind === 'devices' && !item.is_device) continue;
      if (kind === 'folders' && !item.is_folder) continue;
      if (!tokens.every((t) => item.lower.includes(t))) continue;
      const inName = tokens.every((t) => item.nameLower.includes(t));
      let score = 10 - Math.min(9, item.path.length / 40);
      if (inName) score += 20;
      if (item.nameLower === query.toLowerCase().trim()) score += 100;
      else if (item.nameLower.startsWith(tokens[0])) score += 30;
      scored.push({ score, item });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.item.path.length - b.item.path.length || a.item.path.localeCompare(b.item.path));
  return {
    total: scored.length,
    results: scored.slice(0, limit).map(({ item }) => ({ name: item.name, path: item.path, uri: item.uri, is_device: item.is_device, is_loadable: item.is_loadable, root: item.path.split('/')[0] }))
  };
}

export function findPathByUri(uri: string): string | null {
  for (const { items } of index.values()) {
    const hit = items.find((i) => i.uri === uri);
    if (hit) return hit.path;
  }
  return null;
}

export async function runBrowse(args: Record<string, any>, client: BridgeClient): Promise<unknown> {
  const action: string = args.action ?? 'list';
  const roots: string[] = args.roots ?? DEFAULT_ROOTS;
  const unknown = roots.filter((r) => !ALL_ROOTS.includes(r));
  if (unknown.length) throw new CompositionError(`Unknown roots ${unknown.join(', ')}. Roots: ${ALL_ROOTS.join(', ')}`);
  if (action === 'list') {
    const { path, kind, limit, offset } = args;
    return client.sendCommand('browse', { ...(path !== undefined ? { path } : {}), ...(kind ? { kind } : {}), ...(limit !== undefined ? { limit } : {}), ...(offset !== undefined ? { offset } : {}) });
  }
  if (action === 'index') {
    const { built } = await ensureIndexed(client, roots, true);
    return { indexed: built, roots: [...index.keys()].map((r) => ({ root: r, items: index.get(r)!.items.length })) };
  }
  if (action === 'search') {
    if (typeof args.query !== 'string' || !args.query.trim()) throw new CompositionError('search needs a query');
    const { built } = await ensureIndexed(client, roots, Boolean(args.refresh));
    const found = searchIndex(args.query, roots, args.kind ?? 'loadable', args.limit ?? 25);
    return { query: args.query, roots, kind: args.kind ?? 'loadable', total_matches: found.total, results: found.results, ...(Object.keys(built).length ? { indexed_now: built } : {}) };
  }
  throw new CompositionError('action must be one of: list, search, index');
}

/** A uri the search index knows becomes its path, which the bridge resolves without walking the whole browser. */
export function loadItemParams(args: Record<string, any>): Record<string, any> {
  const params: Record<string, any> = { ...args };
  if (params.uri && !params.path) {
    const known = findPathByUri(params.uri);
    if (known) {
      params.path = known;
      delete params.uri;
    }
  }
  return params;
}

export const BROWSE_SPECS: ToolSpec[] = [
  {
    name: 'browse',
    description:
      "Explore and search Live's browser (instruments, presets, effects, drum kits, packs, user library...). `action` list (default): `path` like 'instruments/Drift/Bass' (no path lists the roots), " +
      "`kind` all|folders|loadable|devices, paged with `limit` (default 100) and `offset`; every item has a `path` to browse deeper or load. " +
      "search: `query` words (all must appear in the item's path, e.g. 'drift bass sub') over the preset and device names of `roots` (default: instruments, audio_effects, midi_effects, drums, sounds, max_for_live, user_library, packs); " +
      "`kind` loadable (default), devices or folders; ranked with exact and prefix name matches first. The first search builds an index by walking the browser in short slices (a few seconds, Live stays responsive) and keeps it until `refresh: true`; " +
      "the big sample libraries ('samples', 'clips'), the folders you added to Live's sidebar ('user_folders') and 'colors' (Favorites) are only indexed if you name them in `roots`. index: (re)build the index for `roots`. Load what you find with load_item.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'search', 'index'], description: 'Default list' },
        path: { type: 'string', description: "list: 'root/folder/item'; omit to list roots" },
        kind: { type: 'string', enum: ['all', 'folders', 'loadable', 'devices'], description: 'list: filter (default all); search: default loadable' },
        limit: { type: 'number', description: 'list: page size (default 100); search: results (default 25)' },
        offset: { type: 'number', description: 'list: page start' },
        query: { type: 'string', description: 'search: words that must all appear in the item path' },
        roots: { type: 'array', items: { type: 'string' }, description: 'search/index: browser roots to cover' },
        refresh: { type: 'boolean', description: 'search: rebuild the index first' }
      }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    bridge: { command: 'browse' },
    requires: ['browser_walk'],
    run: runBrowse
  },
  {
    name: 'load_item',
    description:
      "Load a browser item (from browse) by `path`, or by `uri` (fast when it is in the search index, otherwise slow: it walks the whole browser). `target`: a track ('tracks/2', 'returns/0', 'master') loads an instrument, effect or preset onto it and " +
      "returns the addresses of the devices it added; a clip slot ('tracks/2/slots/0') loads a sample into it; a device ('tracks/2/devices/0') hot-swaps it for the item. Loading selects the target in Live's window. " +
      "`action` preview plays an item on the preview channel without loading it (stop_preview stops it; audible, and it needs no target). Folders and categories cannot be loaded: browse into them. One undo step.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['load', 'preview', 'stop_preview'], description: 'Default load' },
        path: { type: 'string', description: "Item path from browse/search, e.g. 'instruments/Drift/Bass/Sub Pulse'" },
        uri: { type: 'string', description: 'Item uri instead of a path' },
        target: { type: 'string', description: "Track, clip slot or device address (load)" }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    bridge: { command: 'load_item', params: loadItemParams }
  }
];
