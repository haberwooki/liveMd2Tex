// The shape of the speed benchmark's result files and the pairing of their samples (docs/DEVELOPING.md, "Measuring
// speed"). It imports nothing from the engine host or the extension, so compare.ts, which reads these files, does
// not change when the engine's files are renamed. bench.ts writes the files.

export type Mode = 'warmup' | 'cold' | 'quick' | 'save' | 'fresh';

export interface Sample {
  doc: string;
  mode: Mode;
  rep: number;
  /** Paired runs: 'A' or 'B'. */
  variant?: 'A' | 'B';
  /** Which try of its pair (or single compile) this is: 0, then 1 after a busy try was set aside, and so on. */
  attempt?: number;
  /** Set aside: the machine was busier than --max-busy, or lower on memory than --min-free-mb; the unit ran again. */
  discarded?: boolean;
  /** Kept although the machine was busy (every try was busy). */
  noisy?: boolean;
  /** Markdown to LaTeX (Markdown documents only). */
  convertMs: number | null;
  /** prepareCompile: collect the project, scan references, choose the engine (conversion excluded). */
  collectMs: number;
  /** engine.compile() as the extension host sees it: IPC both ways, the engine host, the worker. */
  serviceMs: number;
  hostTotalMs: number;
  ipcMs: number;
  engineStartMs: number;
  /** The job's wait for its worker: the engine host's total minus the programs, the restores and the worker's own work. */
  hiddenWaitMs: number;
  /** This job's worker's start, whether or not the job waited for it: instantiate and mount, ms. */
  prepInstantiateMs: number;
  prepMountMs: number;
  mountProjectMs: number;
  /** The programs, per program: total ms and number of runs. */
  tools: Record<string, { ms: number; runs: number }>;
  callMainMs: number;
  /** The worker thread's CPU time in the programs (null in the file when the worker had no probe). */
  callMainCpuMs: number | null;
  /** The worker thread's CPU time for the whole job (null in the file when the worker had no probe). */
  jobCpuMs: number | null;
  /** The memory restore, all programs; null when a program's probe record lacks it (stepTotals). */
  restoreMs: number | null;
  lz4DecodeMs: number;
  lz4ReadMs: number;
  lz4Bytes: number;
  lz4Chunks: number;
  fsMs: number;
  lookups: number;
  lookupMisses: number;
  opens: number;
  openMisses: number;
  t1cFiles: number;
  t1cMs: number;
  resultMs: number;
  passes: number;
  heapMB: number;
  pdfBytes: number;
  pages: number | null;
  errors: number;
  /** Hashes (SHA-256, first 16 hex digits) of the PDF, the .aux, the problems list and the SyncTeX text. */
  pdfSha: string | null;
  auxSha: string | null;
  problemsSha: string;
  synctexSha: string | null;
  /** Machine-wide CPU use during the compile, and the machine's free memory before it. */
  cpuBusyPct: number;
  freeMemMB: number;
  /** With LIVEMD2TEX_SPEED_FILES=1 or all: the image files read, bytes each. */
  files?: Record<string, number>;
}

/** What a result file says about the run as a whole (bench.ts's `machine`). */
/** What a calling script saw at the start (LIVEMD2TEX_SPEED_START_LOAD). */
export interface ReportedLoad {
  wslLoad?: number;
  windowsCpuPct?: number;
  power?: string;
}

export interface RunMachine {
  runtime: { node: string; v8: string; electron: string | null };
  hostArgs: string[];
  env: Record<string, string>;
  /**
   * A's image and engine folder by name; the image by the hash of its index file, and the engine by the hash of its
   * files (glue, WebAssembly, texmf-override.cnf, fonts.conf).
   */
  data?: string;
  dataSha?: string;
  engine?: string;
  engineSha?: string;
  ab: string | null;
  /** The two-host modes: B's extra flags (an empty list for --ab-host none), B's image, B's environment. */
  abHost: string[] | null;
  abData: string | null;
  abDataSha?: string | null;
  abEnv?: Record<string, string>;
  /** B's engine folder (by name) and its files by hash. */
  abEngine?: string | null;
  abEngineSha?: string | null;
  /** The pause between compiles (--pause), ms. */
  pauseMs?: number;
  /** Two hosts: both restart every this many pairs within a row, in alternating order. */
  restartEvery?: number;
  /** The load when the run started: machine CPU over two seconds, free memory, and what the calling script saw. */
  start?: { cpuPct: number; freeMemMB: number; reported?: ReportedLoad };
}

/** Two hosts: one restart of both, before a pair (`beforeRep`) of a row; the host started first comes first. */
export interface HostRestart {
  doc: string;
  mode: string;
  beforeRep: number;
  order: ('A' | 'B')[];
  ms: number[];
}

export interface Run {
  label: string;
  machine: RunMachine;
  samples: Sample[];
  hostStarts: { ms: number }[];
  hostRestarts?: HostRestart[];
}

export interface Pair {
  doc: string;
  mode: string;
  rep: number;
  a: Sample;
  b: Sample;
}

/** The samples a table or a rule uses: not the first compiles, not the set-aside tries. */
/** A program step as the worker reports it: the program first in argv, its time, and the probe's record if any. */
export interface StepLike {
  argv: string[];
  ms: number;
  probe?: Record<string, number>;
}

/** The probe's per-program counters that a sample adds up. */
const STEP_SUMS = ['lz4DecodeMs', 'lz4Ms', 'lz4Bytes', 'lz4Chunks', 'fsMs', 'lookups', 'lookupMisses', 'opens', 'openMisses', 't1cFiles', 't1cMs'] as const;

export interface StepTotals {
  /** Per program: total ms and number of runs. */
  tools: Record<string, { ms: number; runs: number }>;
  callMainMs: number;
  /** null when any program's CPU time is missing (a worker without the probe): never a number that looks like a gain. */
  callMainCpuMs: number | null;
  /**
   * The memory restore over all programs; null when the job ran no program or any program's record lacks it, so the
   * timer of compare.js --removes-work never reads "not measured" as 0 ms.
   */
  restoreMs: number | null;
  sums: Record<(typeof STEP_SUMS)[number], number>;
}

const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Adds up a job's program steps for a sample (bench.ts). */
export function stepTotals(steps: StepLike[]): StepTotals {
  const tools: Record<string, { ms: number; runs: number }> = {};
  let callMainMs = 0;
  let callMainCpuMs: number | null = 0;
  let restoreMs: number | null = steps.length > 0 ? 0 : null;
  const sums = Object.fromEntries(STEP_SUMS.map((k) => [k, 0])) as StepTotals['sums'];
  for (const s of steps) {
    const t = (tools[s.argv[0]] ??= { ms: 0, runs: 0 });
    t.ms += s.ms;
    t.runs++;
    callMainMs += s.probe?.callMainMs ?? s.ms;
    const cpu = s.probe?.callMainCpuMs;
    callMainCpuMs = callMainCpuMs !== null && isNumber(cpu) ? callMainCpuMs + cpu : null;
    const restore = s.probe?.restoreMs;
    restoreMs = restoreMs !== null && isNumber(restore) ? restoreMs + restore : null;
    for (const k of STEP_SUMS) {
      sums[k] += s.probe?.[k] ?? 0;
    }
  }
  return { tools, callMainMs, callMainCpuMs, restoreMs, sums };
}

export const kept = (samples: Sample[]): Sample[] => samples.filter((s) => s.mode !== 'warmup' && !s.discarded);

/** The pairs of a paired run. Set-aside tries are left out unless `setAside` is true, which pairs only those. */
export function pairsOf(samples: Sample[], setAside = false): Pair[] {
  const usable = samples.filter((s) => s.mode !== 'warmup' && s.variant && Boolean(s.discarded) === setAside);
  const out: Pair[] = [];
  for (const a of usable.filter((s) => s.variant === 'A')) {
    const b = usable.find((s) => s.variant === 'B' && s.doc === a.doc && s.mode === a.mode && s.rep === a.rep && (s.attempt ?? 0) === (a.attempt ?? 0));
    if (b) {
      out.push({ doc: a.doc, mode: a.mode, rep: a.rep, a, b });
    }
  }
  return out;
}

/** Whether a pair's outputs agree: the PDF, the .aux, the problems list and the SyncTeX text. */
export const sameOutputs = (p: Pair): boolean =>
  p.a.pdfSha === p.b.pdfSha && p.a.auxSha === p.b.auxSha && p.a.problemsSha === p.b.problemsSha && p.a.synctexSha === p.b.synctexSha;

/**
 * Whether a pair's B is broken whatever the outputs may otherwise do (an engine or data change): no PDF on either
 * side, another page count, or more error lines than A.
 */
export function brokenB(p: Pair): string | null {
  if (!p.a.pdfSha || !p.b.pdfSha) {
    return `no PDF on side ${p.a.pdfSha ? 'B' : 'A'}`;
  }
  if (p.a.pages !== p.b.pages) {
    return `pages ${p.a.pages} -> ${p.b.pages}`;
  }
  if (p.b.errors > p.a.errors) {
    return `errors ${p.a.errors} -> ${p.b.errors}`;
  }
  return null;
}
