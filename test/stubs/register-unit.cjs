'use strict';
// Loaded by Mocha (.mocharc.cjs) into the unit-test process before any test file. Allows exactly the forks
// the unit tests make: the engine host and the stub probe, each started from the fork file (compiled to
// out/ by tsc, or bundled to dist/fork.js).

const path = require('node:path');
const state = require('./stub-state.cjs');

const root = path.resolve(__dirname, '..', '..');
state.configure({
  role: 'unit-test',
  allowForkTargets: [
    path.join(root, 'dist', 'engine-host.js'),
    path.join(root, 'test', 'fixtures', 'stub-probe.cjs'),
  ],
  allowForkCallers: [
    path.join(root, 'out', 'src', 'extension', 'engineHostFork.js'),
    path.join(root, 'dist', 'fork.js'),
  ],
});
require('./process-stub.cjs');
require('./network-stub.cjs');
