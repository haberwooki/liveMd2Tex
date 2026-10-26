// Shared helpers for the integration tests, which run inside VS Code's extension host.

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension/extension';
import { STUB_STATE_KEY, type StubReport } from '../../src/shared/engineProtocol';
import { EXTENSION_ID } from '../../src/shared/identity';

/** The repository root (out/test/integration -> root). */
export const root = path.resolve(__dirname, '..', '..', '..');

export interface StubState {
  role: string;
  stubs: string[];
  blocked: { kind: string; detail: string; stack: string }[];
  allowedForks: { target: string; caller: string }[];
  report(): StubReport;
  clearBlocked(): void;
}

export function stubState(): StubState {
  const state = (globalThis as Record<symbol, unknown>)[Symbol.for(STUB_STATE_KEY)] as StubState | undefined;
  if (!state || state.stubs.length !== 2) {
    throw new Error('The stubs are not loaded in the extension host (mocha.preload in .vscode-test.mjs).');
  }
  return state;
}

export async function activateExtension(): Promise<TestApi> {
  const ext = vscode.extensions.getExtension<TestApi | undefined>(EXTENSION_ID);
  if (!ext) {
    throw new Error(`${EXTENSION_ID} is not loaded in the test window.`);
  }
  const api = await ext.activate();
  if (!api) {
    throw new Error('The extension did not return its test API (is the window in test mode?).');
  }
  return api;
}

/**
 * The blocked attempts (since index `from`) whose stack passes through this repository's code: the extension's
 * bundles in dist/ or the compiled tests in out/. Attempts made by VS Code's own code in the test window are
 * reported by reportBlocked() but are not the extension's.
 */
export function ownAttempts(state: StubState, from = 0): StubState['blocked'] {
  const mine = [root, root.replace(/\\/g, '/')].map((p) => p.toLowerCase());
  const callerFrames = (stack: string) =>
    stack
      .toLowerCase()
      .split('\n')
      .filter((line) => !/test[\\/]stubs[\\/]/.test(line));
  return state.blocked
    .slice(from)
    .filter((b) => callerFrames(b.stack).some((line) => mine.some((p) => line.includes(p))));
}

/** Prints every attempt the stubs blocked in the extension host so far, with the first frames of each stack. */
export function reportBlocked(label: string): void {
  const state = stubState();
  console.log(`      stub record ${label}: ${state.allowedForks.length} allowed fork(s), ${state.blocked.length} blocked attempt(s)`);
  for (const b of state.blocked) {
    const frames = b.stack.split('\n').slice(2, 9).map((l) => `          ${l.trim()}`).join('\n');
    console.log(`        blocked ${b.kind}: ${b.detail}\n${frames}`);
  }
}

export const engineStubArgs =['--require', path.join(root, 'test', 'stubs', 'register-engine-host.cjs')];
