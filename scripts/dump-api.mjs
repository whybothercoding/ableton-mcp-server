#!/usr/bin/env node
// Dumps Live's Python API (class level only, read-only) from the running Live into docs/live-api/<version>.json,
// or checks the running Live against the committed dump.
//
//   npm run dump-api           write docs/live-api/<live version>.json
//   npm run test:drift         compare the running Live with the committed dump; exit 1 and list differences on drift
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbletonClient } from '../dist/client/AbletonClient.js';
import { diffDumps, stable } from './registry-lib.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const check = process.argv.includes('--check');
const client = new AbletonClient({ timeoutMs: 60000 });

const head = await client.sendCommand('introspect_api');
const dump = { live_version: head.live_version, build: head.build, modules: {} };
for (const module of head.modules) dump.modules[module] = await client.sendCommand('introspect_api', { module });

const file = path.join(root, 'docs', 'live-api', `${dump.live_version}.json`);
if (check) {
  if (!fs.existsSync(file)) {
    console.error(`No committed dump for Live ${dump.live_version} (${path.relative(root, file)}). Run \`npm run dump-api\` and commit it.`);
    process.exit(1);
  }
  const committed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const diff = diffDumps(committed, dump);
  if (diff.same) {
    console.log(`No API drift: Live ${dump.live_version} matches ${path.relative(root, file)}.`);
    process.exit(0);
  }
  console.log(`API DRIFT against ${path.relative(root, file)}: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed`);
  for (const [label, list] of [['ADDED', diff.added], ['REMOVED', diff.removed], ['CHANGED', diff.changed]]) {
    for (const line of list.slice(0, 40)) console.log(`  ${label} ${line}`);
    if (list.length > 40) console.log(`  ... ${list.length - 40} more ${label}`);
  }
  process.exit(1);
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, stable(dump));
const size = (fs.statSync(file).size / 1024).toFixed(0);
console.log(`Wrote ${path.relative(root, file)} (${size} KB): ${head.modules.length} modules`);
process.exit(0);
