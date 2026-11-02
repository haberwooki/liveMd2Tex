// Safety fixtures (docs/DESIGN.md#rules): \write18, \input|, an output pipe and an .eps figure each end with a plain
// message, no process started and no connection opened, in the engine host and in its worker. The "forced" cases
// turn shell escape on on purpose, to show that the engine's own stubs (engine/build/stubs.c: system() and popen()
// refuse) still run nothing: TeX reports the stub's answer, the transcript and the .fls show the command reached it,
// no file appears in the engine's file system or on the real disk, and the stubs record no process.

import * as assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { root, stubState } from '../support/helpers';
import { compileAndRecord, engineAssetPaths, job, readFolder, sharedEngine } from './support';

const fixtures = path.join(root, 'test', 'engine', 'fixtures');

describe('safety fixtures: no shell, no outside program', function () {
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

  /**
   * A command that ran would write its file on the real disk, in the engine host's working folder (the test's), not
   * in the engine's in-memory file system: none may be there after the run.
   */
  const onDisk = (name: string) => [process.cwd(), root].map((d) => path.join(d, name));
  const clearDisk = (name: string) => onDisk(name).forEach((p) => rmSync(p, { force: true }));
  const assertNotOnDisk = (name: string) => assert.deepEqual(onDisk(name).filter((p) => existsSync(p)), [], `a command ran and wrote ${name}`);

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

  it("\\write18 with shell escape forced on: the engine's system() stub answers -1 and runs nothing", async () => {
    clearDisk('shell-was-here.txt');
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
        readBack: ['shell-was-here.txt', 'tex-wrote-this.txt'],
      }),
    );
    assert.ok(result.pdf, result.error);
    assert.match(result.log, /runsystem\(echo shell-was-here > shell-was-here\.txt\)/);
    // The command reached system(), and our stub answered -1 (web2c's runsystem prints the code).
    assert.match(result.transcript, /system returned with code -1/);
    // The file TeX wrote itself is read back, so the read-back works; the command's file is not there, nor on disk.
    assert.equal(result.readBack?.['tex-wrote-this.txt']?.trim(), 'written by TeX');
    assert.equal(result.readBack?.['shell-was-here.txt'], undefined, 'a command ran and wrote its file');
    assertNotOnDisk('shell-was-here.txt');
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

  // A runaway \romannumeral recursion: each level is a deeper C call. Each case runs twice: with Node's default 4 MB
  // worker stack, pdfTeX's first run still ends with TeX's message and the second with a RangeError (at -Oz, checked
  // 2026-11-01 three times, and at -O3 on 2026-11-02; V8 compiling the hot functions again, with larger frames, is the
  // likely reason). At -O3, the shipped level, XeTeX's first run fails at 4 MB too; at -Oz it held. With the worker's
  // 16 MiB (core.ts, WORKER_STACK_MB) every run ends with TeX's message.
  for (const engine of ['pdflatex', 'xelatex'] as const) {
    it(`a runaway macro ends with TeX's own "expansion depth" message, not a stack overflow of the worker, twice (${engine})`, async () => {
      for (const run of [1, 2]) {
        const { result } = await compileAndRecord(
          `fixture-recursion-${engine}-${run}`,
          job({ main: 'recursion.tex', files: readFolder(fixtures, (f) => f === 'recursion.tex'), engine, bibtex: 'never', maxPasses: 1, synctex: false }),
        );
        assert.match(result.log, /TeX capacity exceeded, sorry \[expansion depth=10000\]/, `run ${run}: ${result.transcript.slice(-2000)}`);
        assert.doesNotMatch(`${result.transcript}\n${result.error ?? ''}`, /RangeError|Maximum call stack|the step stopped with/, `run ${run}`);
      }
    });
  }

  it("\\input| with shell escape forced on: the engine's popen() stub refuses, the file is not found, nothing runs", async () => {
    clearDisk('pipe-was-here.txt');
    const { result } = await compileAndRecord(
      'fixture-input-pipe-forced',
      job({
        main: 'input-pipe.tex',
        files: readFolder(fixtures, (f) => f === 'input-pipe.tex'),
        engine: 'pdflatex',
        bibtex: 'never',
        maxPasses: 1,
        synctex: false,
        forceShellEscape: true,
        readBack: ['pipe-was-here.txt', 'input-pipe.fls'],
      }),
    );
    assert.equal(result.pdf, null, 'the document stops at the refused pipe');
    assert.match(result.log, /not found|can't find file/i);
    // TeX took the pipe branch (it records the command in the .fls before popen()), so the refusal was popen()'s,
    // not a missing file named "|echo ...".
    assert.match(result.readBack?.['input-pipe.fls'] ?? '', /^INPUT echo pipe-was-here > pipe-was-here\.txt$/m);
    assert.equal(result.readBack?.['pipe-was-here.txt'], undefined, 'a command ran and wrote its file');
    assertNotOnDisk('pipe-was-here.txt');
    await assertNothingStarted(result.stubs);
  });

  it("an output pipe with shell escape forced on: the engine's popen() stub refuses, the pipe is not opened, nothing runs", async () => {
    clearDisk('out-pipe-was-here.txt');
    const { result } = await compileAndRecord(
      'fixture-output-pipe-forced',
      job({
        main: 'output-pipe.tex',
        files: readFolder(fixtures, (f) => f === 'output-pipe.tex'),
        engine: 'pdflatex',
        bibtex: 'never',
        maxPasses: 1,
        synctex: false,
        forceShellEscape: true,
        readBack: ['out-pipe-was-here.txt', 'output-pipe.fls'],
      }),
    );
    // TeX asked popen() for the pipe (the .fls records the command), and the refusal stops the document.
    assert.match(result.readBack?.['output-pipe.fls'] ?? '', /^OUTPUT echo out-pipe-was-here > out-pipe-was-here\.txt$/m);
    assert.equal(result.readBack?.['out-pipe-was-here.txt'], undefined, 'a command ran and wrote its file');
    assertNotOnDisk('out-pipe-was-here.txt');
    console.log(`      pdf: ${result.pdf ? 'yes' : 'no'}; ${lines(result.log, 'I can\'t write on file') || lines(result.log, '!') || 'no error line'}`);
    await assertNothingStarted(result.stubs);
  });
});
