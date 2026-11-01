// The speed probe's stand-in in every build but the measuring one (docs/DEVELOPING.md, "Measuring speed"):
// scripts/build.mjs bundles this file into the worker in place of speedProbe.ts unless it is given --speed-probe.
// Every hook does nothing and reads no environment variable. It exports the same names as speedProbe.ts (a unit
// test checks it), with the values the worker has without a probe.

import type { ProbeCounters } from './speedProbe';

export const PROBE = false;

const none: ProbeCounters = {
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

export function switchValue(): string | undefined {
  return undefined;
}
export function applyJobSwitches(): void {}
export const restoreUpper = (): boolean => false;
export const restoreLazy = (): boolean => false;
export const synctexValue = (): string => '1';
export const lz4Slots = (fallback: number): number => fallback;
export function probeEnv(): Record<string, string> {
  return {};
}
export function snapshot(): ProbeCounters {
  return none;
}
export function delta(): Record<string, number> {
  return {};
}
export function noteT1c(): void {}
export function fileEntries(): Record<string, number> {
  return {};
}
export function install(): void {}
export function threadCpuMs(): number {
  return 0;
}
