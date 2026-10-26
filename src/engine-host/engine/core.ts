// The engine host's long-lived state (docs/DESIGN.md#architecture): the compiled WebAssembly module and the image bytes,
// read once with fs (never fetch) into a SharedArrayBuffer; a worker_thread per compile, which cancel
// terminates while the process, the module and the image stay.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { basename, dirname, join, posix } from 'node:path';
import { failedResult as failed, imageKey, TEXMF_PREFIX, type CompileJob, type CompileResult, type DataImageRef, type EngineAssetPaths, type EngineInitInfo } from '../../shared/engineJobs';
import { buildImageIndex, DamagedData, damagedMessage, packedMismatch, readPackageMetadata, type CompressedTable, type PackageMetadata } from './packageMeta';
import type { CacheFile, ExtraImage, WorkerJob, WorkerSetup } from './worker';

export interface LoadedEngine {
  setup: Omit<WorkerSetup, 'createdAt' | 'fontCache'>;
  info: EngineInitInfo;
}

function readIntoShared(file: string): SharedArrayBuffer {
  const size = statSync(file).size;
  const shared = new SharedArrayBuffer(size);
  const view = new Uint8Array(shared);
  const fd = openSync(file, 'r');
  try {
    let offset = 0;
    while (offset < size) {
      const n = readSync(fd, view, offset, Math.min(16 * 1024 * 1024, size - offset), offset);
      if (n <= 0) {
        throw new Error(`${file}: short read at ${offset} of ${size}`);
      }
      offset += n;
    }
  } finally {
    closeSync(fd);
  }
  return shared;
}

/**
 * An image's packed list must agree with the data set's manifest beside its index (packedMismatch; t1c gate, S-1):
 * the engine host checks only the files the index lists. `id` is null for the core image.
 */
function checkPackedList(indexPath: string, metadata: PackageMetadata, id: string | null): void {
  const manifestPath = join(dirname(indexPath), 'manifest.json');
  if (!existsSync(manifestPath)) {
    return;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    manifest = metadata.packed ? { image: { index: basename(indexPath) } } : null;
  }
  const files = packedMismatch(metadata, manifest, basename(indexPath));
  if (files !== null) {
    throw new DamagedData(damagedMessage(id, 'its index and its manifest list different packed fonts', 'so the engine does not use it'), files);
  }
}

/**
 * Reads a data extension's image (CompileJob.dataImages) into a SharedArrayBuffer, as the core image is read. Its
 * file names must be plain texmf paths under the image's root (they are mounted under /texmf-extra).
 */
export function loadDataImage(ref: DataImageRef): ExtraImage {
  const image = readIntoShared(ref.data);
  const { metadata, compressed } = JSON.parse(readFileSync(ref.index, 'utf8')) as { metadata: PackageMetadata; compressed: CompressedTable };
  if (metadata.remote_package_size !== image.byteLength) {
    throw new Error(`data image ${ref.id}: ${image.byteLength} bytes, its index says ${metadata.remote_package_size}`);
  }
  for (const f of metadata.files) {
    if (!f.filename.startsWith('/') || posix.normalize(f.filename) !== f.filename || f.filename.split('/').includes('..')) {
      throw new Error(`data image ${ref.id}: not a plain texmf path: ${f.filename}`);
    }
  }
  checkPackedList(ref.index, metadata, ref.id);
  return { id: ref.id, key: imageKey(ref), image, index: buildImageIndex(metadata, compressed) };
}

export async function loadEngine(paths: EngineAssetPaths): Promise<LoadedEngine> {
  const t0 = performance.now();
  const module = await WebAssembly.compile(readFileSync(paths.wasm));
  const t1 = performance.now();
  const image = readIntoShared(paths.data);
  const t2 = performance.now();
  // The loader script (development) or the JSON index made from it for the package (scripts/stage-engine.mjs).
  const loaderText = readFileSync(paths.loader, 'utf8');
  const { metadata, compressed } = paths.loader.endsWith('.json')
    ? (JSON.parse(loaderText) as ReturnType<typeof readPackageMetadata>)
    : readPackageMetadata(loaderText);
  const t3 = performance.now();
  if (metadata.remote_package_size !== image.byteLength) {
    throw new Error(`image is ${image.byteLength} bytes, its metadata says ${metadata.remote_package_size}`);
  }
  checkPackedList(paths.loader, metadata, null);
  return {
    setup: {
      module,
      image,
      index: buildImageIndex(metadata, compressed),
      gluePath: paths.glue,
      cnfOverride: readFileSync(paths.cnfOverride, 'utf8'),
      fontsConf: readFileSync(paths.fontsConf, 'utf8'),
    },
    info: {
      compileMs: Math.round(t1 - t0),
      readImageMs: Math.round(t2 - t1),
      metadataMs: Math.round(t3 - t2),
      imageBytes: image.byteLength,
      files: metadata.files.length,
    },
  };
}

interface Standby {
  worker: Worker;
  /** The data images this worker mounted when it started. */
  extras: Set<string>;
  /** The version of fontconfig's cache the worker was given when it started. */
  fontCacheVersion: number;
  dead: boolean;
}

export class EngineCore {
  private running: { worker: Worker; jobId: number; settle: (r: CompileResult) => void } | null = null;
  /**
   * The next compile's worker, started ahead of time: it instantiates the engine and mounts the image while no
   * compile runs, so a live edit's job pays only for its own files and the TeX run (docs/DESIGN.md#live-behaviour).
   */
  private standby: Standby | null = null;
  /**
   * fontconfig's cache, one file per font folder: made by the first XeTeX compile, completed by later ones (a newly
   * mounted add-on's folders), and given to every later worker. Each change makes a new version.
   */
  private fontCache: CacheFile[] = [];
  private fontCacheVersion = 0;
  /**
   * Data extension images read so far (G2E-02), by key (id, version and content; G2E-R1). Only images still
   * installed are kept (CompileJob.knownImages), and a worker mounts exactly the images its job lists.
   */
  private readonly extras = new Map<string, ExtraImage>();
  /** The images the last job mounted: the next standby worker mounts them ahead of time. */
  private lastImages: ExtraImage[] = [];
  /** The last worker's termination: the next job waits for it, so two workers never run a job at once. */
  private stopping: Promise<void> = Promise.resolve();
  /**
   * Each project's files as the extension last sent them (CompileJob.project), each in a SharedArrayBuffer of its
   * own, so the worker gets them without a copy. The most recently used projects are kept, at most 8 and at most
   * KEPT_BYTES together (the project being compiled always stays); a project dropped here costs one full resend
   * ("need-full") at its next compile (re-gate G1BE-03).
   */
  private readonly projects = new Map<string, { version: number; files: Map<string, Uint8Array> }>();
  private static readonly KEPT_PROJECTS = 8;
  static readonly KEPT_BYTES = 256 * 1024 * 1024;

  /** Forgets a project's kept files. */
  dropProject(key: string): boolean {
    return this.projects.delete(key);
  }

  /** The keys of the kept projects, oldest first (for the tests). */
  keptProjects(): string[] {
    return [...this.projects.keys()];
  }

  /** Applies a job's change set; returns the job with the project's full file list, or null when the base is missing. */
  private withProjectFiles(job: CompileJob): CompileJob | null {
    const p = job.project;
    if (!p) {
      return job;
    }
    let entry = this.projects.get(p.key);
    if (p.base !== null && (!entry || entry.version !== p.base)) {
      return null;
    }
    if (p.base === null || !entry) {
      entry = { version: 0, files: new Map() };
    }
    for (const path of p.removed) {
      entry.files.delete(path);
    }
    for (const file of job.files) {
      const shared = new Uint8Array(new SharedArrayBuffer(file.data.length));
      shared.set(file.data);
      entry.files.set(file.path, shared);
    }
    entry.version = p.version;
    this.projects.delete(p.key);
    this.projects.set(p.key, entry);
    const bytes = (e: { files: Map<string, Uint8Array> }) => [...e.files.values()].reduce((n, d) => n + d.length, 0);
    let total = [...this.projects.values()].reduce((n, e) => n + bytes(e), 0);
    while (this.projects.size > 1 && (this.projects.size > EngineCore.KEPT_PROJECTS || total > this.keptBytes)) {
      const oldest = this.projects.keys().next().value as string;
      total -= bytes(this.projects.get(oldest) as { files: Map<string, Uint8Array> });
      this.projects.delete(oldest);
    }
    // The user's package files came in the same change set, under a prefix (G2E-02).
    const files = [...entry.files].map(([path, data]) => ({ path, data }));
    return {
      ...job,
      files: files.filter((f) => !f.path.startsWith(TEXMF_PREFIX)),
      texmfFiles: files.filter((f) => f.path.startsWith(TEXMF_PREFIX)).map((f) => ({ path: f.path.slice(TEXMF_PREFIX.length), data: f.data })),
    };
  }

  constructor(
    private readonly engine: LoadedEngine,
    private readonly workerFile: string,
    private readonly keepStandby = true,
    /** The most bytes of kept project files (tests pass less). */
    private readonly keptBytes = EngineCore.KEPT_BYTES,
  ) {
    if (keepStandby) {
      this.standby = this.spawn([]);
    }
  }

  /** A worker that mounts `extras` (data images) while it prepares, before any job. */
  private spawn(extras: ExtraImage[]): Standby {
    const worker = new Worker(this.workerFile, {
      workerData: { ...this.engine.setup, extras, fontCache: this.fontCache, createdAt: Date.now() } satisfies WorkerSetup,
    });
    const standby: Standby = { worker, fontCacheVersion: this.fontCacheVersion, dead: false, extras: new Set(extras.map((e) => e.key)) };
    // A worker that fails before it gets a job is replaced by the next compile.
    worker.on('error', () => {
      standby.dead = true;
    });
    worker.on('exit', () => {
      standby.dead = true;
    });
    return standby;
  }

  /**
   * Runs one compile in the standby worker (or a fresh one). A compile already running is cancelled first, and
   * the job is posted only after that worker has exited (build gate 1, G1E-01).
   */
  compile(incoming: CompileJob): Promise<CompileResult> {
    this.cancel();
    const job = this.withProjectFiles(incoming);
    if (!job) {
      return Promise.resolve(failed(incoming.id, 'need-full'));
    }
    // Forget images that are no longer installed, or that an update replaced (G2E-R1).
    if (job.knownImages) {
      const known = new Set(job.knownImages);
      for (const key of [...this.extras.keys()]) {
        if (!known.has(key)) {
          this.extras.delete(key);
        }
      }
    }
    let images: ExtraImage[];
    try {
      images = (job.dataImages ?? []).map((ref) => {
        const key = imageKey(ref);
        let image = this.extras.get(key);
        if (!image) {
          image = loadDataImage(ref);
          // A newer image of the same data set replaces the older one.
          for (const [k, old] of this.extras) {
            if (old.id === ref.id) {
              this.extras.delete(k);
            }
          }
          this.extras.set(key, image);
        }
        return image;
      });
    } catch (err) {
      const result = failed(incoming.id, err instanceof Error ? err.message : String(err));
      return Promise.resolve(err instanceof DamagedData ? { ...result, damaged: err.files } : result);
    }
    const wanted = new Set(images.map((i) => i.key));
    const previous = this.stopping;
    const started = performance.now();
    let standby = this.standby;
    this.standby = null;
    // A standby worker that mounted an image this job does not list would show it: a fresh worker instead.
    if (!standby || standby.dead || [...standby.extras].some((k) => !wanted.has(k))) {
      if (standby) {
        void standby.worker.terminate();
      }
      standby = this.spawn(images);
    }
    this.lastImages = images;
    const { worker, fontCacheVersion } = standby;
    const mounted = standby.extras;
    return new Promise<CompileResult>((resolve) => {
      let done = false;
      const settle = (result: CompileResult) => {
        if (done) {
          return;
        }
        done = true;
        if (this.running?.worker === worker) {
          this.running = null;
        }
        this.stopping = worker.terminate().then(
          () => undefined,
          () => undefined,
        );
        const { fontCache, ...rest } = result;
        if (fontCache && fontCache.length > 0) {
          const names = new Set(fontCache.map((f) => f.name));
          this.fontCache = [...this.fontCache.filter((f) => !names.has(f.name)), ...fontCache];
          this.fontCacheVersion++;
        }
        resolve({ ...rest, timings: { ...rest.timings, totalMs: Math.round(performance.now() - started) } });
        if (this.keepStandby && !this.standby && !this.disposed) {
          this.standby = this.spawn(this.lastImages.filter((i) => this.extras.has(i.key)));
        }
      };
      this.running = { worker, jobId: job.id, settle };
      worker.once('message', (result: CompileResult) => settle(result));
      worker.once('error', (err) => settle(failed(job.id, `worker error: ${String(err)}`)));
      worker.once('exit', (code) => settle(failed(job.id, `worker exited with code ${code}`)));
      const message: WorkerJob = {
        job,
        fontCache: fontCacheVersion !== this.fontCacheVersion && this.fontCache.length > 0 ? this.fontCache : undefined,
        // Images this worker did not mount when it started (read for this job): it mounts them first.
        extras: images.filter((i) => !mounted.has(i.key)),
      };
      void previous.then(() => {
        if (!done) {
          worker.postMessage(message);
        }
      });
    });
  }

  /**
   * Terminates the running compile, if any; the module, the image and the standby worker stay. With `jobId`,
   * only that job's compile: a cancel meant for a job that already ended never stops the next one (G1E-06).
   */
  cancel(jobId?: number): boolean {
    const running = this.running;
    if (!running || (jobId !== undefined && running.jobId !== jobId)) {
      return false;
    }
    this.running = null;
    running.settle(failed(running.jobId, 'cancelled'));
    return true;
  }

  private disposed = false;

  /** Stops every worker (the engine host is shutting down). */
  dispose(): void {
    this.disposed = true;
    this.cancel();
    if (this.standby) {
      void this.standby.worker.terminate();
      this.standby = null;
    }
  }
}
