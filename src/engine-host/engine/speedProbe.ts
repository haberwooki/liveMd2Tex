// The speed probe (docs/DEVELOPING.md, "Measuring speed"). It is built only into the measuring build of the worker
// (`node scripts/build.mjs --speed-probe`); every other build puts speedProbeOff.ts in its place, so none of this
// file ships. Even in the measuring build it does nothing unless the engine host's environment sets
// LIVEMD2TEX_SPEED_PROBE=1. Then it changes no output: it counts and times what the worker does around the engine
// (file-system calls, LZ4 reads and decoding, the memory restore, packed fonts), records the worker thread's CPU
// time, and fixes the dates (SOURCE_DATE_EPOCH, FORCE_SOURCE_DATE), so two runs give the same PDF bytes.
//
// Switches, one experiment each, read only when the probe is on. A value that is not on the list is ignored, so a
// stray or mistyped variable can never break a compile. Each is read from LIVEMD2TEX_SPEED_<NAME>; the per-job ones
// are also read from the job's project file `.speed.json`, which wins for that job (how `bench.js --ab` pairs them).
// A track adds a switch by adding a line to SWITCHES.

import type { EmscriptenModule } from './glue';

export const PROBE = process.env.LIVEMD2TEX_SPEED_PROBE === '1';

const integer = (lo: number, hi: number) => (v: string) => /^\d+$/.test(v) && Number(v) >= lo && Number(v) <= hi;

/** The known switches: which values each accepts, and whether a job's `.speed.json` may set it. */
const SWITCHES: Record<string, { valid: (v: string) => boolean; perJob: boolean }> = {
  // upper: copy the header back, then zero only the memory above it (the same bytes as today's order).
  // lazy: restore before the next program instead of after this one, so a job's last program skips it.
  restore: { valid: (v) => ['upper', 'lazy', 'lazy-upper'].includes(v), perJob: true },
  // -1: SyncTeX written uncompressed (the SyncTeX worker reads both forms).
  synctex: { valid: (v) => v === '-1', perJob: true },
  // Error.stackTraceLimit while the job runs (the glue's file-system error is an Error in today's engine).
  stacklimit: { valid: integer(0, 100), perJob: true },
  // LZ4 chunk cache slots per mounted image (applies when the worker mounts, so environment only).
  lz4slots: { valid: integer(1, 4096), perJob: false },
  // The image files read, bytes each, in the result: 1 the 40 largest, all every one (environment only).
  files: { valid: (v) => v === '1' || v === 'all', perJob: false },
};

function fromEnvironment(): Record<string, string> {
  const out: Record<string, string> = {};
  if (PROBE) {
    for (const [name, s] of Object.entries(SWITCHES)) {
      const v = process.env[`LIVEMD2TEX_SPEED_${name.toUpperCase()}`];
      if (v !== undefined && s.valid(v)) {
        out[name] = v;
      }
    }
  }
  return out;
}

const environment = fromEnvironment();
let current: Record<string, string> = { ...environment };
const defaultStackLimit = Error.stackTraceLimit;

/** A switch's value for the job now running, or undefined. */
export function switchValue(name: string): string | undefined {
  return current[name];
}

/** Applies a job's `.speed.json` text (null: none) on top of the environment's values; probe mode only. */
export function applyJobSwitches(json: string | null): void {
  if (!PROBE) {
    return;
  }
  // A new job: its own switches and its own file list (a worker that served two jobs would add them up).
  fileBytes.clear();
  current = { ...environment };
  let given: unknown;
  try {
    given = json ? JSON.parse(json) : null;
  } catch {
    given = null;
  }
  if (given && typeof given === 'object') {
    for (const [name, v] of Object.entries(given as Record<string, unknown>)) {
      const s = SWITCHES[name];
      if (s?.perJob && typeof v === 'string' && s.valid(v)) {
        current[name] = v;
      }
    }
  }
  Error.stackTraceLimit = current.stacklimit !== undefined ? Number(current.stacklimit) : defaultStackLimit;
}

export const restoreUpper = (): boolean => current.restore === 'upper' || current.restore === 'lazy-upper';
export const restoreLazy = (): boolean => current.restore === 'lazy' || current.restore === 'lazy-upper';
/** The value of TeX's -synctex option when SyncTeX is wanted. */
export const synctexValue = (): string => current.synctex ?? '1';
/** LZ4 cache slots for an image whose own number is `fallback`. */
export const lz4Slots = (fallback: number): number => (current.lz4slots ? Number(current.lz4slots) : fallback);

/** Fixed dates (docs/DEVELOPING.md, "Measuring speed"), so outputs compare by hash. */
export function probeEnv(): Record<string, string> {
  return PROBE ? { SOURCE_DATE_EPOCH: '1700000000', FORCE_SOURCE_DATE: '1' } : {};
}

export interface ProbeCounters {
  /** Time in the wrapped file-system calls, outermost call only (nested calls are not counted twice). */
  fsMs: number;
  lookups: number;
  lookupMisses: number;
  opens: number;
  openMisses: number;
  stats: number;
  statMisses: number;
  readdirs: number;
  /** LZ4 file reads: calls, bytes served, time (decoding included). */
  lz4Reads: number;
  lz4Bytes: number;
  lz4Ms: number;
  /** LZ4 chunks decoded (2,048 bytes each) and the time spent in the decoder. */
  lz4Chunks: number;
  lz4DecodeMs: number;
  /** Packed Type 1 fonts (t1c) unpacked and checked in this worker, and the time (the LZ4 read included). */
  t1cFiles: number;
  t1cMs: number;
}

const counters: ProbeCounters = {
  fsMs: 0,
  lookups: 0,
  lookupMisses: 0,
  opens: 0,
  openMisses: 0,
  stats: 0,
  statMisses: 0,
  readdirs: 0,
  lz4Reads: 0,
  lz4Bytes: 0,
  lz4Ms: 0,
  lz4Chunks: 0,
  lz4DecodeMs: 0,
  t1cFiles: 0,
  t1cMs: 0,
};

/** Bytes read per image file (with the `files` switch). */
const fileBytes = new Map<string, number>();

export function snapshot(): ProbeCounters {
  return { ...counters };
}

/** The counters since `since` (a copy taken earlier), rounded. */
export function delta(since: ProbeCounters): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(counters) as (keyof ProbeCounters)[]) {
    const d = counters[k] - since[k];
    out[k] = k.endsWith('Ms') ? Math.round(d * 10) / 10 : d;
  }
  return out;
}

/** One packed font unpacked and checked, in `ms`. */
export function noteT1c(ms: number): void {
  counters.t1cFiles++;
  counters.t1cMs += ms;
}

/** The files read so far, largest first, as result entries `file:<path>` (none without the `files` switch). */
export function fileEntries(): Record<string, number> {
  const list = [...fileBytes].sort((a, b) => b[1] - a[1]);
  const kept = current.files === 'all' ? list : list.slice(0, 40);
  return Object.fromEntries(kept.map(([p, n]) => [`file:${p}`, n]));
}

let depth = 0;

/** Wraps `obj[name]` so its calls are counted (and timed when outermost); `miss` counts the calls that throw. */
function wrap(obj: Record<string, unknown>, name: string, count: keyof ProbeCounters, miss?: keyof ProbeCounters): void {
  const original = obj[name] as (...args: unknown[]) => unknown;
  obj[name] = function (this: unknown, ...args: unknown[]) {
    counters[count]++;
    const outer = depth === 0;
    const t0 = outer ? performance.now() : 0;
    depth++;
    try {
      return original.apply(this, args);
    } catch (err) {
      if (miss) {
        counters[miss]++;
      }
      throw err;
    } finally {
      depth--;
      if (outer) {
        counters.fsMs += performance.now() - t0;
      }
    }
  };
}

/** Installs the counters on a module after its image is mounted (probe mode only). */
export function install(M: EmscriptenModule): void {
  if (!PROBE) {
    return;
  }
  const fs = M.FS as unknown as Record<string, unknown>;
  wrap(fs, 'lookupPath', 'lookups', 'lookupMisses');
  wrap(fs, 'open', 'opens', 'openMisses');
  wrap(fs, 'stat', 'stats', 'statMisses');
  wrap(fs, 'readdir', 'readdirs');
  const lz4 = M.LZ4 as unknown as { stream_ops: Record<string, unknown>; codec: Record<string, unknown> };
  const read = lz4.stream_ops.read as (...a: unknown[]) => number;
  lz4.stream_ops.read = function (this: unknown, ...a: unknown[]) {
    const t0 = performance.now();
    const n = read.apply(this, a);
    if (current.files) {
      const p = (a[0] as { path?: string }).path ?? '?';
      fileBytes.set(p, (fileBytes.get(p) ?? 0) + n);
    }
    counters.lz4Reads++;
    counters.lz4Bytes += n;
    counters.lz4Ms += performance.now() - t0;
    return n;
  };
  const uncompress = lz4.codec.uncompress as (...a: unknown[]) => number;
  lz4.codec.uncompress = function (this: unknown, ...a: unknown[]) {
    const t0 = performance.now();
    const n = uncompress.apply(this, a);
    counters.lz4Chunks++;
    counters.lz4DecodeMs += performance.now() - t0;
    return n;
  };
}

/** The worker thread's CPU time so far, ms (probe mode only; 0 otherwise). */
export function threadCpuMs(): number {
  if (!PROBE) {
    return 0;
  }
  const u = process.threadCpuUsage();
  return (u.user + u.system) / 1000;
}
