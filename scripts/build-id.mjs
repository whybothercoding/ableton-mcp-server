// Same algorithm as _compute_build_id in remote-script/AbletonMCP/__init__.py:
// sha1 over "name\0contents\0" for every .py and .json file in the package, sorted by name; first 12 hex chars.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function buildId(dir) {
  const digest = createHash('sha1');
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.py') || n.endsWith('.json')).sort()) {
    digest.update(Buffer.concat([Buffer.from(name), Buffer.from([0]), fs.readFileSync(path.join(dir, name)), Buffer.from([0])]));
  }
  return digest.digest('hex').slice(0, 12);
}

export function scriptVersion(dir) {
  const match = fs.readFileSync(path.join(dir, 'config.py'), 'utf8').match(/SCRIPT_VERSION = "([^"]+)"/);
  return match ? match[1] : null;
}
