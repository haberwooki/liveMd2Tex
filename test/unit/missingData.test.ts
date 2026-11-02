// The rule for a missing engine or TeX data (test/support/missingData.ts; docs/DEVELOPING.md, "The TeX engine"): on
// a laptop a test skips; on CI it skips with one notice only while engine/pins.json does not pin both data packages,
// and fails once both are pinned. scripts/lib/data-pins.mjs gives the workflows the same answer, and
// scripts/engine-assets.mjs explains an unpublished pin instead of downloading it.

import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { importScript, root } from '../support/helpers';
import { DATA_SOURCES, dataPinned, forgetNotice, missingInput, UNPINNED_NOTICE, whenMissing } from '../support/missingData';

const pins = () => JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8')) as { sources: { id: string }[] };
const withIds = (...ids: string[]) => ({ sources: [...pins().sources.filter((s) => !DATA_SOURCES.includes(s.id)), ...ids.map((id) => ({ id }))] });

describe('a missing engine or TeX data: skip, or fail once both data packages are pinned', () => {
  it('skips on a laptop; on CI skips only without both data pins, and fails with them', () => {
    assert.equal(whenMissing(false, false), 'skip');
    assert.equal(whenMissing(false, true), 'skip');
    assert.equal(whenMissing(true, false), 'skip-unpinned');
    assert.equal(whenMissing(true, true), 'fail');
  });

  it('reads both pins from engine/pins.json: core-data alone is not enough', () => {
    assert.deepEqual(DATA_SOURCES, ['livemd2tex-core-data', 'livemd2tex-extra-data']);
    assert.equal(dataPinned(pins()), DATA_SOURCES.every((id) => pins().sources.some((s) => s.id === id)));
    assert.equal(dataPinned(withIds('livemd2tex-core-data', 'livemd2tex-extra-data')), true);
    assert.equal(dataPinned(withIds('livemd2tex-core-data')), false, 'core-data without the add-on');
    assert.equal(dataPinned(withIds('livemd2tex-extra-data')), false, 'the add-on without core-data');
    assert.equal(dataPinned({ sources: [{ id: 'livemd2tex-engine' }] }), false);
    assert.equal(dataPinned(null), false);
  });

  it('applies the rule: on CI before the pins it says why exactly once and lets the test skip; after them it throws', () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      if (!dataPinned()) {
        forgetNotice();
        missingInput('the core data', { CI: 'true' });
        missingInput('the core data', { CI: 'true' });
        missingInput('the Extra Packages add-on', { CI: 'true' });
        assert.equal(lines.filter((l) => l.includes(UNPINNED_NOTICE)).length, 1, 'the notice is printed exactly once');
      } else {
        assert.throws(() => missingInput('the core data', { CI: 'true' }), /need the core data: on CI they fail/);
      }
      const before = lines.length;
      missingInput('the core data', {});
      assert.equal(lines.length, before, 'on a laptop it says nothing');
    } finally {
      console.log = log;
    }
  });

  it('the workflows ask scripts/lib/data-pins.mjs, which agrees, and the test-copy scan waits for the pins', async () => {
    const lib = await importScript<{ dataPinned(p: unknown): boolean; UNPINNED_NOTICE: string; DATA_SOURCES: string[] }>('scripts/lib/data-pins.mjs');
    assert.equal(lib.UNPINNED_NOTICE, UNPINNED_NOTICE);
    assert.deepEqual(lib.DATA_SOURCES, DATA_SOURCES);
    for (const p of [pins(), withIds('livemd2tex-core-data'), withIds('livemd2tex-core-data', 'livemd2tex-extra-data'), { sources: [] }, null]) {
      assert.equal(lib.dataPinned(p), dataPinned(p));
    }
    const runner = readFileSync(path.join(root, '.github', 'workflows', 'test-runner.yml'), 'utf8');
    assert.match(runner, /if node scripts\/lib\/data-pins\.mjs; then\n\s+node scripts\/vsix-scan\.mjs --test-copy\n\s+fi/);
    // The scans run whatever an earlier step did, so a red engine step hides no scan.
    assert.match(runner, /- name: VSIX scans \(plain package and test copy\)\n\s+if: inputs\.package && !cancelled\(\)/);
  });

  it('the integration run applies the rule when no engine is staged: a notice before the pins, a failure after', () => {
    const run = readFileSync(path.join(root, 'scripts', 'run-integration.mjs'), 'utf8');
    assert.match(run, /import \{ dataPinned, [^}]*UNPINNED_NOTICE \} from '\.\/lib\/data-pins\.mjs';/);
    assert.match(run, /if \(process\.env\.CI === 'true'\) \{\n\s+if \(dataPinned\([^\n]+\)\) \{\n(?:[^\n]+\n){1,3}\s+process\.exit\(1\);\n\s+\}\n\s+console\.log\([^\n]*UNPINNED_NOTICE/);
  });

  it('the integration run and the V0 and M6 tests apply the rule to the add-on too (scripts/lib/data-pins.mjs decides; dataRelease.test.ts tests it)', () => {
    const run = readFileSync(path.join(root, 'scripts', 'run-integration.mjs'), 'utf8');
    // The add-on comes from extraDataPackage, whose refusals stop the run; without one, CI after the pins stops too.
    assert.match(run, /const given = extraDataPackage\(pins, path\.join\(root, '\.\.', 'engine_assets'\)\);/);
    assert.match(run, /if \(!extraVsix && process\.env\.CI === 'true' && dataPinned\(pins\)\) \{\n\s+throw new Error\(/);
    assert.match(run, /\} catch \(err\) \{\n\s+console\.error\(`Extra Packages add-on: [^\n]+\n[^\n]+\n\s+process\.exit\(1\);/);
    const v0 = readFileSync(path.join(root, 'test', 'integration', 'v0.test.ts'), 'utf8');
    assert.match(v0, /if \(NEEDS_ADD_ON\.has\(id\) && !addOn\) \{\n\s+missingInput\([^\n]+\n[^\n]+\n\s+ctx\.skip\(\);/);
    const m6 = readFileSync(path.join(root, 'test', 'integration', 'm6.test.ts'), 'utf8');
    assert.match(m6, /if \(!vsix \|\| !existsSync\(vsix\)\) \{\n\s+missingInput\([^\n]+\n[^\n]+\n\s+this\.skip\(\);/);
  });

  it('every VS Code test file that needs the engine applies the rule, so none skips silently once the data is pinned', () => {
    const files = ['integration', 'restricted'].flatMap((dir) =>
      readdirSync(path.join(root, 'test', dir))
        .filter((f) => f.endsWith('.test.ts'))
        .map((f) => path.join('test', dir, f)),
    );
    const asking = files.filter((f) => readFileSync(path.join(root, f), 'utf8').includes('engineAvailable()'));
    assert.ok(asking.length >= 10, `only ${asking.length} files ask whether the engine is staged`);
    for (const f of asking) {
      const text = readFileSync(path.join(root, f), 'utf8');
      assert.match(text, /import \{[^}]*\bmissingInput\b[^}]*\} from '\.\.\/support\/missingData';/, `${f} does not import the rule`);
      assert.match(text, /if \(!api\.engineAvailable\(\)\) \{\n\s+missingInput\(/, `${f} does not apply the rule where the engine is missing`);
    }
  });

  it('engine-assets.mjs names an unpublished release instead of downloading its files', async () => {
    const { unpublishedProblem } = await importScript<{ unpublishedProblem(source: unknown, dir: string): string | null }>('scripts/engine-assets.mjs');
    assert.equal(unpublishedProblem({ id: 'ctan-x', files: [] }, 'D'), null, 'a source with no release');
    assert.equal(unpublishedProblem({ id: 'e', tag: 'engine-x-1', published: '2026-11-02' }, 'D'), null, 'a published release');
    assert.match(unpublishedProblem({ id: 'e', tag: 'engine-x-1', published: null }, 'D') ?? '', /the release engine-x-1 is not published yet .*put its files into D by hand/);
  });
});
