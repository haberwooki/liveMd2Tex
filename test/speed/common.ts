// Shared parts of the speed tools (docs/DEVELOPING.md, "Measuring speed"): the measuring lock, the check that the
// worker was built with the probe, the option reader, and small statistics. Nothing here knows the engine's file
// names (assets.ts does).

import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import * as path from 'node:path';
import { root } from '../support/helpers';

export const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex').slice(0, 16);
export const r1 = (x: number): number => Math.round(x * 10) / 10;
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function median(xs: number[]): number {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length === 0 ? NaN : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/** The default results folder, outside the repository. */
export const defaultOut = path.resolve(root, '..', 'speed_runs');

/** A path as the tools print it: relative to the current folder, never absolute (no user name in a report). */
export function shown(p: string): string {
  return path.relative(process.cwd(), p).replace(/\\/g, '/');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Takes the measuring lock, `../speed_runs/.measuring.lock` whatever the results folder (one measurement at a time
 * on this machine), or throws if another living process holds it. A lock left by a process that has exited is
 * taken over. Returns the release function.
 */
export function takeLock(label: string): () => void {
  mkdirSync(defaultOut, { recursive: true });
  const file = path.join(defaultOut, '.measuring.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, label, since: new Date().toISOString() }));
      closeSync(fd);
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          try {
            unlinkSync(file);
          } catch {
            // already gone
          }
        }
      };
      process.on('exit', release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
      let holder: { pid?: number; label?: string; since?: string } = {};
      try {
        holder = JSON.parse(readFileSync(file, 'utf8')) as typeof holder;
      } catch {
        holder = {};
      }
      if (holder.pid && alive(holder.pid)) {
        throw new Error(`another measurement holds the lock (${holder.label ?? '?'}, pid ${holder.pid}, since ${holder.since ?? '?'}); one at a time`, { cause: err });
      }
      unlinkSync(file);
    }
  }
  throw new Error('could not take the measuring lock');
}

/** Fails unless the worker bundle was built with the probe (node scripts/build.mjs --speed-probe). */
export function requireProbeBuild(): void {
  const bundle = path.join(root, 'dist', 'engine-worker.js');
  if (!existsSync(bundle) || !readFileSync(bundle, 'utf8').includes('LIVEMD2TEX_SPEED_PROBE')) {
    throw new Error('dist/engine-worker.js has no speed probe: run node scripts/build.mjs --speed-probe, then node scripts/stage-engine.mjs --data');
  }
}

/**
 * The one-sided sign test: the chance of `wins` or more wins in `n` fair coin tosses. A gain is called when it is at
 * most 0.05 (7 of 8 pairs, 9 of 10, 10 of 12).
 */
export function signTestP(wins: number, n: number): number {
  let p = 0;
  for (let k = wins; k <= n; k++) {
    let c = 1;
    for (let i = 0; i < k; i++) {
      c = (c * (n - i)) / (i + 1);
    }
    p += c / 2 ** n;
  }
  return p;
}

/**
 * The value after `name` in `argv`, or `fallback` when the option is absent. A missing value, or one that is
 * itself an option, stops the tool (exit 2), and so does a value that is not a number when `number` is set: an
 * option is never silently read from the wrong place.
 */
export function option(argv: string[], name: string, fallback: string): string;
export function option(argv: string[], name: string, fallback: number, number: true): number;
export function option(argv: string[], name: string, fallback: string | number, number = false): string | number {
  const at = argv.indexOf(name);
  if (at < 0) {
    return fallback;
  }
  const v = argv[at + 1];
  if (v === undefined || v.trim() === '' || v.startsWith('--')) {
    console.error(`${name} needs a value`);
    process.exit(2);
  }
  if (number && !Number.isFinite(Number(v))) {
    console.error(`${name} needs a number, not ${v}`);
    process.exit(2);
  }
  return number ? Number(v) : v;
}
