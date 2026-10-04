// Review of M5b, D-F3 (S154): for each package layout, every file Node loads when the handler is imported is certified
// under packageFiles. The loads are traced with a module hook (test/trace-loaded.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { handlerClosure } from '@poly/check';
import { ROOT } from './helpers.mjs';

const BASE = join(ROOT, '.poly', 'test-packages');
const HOOK = join(ROOT, 'test', 'trace-loaded.mjs');
const put = (root, files) => { for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), typeof t === 'string' ? t : JSON.stringify(t)); } };
const J = (o) => JSON.stringify(o);

const scenarios = {
  // Node picks the first matching condition in object order.
  'condition-order': {
    'src/h.mjs': "import x from 'p';\nexport const handle = () => x;\n",
    'node_modules/p/package.json': J({ name: 'p', exports: { '.': { default: './d.js', import: './i.mjs' } } }),
    'node_modules/p/d.js': 'module.exports = "default";\n',
    'node_modules/p/i.mjs': 'export default "import";\n',
  },
  // A dual package required from CommonJS: Node takes 'require'.
  'require-condition': {
    'src/h.mjs': "import x from 'a';\nexport const handle = () => x;\n",
    'node_modules/a/package.json': J({ name: 'a', main: 'index.js' }),
    'node_modules/a/index.js': "module.exports = require('dual');\n",
    'node_modules/dual/package.json': J({ name: 'dual', exports: { import: './esm.mjs', require: './cjs.cjs' } }),
    'node_modules/dual/esm.mjs': 'export default "esm";\n',
    'node_modules/dual/cjs.cjs': 'module.exports = "cjs";\n',
  },
  // A subpath pattern: pat/foo is dist/foo.js.
  'subpath-pattern': {
    'src/h.mjs': "import x from 'pat/foo';\nexport const handle = () => x;\n",
    'node_modules/pat/package.json': J({ name: 'pat', exports: { './*': './dist/*.js' } }),
    'node_modules/pat/dist/foo.js': 'module.exports = "dist";\n',
    'node_modules/pat/foo.js': 'module.exports = "decoy";\n',
  },
  // A package.json "imports" map.
  'imports-map': {
    'src/h.mjs': "import x from 'im';\nexport const handle = () => x;\n",
    'node_modules/im/package.json': J({ name: 'im', type: 'module', exports: './index.js', imports: { '#internal': './lib/internal.js' } }),
    'node_modules/im/index.js': "import y from '#internal';\nexport default y;\n",
    'node_modules/im/lib/internal.js': 'export default "internal";\n',
  },
  // CommonJS require('./data') of data.json.
  'require-json-no-ext': {
    'src/h.mjs': "import x from 'js';\nexport const handle = () => x;\n",
    'node_modules/js/package.json': J({ name: 'js', main: 'index.js' }),
    'node_modules/js/index.js': "module.exports = require('./data');\n",
    'node_modules/js/data.json': J({ secret: 1 }),
  },
  // require('./lib') of a directory with its own package.json main.
  'dir-main': {
    'src/h.mjs': "import x from 'dm';\nexport const handle = () => x;\n",
    'node_modules/dm/package.json': J({ name: 'dm', main: 'index.js' }),
    'node_modules/dm/index.js': "module.exports = require('./lib');\n",
    'node_modules/dm/lib/package.json': J({ main: 'main.js' }),
    'node_modules/dm/lib/main.js': 'module.exports = "main";\n',
  },
  // A scoped package, a self-import and a cycle.
  'scoped-self-cycle': {
    'src/h.mjs': "import x from '@s/q/sub';\nexport const handle = () => x;\n",
    'node_modules/@s/q/package.json': J({ name: '@s/q', exports: { '.': './a.js', './sub': './b.js' } }),
    'node_modules/@s/q/a.js': "module.exports = 'a'; require('./b.js');\n",
    'node_modules/@s/q/b.js': "module.exports = require('@s/q') + 'b';\n",
  },
};

for (const [name, files] of Object.entries(scenarios)) {
  test(`S154: every file Node loads for the layout ${name} is certified`, () => {
    const root = join(BASE, name);
    rmSync(root, { recursive: true, force: true });
    put(root, { ...files, 'package-lock.json': '{}' });
    const c = handlerClosure(root, [join(root, 'src/h.mjs')]);
    const certified = new Set([...Object.keys(c.digests), ...Object.keys(c.packageFiles)]);
    const script = `import(${J('file:///' + join(root, 'src/h.mjs').split(sep).join('/'))}).then((m) => console.log('value', JSON.stringify(m.handle())))`;
    const out = execFileSync(process.execPath, ['--import', 'file:///' + HOOK.split(sep).join('/'), '-e', script], { encoding: 'utf8' });
    const loaded = JSON.parse(out.split('\n').find((l) => l.startsWith('LOADED ')).slice(7)).filter((f) => f.startsWith(root)).map((f) => relative(root, f).split(sep).join('/'));
    assert.deepEqual(loaded.filter((f) => !certified.has(f)), []);
  });
}
