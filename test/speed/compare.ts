// The pass rule of a speed change (docs/DEVELOPING.md, "Measuring speed"), applied to bench.ts's result files.
//
// Paired (the normal case): one result file of a paired run (--ab, --ab-host, --ab-data, --ab-env, --ab-engine).
//   node out/test/speed/compare.js --paired P.json --aim article:quick,bib:quick --band CAL.json [--min-pairs 8]
//        [--no-cpu] [--outputs-may-differ] [--no-wsl] [--no-power]
//   0. The run: it records its start load and did not start busy (machine or Windows CPU above 30 %, or a WSL load
//      above 1; a missing WSL load fails unless --no-wsl says the machine has none) or short of memory (under 3,000
//      MB free). It stayed on mains: the benchmark's power watcher has a reading at the start and at the end, every
//      reading is mains, and no gap between the run's start, its readings and its end is longer than 90 s
//      (--no-power on a system without the watcher; a run made on Windows always has one, so there it is refused).
//      With two hosts, the file shows both start orders in every row, and the calibration restarted its hosts at the
//      same interval as the run. The report names every check lifted by --no-cpu, --outputs-may-differ, --no-wsl
//      or --no-power. The calibration (--band) is an A/A run of the same pairing kind,
//      runtime, engine, image and host flags as the run's A side; it passes the same start and power checks; at most
//      half its pairs are noisy; each row the run uses has at least 10 pairs (with two hosts, at least 4 restart
//      blocks outside fresh mode); and no row leans: each row's two-sided sign test on its untied pairs, corrected
//      for the number of rows the run uses (Holm, at 0.10 for the family, which is 0.10 for a single row).
//   Ties: a pair whose A and B times are equal counts as neither faster nor slower, and every sign test here runs on
//   the untied pairs only.
//   Blocks (two hosts): each engine host keeps its own speed for as long as it runs, so the pairs between two
//   restarts form one block and a row's blocks, not its pairs, are the independent units. The report shows each
//   block's median, and the band covers the spread of the calibration's block medians (below). One host (--ab)
//   runs A and B in the same host, so its row is one block and the band is the pair band.
//   1. Same output: in every pair, set-aside tries included, A's and B's PDF, .aux, problems list and SyncTeX text
//      have the same hash (--outputs-may-differ lifts this for an engine or data change). Whatever the flag, a pair
//      fails when either side has no PDF, the page counts differ, or B has more error lines than A.
//   2. The worker's CPU time is present in every pair (a missing one means a side ran without the probe or failed),
//      unless --no-cpu. It is reported beside wall time, not counted as a second witness: on this laptop it grows
//      with the machine's load as wall time does.
//   3. Each aimed row: at least --min-pairs pairs, an even number; B faster in a majority of the untied pairs that
//      the one-sided sign test calls clear (p at most 0.05: 7 of 8, 9 of 10, 10 of 12); the median of (B - A) / A
//      below minus the band.
//   4. Every other row fails when its wall median is past the band and either the sign test calls B clearly slower
//      (untied pairs) or the CPU median is past its band too (with --no-cpu: the wall median alone). The report gives
//      each such row's band as the slowdown that would pass unseen.
//   5. A pair is noisy when either side was marked so, or ran above 40 % machine CPU, or started below 1,000 MB of
//      free memory (recomputed here, whatever thresholds bench was given). A row with more than half its pairs noisy
//      fails as "run again".
//   The band of a row with n pairs is 3 d / sqrt(n) (about 1.6 standard errors of the median), where d is the median
//   of |B - A| / A in that row of the calibration; a row the calibration lacks gets d = 10 % and says so. With two
//   hosts the band is the larger of that and 3 d_block / sqrt(blocks), where d_block is the median of the absolute
//   block medians in the calibration's row and blocks is the number of blocks in the run's row.
//
// A change that only removes work (only the changes this file names in REMOVES_WORK_TIMERS):
//   node out/test/speed/compare.js --paired P.json --removes-work restoreMs --band CAL.json [--rows doc:mode,...]
//        [--pause0 P0.json [--pause0-band CAL0.json]] [--min-pairs 16] [--no-wsl]
//   No aimed row: every row is a guard row (rule 4), and rules 0, 1, 2 (CPU present) and 5 apply. The timer's entry
//   in REMOVES_WORK_TIMERS lists every document and mode the change acts on (--rows may add rows, never leave one
//   out); each must be in the run with at least 16 pairs and in the calibration. The timer must be present on both
//   sides of every pair; in each listed row B's timer is lower in a clear majority of pairs, and in no row is it
//   higher (by median or by a clear majority). In each listed row the wall time must not contradict the timer: its
//   median may be at most minus the timer's gain (as a share of A's wall median) plus the band, or the work may
//   have moved out of the timed code. When the entry says the change moves work past the result, the run given as
//   --paired must be a default-pause run, and the run made with --pause 0 is given as --pause0 and judged the same
//   way. The claimed gain is the timer's, printed per row.
//
// Calibration: node out/test/speed/compare.js --calibration CAL.json prints d per row (wall and CPU time).
//
// Unpaired (when B cannot run beside A): the A run, the B run, and A again.
//   node out/test/speed/compare.js A.json B.json [--a2 A2.json] [--allow 5] [--aim doc:mode,...]
//   Same output by (document, mode, compile); every row of A and every aimed row present in B; no row slower than
//   --allow % (default 5); each aimed row faster by more than the larger of --allow and A's drift (A compared with
//   A2); a drift above --allow in an aimed row means the machine was too busy. It has no sign test, no noisy check
//   and no start-load check, so a paired run is preferred whenever B can run beside A.
//
// Exit code 0 means PASS, 1 FAIL, 2 a mistake in the arguments. PASS is necessary, not sufficient: the gate also
// reads the suites and the reports. The rerun policy (one full rerun at most, of every row, with a fresh A/A
// calibration made in the same quiet window; docs/DEVELOPING.md) is for the people running it, not for this tool.

import { readFileSync } from 'node:fs';
import { median, option, r1, signTestP } from './common';
import { brokenB, kept, pairsOf, sameOutputs, type Pair, type Run, type Sample } from './samples';

const rowKey = (doc: string, mode: string) => `${doc}:${mode}`;
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
/** The machine load above which a run's start makes the whole run noisy. */
const BUSY_START_CPU = 30;
const BUSY_START_WSL = 1;
/** Rule 5's thresholds for a noisy pair (above), applied here whatever bench was told. */
const MAX_BUSY = 40;
const MIN_FREE_MB = 1000;
/** The least free memory at a run's start (a calibration that started with 1.3 GB free ran short). */
const MIN_START_FREE_MB = 3000;
/** The fewest pairs a calibration row may have. */
const CALIBRATION_MIN_PAIRS = 10;
/** Two hosts: the fewest restart blocks a calibration row may have outside fresh mode (16 pairs, --restart-every 4). */
const CALIBRATION_MIN_BLOCKS = 4;
/** The calibration's lean check: the family's level for Holm's correction over the rows the run uses. */
const LEAN_ALPHA = 0.1;
/** --removes-work: the fewest pairs per row for a change that only removes work. */
const REMOVES_WORK_MIN_PAIRS = 16;
/** A change that only removes work, and the timer that covers its code on both sides. */
export interface RemovesWorkTimer {
  /** What the change removes. */
  what: string;
  /** Every document and mode the change acts on (doc:mode): the run and the calibration must have them all. */
  rows: string[];
  /** Whether the change moves work past the result: then a run made with --pause 0 is judged too. */
  afterResult: boolean;
}

const BENCH_DOCS = ['md', 'article', 'bib', 'beamer', 'xefonts', 'long'];

/**
 * The timers --removes-work may use, one per change named for it, with the rows the change acts on and whether it
 * moves work past the result. Adding one needs a review that confirms, from the change's diff, that it adds work on
 * no path.
 */
export const REMOVES_WORK_TIMERS: Record<string, RemovesWorkTimer> = {
  restoreMs: {
    what: 'the memory restore between programs (restored before the next program instead of after each one)',
    // Every document, a first compile (two to four programs) and a quick pass (one TeX pass; XeTeX's adds xdvipdfmx).
    rows: BENCH_DOCS.flatMap((d) => [`${d}:quick`, `${d}:cold`]),
    // The job's last restore is dropped and the worker exits; nothing moves past the result.
    afterResult: false,
  },
};

export interface Verdict {
  pass: boolean;
  /** Set when the arguments themselves are wrong (the command exits 2). */
  error?: string;
  failures: string[];
  lines: string[];
}

/** Whether a pair is noisy: marked so by bench, or past rule 5's thresholds (above) on either side. */
export const isNoisy = (p: Pair): boolean =>
  Boolean(p.a.noisy || p.b.noisy) || [p.a, p.b].some((s) => !(s.cpuBusyPct <= MAX_BUSY) || !(s.freeMemMB >= MIN_FREE_MB));

export interface CalibrationRow {
  /** d, the median of |B - A| / A in percent: wall time and job CPU time. */
  wall: number;
  cpu: number;
  n: number;
  noisy: number;
  /** Pairs in which B was faster, slower, or tied with A (wall time), for the lean check. */
  faster: number;
  slower: number;
  ties: number;
  /** Each block's median of (B - A) / A, percent (wall); one block for a one-host run. */
  blocks: number[];
  /** d_block: the median of the absolute block medians, percent, for wall time and job CPU time. */
  blockWall: number;
  blockCpu: number;
}

/** B faster, slower and tied with A in a row's pairs (wall time). */
function signs(g: Pair[]): { faster: number; slower: number; ties: number } {
  const faster = g.filter((p) => p.b.serviceMs < p.a.serviceMs).length;
  const slower = g.filter((p) => p.b.serviceMs > p.a.serviceMs).length;
  return { faster, slower, ties: g.length - faster - slower };
}

/**
 * A row's pairs in blocks: with two hosts, the pairs between two restarts of the hosts (each host keeps its own
 * speed while it runs), and in fresh mode, where the hosts start again before every compile, each pair alone. One
 * host: the whole row. Pairs before a row's first recorded restart form a block of their own.
 */
export function blocksOf(run: Run, g: Pair[]): Pair[][] {
  if (pairingKind(run) !== 'two hosts' || g.length === 0) {
    return g.length > 0 ? [g] : [];
  }
  const { doc, mode } = g[0];
  const sorted = [...g].sort((x, y) => x.rep - y.rep);
  if (mode === 'fresh') {
    return sorted.map((p) => [p]);
  }
  const starts = (run.hostRestarts ?? []).filter((r) => r.doc === doc && r.mode === mode).map((r) => r.beforeRep);
  const out = new Map<number, Pair[]>();
  for (const p of sorted) {
    const block = starts.filter((s) => s <= p.rep).length;
    out.set(block, [...(out.get(block) ?? []), p]);
  }
  return [...out.values()];
}

/** The median of (B - A) / A in percent within each block, against the row's A median (wall, or job CPU). */
function blockMedians(blocks: Pair[][], cpu: boolean, aMedian: number): number[] {
  return blocks.map((b) => median(b.map((p) => (100 * (cpu ? (p.b.jobCpuMs ?? NaN) - (p.a.jobCpuMs ?? NaN) : p.b.serviceMs - p.a.serviceMs)) / aMedian)));
}

/** d per row: the median of |B - A| / A (percent) over a run's pairs, for wall time and job CPU time. */
export function calibration(run: Run): Map<string, CalibrationRow> {
  const out = new Map<string, CalibrationRow>();
  const pairs = pairsOf(run.samples);
  for (const key of new Set(pairs.map((p) => rowKey(p.doc, p.mode)))) {
    const g = pairs.filter((p) => rowKey(p.doc, p.mode) === key);
    const am = median(g.map((p) => p.a.serviceMs));
    const ac = median(g.map((p) => p.a.jobCpuMs ?? NaN));
    const hasCpu = g.every((p) => finite(p.a.jobCpuMs) && finite(p.b.jobCpuMs));
    const cpu = hasCpu ? median(g.map((p) => (100 * Math.abs((p.b.jobCpuMs as number) - (p.a.jobCpuMs as number))) / ac)) : NaN;
    const blocks = blocksOf(run, g);
    const bw = blockMedians(blocks, false, am);
    const bc = hasCpu ? blockMedians(blocks, true, ac) : [];
    out.set(key, {
      wall: r1(median(g.map((p) => (100 * Math.abs(p.b.serviceMs - p.a.serviceMs)) / am))),
      cpu: r1(cpu),
      n: g.length,
      noisy: g.filter(isNoisy).length,
      ...signs(g),
      blocks: bw.map(r1),
      blockWall: r1(median(bw.map(Math.abs))),
      blockCpu: hasCpu ? r1(median(bc.map(Math.abs))) : NaN,
    });
  }
  return out;
}

/** One host (--ab) or two (--ab-host, --ab-data, --ab-env, --ab-engine). */
function pairingKind(run: Run): 'one host' | 'two hosts' | 'unpaired' {
  const m = run.machine;
  if (m.ab !== null && m.ab !== undefined) {
    return 'one host';
  }
  if (m.abHost !== null && m.abHost !== undefined) {
    return 'two hosts';
  }
  if (m.abData || (m.abEnv && Object.keys(m.abEnv).length > 0) || m.abEngine) {
    return 'two hosts';
  }
  return 'unpaired';
}

/**
 * Whether a run is an A/A run: the same switches, flags, image, environment and engine on both sides. Two engine
 * folders count as one engine when their engine files (glue, WebAssembly, texmf-override.cnf, fonts.conf) have the
 * same hash, and two image folders as one image when their index files have the same hash.
 */
export function isAA(run: Run): boolean {
  const m = run.machine;
  const kind = pairingKind(run);
  if (kind === 'one host') {
    return m.ab === '{}';
  }
  return (
    kind === 'two hosts' &&
    (m.abHost ?? []).length === 0 &&
    (!m.abData || (Boolean(m.abDataSha) && m.abDataSha === m.dataSha)) &&
    !(m.abEnv && Object.keys(m.abEnv).length > 0) &&
    (!m.abEngine || (Boolean(m.abEngineSha) && m.abEngineSha === m.engineSha))
  );
}

/** Why a run's start makes it noisy (or cannot be judged), or null. */
function busyStart(run: Run, noWsl: boolean): string | null {
  const s = run.machine.start;
  if (!s) {
    return 'it records no start load (an older result file)';
  }
  const why: string[] = [];
  if (!(s.cpuPct <= BUSY_START_CPU)) {
    why.push(`machine CPU ${s.cpuPct} % at the start`);
  }
  // Read from a file: a value that is not a number counts as not reported.
  const wsl: unknown = s.reported?.wslLoad;
  if (typeof wsl !== 'number') {
    if (!noWsl) {
      why.push('WSL load not reported (LIVEMD2TEX_SPEED_START_LOAD; --no-wsl on a machine without WSL)');
    }
  } else if (!(wsl <= BUSY_START_WSL)) {
    why.push(`WSL load ${wsl} at the start`);
  }
  const win: unknown = s.reported?.windowsCpuPct;
  if (typeof win === 'number' && !(win <= BUSY_START_CPU)) {
    why.push(`Windows CPU ${win} % at the start`);
  }
  if (!(s.freeMemMB >= MIN_START_FREE_MB)) {
    why.push(`${s.freeMemMB} MB free at the start, under ${MIN_START_FREE_MB}`);
  }
  return why.length > 0 ? why.join(', ') : null;
}

/** The longest a power record may go without a reading (the watcher reads about every 30 s). */
const MAX_POWER_GAP_S = 90;

/**
 * Why a run cannot show that it stayed on mains, or null. The calling script's start report must not say battery,
 * and the benchmark's power watcher must have a reading at the start and at the end, every one of them mains (2) or
 * "no battery" (null), with no gap of more than 90 s from the run's start through its readings to its end (a
 * watcher that died in the middle leaves one). Without a watcher's readings the run fails, unless noPower says the
 * system has no watcher; a run made on Windows always has one, so there noPower is refused.
 */
function powerProblem(r: Run, noPower: boolean): string | null {
  const m = r.machine;
  const reported: unknown = m.start?.reported?.power;
  if (typeof reported === 'string' && reported !== 'mains' && reported !== 'no battery') {
    return `the calling script reported power "${reported}" at the start`;
  }
  if (noPower && (m.platform ?? '').startsWith('win32')) {
    return `--no-power is for a system without the power watcher, and this run ran on Windows (${m.platform ?? ''})`;
  }
  const readings = m.power?.readings ?? [];
  if (readings.length === 0) {
    return noPower ? null : `it records no power readings (${m.power?.noWatcher ?? 'an older result file'}; --no-power on a system without the watcher)`;
  }
  if (readings.length < 2) {
    return `it records ${readings.length} power reading${readings.length === 1 ? '' : 's'}, not one at the start and one at the end`;
  }
  const off = readings.filter((r) => r.status !== 2 && r.status !== null);
  if (off.length > 0) {
    return `it left mains: ${off.length} of ${readings.length} power readings were not mains (the first at ${off[0].at}, battery status ${String(off[0].status)})`;
  }
  const times = [r.started, ...readings.map((x) => x.at), r.finished].filter((x): x is string => typeof x === 'string').map((x) => Date.parse(x)).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) {
    const gap = (times[i] - times[i - 1]) / 1000;
    if (gap > MAX_POWER_GAP_S) {
      return `its power readings have a gap of ${Math.round(gap)} s (from ${new Date(times[i - 1]).toISOString()} to ${new Date(times[i]).toISOString()}): the watcher may have stopped`;
    }
  }
  return null;
}

/** Why a calibration does not fit the run, for the rows the run uses (empty: it fits). */
function calibrationProblems(b: Run, run: Run, rows: string[], cal: Map<string, CalibrationRow>, noWsl: boolean, noPower: boolean): string[] {
  const out: string[] = [];
  const name = `the calibration ${b.label}`;
  if (!isAA(b)) {
    out.push(`${name} is not an A/A run`);
  }
  if (pairingKind(b) !== pairingKind(run)) {
    out.push(`${name} pairs in ${pairingKind(b)}, the run in ${pairingKind(run)}`);
  }
  const rb = b.machine.runtime;
  const rr = run.machine.runtime;
  if (rb.node !== rr.node || rb.electron !== rr.electron || rb.v8 !== rr.v8) {
    out.push(`${name} ran under another runtime`);
  }
  if (!b.machine.engineSha || !b.machine.dataSha || !run.machine.engineSha || !run.machine.dataSha) {
    out.push(`${name} or the run does not record its engine and image hashes (an older result file)`);
  } else {
    if (b.machine.engineSha !== run.machine.engineSha) {
      out.push(`${name} ran another engine than the run's A side`);
    }
    if (b.machine.dataSha !== run.machine.dataSha) {
      out.push(`${name} ran another image than the run's A side`);
    }
  }
  if (JSON.stringify(b.machine.hostArgs ?? []) !== JSON.stringify(run.machine.hostArgs ?? [])) {
    out.push(`${name} ran with other host flags (${(b.machine.hostArgs ?? []).join(' ') || 'none'}) than the run (${(run.machine.hostArgs ?? []).join(' ') || 'none'})`);
  }
  const busy = busyStart(b, noWsl);
  if (busy) {
    out.push(`${name} started busy or cannot show its start (${busy})`);
  }
  if (pairingKind(b) === 'two hosts' && b.machine.restartEvery !== run.machine.restartEvery) {
    out.push(`${name} restarted its hosts every ${String(b.machine.restartEvery)} pairs and the run every ${String(run.machine.restartEvery)}: its block spread does not fit the run's blocks`);
  }
  const power = powerProblem(b, noPower);
  if (power) {
    out.push(`${name}: ${power}`);
  }
  const bp = pairsOf(b.samples);
  if (bp.filter(isNoisy).length * 2 > bp.length) {
    out.push(`${name} has more than half its pairs noisy: calibrate on a quiet machine`);
  }
  const leans: { key: string; c: CalibrationRow; p: number }[] = [];
  for (const key of rows) {
    const c = cal.get(key);
    if (!c) {
      continue;
    }
    if (c.n < CALIBRATION_MIN_PAIRS) {
      out.push(`${name}'s row ${key} has ${c.n} pairs, fewer than ${CALIBRATION_MIN_PAIRS}`);
    }
    if (pairingKind(b) === 'two hosts' && !key.endsWith(':fresh') && c.blocks.length < CALIBRATION_MIN_BLOCKS) {
      out.push(`${name}'s row ${key} has ${c.blocks.length} restart block${c.blocks.length === 1 ? '' : 's'}, fewer than ${CALIBRATION_MIN_BLOCKS} (--restart-every 4 with 16 pairs)`);
    }
    const untied = c.faster + c.slower;
    leans.push({ key, c, p: Math.min(1, 2 * Math.min(signTestP(c.faster, untied), signTestP(c.slower, untied))) });
  }
  // Holm: the smallest p against LEAN_ALPHA / m, the next against LEAN_ALPHA / (m - 1), and so on, stopping at the
  // first row that is not clear. A perfect A/A run of 10 rows then leans by chance at most 10 % of the time, not 40 %.
  leans.sort((x, y) => x.p - y.p);
  for (const [i, { key, c, p }] of leans.entries()) {
    const limit = LEAN_ALPHA / (leans.length - i);
    if (p > limit) {
      break;
    }
    const dir = c.faster > c.slower ? 'faster' : 'slower';
    out.push(
      `${name}'s row ${key} leans: B ${dir} in ${Math.max(c.faster, c.slower)} of ${c.faster + c.slower} untied pairs of the same build (${c.ties} tie${c.ties === 1 ? '' : 's'}; two-sided p ${p.toFixed(4)}, Holm's limit ${limit.toFixed(4)} over ${leans.length} row${leans.length === 1 ? '' : 's'})`,
    );
  }
  return out;
}

/** Two hosts: each row (fresh mode aside, which restarts every compile) must show both start orders. */
function startOrderProblems(run: Run, rows: string[]): string[] {
  if (pairingKind(run) !== 'two hosts') {
    return [];
  }
  if (!run.hostRestarts) {
    return ['the file does not record the hosts\' start order (an older result file)'];
  }
  const out: string[] = [];
  for (const key of rows) {
    const [doc, mode] = key.split(':');
    if (mode === 'fresh') {
      continue;
    }
    const firsts = new Set(run.hostRestarts.filter((r) => r.doc === doc && r.mode === mode).map((r) => r.order[0]));
    if (!(firsts.has('A') && firsts.has('B'))) {
      out.push(`${key}: the hosts started in one order only through the row`);
    }
  }
  return out;
}

export interface RemovesWork {
  /** A sample field that times the work removed, on both sides (one of REMOVES_WORK_TIMERS). */
  timer: string;
  /** --rows: rows to judge besides the timer's own list (empty: the list alone). Leaving one of the list out fails. */
  rows: string[];
  /** --pause0: the run made with --pause 0, required when the timer's entry says work moves past the result. */
  pause0?: Run | null;
  /** --pause0-band: its calibration; the main calibration when absent. */
  pause0Band?: Run | null;
}

export interface PairedOptions {
  aim: string[];
  band: Run | null;
  minPairs: number;
  useCpu: boolean;
  outputsMayDiffer: boolean;
  /** The machine has no WSL, so no WSL load is reported. */
  noWsl?: boolean;
  /** The runs carry no power watcher's record (a system without one), so none is required. */
  noPower?: boolean;
  /** --removes-work: judge a change that only removes work. */
  removesWork?: RemovesWork | null;
  /** The named timers (REMOVES_WORK_TIMERS unless a test gives others). */
  timers?: Record<string, RemovesWorkTimer>;
  /** Internal: this run is the --pause 0 run of a change that moves work past the result. */
  pause0Run?: boolean;
}

function argumentError(run: Run, o: PairedOptions): string | null {
  const rw = o.removesWork;
  if (rw) {
    const timers = o.timers ?? REMOVES_WORK_TIMERS;
    if (!Object.hasOwn(timers, rw.timer)) {
      return `--removes-work takes a timer named for a change in REMOVES_WORK_TIMERS (${Object.keys(timers).join(', ')}), not ${rw.timer}`;
    }
    if (o.aim.length > 0) {
      return '--removes-work has no aimed row: drop --aim';
    }
    if (!o.band) {
      return '--removes-work needs a calibration (--band) of the same rows';
    }
    if (!o.useCpu) {
      return '--removes-work keeps the CPU check: drop --no-cpu';
    }
    if (o.outputsMayDiffer) {
      return '--removes-work keeps the outputs: drop --outputs-may-differ';
    }
  } else if (o.aim.length === 0) {
    return 'paired mode needs --aim (the rows the change aims at), or --removes-work';
  }
  if (!Number.isInteger(o.minPairs) || o.minPairs < 2) {
    return '--min-pairs needs a whole number of at least 2';
  }
  if (pairingKind(run) === 'unpaired') {
    return `${run.label} is not a paired run`;
  }
  return null;
}

export function judgePaired(run: Run, o: PairedOptions): Verdict {
  const lines: string[] = [];
  const failures: string[] = [];
  const error = argumentError(run, o);
  if (error) {
    return { pass: false, error, failures, lines };
  }
  const rw = o.removesWork ?? null;
  const entry = rw ? (o.timers ?? REMOVES_WORK_TIMERS)[rw.timer] : null;
  // The rows the change acts on: the timer's own list, and any the caller adds.
  const listed = rw && entry ? [...new Set([...entry.rows, ...rw.rows])] : [];
  const minPairs = rw ? Math.max(o.minPairs, REMOVES_WORK_MIN_PAIRS) : o.minPairs;
  const noWsl = Boolean(o.noWsl);
  const noPower = Boolean(o.noPower);
  const twoHosts = pairingKind(run) === 'two hosts';
  const pairs = pairsOf(run.samples);
  const rows = [...new Set(pairs.map((p) => rowKey(p.doc, p.mode)))];

  const busy = busyStart(run, noWsl);
  if (busy) {
    failures.push(`the run started busy or cannot show its start (${busy}): run again`);
  }
  const power = powerProblem(run, noPower);
  if (power) {
    failures.push(`the run: ${power}: run again on mains`);
  }
  failures.push(...startOrderProblems(run, rows));
  let cal: Map<string, CalibrationRow> | null = null;
  if (o.band) {
    cal = calibration(o.band);
    failures.push(...calibrationProblems(o.band, run, rows, cal, noWsl, noPower));
  }
  let pause0: Verdict | null = null;
  if (rw && entry) {
    lines.push(`removes work: ${rw.timer}, ${entry.what}; ${run.machine.pauseMs === undefined ? 'pause not recorded' : `pause ${run.machine.pauseMs} ms`}${o.pause0Run ? ' (the --pause 0 run)' : ''}`);
    const left = rw.rows.length > 0 ? entry.rows.filter((k) => !rw.rows.includes(k)) : [];
    if (left.length > 0) {
      failures.push(`--rows leaves out rows the change acts on (${left.join(', ')}); the timer's list is the least a run covers`);
    }
    if (run.machine.pauseMs === undefined) {
      failures.push('the run does not record its pause');
    } else if (o.pause0Run && run.machine.pauseMs !== 0) {
      failures.push(`the --pause 0 run was made with a pause of ${run.machine.pauseMs} ms`);
    } else if (!o.pause0Run && entry.afterResult && run.machine.pauseMs === 0) {
      failures.push('this is a --pause 0 run: give the default-pause run as --paired and this one as --pause0');
    }
    if (!o.pause0Run && entry.afterResult && !rw.pause0) {
      failures.push('the change moves work past the result: give its run made with --pause 0 as well (--pause0)');
    }
    if (!o.pause0Run && rw.pause0) {
      pause0 = judgePaired(rw.pause0, { ...o, band: rw.pause0Band ?? o.band, removesWork: { timer: rw.timer, rows: rw.rows }, pause0Run: true });
      if (pause0.error) {
        return { pass: false, error: `the --pause 0 run: ${pause0.error}`, failures, lines };
      }
      failures.push(...pause0.failures.map((x) => `the --pause 0 run: ${x}`));
    }
    for (const key of listed) {
      const n = pairs.filter((p) => rowKey(p.doc, p.mode) === key).length;
      if (n === 0) {
        failures.push(`${key}: the change acts on this row, but the run has no pairs for it`);
      }
      if (!cal?.has(key)) {
        failures.push(`${key}: the calibration has no row for it (--removes-work takes no default band)`);
      }
    }
  }
  lines.push(`paired run ${run.label} (${pairingKind(run)}); bands from ${o.band ? `calibration ${o.band.label}` : 'no calibration (d = 10 % for every row)'}`);
  for (const [lifted, what] of [
    [!o.useCpu, "--no-cpu: the worker's CPU time is not required in every pair"],
    [o.outputsMayDiffer, '--outputs-may-differ: outputs are compared by PDF, page count and error lines only'],
    [noWsl, '--no-wsl: no WSL load is required at the start'],
    [noPower, '--no-power: no power readings are required'],
  ] as const) {
    if (lifted) {
      lines.push(`lifted: ${what}`);
    }
  }
  lines.push(
    `| row | ${rw ? 'acts on' : 'aimed'} | pairs (noisy) | B faster | p (B faster) | p (B slower) | wall (B - A) / A | CPU (B - A) / A | band wall / CPU | unseen below | same outputs |${rw ? ` ${rw.timer} A / B (B lower) |` : ''}${twoHosts ? ' blocks (B - A) / A |' : ''} verdict |`,
  );
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|${rw ? '---|' : ''}${twoHosts ? '---|' : ''}---|`);
  // Outputs of the set-aside tries are compared too: a rare difference could hide in a busy try.
  for (const p of pairsOf(run.samples, true)) {
    const broken = brokenB(p);
    if (broken || (!o.outputsMayDiffer && !sameOutputs(p))) {
      failures.push(`${rowKey(p.doc, p.mode)} try ${p.a.attempt ?? 0} of pair ${p.rep} (set aside): ${broken ?? 'outputs differ'}`);
    }
  }
  const pct = (x: number) => (finite(x) ? `${r1(x)} %` : 'missing');
  for (const key of rows) {
    const g: Pair[] = pairs.filter((p) => rowKey(p.doc, p.mode) === key);
    const n = g.length;
    const c = cal?.get(key);
    const d = c ?? { wall: 10, cpu: 10, blockWall: 10, blockCpu: 10 };
    const am = median(g.map((p) => p.a.serviceMs));
    // Two hosts: the blocks between restarts are the independent units, so the band also covers the calibration's
    // spread of block medians over the number of blocks in this row.
    const blocks = blocksOf(run, g);
    const nb = blocks.length;
    const bandWall = twoHosts ? Math.max((3 * d.wall) / Math.sqrt(n), (3 * d.blockWall) / Math.sqrt(nb)) : (3 * d.wall) / Math.sqrt(n);
    const bandCpu = twoHosts ? Math.max((3 * d.cpu) / Math.sqrt(n), (3 * d.blockCpu) / Math.sqrt(nb)) : (3 * d.cpu) / Math.sqrt(n);
    const blockText = twoHosts ? `${nb}: ${blockMedians(blocks, false, am).map((x) => `${x > 0 ? '+' : ''}${r1(x)}`).join(', ')} %` : '';
    const wall = median(g.map((p) => (100 * (p.b.serviceMs - p.a.serviceMs)) / am));
    const cpuMissing = g.filter((p) => !finite(p.a.jobCpuMs) || !finite(p.b.jobCpuMs)).length;
    const ac = median(g.map((p) => p.a.jobCpuMs ?? NaN));
    const cpu = cpuMissing === 0 ? median(g.map((p) => (100 * ((p.b.jobCpuMs as number) - (p.a.jobCpuMs as number))) / ac)) : NaN;
    // Ties count as neither: the sign tests run on the untied pairs.
    const { faster, slower, ties } = signs(g);
    const untied = faster + slower;
    const pFaster = signTestP(faster, untied);
    const pSlower = signTestP(slower, untied);
    const untiedText = `${untied} untied pair${untied === 1 ? '' : 's'}${ties > 0 ? `, ${ties} tie${ties === 1 ? '' : 's'}` : ''}`;
    const same = g.filter(sameOutputs).length;
    const broken = g.map(brokenB).filter((x): x is string => x !== null);
    const noisy = g.filter(isNoisy).length;
    const aimed = o.aim.includes(key);
    const actsOn = listed.includes(key);
    const why: string[] = [];
    if (same < n && !o.outputsMayDiffer) {
      why.push(`outputs differ in ${n - same} of ${n} pairs`);
    }
    if (broken.length > 0) {
      why.push(`B broken in ${broken.length} of ${n} pairs (${broken[0]})`);
    }
    if (o.useCpu && cpuMissing > 0) {
      why.push(`CPU time missing in ${cpuMissing} of ${n} pairs (a side ran without the probe or failed)`);
    }
    if (o.useCpu && cpuMissing === 0 && !finite(bandCpu)) {
      why.push('the calibration has no CPU times for this row');
    }
    if (!finite(bandWall) || !finite(wall)) {
      why.push('no wall-time band or median (a calibration or run without times for this row)');
    }
    if (aimed || actsOn) {
      if (n < minPairs || n % 2 === 1) {
        why.push(`${n} pairs: at least ${minPairs}, an even number`);
      }
    }
    if (aimed) {
      if (pFaster > 0.05) {
        why.push(`B faster in ${faster} of ${untiedText} (p ${pFaster.toFixed(3)})`);
      }
      if (!(wall < -bandWall)) {
        why.push(`wall ${r1(wall)} % is not below -${r1(bandWall)} %`);
      }
    } else {
      const wallPast = wall > bandWall;
      const cpuPast = finite(cpu) && finite(bandCpu) && cpu > bandCpu;
      if (wallPast && (!o.useCpu || pSlower <= 0.05 || cpuPast)) {
        why.push(`slower: wall +${r1(wall)} % past ${r1(bandWall)} % (B slower in ${slower} of ${untiedText}${o.useCpu ? `; CPU ${r1(cpu)} %` : ''})`);
      }
    }
    let timerText = '';
    if (rw) {
      const timerOf = (s: Sample): unknown => (s as unknown as Record<string, unknown>)[rw.timer];
      const missing = g.filter((p) => !finite(timerOf(p.a)) || !finite(timerOf(p.b))).length;
      if (missing > 0) {
        why.push(`${rw.timer} missing in ${missing} of ${n} pairs`);
        timerText = 'missing';
      } else {
        const ta = g.map((p) => timerOf(p.a) as number);
        const tb = g.map((p) => timerOf(p.b) as number);
        const lower = g.filter((_, i) => tb[i] < ta[i]).length;
        const higher = g.filter((_, i) => tb[i] > ta[i]).length;
        const ma = median(ta);
        const mb = median(tb);
        timerText = `${r1(ma)} / ${r1(mb)} ms (${lower} of ${n}; gain ${r1(ma - mb)} ms)`;
        // Ties count as neither: the sign tests run on the pairs where the timers differ.
        if (actsOn && signTestP(lower, lower + higher) > 0.05) {
          why.push(`${rw.timer} lower on B in only ${lower} of ${n} pairs (${lower + higher} untied)`);
        }
        // The wall time must show the timer's gain within the band; if it does not, the work may have moved out of
        // the timed code, where only the guard band would see it.
        const gainShare = (100 * (ma - mb)) / am;
        if (actsOn && gainShare > 0 && wall > -gainShare + bandWall) {
          why.push(`wall ${r1(wall)} % does not show the timer's gain of ${r1(gainShare)} % of A's time (at most ${r1(-gainShare + bandWall)} % with the band): the work may have moved out of the timed code`);
        }
        if (mb > ma || signTestP(higher, lower + higher) <= 0.05) {
          why.push(`${rw.timer} higher on B (median ${r1(mb)} against ${r1(ma)} ms; higher in ${higher} of ${n} pairs)`);
        }
      }
    }
    if (noisy * 2 > n) {
      why.push(`${noisy} of ${n} pairs noisy: run again on a quiet machine`);
    }
    if (!c) {
      lines.push(`note: ${key} has no row in the calibration; d = 10 %`);
    }
    const verdict = why.length === 0 ? (aimed ? 'faster' : 'same') : `FAIL: ${why.join('; ')}`;
    if (why.length > 0) {
      failures.push(`${key}: ${why.join('; ')}`);
    }
    const unseen = aimed ? '-' : pct(bandWall);
    lines.push(
      `| ${key} | ${aimed || actsOn ? 'yes' : ''} | ${n} (${noisy}) | ${faster} of ${untied}${ties > 0 ? ` (${ties} tied)` : ''} | ${pFaster.toFixed(3)} | ${pSlower.toFixed(3)} | ${pct(wall)} | ${pct(cpu)} | ${pct(bandWall)} / ${pct(bandCpu)} | ${unseen} | ${same}/${n} |${rw ? ` ${timerText} |` : ''}${twoHosts ? ` ${blockText} |` : ''} ${verdict} |`,
    );
  }
  if (!rw) {
    lines.push('A guard row\'s "unseen below" is the slowdown it would pass as "same".');
  }
  for (const a of o.aim) {
    if (!pairs.some((p) => rowKey(p.doc, p.mode) === a)) {
      failures.push(`${a}: aimed, but the run has no pairs for it`);
    }
  }
  if (pause0) {
    lines.push('', 'The --pause 0 run:', ...pause0.lines);
  }
  return verdict(failures, lines);
}

/** Ends the report: every failure listed (the run's own, the calibration's, the rows'), then PASS or FAIL. */
function verdict(failures: string[], lines: string[]): Verdict {
  if (failures.length > 0) {
    lines.push('', 'Failures:', ...failures.map((f) => `- ${f}`));
  }
  lines.push(failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`);
  return { pass: failures.length === 0, failures, lines };
}

export function judgeUnpaired(a: Run, b: Run, a2: Run | null, allow: number, aim: string[]): Verdict {
  const lines: string[] = [];
  const failures: string[] = [];
  if (!finite(allow) || allow < 0) {
    return { pass: false, error: '--allow needs a number', failures, lines };
  }
  const key = (s: Sample) => `${s.doc}|${s.mode}|${s.rep}`;
  const bByKey = new Map(kept(b.samples).map((s) => [key(s), s]));
  let diffs = 0;
  for (const s of kept(a.samples)) {
    const t = bByKey.get(key(s));
    if (t) {
      for (const f of ['pdfSha', 'auxSha', 'problemsSha', 'synctexSha', 'pages', 'errors'] as const) {
        if (s[f] !== t[f]) {
          diffs++;
          lines.push(`  ${key(s)}: ${f} ${String(s[f])} -> ${String(t[f])}`);
        }
      }
    }
  }
  if (diffs > 0) {
    failures.push(`${diffs} output differences`);
  }
  const byRow = (r: Run) => {
    const m = new Map<string, number>();
    for (const k of new Set(kept(r.samples).map((s) => rowKey(s.doc, s.mode)))) {
      m.set(k, median(kept(r.samples).filter((s) => rowKey(s.doc, s.mode) === k).map((s) => s.serviceMs)));
    }
    return m;
  };
  const ma = byRow(a);
  const mb = byRow(b);
  const m2 = a2 ? byRow(a2) : null;
  for (const k of aim) {
    if (!ma.has(k) || !mb.has(k)) {
      failures.push(`${k}: aimed, but ${!ma.has(k) ? a.label : b.label} has no such row`);
    }
  }
  lines.push(`A ${a.label}, B ${b.label}${a2 ? `, A2 ${a2.label}` : ''}; --allow ${allow} %`);
  lines.push('| row | aimed | A median ms | B median ms | (B - A) / A | drift (A2 - A) / A | verdict |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const [k, va] of ma) {
    const vb = mb.get(k);
    if (vb === undefined) {
      failures.push(`${k}: in ${a.label} but not in ${b.label}`);
      continue;
    }
    const change = (100 * (vb - va)) / va;
    const drift = m2?.has(k) ? (100 * ((m2.get(k) as number) - va)) / va : NaN;
    const aimed = aim.includes(k);
    let verdictText = 'same';
    if (change > allow) {
      verdictText = 'FAIL: slower';
    } else if (aimed) {
      const need = Math.max(allow, finite(drift) ? Math.abs(drift) : allow);
      if (finite(drift) && Math.abs(drift) > allow) {
        verdictText = 'FAIL: the machine drifted; run again';
      } else if (!(change < -need)) {
        verdictText = `FAIL: not faster by more than ${r1(need)} %`;
      } else {
        verdictText = 'faster';
      }
    }
    if (verdictText.startsWith('FAIL')) {
      failures.push(`${k}: ${verdictText}`);
    }
    lines.push(`| ${k} | ${aimed ? 'yes' : ''} | ${va} | ${vb} | ${r1(change)} % | ${finite(drift) ? `${r1(drift)} %` : '-'} | ${verdictText} |`);
  }
  return verdict(failures, lines);
}

function main(): void {
  const argv = process.argv.slice(2);
  const load = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Run;
  const calFile = option(argv, '--calibration', '');
  if (calFile) {
    const run = load(calFile);
    console.log(`calibration ${run.label}: d = median |B - A| / A per row (wall, job CPU), pairs; with two hosts, each restart block's median and d_block`);
    console.log('| row | pairs (noisy) | B faster / slower / tied | d wall % | d CPU % | band for 10 pairs, wall / CPU % | blocks (B - A) / A % | d_block wall / CPU % |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const [k, v] of calibration(run)) {
      console.log(`| ${k} | ${v.n} (${v.noisy}) | ${v.faster} / ${v.slower} / ${v.ties} | ${v.wall} | ${v.cpu} | ${r1((3 * v.wall) / Math.sqrt(10))} / ${r1((3 * v.cpu) / Math.sqrt(10))} | ${v.blocks.length}: ${v.blocks.join(', ')} | ${v.blockWall} / ${v.blockCpu} |`);
    }
    return;
  }
  const aim = option(argv, '--aim', '').split(',').filter(Boolean);
  const pairedFile = option(argv, '--paired', '');
  let result: Verdict;
  if (pairedFile) {
    const bandFile = option(argv, '--band', '');
    const timer = option(argv, '--removes-work', '');
    if (argv.includes('--after-result')) {
      console.error('--after-result is gone: the timer\'s entry in REMOVES_WORK_TIMERS says whether work moves past the result; give that run as --pause0');
      process.exit(2);
    }
    const pause0File = option(argv, '--pause0', '');
    const pause0BandFile = option(argv, '--pause0-band', '');
    result = judgePaired(load(pairedFile), {
      aim,
      band: bandFile ? load(bandFile) : null,
      minPairs: option(argv, '--min-pairs', 8, true),
      useCpu: !argv.includes('--no-cpu'),
      outputsMayDiffer: argv.includes('--outputs-may-differ'),
      noWsl: argv.includes('--no-wsl'),
      noPower: argv.includes('--no-power'),
      removesWork: timer
        ? {
            timer,
            rows: option(argv, '--rows', '').split(',').filter(Boolean),
            pause0: pause0File ? load(pause0File) : null,
            pause0Band: pause0BandFile ? load(pause0BandFile) : null,
          }
        : null,
    });
  } else {
    // The two files of an unpaired comparison: the arguments that are neither an option nor an option's value.
    const valued = new Set(['--allow', '--a2', '--aim', '--band', '--min-pairs', '--paired', '--calibration', '--removes-work', '--rows', '--pause0', '--pause0-band']);
    const files = argv.filter((x, i) => !x.startsWith('--') && !valued.has(argv[i - 1]));
    if (files.length !== 2) {
      console.error('give two result files (A and B), or --paired FILE');
      process.exit(2);
    }
    const a2File = option(argv, '--a2', '');
    result = judgeUnpaired(load(files[0]), load(files[1]), a2File ? load(a2File) : null, option(argv, '--allow', 5, true), aim);
  }
  if (result.error) {
    console.error(result.error);
    process.exit(2);
  }
  console.log(result.lines.join('\n'));
  process.exit(result.pass ? 0 : 1);
}

if (require.main === module) {
  main();
}
