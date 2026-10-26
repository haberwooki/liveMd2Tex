'use strict';
// Loaded by @vscode/test-cli (mocha.preload in .vscode-test.mjs) into VS Code's extension host before the
// integration tests, and before the extension activates. Allows one fork: dist/engine-host.js, started
// from dist/fork.js.

const path = require('node:path');
const state = require('./stub-state.cjs');

const root = path.resolve(__dirname, '..', '..');
state.configure({
  role: 'extension-host',
  allowForkTargets: [path.join(root, 'dist', 'engine-host.js')],
  allowForkCallers: [path.join(root, 'dist', 'fork.js')],
});
require('./process-stub.cjs');
require('./network-stub.cjs');
