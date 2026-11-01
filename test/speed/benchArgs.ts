// The benchmark's options and its start-load report (docs/DEVELOPING.md, "Measuring speed"). They live apart from
// bench.ts, which uses today's engine files, so that they and their unit test import nothing the engine's own build
// deletes.

import * as path from 'node:path';
import { defaultOut } from './common';
import type { Mode, ReportedLoad } from './samples';

export interface BenchArgs {
  label: string;
  docs: string[] | null;
  modes: Mode[];
  reps: Record<Mode, number>;
  pauseMs: number;
  hostStarts: number;
  /** Flags for every engine host (repeatable; a flag starts with "--"). */
  hostArgs: string[];
  render: boolean;
  out: string;
  /** A data folder (core.data, core.index.json) instead of the staged image. */
  data: string | null;
  /** Paired in one engine host: B's worker switches (the job's .speed.json). */
  ab: string | null;
  /** Paired between two engine hosts: whether --ab-host was given, and B's extra flags ("none": no flag). */
  abHostGiven: boolean;
  abHost: string[];
  /** Paired between two engine hosts: B mounts this data folder's image. */
  abData: string | null;
  /** Paired between two engine hosts: B's extra environment variables. */
  abEnv: Record<string, string>;
  /** An engine folder for A (and B unless --ab-engine), instead of dist/engine. */
  engine: string | null;
  /** Paired between two engine hosts: B's engine folder. */
  abEngine: string | null;
  maxBusy: number;
  minFreeMB: number;
  retries: number;
  /** Two hosts: restart both every this many pairs within a row, in alternating order. */
  restartEvery: number;
}

/** Options whose value is itself a flag (it starts with "--"). */
const FLAG_VALUED = new Set(['--host-arg', '--ab-host']);
const MODES: Mode[] = ['cold', 'quick', 'save', 'fresh'];

/** Reads bench.js's arguments; throws on a missing value, a value that is not a number where one is due, or an unknown option or mode. */
export function parseBenchArgs(argv: string[]): BenchArgs {
  const a: BenchArgs = {
    label: 'run',
    docs: null,
    modes: ['cold', 'quick', 'save'],
    reps: { warmup: 1, cold: 3, quick: 7, save: 3, fresh: 3 },
    pauseMs: 1000,
    hostStarts: 3,
    hostArgs: [],
    render: true,
    out: defaultOut,
    data: null,
    ab: null,
    abHostGiven: false,
    abHost: [],
    abData: null,
    abEnv: {},
    engine: null,
    abEngine: null,
    maxBusy: 40,
    minFreeMB: 1000,
    retries: 3,
    restartEvery: 2,
  };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    const v = () => {
      const next = argv[++i];
      if (next === undefined || next === '' || (next.startsWith('--') && !FLAG_VALUED.has(name))) {
        throw new Error(`${name} needs a value`);
      }
      return next;
    };
    /** A number in [lo, hi]; whole when `whole`. */
    const num = (lo: number, hi = Infinity, whole = false) => {
      const s = v();
      const n = Number(s);
      if (s.trim() === '' || !Number.isFinite(n) || n < lo || n > hi || (whole && !Number.isInteger(n))) {
        throw new Error(`${name} needs ${whole ? 'a whole number' : 'a number'} from ${lo}${hi === Infinity ? ' up' : ` to ${hi}`}, not ${s}`);
      }
      return n;
    };
    const count = () => num(1, Infinity, true);
    switch (name) {
      case '--label': a.label = v(); break;
      case '--docs': a.docs = v().split(',').filter(Boolean); break;
      case '--modes': a.modes = v().split(',').filter(Boolean) as Mode[]; break;
      case '--cold': a.reps.cold = count(); break;
      case '--quick': a.reps.quick = count(); break;
      case '--save': a.reps.save = count(); break;
      case '--fresh': a.reps.fresh = count(); break;
      case '--pause': a.pauseMs = num(0); break;
      case '--host-starts': a.hostStarts = num(0, Infinity, true); break;
      case '--host-arg': a.hostArgs.push(v()); break;
      case '--no-render': a.render = false; break;
      case '--out': a.out = path.resolve(v()); break;
      case '--data': a.data = path.resolve(v()); break;
      case '--ab': a.ab = v(); break;
      case '--ab-host': {
        // "none": a second engine host with no extra flag (an A/A calibration of two hosts).
        a.abHostGiven = true;
        const flag = v();
        if (flag !== 'none') {
          a.abHost.push(flag);
        }
        break;
      }
      case '--ab-data': a.abData = path.resolve(v()); break;
      case '--ab-env': {
        const [k, ...rest] = v().split('=');
        if (!k || rest.length === 0) {
          throw new Error(`--ab-env needs KEY=VALUE, not ${k}`);
        }
        a.abEnv[k] = rest.join('=');
        break;
      }
      case '--engine': a.engine = path.resolve(v()); break;
      case '--ab-engine': a.abEngine = path.resolve(v()); break;
      case '--max-busy': a.maxBusy = num(0, 100); break;
      case '--min-free-mb': a.minFreeMB = num(0); break;
      case '--retries': a.retries = num(0, Infinity, true); break;
      case '--restart-every': a.restartEvery = count(); break;
      default: throw new Error(`unknown argument ${name}`);
    }
  }
  const bad = a.modes.filter((m) => !MODES.includes(m));
  if (bad.length > 0 || a.modes.length === 0) {
    throw new Error(`unknown mode ${bad.join(', ') || '(none given)'}: use ${MODES.join(', ')}`);
  }
  return a;
}

/**
 * The load a calling script saw at the start, from LIVEMD2TEX_SPEED_START_LOAD (JSON: wslLoad, windowsCpuPct,
 * power). Absent: undefined. A field of the wrong type, an unknown field or text that is not a JSON object throws,
 * so a broken report never passes as a quiet machine. null for wslLoad or windowsCpuPct means "could not read it"
 * and is left out, so compare.js says the WSL load was not reported.
 */
export function parseStartLoad(text: string | undefined): ReportedLoad | undefined {
  if (text === undefined || text === '') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('LIVEMD2TEX_SPEED_START_LOAD is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LIVEMD2TEX_SPEED_START_LOAD must be a JSON object');
  }
  const out: ReportedLoad = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (k === 'wslLoad' || k === 'windowsCpuPct') {
      if (v === null) {
        continue;
      }
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new Error(`LIVEMD2TEX_SPEED_START_LOAD: ${k} must be a number, not ${JSON.stringify(v)}`);
      }
      out[k] = v;
    } else if (k === 'power') {
      if (typeof v !== 'string') {
        throw new Error(`LIVEMD2TEX_SPEED_START_LOAD: power must be text, not ${JSON.stringify(v)}`);
      }
      out.power = v;
    } else {
      throw new Error(`LIVEMD2TEX_SPEED_START_LOAD: unknown field ${k}`);
    }
  }
  return out;
}
