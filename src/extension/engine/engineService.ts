// The extension's handle on the engine host (docs/DESIGN.md#store-and-packaging, #engine-and-data): started on the first compile, not on
// activation; stopped after an idle period; the engine files found inside the extension. It is the first
// compile backend (src/shared/backend.ts; build gate 1, G1E-06).
//
// Two rules from build gate 1:
// - A failed start or engine load stops the forked process at once and is remembered: later compiles fail with
//   the same message and fork nothing, until the engine files or the Node flags change or retry() is called
//   (the compile command does). One leaked process per typing pause is what it prevented (G1E-02).
// - Only changed files cross the process boundary (docs/DESIGN.md#engine-and-data, #live-behaviour; G1E-03). For each project the
//   service remembers what it sent; a job carries the files that changed since then and the paths removed, and
//   the engine host keeps the rest. If the host lacks that base (it restarted), it answers "need-full" and the
//   service sends everything once.
// - Cancel names the job it means: the one this service has in flight. The engine host ignores a cancel for any
//   other job (G1E-06).

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { BackendCapabilities, BackendResult, CanCompile, CompileBackend } from '../../shared/backend';
import { TEXMF_PREFIX, type CompileJob, type CompileResult, type EngineAssetPaths, type EngineInitInfo, type EngineMemory, type ProjectFile } from '../../shared/engineJobs';
import { EngineHost, type EngineHostOptions } from '../engineHostClient';

/**
 * The engine files inside this copy of the extension: dist/engine/ (the patched glue, the WebAssembly engine,
 * our texmf.cnf and fonts.conf) and dist/data/ (the TeX image and its index). Version 0 ships TeXlyre's image
 * unchanged as the interim data; the separate data extensions come with B1 and G0 (docs/DESIGN.md#store-and-packaging).
 */
export function bundledEngineAssets(extensionPath: string): EngineAssetPaths | null {
  const engine = path.join(extensionPath, 'dist', 'engine');
  const data = path.join(extensionPath, 'dist', 'data');
  const paths: EngineAssetPaths = {
    glue: path.join(engine, 'busytex.js'),
    wasm: path.join(engine, 'busytex.wasm'),
    cnfOverride: path.join(engine, 'texmf-override.cnf'),
    fontsConf: path.join(engine, 'fonts.conf'),
    data: path.join(data, 'texlive-extra.data'),
    loader: path.join(data, 'texlive-extra.index.json'),
  };
  return Object.values(paths).every((p) => existsSync(p)) ? paths : null;
}

/** What the service needs of an engine host (EngineHost; a fake in the unit tests). */
export interface EngineHostLike {
  readonly running: boolean;
  start(): Promise<unknown>;
  init(assets: EngineAssetPaths): Promise<EngineInitInfo>;
  compile(job: CompileJob): Promise<CompileResult>;
  cancel(jobId?: number): Promise<boolean>;
  dropProject?(key: string): Promise<boolean>;
  memory(): Promise<EngineMemory>;
  stop(): Promise<unknown>;
}

export interface EngineServiceOptions {
  modulePath: string;
  assets: () => EngineAssetPaths | null;
  idleMinutes: () => number;
  log: (line: string) => void;
  /** Makes an engine host; the default forks the real one. */
  createHost?: (options: EngineHostOptions) => EngineHostLike;
}

export type TimedResult = BackendResult;

/** The engine cannot be used (its files are missing, or it failed to start or load). Shown once per cause. */
export class EngineUnavailableError extends Error {
  constructor(
    message: string,
    /** False when the same failure was already reported. */
    readonly firstTime: boolean,
  ) {
    super(message);
    this.name = 'EngineUnavailableError';
  }
}

const equalBytes = (a: Uint8Array, b: Uint8Array) => a === b || (a.length === b.length && Buffer.compare(a, b) === 0);

const NO_ASSETS = 'The TeX engine files are not part of this copy of the extension.';

export class EngineService implements CompileBackend {
  private host: EngineHostLike | undefined;
  private loaded: Promise<EngineInitInfo> | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  /** The last start or load failure, and the setup it happened with. */
  private failure: { key: string; message: string } | undefined;
  /** What each project's last compile sent to the current engine host. */
  private readonly sent = new Map<string, { version: number; files: Map<string, Uint8Array> }>();
  /** Files sent by the last compile, for the tests and the log. */
  lastTransfer: { project?: string; changed: number; removed: number; full: boolean; bytes: number } | undefined;
  /** Node flags for the engine host; empty in production, the stubs in tests. */
  execArgv: string[] = [];
  /** The job whose compile is in flight, for cancel. */
  private inFlight: number | undefined;

  constructor(private readonly options: EngineServiceOptions) {}

  get running(): boolean {
    return this.host?.running ?? false;
  }

  capabilities(): BackendCapabilities {
    return { engines: ['pdflatex', 'xelatex'], synctex: true, bibtex: true, changeSets: true };
  }

  /** Whether a compile can start now: the engine files are here and the engine has not failed to load. */
  canCompile(job: Pick<CompileJob, 'engine' | 'main'>): CanCompile {
    const assets = this.options.assets();
    if (!assets) {
      return { ok: false, reason: NO_ASSETS };
    }
    if (this.failure?.key === this.setupKey(assets)) {
      return { ok: false, reason: this.failure.message };
    }
    return this.capabilities().engines.includes(job.engine) ? { ok: true } : { ok: false, reason: `The engine ${job.engine} is not available.` };
  }

  /** Starts and loads the engine now (a warm-up before the first compile). */
  async prepare(): Promise<void> {
    const assets = this.options.assets();
    if (!assets) {
      throw new EngineUnavailableError(NO_ASSETS, false);
    }
    this.clearIdle();
    try {
      await this.ensure(assets);
    } finally {
      this.armIdle();
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  /**
   * A project nobody shows any more: its copy here and its kept files in the engine host go (re-gate G1BE-03).
   * Its next compile, if any, sends all its files again.
   */
  forget(project: string): void {
    this.sent.delete(project);
    if (this.host?.running && this.host.dropProject) {
      void this.host.dropProject(project).catch(() => undefined);
    }
  }

  /** Forget a remembered failure, so the next compile tries to start the engine again. */
  retry(): void {
    this.failure = undefined;
  }

  private setupKey(assets: EngineAssetPaths): string {
    return JSON.stringify({ assets, execArgv: this.execArgv });
  }

  private makeHost(): EngineHostLike {
    const options: EngineHostOptions = {
      modulePath: this.options.modulePath,
      execArgv: this.execArgv,
      log: this.options.log,
      requestTimeoutMs: 120000,
    };
    return this.options.createHost ? this.options.createHost(options) : new EngineHost(options);
  }

  /** Starts and loads the engine if needed; returns the start time and load info when it had to. */
  private async ensure(assets: EngineAssetPaths): Promise<{ host: EngineHostLike; engineStartMs: number; init: EngineInitInfo | null }> {
    const key = this.setupKey(assets);
    if (this.failure?.key === key) {
      throw new EngineUnavailableError(this.failure.message, false);
    }
    if (this.host && this.host.running && this.loaded) {
      await this.loaded;
      return { host: this.host, engineStartMs: 0, init: null };
    }
    // A host that died is replaced; what it held is gone with it.
    if (this.host) {
      await this.host.stop().catch(() => undefined);
    }
    this.sent.clear();
    const started = performance.now();
    const host = this.makeHost();
    this.host = host;
    this.loaded = host.start().then(() => host.init(assets));
    let init: EngineInitInfo;
    try {
      init = await this.loaded;
    } catch (err) {
      this.loaded = undefined;
      this.host = undefined;
      await host.stop().catch(() => undefined);
      const message = `The TeX engine could not be loaded: ${err instanceof Error ? err.message : String(err)}. Run "Compile this document now" to try again.`;
      this.failure = { key, message };
      this.options.log(message);
      throw new EngineUnavailableError(message, true);
    }
    const engineStartMs = Math.round(performance.now() - started);
    this.options.log(`engine started in ${engineStartMs} ms (module ${init.compileMs} ms, image ${init.readImageMs} ms, ${init.files} files)`);
    return { host, engineStartMs, init };
  }

  /**
   * Compiles a job. With `project`, the files are sent as a change set against what this project's last
   * compile sent (the job itself keeps its full file list).
   */
  async compile(job: CompileJob, project?: string): Promise<TimedResult> {
    const assets = this.options.assets();
    if (!assets) {
      const message = NO_ASSETS;
      const firstTime = this.failure?.message !== message;
      this.failure = { key: 'no-assets', message };
      throw new EngineUnavailableError(message, firstTime);
    }
    if (this.failure?.key === 'no-assets') {
      this.failure = undefined;
    }
    this.clearIdle();
    try {
      const { host, engineStartMs, init } = await this.ensure(assets);
      return { result: await this.send(host, job, project), engineStartMs, init };
    } finally {
      this.armIdle();
    }
  }

  private async send(host: EngineHostLike, job: CompileJob, project: string | undefined): Promise<CompileResult> {
    this.inFlight = job.id;
    try {
      return await this.sendFiles(host, job, project);
    } finally {
      if (this.inFlight === job.id) {
        this.inFlight = undefined;
      }
    }
  }

  private async sendFiles(host: EngineHostLike, job: CompileJob, project: string | undefined): Promise<CompileResult> {
    const bytes = (files: ProjectFile[]) => files.reduce((n, f) => n + f.data.length, 0);
    if (!project) {
      this.lastTransfer = { changed: job.files.length, removed: 0, full: true, bytes: bytes(job.files) };
      return host.compile(job);
    }
    const previous = this.sent.get(project);
    const version = (previous?.version ?? 0) + 1;
    // The user's package files go in the change set too (G2E-02), under a prefix the engine host splits off.
    const all = [...job.files, ...(job.texmfFiles ?? []).map((f) => ({ path: `${TEXMF_PREFIX}${f.path}`, data: f.data }))];
    const now = new Map(all.map((f) => [f.path, f.data]));
    const changed = previous ? all.filter((f) => !previous.files.has(f.path) || !equalBytes(previous.files.get(f.path) as Uint8Array, f.data)) : all;
    const removed = previous ? [...previous.files.keys()].filter((p) => !now.has(p)) : [];
    this.lastTransfer = { project, changed: changed.length, removed: removed.length, full: !previous, bytes: bytes(changed) };
    let result = await host.compile({ ...job, files: changed, texmfFiles: undefined, project: { key: project, base: previous ? previous.version : null, version, removed } });
    if (result.error === 'need-full') {
      this.options.log(`${project}: the engine host lacked the project's files; sending all of them`);
      this.lastTransfer = { project, changed: all.length, removed: 0, full: true, bytes: bytes(all) };
      result = await host.compile({ ...job, files: all, texmfFiles: undefined, project: { key: project, base: null, version, removed: [] } });
    }
    // The host applied the change set when the job arrived, whether the compile then finished or was cancelled.
    this.sent.set(project, { version, files: now });
    return result;
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private armIdle(): void {
    this.clearIdle();
    const minutes = this.options.idleMinutes();
    if (minutes > 0) {
      this.idleTimer = setTimeout(() => {
        this.options.log(`engine stopped after ${minutes} idle minutes`);
        void this.stop();
      }, minutes * 60000);
      this.idleTimer.unref?.();
    }
  }

  /**
   * Terminates the worker of the compile in flight (its compile() then resolves with error 'cancelled'), when
   * `jobId` is that compile's job or is left out. The engine host, the compiled module, the image and the
   * standby worker stay.
   */
  async cancel(jobId?: number): Promise<void> {
    const target = this.inFlight;
    if (target === undefined || (jobId !== undefined && jobId !== target)) {
      return;
    }
    if (this.host?.running) {
      try {
        await this.host.cancel(target);
      } catch (err) {
        this.options.log(`cancel failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** The engine host's memory use, or null when it is not running. */
  async memory(): Promise<EngineMemory | null> {
    return this.host?.running ? this.host.memory() : null;
  }

  async stop(): Promise<void> {
    this.clearIdle();
    const host = this.host;
    this.host = undefined;
    this.loaded = undefined;
    this.sent.clear();
    await host?.stop();
  }
}
