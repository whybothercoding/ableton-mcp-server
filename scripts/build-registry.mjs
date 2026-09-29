#!/usr/bin/env node
// Builds remote-script/AbletonMCP/registry_data.json from the committed API dump for the newest Live version found.
//   npm run build-registry          write the registry
//   npm run build-registry -- --check   fail if the committed registry is not what the dump produces
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRegistry, stable } from './registry-lib.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, 'docs', 'live-api');
const dumps = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
if (!dumps.length) {
  console.error('No API dump in docs/live-api. Run `npm run dump-api` first.');
  process.exit(1);
}
const dump = JSON.parse(fs.readFileSync(path.join(dir, dumps.at(-1)), 'utf8'));
const target = path.join(root, 'remote-script', 'AbletonMCP', 'registry_data.json');
const text = stable(buildRegistry(dump));
if (process.argv.includes('--check')) {
  const same = fs.existsSync(target) && fs.readFileSync(target, 'utf8') === text;
  console.log(same ? 'registry_data.json is up to date.' : 'registry_data.json is out of date: run `npm run build-registry`.');
  process.exit(same ? 0 : 1);
}
fs.writeFileSync(target, text);
console.log(`Wrote ${path.relative(root, target)} from ${dumps.at(-1)}`);
