// The public hook for private tests (docs/DESIGN.md#testing; scripts/lib/private-tests.cjs and
// scripts/private-tests.mjs): the pointer file is git-ignored, the runners add nothing without it, and an overlay
// folder outside the repository compiles against the repository's code and packages into the layout the runners
// read. The overlay here is a throwaway folder made by the test; it holds no private material.

import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { importScript, root } from '../support/helpers';

interface PrivateTestsLib {
  privateTestsFolder(root?: string): string | undefined;
  privateSpecs(suites: string[], root?: string): string[];
}
interface PrivateTestsScript {
  compilePrivateTests(options: { root?: string; overlay: string; outDir?: string }): number;
}

describe('private tests: the public hook', function () {
  this.timeout(120000);
  let lib: PrivateTestsLib;
  let tmp: string;

  before(async () => {
    lib = await importScript<PrivateTestsLib>('scripts/lib/private-tests.cjs');
  });
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-private-tests-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('the pointer file is git-ignored, and so is the compiled overlay (out/)', () => {
    const ignore = readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/);
    assert.ok(ignore.includes('/.private-fixtures.json'));
    assert.ok(ignore.includes('/out/'));
  });

  it('the example pointer file names no private folder or document', () => {
    const example = JSON.parse(readFileSync(path.join(root, '.private-fixtures.example.json'), 'utf8')) as {
      privateTests?: string;
      fixtures: Record<string, { main: string }>;
    };
    assert.equal(example.privateTests, '../private_tests');
    for (const entry of Object.values(example.fixtures)) {
      assert.match(entry.main, /^path\/to\//);
    }
  });

  it('adds nothing without .private-fixtures.json, without "privateTests", or without the compiled folder', () => {
    const repo = path.join(tmp, 'repo');
    mkdirSync(repo);
    assert.equal(lib.privateTestsFolder(repo), undefined);
    assert.deepEqual(lib.privateSpecs(['unit', 'engine'], repo), []);
    writeFileSync(path.join(repo, '.private-fixtures.json'), JSON.stringify({ root: '../fixtures', fixtures: {} }));
    assert.equal(lib.privateTestsFolder(repo), undefined);
    assert.deepEqual(lib.privateSpecs(['unit'], repo), []);
    writeFileSync(path.join(repo, '.private-fixtures.json'), JSON.stringify({ root: '../fixtures', fixtures: {}, privateTests: '../overlay' }));
    assert.equal(lib.privateTestsFolder(repo), path.join(tmp, 'overlay'));
    assert.deepEqual(lib.privateSpecs(['unit', 'engine'], repo), []);
    mkdirSync(path.join(repo, 'out', 'private', 'engine'), { recursive: true });
    assert.deepEqual(lib.privateSpecs(['unit', 'engine'], repo), ['out/private/engine/**/*.test.js']);
    writeFileSync(path.join(repo, '.private-fixtures.json'), '{ not json');
    assert.equal(lib.privateTestsFolder(repo), undefined);
  });

  it('compiles an overlay outside the repository against the repository code and packages', async () => {
    const { compilePrivateTests } = await importScript<PrivateTestsScript>('scripts/private-tests.mjs');
    const overlay = path.join(tmp, 'overlay');
    mkdirSync(path.join(overlay, 'unit'), { recursive: true });
    writeFileSync(path.join(overlay, 'unit', 'shared.ts'), 'export const twice = (n: number): number => 2 * n;\n');
    writeFileSync(
      path.join(overlay, 'unit', 'sample.test.ts'),
      [
        "import * as assert from 'node:assert/strict';",
        "import { PDFDocument } from 'pdf-lib';",
        "import { PUBLISHER } from '../../src/shared/identity';",
        "import { root } from '../../test/support/helpers';",
        "import { twice } from './shared';",
        "it('sample', () => { assert.ok(PUBLISHER && root && PDFDocument && twice(2) === 4); });",
        '',
      ].join('\n'),
    );
    const outDir = path.join(tmp, 'out-private');
    assert.equal(compilePrivateTests({ overlay, outDir }), 2);
    const js = readFileSync(path.join(outDir, 'unit', 'sample.test.js'), 'utf8');
    assert.match(js, /require\("\.\.\/\.\.\/src\/shared\/identity"\)/);
    assert.match(js, /require\("pdf-lib"\)/);
    assert.ok(existsSync(path.join(outDir, 'unit', 'shared.js')));
    assert.ok(!existsSync(path.join(outDir, 'unit', 'sample.test.js.map')), 'no source maps');
  });

  it('reports a type error in the overlay and refuses an overlay inside the repository', async () => {
    const { compilePrivateTests } = await importScript<PrivateTestsScript>('scripts/private-tests.mjs');
    const overlay = path.join(tmp, 'overlay');
    mkdirSync(path.join(overlay, 'engine'), { recursive: true });
    writeFileSync(path.join(overlay, 'engine', 'bad.test.ts'), "import { PUBLISHER } from '../../src/shared/identity';\nconst n: number = PUBLISHER;\nexport { n };\n");
    assert.throws(() => compilePrivateTests({ overlay, outDir: path.join(tmp, 'out-private') }), /not assignable to type 'number'/);
    assert.throws(() => compilePrivateTests({ overlay: path.join(root, 'test', 'unit') }), /outside the repository/);
  });
});
