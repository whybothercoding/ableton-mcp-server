#!/usr/bin/env node
// Copies remote-script/AbletonMCP into Live's User Library ("Remote Scripts/AbletonMCP") and reports the build id.
//
//   npm run deploy              deploy (User Library found from Live's own preferences, or ABLETON_USER_LIBRARY)
//   npm run deploy -- --dry-run show what would change
//   npm run deploy -- --check   compare the deployed build with the one running inside Live
//
// Live only scans Remote Scripts at launch: restart Live after deploying (or use `npm run hotswap` while developing).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildId } from './build-id.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, 'remote-script', 'AbletonMCP');
const args = new Set(process.argv.slice(2));

function detectUserLibrary() {
  if (process.env.ABLETON_USER_LIBRARY) return process.env.ABLETON_USER_LIBRARY;
  const prefs = path.join(os.homedir(), 'Library', 'Preferences', 'Ableton');
  if (!fs.existsSync(prefs)) return null;
  const configs = fs
    .readdirSync(prefs)
    .filter((n) => /^Live \d/.test(n))
    .map((n) => path.join(prefs, n, 'Library.cfg'))
    .filter((p) => fs.existsSync(p))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const cfg of configs) {
    // Live stores the library as a parent folder (ProjectPath) plus a name (ProjectName): the library is <ProjectPath>/<ProjectName>
    const text = fs.readFileSync(cfg, 'utf8');
    const block = text.match(/<UserLibrary>[\s\S]*?<\/UserLibrary>/);
    const parent = block && block[0].match(/<ProjectPath Value="([^"]+)"/);
    const name = block && block[0].match(/<ProjectName Value="([^"]+)"/);
    if (parent && name) return path.join(parent[1], name[1]);
  }
  return null;
}

const local = buildId(source);
if (args.has('--check')) {
  const { AbletonClient } = await import('../dist/client/AbletonClient.js');
  const info = await new AbletonClient().sendCommand('get_script_info');
  const same = info.build_id === local;
  console.log(`running in Live: ${info.script_version} build ${info.build_id ?? 'unknown (old script)'}\nlocal source:   build ${local}`);
  console.log(same ? 'Up to date.' : 'DIFFERENT: run `npm run deploy` and restart Live.');
  process.exit(same ? 0 : 1);
}

const library = detectUserLibrary();
if (!library) {
  console.error('Could not find your Live User Library. Set ABLETON_USER_LIBRARY to the path shown in Live > Preferences > Library.');
  process.exit(1);
}
if (!fs.existsSync(library)) {
  console.error(`User Library not found at ${library}. Is the drive mounted?`);
  process.exit(1);
}
if (!fs.existsSync(path.join(library, 'Presets')) && !fs.existsSync(path.join(library, 'Defaults')) && !fs.existsSync(path.join(library, 'Remote Scripts'))) {
  console.error(`${library} does not look like a Live User Library (no Presets, Defaults or Remote Scripts folder). Refusing to deploy there.`);
  process.exit(1);
}
const target = path.join(library, 'Remote Scripts', 'AbletonMCP');
if (!args.has('--dry-run')) fs.mkdirSync(target, { recursive: true });
const flags = ['-a', '--delete', '--exclude', '__pycache__', ...(args.has('--dry-run') ? ['-n', '-v'] : [])];
execFileSync('rsync', [...flags, source + '/', target + '/'], { stdio: 'inherit' });
console.log(`${args.has('--dry-run') ? 'Would deploy' : 'Deployed'} build ${local} to ${target}`);
if (!args.has('--dry-run')) console.log('Restart Live to load it (Live only scans Remote Scripts at launch).');
