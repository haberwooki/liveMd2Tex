// Plain-words help for the 20 most common TeX errors, on the engine (docs/DESIGN.md#help-for-new-users): each fixture
// in test/fixtures/tex-errors/ makes its error happen with pdfLaTeX; the log goes through the extension's log
// parser, and the first error must get the help the fixture is named after.

import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { helpFor, HELP_IDS } from '../../src/extension/diagnostics/errorHelp';
import { parseTexLog } from '../../src/extension/diagnostics/logParser';
import { root } from '../support/helpers';
import { engineAssetPaths, job, sharedEngine } from './support';

const dir = path.join(root, 'test', 'fixtures', 'tex-errors');
const fixtures = readdirSync(dir).filter((f) => f.endsWith('.tex'));

describe('plain-words help for the 20 most common TeX errors, on the engine', function () {
  this.timeout(600000);

  before(function () {
    if (!engineAssetPaths()) {
      this.skip();
    }
  });

  it('has one fixture for each error that has help', () => {
    assert.deepEqual(
      fixtures.map((f) => f.replace(/^\d+-/, '').replace(/\.tex$/, '')).sort(),
      [...HELP_IDS].sort(),
    );
  });

  for (const file of fixtures) {
    const id = file.replace(/^\d+-/, '').replace(/\.tex$/, '');
    it(`${id}: the error happens, and its help is shown`, async () => {
      const { host } = await sharedEngine();
      const data = new Uint8Array(readFileSync(path.join(dir, file)));
      const result = await host.compile(job({ main: 'main.tex', files: [{ path: 'main.tex', data }], engine: 'pdflatex', bibtex: 'never', maxPasses: 1, synctex: false }));
      const errors = parseTexLog(result.log, 'main.tex').filter((d) => d.severity === 'error');
      assert.ok(errors.length > 0, `${file}: no error in the log`);
      const help = helpFor(errors[0].message);
      assert.equal(help?.id, id, `${file}: "${errors[0].message}" got ${help?.id ?? 'no help'}`);
      assert.ok((help?.help.length ?? 0) > 20);
    });
  }

  /** The first TeX error of a fixture compiled on the engine, as the log parser gives it. */
  async function firstError(file: string): Promise<string> {
    const { host } = await sharedEngine();
    const data = new Uint8Array(readFileSync(file));
    const result = await host.compile(job({ main: 'main.tex', files: [{ path: 'main.tex', data }], engine: 'pdflatex', bibtex: 'never', maxPasses: 1, synctex: false }));
    const errors = parseTexLog(result.log, 'main.tex').filter((d) => d.severity === 'error');
    assert.ok(errors.length > 0, `${file}: no error in the log`);
    return errors[0].message;
  }

  for (const [file, right, wrong] of [
    ['undefined-in-macro.tex', 'foo', 'mymacro'],
    ['undefined-in-argument.tex', 'foo', 'ref'],
  ] as const) {
    it(`variants/${file}: the help names \\${right}, the command TeX did not know, not \\${wrong}`, async () => {
      const message = await firstError(path.join(dir, 'variants', file));
      const help = helpFor(message);
      assert.equal(help?.id, 'undefined-command', message);
      assert.match(help?.help ?? '', new RegExp(`the command \\\\${right}\\.`), `${message} -> ${help?.help ?? ''}`);
      assert.doesNotMatch(help?.help ?? '', new RegExp(`\\\\${wrong}\\b`));
    });
  }

  it("file-ended: the help names the command without TeX's full stop", async () => {
    const message = await firstError(path.join(dir, '08-file-ended.tex'));
    assert.match(helpFor(message)?.help ?? '', /argument of \\textbf: a \}/, message);
  });
});
