// The private test overlay (docs/DESIGN.md#testing). Tests on private documents are not in this repository. A
// git-ignored .private-fixtures.json may name a folder of them outside it ("privateTests", relative to the
// repository root). The folder mirrors test/: engine/, unit/, integration/ and converter/. Each overlay test is
// written as if it lived one folder below the repository root, so it imports repository code as
// ../../src/... and ../../test/support/.... scripts/private-tests.mjs compiles the folder into the git-ignored
// out/private/, and each test runner (.mocharc.cjs, .mocharc.engine.cjs, .vscode-test.mjs) adds
// out/private/<suite>/**/*.test.js through privateSpecs. Without the file, the key or the compiled folder,
// nothing is added and nothing is said.

const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

/** The private test folder that .private-fixtures.json names, as an absolute path, or undefined. */
function privateTestsFolder(root = repoRoot) {
  const file = path.join(root, '.private-fixtures.json');
  if (!existsSync(file)) {
    return undefined;
  }
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  return typeof config.privateTests === 'string' && config.privateTests !== '' ? path.resolve(root, config.privateTests) : undefined;
}

/** The compiled private tests of these suites, as spec globs relative to `root`, or [] when there are none. */
function privateSpecs(suites, root = repoRoot) {
  if (!privateTestsFolder(root)) {
    return [];
  }
  return suites.filter((suite) => existsSync(path.join(root, 'out', 'private', suite))).map((suite) => `out/private/${suite}/**/*.test.js`);
}

module.exports = { privateSpecs, privateTestsFolder };
