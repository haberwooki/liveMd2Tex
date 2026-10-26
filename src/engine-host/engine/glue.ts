// Loads the patched Emscripten glue (a CommonJS module) by its absolute path. This is the one file in src/ that
// may use node:module (eslint.config.mjs): loading the engine glue is the only dynamic module load the
// extension makes, and the glue it loads is the patched copy whose diff is reviewed in engine/patches/.

import { createRequire } from 'node:module';

/** The parts of an Emscripten module object the engine uses. */
export interface EmscriptenModule {
  FS: EmscriptenFS;
  ENV: Record<string, string>;
  LZ4: {
    init(): void;
    CHUNK_SIZE: number;
    FILE_MODE: number;
    DIR_MODE: number;
    createNode(parent: unknown, name: string, mode: number, dev: number, contents: unknown): unknown;
    /** The LZ4 file's stream operations; read(stream, buffer, offset, length, position) returns the bytes read. */
    stream_ops: { read(stream: { node: { size: number } }, buffer: Uint8Array, offset: number, length: number, position: number): number } & Record<string, unknown>;
  };
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  callMain(args: string[]): number;
  _flush_streams?: () => void;
}

export interface EmscriptenFS {
  mkdir(path: string): unknown;
  lookupPath(path: string): { node: unknown };
  mkdirTree(path: string): void;
  readdir(path: string): string[];
  stat(path: string): { mode: number };
  isDir(mode: number): boolean;
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string, opts?: { encoding: 'binary' | 'utf8' }): Uint8Array | string;
  analyzePath(path: string): { exists: boolean };
  chdir(path: string): void;
  unlink(path: string): void;
  /** The error a file operation throws to return an errno to the program (29: EIO). */
  ErrnoError: new (errno: number) => Error;
}

export type EmscriptenFactory = (moduleArg: Record<string, unknown>) => Promise<EmscriptenModule>;

export function loadGlue(gluePath: string): EmscriptenFactory {
  const load = createRequire(gluePath);
  const exported = load(gluePath) as EmscriptenFactory | { default: EmscriptenFactory };
  return typeof exported === 'function' ? exported : exported.default;
}
