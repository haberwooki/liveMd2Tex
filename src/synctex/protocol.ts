// Messages between the extension host and the SyncTeX worker (worker.ts). Plain data only.

import type { ForwardResult } from './parser';

export type SyncRequest =
  | { id: number; type: 'load'; key: string; data: Uint8Array }
  | { id: number; type: 'inverse'; key: string; page: number; x: number; y: number }
  | { id: number; type: 'forward'; key: string; file: string; line: number }
  | { id: number; type: 'drop'; key: string };

export interface LoadResult {
  pages: number;
  /** The project files the compile read, relative to the project folder. */
  files: string[];
}

export interface InverseAnswer {
  /** Relative to the project folder; null for a file outside it (a class or package file). */
  file: string | null;
  line: number;
}

export type SyncResult = LoadResult | InverseAnswer | ForwardResult | null;

export type SyncResponse = { id: number; ok: true; result: SyncResult } | { id: number; ok: false; error: string };
