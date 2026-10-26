// S1 safety fixtures (docs/DESIGN.md#rules): \write18, an .eps figure and a LuaTeX socket attempt each end with a
// plain message, no process started and no connection opened, in the engine host and in its worker. The
// "forced" cases turn the outer defences off on purpose (shell escape on, LuaTeX's socket library loaded) to
// show that the patched glue alone still refuses.

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { root, stubState } from '../support/helpers';
import { compileAndRecord, engineAssetPaths, job, readFolder, sharedEngine } from './support';

const fixtures = path.join(root, 'test', 'engine', 'fixtures');

describe('S1 fixtures: no shell, no outside program, no socket', function () {
  this.timeout(300000);

  before(function () {
    if (!engineAssetPaths()) {
      this.skip();
    }
  });

  async function assertNothingStarted(workerStubs: { blocked: unknown[]; allowedForks: unknown[] } | null) {
    assert.ok(workerStubs, 'the stubs are loaded in the compile worker');
    assert.deepEqual(workerStubs.blocked, [], 'the compile worker tried to spawn or connect');
    assert.deepEqual(workerStubs.allowedForks, []);
    const host = await (await sharedEngine()).host.stubReport();
    assert.ok(host);
    assert.deepEqual(host.blocked, [], 'the engine host tried to spawn or connect');
    assert.deepEqual(host.allowedForks, [], 'the engine host started a process');
    assert.deepEqual(stubState().blocked, [], 'the test process tried to spawn or connect');
  }

  const lines = (text: string, needle: string) => [...new Set(text.split('\n').filter((l) => l.includes(needle)))].join(' | ');

  it('\\write18 runs nothing: TeX reports it disabled and the PDF is made', async () => {
    const { result } = await compileAndRecord(
      'fixture-write18',
      job({ main: 'write18.tex', files: readFolder(fixtures, (f) => f === 'write18.tex'), engine: 'pdflatex', bibtex: 'never', maxPasses: 1, synctex: true }),
    );
    assert.ok(result.pdf, result.error);
    assert.match(result.log, /runsystem\(echo shell-was-here > shell-was-here\.txt\)\.\.\.disabled/);
    assert.match(result.log, /runsystem\(kpsewhich article\.cls\)\.\.\.disabled/);
    await assertNothingStarted(result.stubs);
  });

  it('\\write18 with shell escape forced on: the patched glue still runs nothing', async () => {
    const { result } = await compileAndRecord(
      'fixture-write18-forced',
      job({
        main: 'write18.tex',
        files: readFolder(fixtures, (f) => f === 'write18.tex'),
        engine: 'pdflatex',
        bibtex: 'never',
        maxPasses: 1,
        synctex: true,
        forceShellEscape: true,
        readBack: ['shell-was-here.txt'],
      }),
    );
    assert.ok(result.pdf, result.error);
    assert.match(result.log, /runsystem\(echo shell-was-here > shell-was-here\.txt\)/);
    assert.deepEqual(Object.keys(result.readBack ?? {}), [], 'a command ran and wrote its file');
    console.log(`      ${lines(result.log, 'runsystem')}`);
    await assertNothingStarted(result.stubs);
  });

  it('an .eps figure ends with a plain error, a PDF, and no Ghostscript', async () => {
    const { result, analysis } = await compileAndRecord(
      'fixture-eps',
      job({
        main: 'eps.tex',
        files: readFolder(fixtures, (f) => f === 'eps.tex' || f === 'square.eps'),
        engine: 'pdflatex',
        bibtex: 'never',
        maxPasses: 1,
        synctex: true,
      }),
    );
    assert.ok(result.pdf, result.error);
    assert.ok(analysis.errors.length > 0, 'expected a LaTeX error for the .eps figure');
    console.log(`      ${analysis.errors[0]}`);
    await assertNothingStarted(result.stubs);
  });

  const luaCases = [
    { name: 'with --nosocket (as every LuaTeX call)', socket: false, shell: false, expect: /FIXTURE socket-library: absent/ },
    { name: 'with --socket (the patched glue refuses the socket)', socket: true, shell: false, expect: /FIXTURE socket-connect: nil \/ permission denied/ },
    {
      name: 'with --socket and shell escape forced on (the patched glue refuses both)',
      socket: true,
      shell: true,
      expect: /FIXTURE socket-connect: nil \/ permission denied/,
    },
  ];
  for (const c of luaCases) {
    it(`LuaHBTeX ${c.name}: no connection, no os.execute, no io.popen`, async () => {
      const { result } = await compileAndRecord(
        `fixture-luasocket-${c.socket ? 'socket' : 'nosocket'}${c.shell ? '-shell' : ''}`,
        job({
          main: 'luasocket.tex',
          files: readFolder(fixtures, (f) => f === 'luasocket.tex'),
          engine: 'luahbtex-ini',
          bibtex: 'never',
          maxPasses: 1,
          synctex: false,
          allowLuaSocketLibrary: c.socket,
          forceShellEscape: c.shell,
        }),
      );
      const text = `${result.log}\n${result.transcript}`;
      assert.match(text, c.expect, text.slice(-3000));
      assert.doesNotMatch(text, /lua-was-here/);
      assert.match(text, /FIXTURE os\.execute: true \/ (nil|-1)/);
      assert.match(text, /FIXTURE io\.popen: true \/ nil/);
      console.log(`      ${lines(text, 'FIXTURE')}`);
      await assertNothingStarted(result.stubs);
    });
  }
});
