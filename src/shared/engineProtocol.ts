// Messages between the extension host and the engine host (docs/DESIGN.md#architecture). The channel is the IPC pipe
// that child_process.fork opens; serialization is 'advanced', so typed arrays cross without copying to JSON.

import type { CompileJob, CompileResult, EngineAssetPaths, EngineInitInfo, EngineMemory } from './engineJobs';

export type ToEngine =
  | { type: 'ping'; id: number; payload: string }
  | { type: 'init'; id: number; assets: EngineAssetPaths }
  | { type: 'compile'; id: number; job: CompileJob }
  /** Cancels the compile of job `jobId` only (any running compile without it); build gate 1, G1E-06. */
  | { type: 'cancel'; id: number; jobId?: number }
  | { type: 'memory'; id: number }
  | { type: 'wasmCheck'; id: number }
  | { type: 'stubReport'; id: number }
  /** Forget a project's kept files (its preview and editors are gone; re-gate G1BE-03). */
  | { type: 'dropProject'; id: number; key: string }
  | { type: 'shutdown' };

export interface EngineReady {
  type: 'ready';
  pid: number;
  /** Node version of the program running the engine host. */
  node: string;
  /** Electron version when the engine host runs inside VS Code's own program (Code.exe in Node mode). */
  electron: string | null;
  runAsNode: boolean;
  execPath: string;
}

/** What the test stubs recorded in a process (null when no stub is loaded, as in production). */
export interface StubReport {
  role: string;
  stubs: string[];
  blocked: { kind: string; detail: string }[];
  allowedForks: { target: string }[];
}

export type FromEngine =
  | EngineReady
  | { type: 'pong'; id: number; payload: string }
  | { type: 'wasmCheck'; id: number; result: number }
  | { type: 'stubReport'; id: number; report: StubReport | null }
  | { type: 'init'; id: number; info: EngineInitInfo }
  | { type: 'compile'; id: number; result: CompileResult }
  | { type: 'cancel'; id: number; cancelled: boolean }
  | { type: 'memory'; id: number; memory: EngineMemory }
  | { type: 'dropProject'; id: number; dropped: boolean }
  | { type: 'error'; id?: number; message: string };

/** The global symbol under which the test stubs keep their record (see test/stubs/stub-state.cjs). */
export const STUB_STATE_KEY = 'livemd2tex.stubs';

/**
 * A 41-byte WebAssembly module exporting add(i32, i32) -> i32. Used to show that WebAssembly compiles and
 * runs in the engine host and in the viewer under its CSP; no file is fetched for it.
 */
export const TINY_WASM_ADD = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic, version 1
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, // type section: (i32, i32) -> i32
  0x03, 0x02, 0x01, 0x00, // function section: one function of type 0
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, // export "add" = function 0
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b, // body: local.get 0, local.get 1, i32.add
]);
