#!/usr/bin/env node
// DEV ONLY: reload the deployed AbletonMCP package inside the running Live without restarting it.
// Run `npm run deploy` first. Uses the bridge's eval command, so it only works while the script is already loaded.
// Fresh-start behaviour (imports, Live's package loader) is only proven by an actual restart: do that before releasing.
import { AbletonClient } from '../dist/client/AbletonClient.js';

// Reloading `registry` starts a fresh command table, so EVERY loaded module must be reloaded after it (or its commands
// vanish). Foundation modules go first; the rest are found dynamically so new modules are picked up automatically.
const foundation = ['config', 'clock', 'registry', 'helpers', 'curves'];
const code =
  `(lambda sys, il: (self._pump_timer.stop(), self.server.close(), ` +
  `[il.reload(sys.modules['AbletonMCP.' + n]) for n in ${JSON.stringify(foundation)} if 'AbletonMCP.' + n in sys.modules], ` +
  `[il.reload(sys.modules[m]) for m in sorted(k for k in list(sys.modules) if k.startswith('AbletonMCP.') and k.split('.')[1] not in ${JSON.stringify(foundation)})], ` +
  `setattr(self, '__class__', il.reload(sys.modules[type(self).__module__]).AbletonMCP), ` +
  `setattr(self, '_pump_timer', None), setattr(self, 'server', None), self.start_server(), ` +
  `{'version': self._get_script_info()['script_version'], 'build_id': self._get_script_info().get('build_id'), 'pump': self._pump_timer is not None, ` +
  `'commands': len(__import__('AbletonMCP').registry._COMMANDS)})[-1])` +
  `(__import__('sys'), __import__('importlib'))`;
const client = new AbletonClient();
console.log(JSON.stringify(await client.sendCommand('eval', { code })));
process.exit(0);
