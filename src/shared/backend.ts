// The compile backend (docs/DESIGN.md#engine-and-data; build gate 1, G1E-06): what the compile loop needs of an engine, so
// that a second backend (a Tectonic build, or a web worker for a browser version) can sit behind the same calls. EngineService
// (src/extension/engine/engineService.ts) is the first implementation: the forked engine host with busytex.
//
// - capabilities(): what this backend can do at all.
// - canCompile(job): whether it can compile this job now, and if not, why (missing engine files, a failed
//   load). The package half of docs/DESIGN.md#engine-and-data's check is the preamble scan (M6), which needs the data
//   sets' package indexes that the extension holds: it runs in prepareCompile (src/extension/project/
//   packageScan.ts, src/extension/engine/dataResolver.ts) before every compile, and lists every missing file.
// - prepare(): start and load the engine ahead of the first compile (optional warm-up).
// - compile(job, project): one compile. With `project`, only the files changed since that project's last
//   compile cross to the backend; the job itself always lists every file.
// - cancel(jobId): stop that job's compile only; a cancel for a job that already ended does nothing.
// - dispose(): stop everything.

import type { CompileJob, CompileResult, EngineInitInfo } from './engineJobs';

export interface BackendCapabilities {
  /** The TeX engines this backend runs. */
  engines: CompileJob['engine'][];
  /** It writes SyncTeX data. */
  synctex: boolean;
  /** It runs bibtex8 between passes. */
  bibtex: boolean;
  /** It keeps each project's files between compiles and takes change sets. */
  changeSets: boolean;
}

export type CanCompile = { ok: true } | { ok: false; reason: string };

export interface BackendResult {
  result: CompileResult;
  /** Engine start and load, when this compile had to do them; 0 otherwise. */
  engineStartMs: number;
  init: EngineInitInfo | null;
}

export interface CompileBackend {
  capabilities(): BackendCapabilities;
  canCompile(job: Pick<CompileJob, 'engine' | 'main'>): CanCompile;
  prepare(): Promise<void>;
  compile(job: CompileJob, project?: string): Promise<BackendResult>;
  cancel(jobId?: number): Promise<void>;
  dispose(): Promise<void>;
}
