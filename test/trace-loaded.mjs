// Records every file Node loads (ESM and CJS) and prints them on exit.
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
const seen = new Set();
registerHooks({
  load(url, context, next) {
    if (url.startsWith('file:')) seen.add(fileURLToPath(url));
    return next(url, context);
  },
});
process.on('exit', () => { process.stdout.write('LOADED ' + JSON.stringify([...seen]) + '\n'); });
