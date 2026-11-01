// The speed pass rule (test/speed/compare.ts; docs/DEVELOPING.md, "Measuring speed") on small made-up result files:
// a missing value must never pass, a clear gain must pass, and a slower guard row must fail.

import * as assert from 'node:assert/strict';
import { calibration, isAA, isNoisy, judgePaired, judgeUnpaired, REMOVES_WORK_TIMERS, type PairedOptions, type RemovesWork, type RemovesWorkTimer } from '../speed/compare';
import { option } from '../speed/common';
import { stepTotals, type Mode, type Run, type RunMachine, type Sample } from '../speed/samples';

const machine = (over: Partial<RunMachine> = {}): RunMachine => ({
  runtime: { node: '24.0.0', v8: '1', electron: '43.0.0' },
  hostArgs: [],
  env: {},
  data: 'the staged image (dist/data)',
  dataSha: 'image-1',
  engine: 'the staged engine (dist/engine)',
  engineSha: 'engine-1',
  ab: '{}',
  abHost: null,
  abData: null,
  pauseMs: 1000,
  start: { cpuPct: 5, freeMemMB: 8000, reported: { wslLoad: 0.2, windowsCpuPct: 5, power: 'mains' } },
  ...over,
});

function sample(doc: string, rep: number, variant: 'A' | 'B' | undefined, ms: number, cpu: number | null, over: Partial<Sample> = {}): Sample {
  return {
    doc,
    mode: 'quick',
    rep,
    ...(variant ? { variant } : {}),
    attempt: 0,
    convertMs: null,
    collectMs: 1,
    serviceMs: ms,
    hostTotalMs: ms,
    ipcMs: 0,
    engineStartMs: 0,
    hiddenWaitMs: 0,
    prepInstantiateMs: 0,
    prepMountMs: 0,
    mountProjectMs: 0,
    tools: {},
    callMainMs: ms,
    callMainCpuMs: cpu,
    jobCpuMs: cpu,
    restoreMs: 0,
    lz4DecodeMs: 0,
    lz4ReadMs: 0,
    lz4Bytes: 0,
    lz4Chunks: 0,
    fsMs: 0,
    lookups: 0,
    lookupMisses: 0,
    opens: 0,
    openMisses: 0,
    t1cFiles: 0,
    t1cMs: 0,
    resultMs: 0,
    passes: 1,
    heapMB: 64,
    pdfBytes: 1000,
    pages: 2,
    errors: 0,
    pdfSha: 'pdf',
    auxSha: 'aux',
    problemsSha: 'problems',
    synctexSha: 'synctex',
    cpuBusyPct: 10,
    freeMemMB: 8000,
    ...over,
  };
}

/**
 * A paired run: per row, B's time as a share of A's in each pair (A takes 100 ms, CPU 90 % of wall). `b` changes
 * B's sample in every pair (a missing CPU time, no PDF).
 */
function pairedRun(rows: Record<string, number[]>, over: Partial<RunMachine> = {}, b: Partial<Sample> = {}): Run {
  const samples: Sample[] = [];
  for (const [doc, ratios] of Object.entries(rows)) {
    ratios.forEach((r, rep) => {
      samples.push(sample(doc, rep, 'A', 100, 90));
      samples.push(sample(doc, rep, 'B', Math.round(100 * r), Math.round(90 * r), b));
    });
  }
  return { label: 'run', machine: machine(over), samples, hostStarts: [] };
}

/** An A/A calibration: each pair's B differs from A by 4 or 6 %, either way. */
const aa = (docs: string[], over: Partial<RunMachine> = {}): Run =>
  pairedRun(Object.fromEntries(docs.map((d) => [d, [1.04, 0.96, 1.06, 0.94, 1.04, 0.96, 1.06, 0.94, 1.04, 0.96]])), over);

const ten = (r: number) => Array.from({ length: 10 }, () => r);
const opts = (over: Partial<PairedOptions> = {}): PairedOptions => ({ aim: ['article:quick'], band: aa(['article', 'bib']), minPairs: 8, useCpu: true, outputsMayDiffer: false, ...over });
const failsWith = (v: { pass: boolean; failures: string[] }, re: RegExp) => {
  assert.equal(v.pass, false, 'expected FAIL');
  assert.ok(v.failures.some((f) => re.test(f)), `no failure matching ${re}: ${v.failures.join(' | ')}`);
};

describe('speed pass rule (compare.ts)', () => {
  it('passes a clear gain with the same outputs, and keeps the other rows as guards', () => {
    const v = judgePaired(pairedRun({ article: ten(0.8), bib: [1.02, 0.98, 1.02, 0.98, 1.02, 0.98, 1.02, 0.98, 1.02, 0.98] }), opts());
    assert.equal(v.pass, true, v.failures.join(' | '));
    assert.ok(v.lines.some((l) => l.startsWith('| article:quick | yes |') && l.endsWith('| faster |')));
    assert.ok(v.lines.some((l) => l.startsWith('| bib:quick |') && l.endsWith('| same |')));
  });

  it('fails a missing CPU time on side B, which once read as -100 %', () => {
    // The shape a host without the probe writes: jobCpuMs and callMainCpuMs null in the file.
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }, {}, { jobCpuMs: null, callMainCpuMs: null }), opts()), /CPU time missing in 10 of 10/);
    // --no-cpu lifts only that check.
    assert.equal(judgePaired(pairedRun({ article: ten(0.8) }, {}, { jobCpuMs: null }), opts({ useCpu: false })).pass, true);
  });

  it('fails a calibration without CPU times (a band that is not a number)', () => {
    const band = aa(['article']);
    for (const s of band.samples) {
      s.jobCpuMs = null;
    }
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }), opts({ band })), /no CPU times/);
  });

  it('fails a B without a PDF, with another page count or with more errors, even when outputs may differ', () => {
    failsWith(judgePaired(pairedRun({ article: ten(0.3) }, {}, { pdfSha: null, pages: null, errors: 3 }), opts({ outputsMayDiffer: true })), /no PDF on side B/);
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }, {}, { pages: 3, pdfSha: 'other' }), opts({ outputsMayDiffer: true })), /pages 2 -> 3/);
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }, {}, { errors: 1 }), opts({ outputsMayDiffer: true })), /errors 0 -> 1/);
    // Other bytes with the same pages and errors pass only with the flag.
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }, {}, { pdfSha: 'other' }), opts()), /outputs differ/);
    assert.equal(judgePaired(pairedRun({ article: ten(0.8) }, {}, { pdfSha: 'other' }), opts({ outputsMayDiffer: true })).pass, true);
  });

  it('refuses a paired run without --aim, and a --min-pairs that is not a number', () => {
    assert.match(judgePaired(pairedRun({ article: ten(0.8) }), opts({ aim: [] })).error ?? '', /needs --aim/);
    assert.match(judgePaired(pairedRun({ article: ten(0.8) }), opts({ minPairs: NaN })).error ?? '', /--min-pairs/);
  });

  it('fails an aimed row that the run does not have', () => {
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }), opts({ aim: ['article:quick', 'nosuchdoc:quick'] })), /nosuchdoc:quick: aimed, but the run has no pairs/);
  });

  it('fails an aimed row with too few pairs, an odd number, or no clear majority', () => {
    failsWith(judgePaired(pairedRun({ article: ten(0.8).slice(0, 6) }), opts()), /6 pairs: at least 8/);
    failsWith(judgePaired(pairedRun({ article: ten(0.8).slice(0, 9) }), opts()), /9 pairs: at least 8, an even number/);
    failsWith(judgePaired(pairedRun({ article: [0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 1.1, 1.1, 1.1] }), opts()), /B faster in 7 of 10/);
  });

  it('fails a guard row whose wall and CPU medians are both past their bands, whatever the sign test says', () => {
    // B slower by 40 % in 7 of 10 pairs: the sign test alone (p 0.17) would let it through.
    const v = judgePaired(pairedRun({ article: ten(0.8), bib: [1.4, 1.4, 1.4, 1.4, 1.4, 1.4, 1.4, 0.95, 0.95, 0.95] }), opts());
    failsWith(v, /bib:quick: slower/);
  });

  it('fails a run that started busy, and a row with more than half its pairs noisy', () => {
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }, { start: { cpuPct: 70, freeMemMB: 8000 } }), opts()), /started busy or cannot show its start \(machine CPU 70 %/);
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }, { start: { cpuPct: 5, freeMemMB: 8000, reported: { wslLoad: 1.4 } } }), opts()), /WSL load 1.4/);
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }, {}, { noisy: true }), opts()), /10 of 10 pairs noisy/);
  });

  it('refuses a calibration that does not fit the run', () => {
    // Not A/A: B had a switch.
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }), opts({ band: aa(['article'], { ab: '{"restore":"upper"}' }) })), /not an A\/A run/);
    // One host for a run of two hosts.
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }, { ab: null, abHost: ['--jitless'] }), opts({ band: aa(['article']) })), /pairs in one host, the run in two hosts/);
    // Another runtime.
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }), opts({ band: aa(['article'], { runtime: { node: '22.0.0', v8: '1', electron: null } }) })), /another runtime/);
    // More than half its pairs noisy.
    const noisy = aa(['article']);
    for (const s of noisy.samples) {
      s.noisy = true;
    }
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }), opts({ band: noisy })), /more than half its pairs noisy/);
  });

  it('names a row that falls back to d = 10 %', () => {
    const v = judgePaired(pairedRun({ article: ten(0.8), bib: ten(1) }), opts({ band: aa(['article']) }));
    assert.ok(v.lines.includes('note: bib:quick has no row in the calibration; d = 10 %'));
  });

  it('compares the outputs of set-aside tries too', () => {
    const run = pairedRun({ article: ten(0.8) });
    run.samples.push(sample('article', 0, 'A', 300, 270, { discarded: true, attempt: 0 }), sample('article', 0, 'B', 240, 216, { discarded: true, attempt: 0, synctexSha: 'other' }));
    for (const s of run.samples.filter((x) => x.rep === 0 && !x.discarded)) {
      s.attempt = 1;
    }
    failsWith(judgePaired(run, opts()), /try 0 of pair 0 \(set aside\): outputs differ/);
  });

  it('treats two engine folders with the same WebAssembly as A/A, and other WebAssembly as not', () => {
    const two = { ab: null, abHost: null, engine: 'oz-1', engineSha: 'aaa', abEngine: 'oz-2' };
    assert.equal(isAA(aa(['article'], { ...two, abEngineSha: 'aaa' })), true);
    assert.equal(isAA(aa(['article'], { ...two, abEngineSha: 'bbb' })), false);
    assert.equal(isAA(aa(['article'], { ab: null, abHost: [] })), true);
  });

  it('gives d per row from a calibration, and no CPU d when CPU times are missing', () => {
    // |B - A| / A is 4 % in six pairs and 6 % in four: the median is 4 %.
    const c = calibration(aa(['article']));
    assert.equal(c.get('article:quick')?.wall, 4);
    assert.equal(c.get('article:quick')?.n, 10);
    const band = aa(['article']);
    band.samples[1].jobCpuMs = null;
    assert.ok(Number.isNaN(calibration(band).get('article:quick')?.cpu));
  });

  it('refuses a calibration that started busy, has fewer than 10 pairs in a row, or leans', () => {
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }), opts({ band: aa(['article'], { start: { cpuPct: 90, freeMemMB: 8000, reported: { wslLoad: 5 } } }) })), /calibration run started busy.*WSL load 5/);
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }), opts({ band: pairedRun({ article: [1.02, 0.98] }) })), /row article:quick has 2 pairs, fewer than 10/);
    // An A/A row whose B is slower in 10 of 10 pairs: a host or order effect, which |B - A| alone would hide.
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }), opts({ band: pairedRun({ article: ten(1.03) }) })), /row article:quick leans: B slower in 10 of 10/);
  });

  it('refuses a calibration made on another image, engine or host flags than the run, or without their hashes', () => {
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }), opts({ band: aa(['article'], { dataSha: 'image-2' }) })), /another image than the run's A side/);
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }), opts({ band: aa(['article'], { engineSha: 'engine-2' }) })), /another engine than the run's A side/);
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }), opts({ band: aa(['article'], { hostArgs: ['--no-liftoff'] }) })), /other host flags \(--no-liftoff\)/);
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }), opts({ band: aa(['article'], { engineSha: undefined }) })), /does not record its engine and image hashes/);
  });

  it('treats two image folders as one image only when their index files have the same hash', () => {
    const two = { ab: null, abHost: null, data: 'oz', dataSha: 'image-1', abData: 'o2' };
    assert.equal(isAA(aa(['article'], { ...two, abDataSha: 'image-1' })), true);
    assert.equal(isAA(aa(['article'], { ...two, abDataSha: 'image-2' })), false);
    // The same folder name is not enough.
    assert.equal(isAA(aa(['article'], { ...two, abData: 'oz', abDataSha: undefined })), false);
  });

  it('fails a run with no WSL load reported, unless --no-wsl says the machine has none', () => {
    const run = pairedRun({ article: ten(0.8) }, { start: { cpuPct: 5, freeMemMB: 8000, reported: { windowsCpuPct: 5 } } });
    const band = aa(['article', 'bib'], { start: { cpuPct: 5, freeMemMB: 8000 } });
    failsWith(judgePaired(run, opts({ band })), /WSL load not reported/);
    assert.equal(judgePaired(run, opts({ band, noWsl: true })).pass, true);
  });

  it('marks a pair noisy by its own CPU and free memory, whatever thresholds bench was given', () => {
    const run = pairedRun({ article: ten(0.8) }, {}, { cpuBusyPct: 60 });
    assert.equal(isNoisy({ doc: 'article', mode: 'quick', rep: 0, a: run.samples[0], b: run.samples[1] }), true);
    failsWith(judgePaired(run, opts()), /10 of 10 pairs noisy/);
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }, {}, { freeMemMB: 400 }), opts()), /10 of 10 pairs noisy/);
  });

  it('fails a two-host row whose hosts started in one order only', () => {
    const two = { ab: null, abHost: ['--no-liftoff'] };
    const band = aa(['article'], { ab: null, abHost: [] });
    const restart = (beforeRep: number, first: 'A' | 'B') => ({ doc: 'article', mode: 'quick', beforeRep, order: first === 'A' ? (['A', 'B'] as const).slice() : (['B', 'A'] as const).slice(), ms: [300, 300] });
    const oneOrder = { ...pairedRun({ article: ten(0.8) }, two), hostRestarts: [restart(0, 'A'), restart(2, 'A')] };
    failsWith(judgePaired(oneOrder, opts({ band })), /article:quick: the hosts started in one order only/);
    const both = { ...pairedRun({ article: ten(0.8) }, two), hostRestarts: [restart(0, 'A'), restart(2, 'B')] };
    assert.equal(judgePaired(both, opts({ band })).pass, true, judgePaired(both, opts({ band })).failures.join(' | '));
    failsWith(judgePaired(pairedRun({ article: ten(0.8) }, two), opts({ band })), /does not record the hosts' start order/);
  });

  it('reports each guard row\'s band as the slowdown that would pass unseen', () => {
    const v = judgePaired(pairedRun({ article: ten(0.8), bib: ten(1) }), opts());
    // d = 4 % in the calibration, 10 pairs: 3 x 4 / sqrt(10) = 3.8 %.
    assert.ok(v.lines.some((l) => l.startsWith('| bib:quick |') && l.includes('| 3.8 % |')), v.lines.join('\n'));
  });

  describe('a change that only removes work (--removes-work)', () => {
    const sixteen = (r: number) => Array.from({ length: 16 }, () => r);
    const aaSixteen = Array.from({ length: 16 }, (_, i) => [1.04, 0.96, 1.06, 0.94][i % 4]);
    /** Rows by doc:mode; B's time as a share of A's (100 ms) per pair; each side's restore timer (A 3 ms, B 0). */
    const rowRun = (rows: Record<string, { ratios: number[]; restoreA?: number | null; restoreB?: number | null }>, over: Partial<RunMachine> = {}): Run => {
      const samples: Sample[] = [];
      for (const [key, r] of Object.entries(rows)) {
        const [doc, mode] = key.split(':');
        r.ratios.forEach((ratio, rep) => {
          samples.push(sample(doc, rep, 'A', 100, 90, { mode: mode as Mode, restoreMs: r.restoreA === undefined ? 3 : r.restoreA }));
          samples.push(sample(doc, rep, 'B', Math.round(100 * ratio), Math.round(90 * ratio), { mode: mode as Mode, restoreMs: r.restoreB === undefined ? 0 : r.restoreB }));
        });
      }
      return { label: 'run', machine: machine(over), samples, hostStarts: [] };
    };
    const rows = ['article:quick', 'article:cold'];
    /** A timer table for the tests: two rows, and whether work moves past the result. */
    const timers = (afterResult = false): Record<string, RemovesWorkTimer> => ({ restoreMs: { what: 'test', rows, afterResult } });
    const aaRows = (keys: string[], over: Partial<RunMachine> = {}) => rowRun(Object.fromEntries(keys.map((k) => [k, { ratios: aaSixteen, restoreB: 3 }])), over);
    const band = aaRows(rows);
    const removes = (over: Partial<PairedOptions> = {}): PairedOptions => opts({ aim: [], band, removesWork: { timer: 'restoreMs', rows: [] }, timers: timers(), ...over });
    /** The timer drops by 3 ms (3 % of A's time) and the wall time by 3 %. */
    const good = (over: Partial<RunMachine> = {}) => rowRun({ 'article:quick': { ratios: sixteen(0.97) }, 'article:cold': { ratios: sixteen(0.97) } }, over);

    it('passes when the timer shows the work gone in every row it acts on and no row is slower', () => {
      const v = judgePaired(good(), removes());
      assert.equal(v.pass, true, v.failures.join(' | '));
      assert.ok(v.lines.some((l) => l.startsWith('| article:quick | yes |') && l.includes('3 / 0 ms (16 of 16; gain 3 ms)')), v.lines.join('\n'));
    });

    it('refuses an unnamed timer, an aimed row, no calibration, --no-cpu and --outputs-may-differ', () => {
      const err = (o: Partial<PairedOptions>) => judgePaired(good(), removes(o)).error ?? '';
      assert.match(err({ removesWork: { timer: 'fsMs', rows: [] } }), /REMOVES_WORK_TIMERS/);
      assert.match(err({ aim: ['article:quick'] }), /no aimed row/);
      assert.match(err({ band: null }), /needs a calibration/);
      assert.match(err({ useCpu: false }), /keeps the CPU check/);
      assert.match(err({ outputsMayDiffer: true }), /keeps the outputs/);
    });

    it('fails a missing timer (bench writes a missing restore time as null), a timer not lower where the change acts, and a timer higher in any row', () => {
      const run = good();
      run.samples[1].restoreMs = null;
      failsWith(judgePaired(run, removes()), /restoreMs missing in 1 of 16/);
      failsWith(judgePaired(rowRun({ 'article:quick': { ratios: sixteen(0.97), restoreB: 3 }, 'article:cold': { ratios: sixteen(0.97) } }), removes()), /article:quick: .*restoreMs lower on B in only 0 of 16/);
      // Work moved into the timed code of a row the change was not meant to touch shows as a higher timer there.
      const moved = rowRun({ 'article:quick': { ratios: sixteen(0.97) }, 'article:cold': { ratios: sixteen(0.97) }, 'bib:quick': { ratios: sixteen(1), restoreA: 20, restoreB: 40 } });
      failsWith(judgePaired(moved, removes()), /bib:quick: .*restoreMs higher on B/);
    });

    it('fails when the wall time does not show the timer\'s gain: the work may have moved out of the timed code', () => {
      // The timer drops by 5 ms (5 % of A's time), but the wall time stays flat; the band is 3.75 %.
      const flat = rowRun({ 'article:quick': { ratios: sixteen(1), restoreA: 5 }, 'article:cold': { ratios: sixteen(1), restoreA: 5 } });
      failsWith(judgePaired(flat, removes()), /article:quick: .*wall 0 % does not show the timer's gain of 5 % of A's time/);
      // Slower everywhere by 1.5 %, inside the guard band: still caught by the timer's gain.
      const slower = rowRun({ 'article:quick': { ratios: sixteen(1.015), restoreA: 5 }, 'article:cold': { ratios: sixteen(1.015), restoreA: 5 } });
      failsWith(judgePaired(slower, removes()), /does not show the timer's gain/);
      // The same timer drop with the wall time 5 % lower passes.
      assert.equal(judgePaired(rowRun({ 'article:quick': { ratios: sixteen(0.95), restoreA: 5 }, 'article:cold': { ratios: sixteen(0.95), restoreA: 5 } }), removes()).pass, true);
    });

    it('needs every row of the timer\'s own list: restoreMs lists all six documents, quick and cold', () => {
      assert.deepEqual(REMOVES_WORK_TIMERS.restoreMs.rows, ['md', 'article', 'bib', 'beamer', 'xefonts', 'long'].flatMap((d) => [`${d}:quick`, `${d}:cold`]));
      assert.equal(REMOVES_WORK_TIMERS.restoreMs.afterResult, false);
      // A run of two rows, judged by the real table: the ten rows it lacks fail, with or without a narrow --rows.
      const narrow = judgePaired(good(), removes({ timers: undefined }));
      failsWith(narrow, /md:quick: the change acts on this row, but the run has no pairs/);
      failsWith(narrow, /long:cold: the calibration has no row for it/);
      failsWith(judgePaired(good(), removes({ timers: undefined, removesWork: { timer: 'restoreMs', rows: ['article:quick'] } })), /--rows leaves out rows the change acts on \(md:quick, md:cold, article:cold, bib:quick/);
    });

    it('lets --rows add a row, which must then be in the run and the calibration with 16 pairs', () => {
      const plus = removes({ removesWork: { timer: 'restoreMs', rows: [...rows, 'bib:quick'] } });
      failsWith(judgePaired(good(), plus), /bib:quick: the change acts on this row, but the run has no pairs/);
      failsWith(judgePaired(good(), plus), /bib:quick: the calibration has no row for it/);
      const short = rowRun({ 'article:quick': { ratios: sixteen(0.97).slice(0, 10) }, 'article:cold': { ratios: sixteen(0.97) } });
      failsWith(judgePaired(short, removes()), /article:quick: 10 pairs: at least 16/);
    });

    it('fails a slower guard row: the timer does not excuse a slowdown elsewhere', () => {
      failsWith(judgePaired(rowRun({ 'article:quick': { ratios: sixteen(0.97) }, 'article:cold': { ratios: sixteen(1.2) } }), removes()), /article:cold: slower/);
    });

    it('judges both runs when the timer\'s change moves work past the result, and refuses the --pause 0 run alone', () => {
      const after = (rw: Partial<RemovesWork>) => removes({ timers: timers(true), removesWork: { timer: 'restoreMs', rows: [], ...rw } });
      const pause0 = good({ pauseMs: 0 });
      const pause0Band = aaRows(rows, { pauseMs: 0 });
      // The default-pause run alone.
      failsWith(judgePaired(good(), after({})), /give its run made with --pause 0 as well/);
      // The --pause 0 run alone, given as the main run.
      failsWith(judgePaired(pause0, after({})), /this is a --pause 0 run/);
      // Both: passes; and a --pause0 file that was not made with --pause 0 fails.
      const both = judgePaired(good(), after({ pause0, pause0Band }));
      assert.equal(both.pass, true, both.failures.join(' | '));
      assert.ok(both.lines.includes('The --pause 0 run:'));
      failsWith(judgePaired(good(), after({ pause0: good(), pause0Band })), /the --pause 0 run: the --pause 0 run was made with a pause of 1000 ms/);
      // A slowdown in the --pause 0 run alone fails the change.
      const slow0 = rowRun({ 'article:quick': { ratios: sixteen(0.97) }, 'article:cold': { ratios: sixteen(1.2) } }, { pauseMs: 0 });
      failsWith(judgePaired(good(), after({ pause0: slow0, pause0Band })), /the --pause 0 run: article:cold: slower/);
    });
  });

  describe('step totals (stepTotals, which bench.ts uses)', () => {
    it('adds up the programs and keeps a missing CPU or restore time as null, never 0', () => {
      const t = stepTotals([
        { argv: ['pdflatex'], ms: 300, probe: { callMainMs: 290, callMainCpuMs: 280, restoreMs: 17, opens: 302 } },
        { argv: ['bibtex8'], ms: 15, probe: { callMainMs: 14, callMainCpuMs: 13, restoreMs: 16, opens: 10 } },
      ]);
      assert.deepEqual(t.tools, { pdflatex: { ms: 300, runs: 1 }, bibtex8: { ms: 15, runs: 1 } });
      assert.equal(t.callMainCpuMs, 293);
      assert.equal(t.restoreMs, 33);
      assert.equal(t.sums.opens, 312);
      // A worker without the probe reports no record: both times stay null, so compare.js says "missing".
      const none = stepTotals([{ argv: ['pdflatex'], ms: 300 }]);
      assert.equal(none.callMainCpuMs, null);
      assert.equal(none.restoreMs, null);
      assert.equal(stepTotals([{ argv: ['pdflatex'], ms: 300, probe: { callMainCpuMs: 280 } }]).restoreMs, null);
      assert.equal(stepTotals([]).restoreMs, null);
    });
  });

  describe('unpaired', () => {
    const plain = (rows: Record<string, number>, label: string): Run => ({
      label,
      machine: machine({ ab: null }),
      samples: Object.entries(rows).flatMap(([doc, ms]) => [0, 1, 2].map((rep) => sample(doc, rep, undefined, ms, ms))),
      hostStarts: [],
    });

    it('fails an aimed row that neither file has', () => {
      const a = plain({ article: 100 }, 'A');
      failsWith(judgeUnpaired(a, a, null, 5, ['nosuchdoc:quick']), /nosuchdoc:quick: aimed, but A has no such row/);
    });

    it('fails a row of A that B lacks', () => {
      failsWith(judgeUnpaired(plain({ article: 100, bib: 200 }, 'A'), plain({ article: 100 }, 'B'), null, 5, []), /bib:quick: in A but not in B/);
    });

    it('fails a slower row, passes a faster aimed one, and refuses an --allow that is not a number', () => {
      failsWith(judgeUnpaired(plain({ article: 100 }, 'A'), plain({ article: 110 }, 'B'), null, 5, []), /slower/);
      assert.equal(judgeUnpaired(plain({ article: 100 }, 'A'), plain({ article: 80 }, 'B'), plain({ article: 101 }, 'A2'), 5, ['article:quick']).pass, true);
      assert.match(judgeUnpaired(plain({ article: 100 }, 'A'), plain({ article: 80 }, 'B'), null, NaN, []).error ?? '', /--allow/);
    });
  });
});

describe('speed tools: option()', () => {
  const run = (argv: string[], name: string, fallback: number) => {
    const exit = process.exit;
    const error = console.error;
    let code: number | undefined;
    process.exit = ((c?: number) => {
      code = c;
      throw new Error('exit');
    }) as typeof process.exit;
    console.error = () => undefined;
    try {
      return { value: option(argv, name, fallback, true), code };
    } catch {
      return { value: undefined, code };
    } finally {
      process.exit = exit;
      console.error = error;
    }
  };

  it('keeps the default when the option is absent, whatever comes first (experiments.js map once ran 0 times)', () => {
    assert.deepEqual(run(['map'], '--reps', 7), { value: 7, code: undefined });
    assert.deepEqual(run(['map', '--reps', '3'], '--reps', 7), { value: 3, code: undefined });
  });

  it('stops with exit code 2 on a missing value, another option in its place, or a value that is not a number', () => {
    assert.equal(run(['map', '--reps'], '--reps', 7).code, 2);
    assert.equal(run(['--reps', '--out', 'x'], '--reps', 7).code, 2);
    assert.equal(run(['--reps', 'abc'], '--reps', 7).code, 2);
    // An empty value once read as 0.
    assert.equal(run(['--reps', ''], '--reps', 7).code, 2);
  });
});
