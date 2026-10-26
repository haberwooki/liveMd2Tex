// The S1 engine-gate tests (test/engine): slow, need the pinned engine files in ../engine_assets, and skip
// without them. Same stubs as the unit tests in this process; the engine host gets the engine-host stubs.
// Private engine tests are added when .private-fixtures.json names a private test folder
// (scripts/lib/private-tests.cjs).
//   node node_modules/mocha/bin/mocha.js --config .mocharc.engine.cjs
const { privateSpecs } = require('./scripts/lib/private-tests.cjs');

module.exports = {
  spec: ['out/test/engine/**/*.test.js', ...privateSpecs(['engine'])],
  require: ['test/stubs/register-unit.cjs'],
  ui: 'bdd',
  timeout: 900000,
  reporter: 'spec',
  exit: true,
};
