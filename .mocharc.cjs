// Unit tests: plain Node, compiled by tsc to out/. The stubs load first, into this process, so every unit test
// runs with child processes and network blocked and recorded (docs/DESIGN.md#rules). Private unit and converter
// tests are added when .private-fixtures.json names a private test folder (scripts/lib/private-tests.cjs).
const { privateSpecs } = require('./scripts/lib/private-tests.cjs');

module.exports = {
  spec: ['out/test/unit/**/*.test.js', 'out/test/converter/**/*.test.js', ...privateSpecs(['unit', 'converter'])],
  require: ['test/stubs/register-unit.cjs'],
  ui: 'bdd',
  timeout: 30000,
  reporter: 'spec',
};
