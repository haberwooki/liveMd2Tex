// Shared helpers for the unit tests (compiled to out/test/support/helpers.js).

import { existsSync, rmdirSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { STUB_STATE_KEY, type StubReport } from '../../src/shared/engineProtocol';

/** The repository root (out/test/support -> root). */
export const root = path.resolve(__dirname, '..', '..', '..');

/**
 * Removes a folder link a test made: a Windows junction is removed as a folder, a symbolic link elsewhere (Linux,
 * macOS) as a file. Neither touches the folder the link points to.
 */
export function removeLink(link: string): void {
  if (process.platform === 'win32') {
    rmdirSync(link);
  } else {
    unlinkSync(link);
  }
}

export interface StubState {
  role: string;
  stubs: string[];
  blocked: { kind: string; detail: string }[];
  allowedForks: { target: string; caller: string }[];
  report(): StubReport;
  clearBlocked(): void;
}

/** The stub record of this process; fails if the stubs are not loaded. */
export function stubState(): StubState {
  const state = (globalThis as Record<symbol, unknown>)[Symbol.for(STUB_STATE_KEY)] as StubState | undefined;
  if (!state || state.stubs.length !== 2) {
    throw new Error('The test stubs are not loaded in this process (see .mocharc.cjs).');
  }
  return state;
}

/** Imports one of the ES-module scripts under scripts/. */
export function importScript<T>(relative: string): Promise<T> {
  return import(pathToFileURL(path.join(root, relative)).href) as Promise<T>;
}

/** Fails clearly when dist/ has not been built. */
export function requireBuilt(relative: string): string {
  const file = path.join(root, relative);
  if (!existsSync(file)) {
    throw new Error(`${relative} is missing; run "node scripts/build.mjs" before the tests.`);
  }
  return file;
}

export function sameFile(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}
