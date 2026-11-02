// One compile, in a worker_thread of the engine host (docs/DESIGN.md#architecture). The host passes the compiled
// WebAssembly module and the image bytes (a SharedArrayBuffer, not copied); this worker makes its own
// Emscripten instance, mounts the image's file list (LZ4, decompressed only when read), writes the project into
// MEMFS, and runs the tools one after another with BusyTeX's one-instance pattern: one callMain per tool, then
// the WebAssembly memory is cleared and its first 64 MiB restored. The pattern follows BusyTeX's
// busytex_pipeline.js (Vadim Kantorov, MIT; https://github.com/busytex/busytex), written anew here (see step()
// below, and THIRD_PARTY_NOTICES.md). Cancel is the host's worker.terminate().
//
// The image bytes are shared and only read. Each worker decompresses into chunk buffers of its own (the glue's
// file_packager would put them at the end of the image buffer, where two workers could overwrite each other's
// chunks), and the host starts the next job only after the previous worker has exited (core.ts).

import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { ENGINE_FORMATS, failedResult, type CompileJob, type CompileResult, type ProjectFile, type StepRecord } from '../../shared/engineJobs';
import { STUB_STATE_KEY, type StubReport } from '../../shared/engineProtocol';
import { pdfProblem } from '../../shared/pdfCheck';
import { t1cUnpack } from './t1c';
import { loadGlue, type EmscriptenModule } from './glue';
import { checkEnvOverrides, FONT_LIST_IN_IMAGE, fontListText, HEADER_BYTES, headerProblem } from './layout';
import { lsR } from './lsR';
import { damagedMessage, type ImageIndex } from './packageMeta';
import * as speed from './speedProbe';

interface FsNode {
  mode: number;
  stream_ops?: unknown;
  contents: Record<string, FsNode>;
  node_ops: { mknod(parent: FsNode, name: string, mode: number, dev: number): FsNode };
  atime: number;
  mtime: number;
  ctime: number;
}

/** A data extension's image (CompileJob.dataImages), read by the engine host. */
export interface ExtraImage {
  id: string;
  /** The image's identity (id, version and content; imageKey). */
  key: string;
  image: SharedArrayBuffer;
  index: ImageIndex;
}

export interface WorkerSetup {
  module: WebAssembly.Module;
  image: SharedArrayBuffer;
  index: ImageIndex;
  /** Data extension images the host had read when this worker started; mounted with the core (G2E-02). */
  extras?: ExtraImage[];
  gluePath: string;
  cnfOverride: string;
  /**
   * Variables set over the engine's environment (createInstance), for a tool that compares runs or a test; only those
   * layout.ts's ENV_OVERRIDES names (never shell escape), and the extension sets none. They win over the speed
   * probe's fixed dates.
   */
  env?: Record<string, string>;
  createdAt: number;
}

/**
 * Every mounted folder and file gets this time stamp, so a file's date (\pdffilemoddate, the .fls) does not change
 * from one run to the next.
 */
const IMAGE_TIME = Date.UTC(2026, 0, 1);

const FORMATS = ENGINE_FORMATS;
const PROJECT = '/project';
const CNF_DIR = '/engine/cnf';
/** The program path TeX is given (argv[0]): kpathsea derives SELFAUTOLOC from it. An empty file at mount. */
const PROGRAM = '/bin/engine';
/**
 * The font list XeTeX's fontconfig stand-in reads (engine/build/fontlist; LIVEMD2TEX_FONT_LIST): the mounted
 * images' own lists (FONT_LIST_IN_IMAGE), core first, then the add-ons in mount order, each line's path with the
 * image's mount root in front (docs/DESIGN.md, "Engine and data").
 */
const FONT_LIST = '/engine/fonts.list';
/** Where each mounted image's own list is kept (one file per image, in mount order), outside the TeX trees. */
const FONT_LISTS = '/engine/font-lists';
const TEXMFLOG = '/tmp/texmf.log';
/** The user's own package files (CompileJob.texmfFiles). */
const TEXMFHOME = '/texmf-home';
/** Where data extension images are mounted (G2E-02): a texmf tree searched after TEXMFHOME, before the bundle. */
const TEXMF_EXTRA = '/texmf-extra';
// Requests for another pass in the log. Not the word "rerunfilecheck" alone: hyperref loads that package, so its
// name is in every such log; its warning itself says "Rerun to get outlines right".
const RERUN = /Rerun to get|Rerun LaTeX|Please rerun LaTeX|Label\(s\) may have changed/;
const MAX_TRANSCRIPT = 4 * 1024 * 1024;

function stubReport(): StubReport | null {
  const state = (globalThis as Record<symbol, unknown>)[Symbol.for(STUB_STATE_KEY)] as { report(): StubReport } | undefined;
  return state ? state.report() : null;
}

/** Whether a path exists in the engine's file system (FS.stat throws for one that does not). */
function exists(M: EmscriptenModule, path: string): boolean {
  try {
    M.FS.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function createInstance(setup: WorkerSetup, print: (line: string) => void): Promise<EmscriptenModule> {
  const factory = loadGlue(setup.gluePath);
  checkEnvOverrides(setup.env);
  const env: Record<string, string> = {
    // Our texmf.cnf first: its values (no shell escape, no mktex*) win over TeX Live's.
    TEXMFCNF: `${CNF_DIR}:/texlive/texmf-dist/web2c`,
    TEXMFDIST: '/texlive/texmf-dist',
    TEXMFVAR: '/texlive/texmf-dist/texmf-var',
    TEXMFCACHE: '/texlive/texmf-dist/texmf-var',
    // The user's package folder first, then the data extensions' images (kpathsea expands the braces). "!!": the
    // images' files are looked up in their ls-R only (writeExtrasLsR), never by a search of their folders on disk;
    // the user's folder has no ls-R and keeps its disk search.
    TEXMFHOME: `{${TEXMFHOME},!!${TEXMF_EXTRA}}`,
    TEXMFLOG,
    // The font list XeTeX's fontconfig stand-in reads (writeFontList).
    LIVEMD2TEX_FONT_LIST: FONT_LIST,
    MKTEXPK: '0',
    MKTEXTFM: '0',
    MKTEXMF: '0',
    MKTEXFMT: '0',
    MKTEXTEX: '0',
    shell_escape: 'f',
    HOME: '/home/web_user',
    ...speed.probeEnv(),
    ...setup.env,
  };
  return factory({
    thisProgram: PROGRAM,
    noInitialRun: true,
    print,
    printErr: print,
    instantiateWasm(imports: Record<string, Record<string, unknown>>, done: (instance: WebAssembly.Instance) => void) {
      WebAssembly.instantiate(setup.module, imports).then(done, (err: unknown) => print(`instantiate failed: ${String(err)}`));
      return {};
    },
    preRun: [
      (M: EmscriptenModule) => {
        Object.assign(M.ENV, env);
      },
    ],
  });
}

/**
 * Mounts the image's files as LZ4 nodes (decompressed only when read). Equivalent to the glue's
 * LZ4.loadPackage, but each folder is created once and each file node is made directly under its parent,
 * which takes the 23,883-file image from about 14 s to well under a second. `owner` is the data extension's id,
 * or null for the core image: a packed file that fails its check names it (damagedMessage). The image's own font
 * list (FONT_LIST_IN_IMAGE) is not mounted in the tree but at `listAs`: two add-ons' lists share one path.
 */
function mountImage(M: EmscriptenModule, image: SharedArrayBuffer, index: ImageIndex, root: string, owner: string | null, listAs: string): void {
  const L = M.LZ4;
  L.init();
  const data = new Uint8Array(image);
  const size = L.CHUNK_SIZE;
  const slots = speed.lz4Slots(index.cacheSlots);
  const compressedData = {
    data,
    cachedOffset: index.cachedOffset,
    cachedIndexes: new Array<number>(slots).fill(-1),
    // This worker's own decompression buffers, never views on the shared image (build gate 1, G1E-01).
    cachedChunks: Array.from({ length: slots }, () => new Uint8Array(size)),
    offsets: index.chunkOffsets,
    sizes: index.chunkSizes,
    successes: index.chunkCompressed,
  };
  // Folders are made through their parent's node operations: a path lookup per folder (FS.mkdir) costs
  // about a millisecond each in this build, because lookups that miss throw internally.
  const folders = new Map<string, FsNode>([['/', M.FS.lookupPath('/').node as FsNode]]);
  const folder = (p: string): FsNode => {
    let node = folders.get(p);
    if (node === undefined) {
      const parent = folder(posix.dirname(p));
      const name = posix.basename(p);
      node = parent.contents[name] ?? parent.node_ops.mknod(parent, name, L.DIR_MODE, 0);
      folders.set(p, node);
    }
    return node;
  };
  const names = index.names.split('\n');
  const ownList = owner === null ? FONT_LIST_IN_IMAGE.core : FONT_LIST_IN_IMAGE.extra;
  for (let i = 0; i < names.length; i++) {
    const name = names[i] === ownList ? listAs : `${root}${names[i]}`;
    const slash = name.lastIndexOf('/');
    const parent = folder(slash <= 0 ? '/' : name.slice(0, slash));
    if (parent.contents[name.slice(slash + 1)]) {
      continue; // a file another data image already has: the first one mounted stays
    }
    const file = L.createNode(parent, name.slice(slash + 1), L.FILE_MODE, 0, {
      compressedData,
      start: index.starts[i],
      end: index.ends[i],
    }) as FsNode;
    file.atime = file.mtime = file.ctime = IMAGE_TIME;
    const sha256 = index.packed?.[names[i]];
    if (sha256 !== undefined) {
      file.stream_ops = packedStreamOps(M, name, sha256, owner);
    }
  }
  for (const [p, node] of folders) {
    if (p !== '/') {
      node.atime = node.mtime = node.ctime = IMAGE_TIME;
    }
  }
}

/** Speed probe, lazy restore: the last program's memory is not restored yet (see step() in compile()). */
let heapDirty = false;

/** Packed files this worker has unpacked, by path: each is unpacked once, when TeX first reads it. */
const unpacked = new Map<string, Uint8Array>();
/**
 * Packed files whose unpacked bytes did not match the original's SHA-256 (this worker serves none of their bytes),
 * by path, with the image's owner (null: the core; else the data extension's id).
 */
const damaged = new Map<string, string | null>();

/**
 * The stream operations of a file the image stores packed with t1c (B1: the core's Type 1 fonts). The first open
 * reads the packed bytes through the LZ4 layer, encrypts them again (src/engine-host/engine/t1c.ts) and checks the result
 * against the original's SHA-256; reads then serve the original's bytes, cached in this worker. A file that fails
 * the check does not open (an I/O error, never other bytes), and the compile's result says which data is damaged.
 */
function packedStreamOps(M: EmscriptenModule, path: string, sha256: string, owner: string | null): Record<string, unknown> {
  const L = M.LZ4;
  const original = (stream: { node: { size: number } }): Uint8Array => {
    let bytes = unpacked.get(path);
    if (bytes === undefined) {
      const t1c0 = speed.PROBE ? performance.now() : 0;
      const packed = new Uint8Array(stream.node.size);
      L.stream_ops.read(stream, packed, 0, packed.length, 0);
      let restored: Uint8Array | null;
      try {
        restored = t1cUnpack(packed);
      } catch {
        restored = null;
      }
      if (restored === null || createHash('sha256').update(restored).digest('hex') !== sha256) {
        damaged.set(path, owner);
        throw new M.FS.ErrnoError(29);
      }
      bytes = restored;
      unpacked.set(path, bytes);
      if (speed.PROBE) {
        speed.noteT1c(performance.now() - t1c0);
      }
    }
    return bytes;
  };
  return {
    ...L.stream_ops,
    // The check runs when the file is opened, so a damaged font fails to open (TeX stops with "cannot open"); an
    // error in the middle of reading would leave pdfTeX's font reader reading forever.
    open(stream: { node: { size: number } }): void {
      original(stream);
    },
    read(stream: { node: { size: number } }, buffer: Uint8Array, offset: number, length: number, position: number): number {
      const bytes = original(stream);
      const n = Math.min(length, bytes.length - position);
      if (n <= 0) {
        return 0;
      }
      buffer.set(bytes.subarray(position, position + n), offset);
      return n;
    },
  };
}

/** The plain message for the packed files that failed their check: one sentence per data set (damagedMessage). */
function damagedReport(): string {
  const byOwner = new Map<string | null, string[]>();
  for (const [path, owner] of damaged) {
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), posix.basename(path)]);
  }
  return [...byOwner]
    .map(([owner, names]) => damagedMessage(owner, names.length === 1 ? `the font file ${names[0]} did not pass its check` : `the font files ${names.join(', ')} did not pass their checks`))
    .join(' ');
}

/** The images mounted in this worker, in mount order: each one's mount root and where its font list is kept. */
const mounted: { root: string; list: string }[] = [];

/** Mounts an image and records it for the font list. */
function mount(M: EmscriptenModule, image: SharedArrayBuffer, index: ImageIndex, root: string, owner: string | null): void {
  const list = `${FONT_LISTS}/${mounted.length}.tsv`;
  mountImage(M, image, index, root, owner, list);
  mounted.push({ root, list });
}

/**
 * Writes FONT_LIST from the mounted images' own lists (fontListText). An image without a list adds nothing; with no
 * list at all the stand-in finds no font by name, and XeTeX still starts.
 */
function writeFontList(M: EmscriptenModule): void {
  const lists = mounted.filter(({ list }) => exists(M, list)).map(({ root, list }) => ({ root, text: M.FS.readFile(list, { encoding: 'utf8' }) as string }));
  M.FS.writeFile(FONT_LIST, fontListText(lists));
}

/** The data images mounted in this worker, by id. */
const mountedExtras = new Set<string>();
/** Their files, relative to TEXMF_EXTRA: the list its ls-R holds. */
const extraFiles = new Set<string>();
/**
 * The files kpathsea reads at the top of a tree in TEXMFDBS (TeX Live's db.c: ls-R, ls-r and the alias table). An
 * image's own are neither listed nor kept: the worker writes the tree's ls-R itself, and an image's alias table
 * would apply to lookups in every tree, the core's too.
 */
const DATABASE_FILES = ['/ls-R', '/ls-r', '/aliases'];

/** Mounts the images not mounted yet, and writes the tree's ls-R and the font list again. */
function mountExtras(M: EmscriptenModule, extras: ExtraImage[]): void {
  let added = false;
  for (const extra of extras) {
    if (!mountedExtras.has(extra.key)) {
      mount(M, extra.image, extra.index, TEXMF_EXTRA, extra.id);
      mountedExtras.add(extra.key);
      for (const name of extra.index.names.split('\n')) {
        if (name.length > 1 && !DATABASE_FILES.includes(name) && name !== FONT_LIST_IN_IMAGE.extra) {
          extraFiles.add(name.slice(1));
        }
      }
      added = true;
    }
  }
  if (added) {
    writeExtrasLsR(M);
    writeFontList(M);
  }
}

/**
 * Writes TEXMF_EXTRA/ls-R, kpathsea's file name database for every file mounted there (lsR.ts), in place of any
 * image's own: with two images, one image's ls-R would leave the other's files out. Our texmf.cnf lists the tree in
 * TEXMFDBS, so kpathsea looks an add-on's files up in this list; TEXMFHOME marks the tree "!!", so kpathsea never
 * searches its folders on disk, whether it finds the file or not (with an add-on's thousands of folders, a search
 * on disk for each lookup made a compile up to a hundred times slower). Before the first image there is no ls-R:
 * the "!!" alone keeps kpathsea off the empty tree, and an empty ls-R would make it warn "No usable entries in
 * ls-R" in every run.
 */
function writeExtrasLsR(M: EmscriptenModule): void {
  for (const name of DATABASE_FILES) {
    if (exists(M, `${TEXMF_EXTRA}${name}`)) {
      M.FS.unlink(`${TEXMF_EXTRA}${name}`);
    }
  }
  M.FS.writeFile(`${TEXMF_EXTRA}/ls-R`, lsR(extraFiles));
}

/** Everything that does not depend on the job: the images, our texmf.cnf, the program file and the font list. */
function mountStatic(M: EmscriptenModule, setup: WorkerSetup): void {
  M.FS.mkdirTree(FONT_LISTS);
  mount(M, setup.image, setup.index, '', null);
  M.FS.mkdirTree(TEXMF_EXTRA);
  mountExtras(M, setup.extras ?? []);
  writeFontList(M);
  M.FS.mkdirTree(CNF_DIR);
  M.FS.writeFile(`${CNF_DIR}/texmf.cnf`, setup.cnfOverride);
  // The program path is a file, as on a TeX installation; kpathsea reads only its name.
  M.FS.mkdirTree(posix.dirname(PROGRAM));
  M.FS.writeFile(PROGRAM, '');
  M.FS.mkdirTree('/tmp');
}

function mountProject(M: EmscriptenModule, job: CompileJob): void {
  for (const file of job.texmfFiles ?? []) {
    const target = posix.join(TEXMFHOME, posix.normalize(file.path));
    if (!target.startsWith(`${TEXMFHOME}/`)) {
      throw new Error(`refused a package path outside its tree: ${file.path}`);
    }
    M.FS.mkdirTree(posix.dirname(target));
    M.FS.writeFile(target, file.data);
  }
  // Project files first, then the previous compile's auxiliary files (never taken from the real folder).
  for (const file of [...job.files, ...(job.state ?? [])]) {
    const target = posix.join(PROJECT, posix.normalize(file.path));
    if (!target.startsWith(`${PROJECT}/`)) {
      throw new Error(`refused a project path outside the project: ${file.path}`);
    }
    M.FS.mkdirTree(posix.dirname(target));
    M.FS.writeFile(target, file.data);
  }
  M.FS.mkdirTree(posix.join(PROJECT, posix.dirname(job.main)));
  M.FS.chdir(posix.join(PROJECT, posix.dirname(job.main)));
}

/** Auxiliary files that carry over to the next compile of the same document. */
const STATE_FILE = /\.(aux|bbl|toc|lof|lot|loa|out|nav|snm|vrb|idx|ind|bcf|thm)$/i;

function collectState(M: EmscriptenModule): ProjectFile[] {
  const out: ProjectFile[] = [];
  const walk = (dir: string) => {
    for (const name of M.FS.readdir(dir)) {
      if (name === '.' || name === '..') {
        continue;
      }
      const full = `${dir}/${name}`;
      if (M.FS.isDir(M.FS.stat(full).mode)) {
        walk(full);
      } else if (STATE_FILE.test(name)) {
        out.push({ path: full.slice(PROJECT.length + 1), data: M.FS.readFile(full, { encoding: 'binary' }) as Uint8Array });
      }
    }
  };
  walk(PROJECT);
  return out;
}

/** Files in the project folder that the job did not bring (what the steps made), except logs. */
function newProjectFiles(M: EmscriptenModule, job: CompileJob): ProjectFile[] {
  const brought = new Set(job.files.map((f) => posix.normalize(f.path)));
  const out: ProjectFile[] = [];
  const walk = (dir: string) => {
    for (const name of M.FS.readdir(dir)) {
      if (name === '.' || name === '..') {
        continue;
      }
      const full = `${dir}/${name}`;
      const rel = full.slice(PROJECT.length + 1);
      if (M.FS.isDir(M.FS.stat(full).mode)) {
        walk(full);
      } else if (!brought.has(rel) && !/\.(log|fls|aux)$/i.test(name)) {
        out.push({ path: rel, data: M.FS.readFile(full, { encoding: 'binary' }) as Uint8Array });
      }
    }
  };
  walk(PROJECT);
  return out;
}

function readText(M: EmscriptenModule, path: string): string | null {
  return exists(M, path) ? (M.FS.readFile(path, { encoding: 'utf8' }) as string) : null;
}

function readBytes(M: EmscriptenModule, path: string): Uint8Array | null {
  return exists(M, path) ? (M.FS.readFile(path, { encoding: 'binary' }) as Uint8Array) : null;
}

// Everything the tools print, for the result's transcript. A worker runs one job, so one buffer serves.
const out: string[] = [];
let outBytes = 0;
const push = (line: string) => {
  if (outBytes < MAX_TRANSCRIPT) {
    out.push(line);
    outBytes += line.length + 1;
  }
};

interface Prepared {
  M: EmscriptenModule;
  header: Uint8Array;
  workerBootMs: number;
  instantiateMs: number;
  mountMs: number;
  readyAt: number;
}

/**
 * The part of a compile that does not depend on the job: the Emscripten instance and the image's file list.
 * It starts as soon as the worker starts, so a worker the host keeps on standby (core.ts) is ready before the
 * next edit's job arrives, and the job pays only for its own files and the TeX run.
 */
/** What the worker is doing with the engine's file system, for a failure's message (describeError). */
let fsStep = 'starting the engine';

async function prepare(setup: WorkerSetup): Promise<Prepared> {
  const workerBootMs = Date.now() - setup.createdAt;
  const t0 = performance.now();
  const M = await createInstance(setup, push);
  const t1 = performance.now();
  fsStep = 'mounting the core data and writing its file lists (/engine/fonts.list, the add-ons\' ls-R)';
  mountStatic(M, setup);
  speed.install(M);
  // The header is all of memory: everything live must be inside the part each program's restore brings back.
  headerProblem(M.HEAPU8.length);
  const header = M.HEAPU8.slice(0, HEADER_BYTES);
  const t2 = performance.now();
  return { M, header, workerBootMs, instantiateMs: Math.round(t1 - t0), mountMs: Math.round(t2 - t1), readyAt: t2 };
}

/** The job message: the job, and data images. */
export interface WorkerJob {
  job: CompileJob;
  /** Data images the host read after this worker started, which the job needs (mounted before the job). */
  extras?: ExtraImage[];
}

/** Project-relative paths of the job's files that TeX opened (its -recorder list) or that BibTeX read. */
function filesRead(fls: string, aux: string, job: CompileJob): string[] {
  const provided = new Set(job.files.map((f) => posix.normalize(f.path)));
  const mainDir = posix.dirname(job.main);
  const read = new Set<string>();
  let pwd = posix.join(PROJECT, mainDir);
  const add = (abs: string) => {
    const full = posix.normalize(abs);
    if (full.startsWith(`${PROJECT}/`) && provided.has(full.slice(PROJECT.length + 1))) {
      read.add(full.slice(PROJECT.length + 1));
    }
  };
  for (const line of fls.split('\n')) {
    if (line.startsWith('PWD ')) {
      pwd = line.slice(4).trim();
    } else if (line.startsWith('INPUT ')) {
      const name = line.slice(6).trim();
      add(name.startsWith('/') ? name : posix.join(pwd, name));
    }
  }
  for (const m of aux.matchAll(/\\bibdata\{([^}]*)\}/g)) {
    for (const name of m[1].split(',')) {
      const bib = name.trim().replace(/\.bib$/i, '');
      if (bib) {
        add(posix.join(PROJECT, mainDir, `${bib}.bib`));
      }
    }
  }
  return [...read].sort();
}

async function compile(setup: WorkerSetup, message: WorkerJob): Promise<CompileResult> {
  const arrived = performance.now();
  const job = message.job;
  const jobCpu0 = speed.threadCpuMs();
  if (speed.PROBE) {
    const file = job.files.find((f) => f.path === '.speed.json');
    speed.applyJobSwitches(file ? new TextDecoder().decode(file.data) : null);
  }
  const prepared = await preparing;
  const { M, header } = prepared;
  const warm = prepared.readyAt <= arrived;
  const t1 = performance.now();
  fsStep = 'mounting the add-on images the job needs';
  mountExtras(M, message.extras ?? []);
  fsStep = `writing the project's files into ${PROJECT}`;
  mountProject(M, job);
  fsStep = 'running the job';
  const t2 = performance.now();

  // TeX gets the main file's own name ("Paper.TEX" stays as it is; the in-memory file system is case-sensitive),
  // and its outputs are named after that name without the extension (build gate 1, G1E-13).
  const mainName = posix.basename(job.main);
  const base = mainName.replace(/\.tex$/i, '');
  const steps: StepRecord[] = [];
  // One tool: callMain, then the memory is cleared and its first 64 MiB restored (BusyTeX's one-instance pattern,
  // after its busytex_pipeline.js, MIT).
  const restoreHeap = (): number => {
    const r0 = performance.now();
    if (speed.restoreUpper()) {
      M.HEAPU8.set(header);
      M.HEAPU8.fill(0, HEADER_BYTES);
    } else {
      M.HEAPU8.fill(0);
      M.HEAPU8.set(header);
    }
    return performance.now() - r0;
  };
  const step = (argv: string[]): number => {
    // A program always starts on restored memory: with the probe's lazy restore, the previous program's restore
    // runs here. The flag lives at worker scope, so it would hold across jobs too.
    const lazyMs = heapDirty ? restoreHeap() : 0;
    heapDirty = false;
    push(`$ ${argv.join(' ')}`);
    if (exists(M, TEXMFLOG)) {
      M.FS.unlink(TEXMFLOG);
    }
    const before = speed.snapshot();
    const cpu0 = speed.threadCpuMs();
    const started = performance.now();
    let exitCode: number;
    try {
      exitCode = M.callMain([...argv]);
    } catch (err) {
      push(`(the step stopped with ${String(err)})`);
      exitCode = -1;
    }
    const ran = performance.now();
    const cpu1 = speed.threadCpuMs();
    M._flush_streams();
    const texmflog = readText(M, TEXMFLOG);
    if (texmflog) {
      push(`[TEXMFLOG] ${texmflog}`);
    }
    const record: StepRecord = { argv, exitCode, ms: Math.round(performance.now() - started), heapBytes: M.HEAPU8.length };
    // Speed probe: with the lazy restore the restore runs before the next program instead, so the last program
    // of a job (whose worker then exits) skips it.
    let restoreMs = lazyMs;
    if (speed.restoreLazy()) {
      heapDirty = true;
    } else {
      restoreMs += restoreHeap();
    }
    if (speed.PROBE) {
      record.probe = { ...speed.delta(before), callMainMs: Math.round((ran - started) * 10) / 10, callMainCpuMs: Math.round((cpu1 - cpu0) * 10) / 10, restoreMs: Math.round(restoreMs * 10) / 10 };
    }
    steps.push(record);
    return exitCode;
  };

  const synctex = `-synctex=${job.synctex ? speed.synctexValue() : 0}`;
  const shell = job.forceShellEscape ? '-shell-escape' : '-no-shell-escape';
  // -file-line-error: errors read "./file.tex:12: message", which the extension's log parser maps to a file
  // and line (docs/DESIGN.md#live-behaviour).
  // -recorder: TeX lists every file it opens in name.fls; the extension watches those files (docs/DESIGN.md#architecture).
  const texArgv = (): string[] => {
    switch (job.engine) {
      case 'pdflatex':
        return ['pdflatex', shell, '-interaction=nonstopmode', '-file-line-error', '-recorder', synctex, `-jobname=${base}`, '-fmt', FORMATS.pdflatex, mainName];
      case 'xelatex':
        return ['xelatex', shell, '-interaction=nonstopmode', '-file-line-error', '-recorder', synctex, '-no-pdf', `-jobname=${base}`, '-fmt', FORMATS.xelatex, mainName];
    }
  };

  // The citation lines of an .aux file: if they and the .bib files are unchanged, the old .bbl still holds.
  const citations = (aux: string | null) =>
    (aux ?? '')
      .split('\n')
      .filter((l) => /^\\(citation|bibdata|bibstyle)\{/.test(l))
      .sort()
      .join('\n');
  const stateText = (name: string) => {
    const f = job.state?.find((s) => posix.basename(s.path) === name);
    return f ? new TextDecoder().decode(f.data) : null;
  };
  const previousAux = stateText(`${base}.aux`);
  const hadBbl = stateText(`${base}.bbl`) !== null;

  let passes = 0;
  if (job.steps) {
    for (const argv of job.steps) {
      step(argv);
    }
    passes = job.maxPasses;
  } else {
    step(texArgv());
  }
  passes++;
  let bibtexRan = false;
  const aux = readText(M, `${base}.aux`) ?? '';
  const bibliographyMayHaveChanged = !hadBbl || job.bibChanged === true || citations(aux) !== citations(previousAux);
  if (!job.steps && job.bibtex === 'auto' && aux.includes('\\bibdata') && bibliographyMayHaveChanged) {
    step(['bibtex8', '--8bit', `${base}.aux`]);
    bibtexRan = true;
  }
  while (passes < job.maxPasses) {
    const log = readText(M, `${base}.log`) ?? '';
    const wanted = (bibtexRan && passes < 3) || RERUN.test(log);
    if (!wanted) {
      break;
    }
    step(texArgv());
    passes++;
  }
  if (!job.steps && job.engine === 'xelatex') {
    step(['xdvipdfmx', '-o', `${base}.pdf`, `${base}.xdv`]);
  }
  const t3 = performance.now();

  const written = readBytes(M, `${base}.pdf`);
  // A PDF cut short (xdvipdfmx failed, or TeX stopped in the middle of a page) is no PDF: the compile fails, the
  // viewer keeps the last good PDF, and nothing is written next to the source (build gate 1).
  const problem = written ? pdfProblem(written) : null;
  // A packed font that failed its check (packedStreamOps): no PDF, and a plain message instead.
  const pdf = problem || damaged.size > 0 ? null : written;
  const failedStep = steps.filter((s) => s.exitCode !== 0 && !(s.argv[0] === 'bibtex8' && s.exitCode === 1)).pop();
  const cutShort =
    damaged.size > 0
      ? damagedReport()
      : problem
        ? `The PDF came back cut short (${problem})${failedStep ? `; ${failedStep.argv[0]} stopped with exit code ${failedStep.exitCode}` : ''}. The preview keeps the last good PDF.`
        : undefined;
  const log = readText(M, `${base}.log`) ?? '';
  const finalAux = readText(M, `${base}.aux`) ?? '';
  return {
    id: job.id,
    ok: pdf !== null,
    error: cutShort,
    pdf,
    synctex: readBytes(M, `${base}.synctex.gz`) ?? readBytes(M, `${base}.synctex`),
    log,
    blg: readText(M, `${base}.blg`),
    state: collectState(M),
    passes,
    bibtexRan,
    readFiles: job.steps ? [] : filesRead(readText(M, `${base}.fls`) ?? '', finalAux, job),
    ...(damaged.size > 0 ? { damaged: [...damaged.keys()] } : {}),
    rerunRequested: !job.steps && RERUN.test(log),
    bibtexNeeded: !job.steps && !bibtexRan && aux.includes('\\bibdata') && bibliographyMayHaveChanged,
    readBack: Object.fromEntries((job.readBack ?? []).map((p) => [p, readText(M, p)]).filter((e): e is [string, string] => e[1] !== null)),
    newFiles: job.returnNewFiles ? newProjectFiles(M, job) : undefined,
    transcript: out.join('\n'),
    steps,
    timings: {
      workerBootMs: prepared.workerBootMs,
      instantiateMs: prepared.instantiateMs,
      mountMs: prepared.mountMs + Math.round(t2 - t1),
      runMs: Math.round(t3 - t2),
      totalMs: 0,
      warm,
    },
    stubs: stubReport(),
    ...(speed.PROBE
      ? {
          probe: {
            waitForPrepareMs: Math.round(Math.max(0, prepared.readyAt - arrived)),
            mountProjectMs: Math.round((t2 - t1) * 10) / 10,
            resultMs: Math.round((performance.now() - t3) * 10) / 10,
            mountStaticMs: prepared.mountMs,
            jobCpuMs: Math.round((speed.threadCpuMs() - jobCpu0) * 10) / 10,
            ...speed.fileEntries(),
          },
        }
      : {}),
  };
}

/** A thrown value as text: an Error with its stack, or the engine file system's errno, which is not an Error. */
/** Emscripten's numbers for the file system errors a mount or a write meets (its errno table). */
const ERRNO_NAMES: Record<number, string> = { 2: 'permission denied', 20: 'the file exists', 28: 'invalid argument', 31: 'a folder is in the way', 44: 'no such file or folder', 51: 'no space left', 54: 'a path part is not a folder', 55: 'the folder is not empty' };

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.message}\n${err.stack}`;
  }
  if (typeof err === 'object' && err !== null && 'errno' in err) {
    const errno = Number((err as { errno: unknown }).errno);
    return `The engine's file system failed while ${fsStep}: ${ERRNO_NAMES[errno] ?? 'an error'} (errno ${errno}). Reinstall the extension if this repeats.`;
  }
  return String(err);
}

const setup = workerData as WorkerSetup;
const preparing = prepare(setup);
// A failed preparation is reported by the job that waits for it.
preparing.catch(() => undefined);
parentPort?.once('message', (message: WorkerJob) => {
  const job = message.job;
  compile(setup, message).then(
    (result) => {
      const transfer = [result.pdf?.buffer, result.synctex?.buffer].filter((b): b is ArrayBuffer => b instanceof ArrayBuffer);
      parentPort?.postMessage(result, transfer);
    },
    (err: unknown) => {
      parentPort?.postMessage(failedResult(job.id, describeError(err), stubReport()));
    },
  );
});
