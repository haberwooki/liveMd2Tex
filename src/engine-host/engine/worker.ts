// One compile, in a worker_thread of the engine host (docs/DESIGN.md#architecture). The host passes the compiled
// WebAssembly module and the image bytes (a SharedArrayBuffer, not copied); this worker makes its own
// Emscripten instance, mounts the image's file list (LZ4, decompressed only when read), writes the project into
// MEMFS, and runs the tools one after another with BusyTeX's one-instance pattern: one callMain per tool, then
// the WebAssembly memory is cleared and its first 64 MiB restored. Cancel is the host's worker.terminate().
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
import { damagedMessage, type ImageIndex } from './packageMeta';

interface FsNode {
  mode: number;
  stream_ops?: unknown;
  contents: Record<string, FsNode>;
  node_ops: { mknod(parent: FsNode, name: string, mode: number, dev: number): FsNode };
  atime: number;
  mtime: number;
  ctime: number;
}

/** A file of fontconfig's cache, made by the first XeTeX run and reused by later compiles. */
export interface CacheFile {
  name: string;
  data: Uint8Array;
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
  fontsConf: string;
  fontCache: CacheFile[];
  createdAt: number;
}

/**
 * Every mounted folder and file gets this time stamp, so a fontconfig cache made in one worker stays valid
 * in the next (fontconfig compares each folder's mtime with the one recorded in its cache).
 */
const IMAGE_TIME = Date.UTC(2026, 0, 1);

const FORMATS = ENGINE_FORMATS;
const PROJECT = '/project';
const CNF_DIR = '/engine/cnf';
const FONTS_CONF = '/engine/fonts.conf';
const FC_CACHE = '/engine/fc-cache';
const TEXMFLOG = '/tmp/texmf.log';
/** The user's own package files (CompileJob.texmfFiles). */
const TEXMFHOME = '/texmf-home';
/** Where data extension images are mounted (G2E-02): a texmf tree searched after TEXMFHOME, before the bundle. */
const TEXMF_EXTRA = '/texmf-extra';
const HEADER_BYTES = 2 ** 26;
// Requests for another pass in the log. Not the word "rerunfilecheck" alone: hyperref loads that package, so its
// name is in every such log; its warning itself says "Rerun to get outlines right".
const RERUN = /Rerun to get|Rerun LaTeX|Please rerun LaTeX|Label\(s\) may have changed/;
const MAX_TRANSCRIPT = 4 * 1024 * 1024;

function stubReport(): StubReport | null {
  const state = (globalThis as Record<symbol, unknown>)[Symbol.for(STUB_STATE_KEY)] as { report(): StubReport } | undefined;
  return state ? state.report() : null;
}

async function createInstance(setup: WorkerSetup, print: (line: string) => void): Promise<EmscriptenModule> {
  const factory = loadGlue(setup.gluePath);
  const env: Record<string, string> = {
    // Our texmf.cnf first: its values (no shell escape, no mktex*) win over TeX Live's.
    TEXMFCNF: `${CNF_DIR}:/texlive/texmf-dist/web2c`,
    TEXMFDIST: '/texlive/texmf-dist',
    TEXMFVAR: '/texlive/texmf-dist/texmf-var',
    TEXMFCACHE: '/texlive/texmf-dist/texmf-var',
    // The user's package folder first, then the data extensions' images (kpathsea expands the braces).
    TEXMFHOME: `{${TEXMFHOME},${TEXMF_EXTRA}}`,
    TEXMFLOG,
    // Our fonts.conf (engine/fonts.conf), not the image's, which also lists the Type 1 folder.
    FONTCONFIG_PATH: '/engine',
    FONTCONFIG_FILE: FONTS_CONF,
    ICU_DATA: '/texlive/',
    TEXLIVE_REMOTE_ENDPOINT: '',
    MKTEXPK: '0',
    MKTEXTFM: '0',
    MKTEXMF: '0',
    MKTEXFMT: '0',
    MKTEXTEX: '0',
    shell_escape: 'f',
    HOME: '/home/web_user',
  };
  return factory({
    thisProgram: '/bin/busytex',
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
 * or null for the core image: a packed file that fails its check names it (damagedMessage).
 */
function mountImage(M: EmscriptenModule, image: SharedArrayBuffer, index: ImageIndex, root = '', owner: string | null = null): void {
  const L = M.LZ4;
  L.init();
  const data = new Uint8Array(image);
  const size = L.CHUNK_SIZE;
  const compressedData = {
    data,
    cachedOffset: index.cachedOffset,
    cachedIndexes: new Array<number>(index.cacheSlots).fill(-1),
    // This worker's own decompression buffers, never views on the shared image (build gate 1, G1E-01).
    cachedChunks: Array.from({ length: index.cacheSlots }, () => new Uint8Array(size)),
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
  for (let i = 0; i < names.length; i++) {
    const name = `${root}${names[i]}`;
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

/** Everything that does not depend on the job: the image, our texmf.cnf and fonts.conf, fontconfig's cache. */
/** The data images mounted in this worker, by id. */
const mountedExtras = new Set<string>();

function mountExtras(M: EmscriptenModule, extras: ExtraImage[]): void {
  let added = false;
  for (const extra of extras) {
    if (!mountedExtras.has(extra.key)) {
      mountImage(M, extra.image, extra.index, TEXMF_EXTRA, extra.id);
      mountedExtras.add(extra.key);
      added = true;
    }
  }
  if (added) {
    stampFolders(M, TEXMF_EXTRA, extrasTime([...mountedExtras]));
  }
}

/**
 * The time stamp of the data images' folders: one per set of mounted images. fontconfig keeps its cache per
 * folder and rescans a folder whose time stamp changed, so the add-on's fonts are found by name once it is
 * mounted, and found again after it is updated; the same images give the same stamp, so a kept cache stays valid.
 */
export function extrasTime(keys: string[]): number {
  let h = 0;
  for (const c of [...keys].sort().join('\n')) {
    h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  }
  return IMAGE_TIME + 1000 * (1 + (Math.abs(h) % 1_000_000));
}

/** Gives a folder and every folder below it the time stamp `time`. */
function stampFolders(M: EmscriptenModule, top: string, time: number): void {
  const walk = (node: FsNode) => {
    node.atime = node.mtime = node.ctime = time;
    for (const child of Object.values(node.contents ?? {})) {
      // Folders only: an image file's node keeps its chunk table in contents.
      if ((child.mode & 0o170000) === 0o040000) {
        walk(child);
      }
    }
  };
  walk(M.FS.lookupPath(top).node as FsNode);
}

function mountStatic(M: EmscriptenModule, setup: WorkerSetup): void {
  mountImage(M, setup.image, setup.index);
  M.FS.mkdirTree(TEXMF_EXTRA);
  mountExtras(M, setup.extras ?? []);
  M.FS.mkdirTree(CNF_DIR);
  M.FS.writeFile(`${CNF_DIR}/texmf.cnf`, setup.cnfOverride);
  M.FS.writeFile(FONTS_CONF, setup.fontsConf);
  M.FS.mkdirTree(FC_CACHE);
  writeFontCache(M, setup.fontCache);
  M.FS.mkdirTree('/tmp');
}

function writeFontCache(M: EmscriptenModule, files: CacheFile[]): void {
  for (const file of files) {
    M.FS.writeFile(`${FC_CACHE}/${file.name}`, file.data);
  }
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
  return M.FS.analyzePath(path).exists ? (M.FS.readFile(path, { encoding: 'utf8' }) as string) : null;
}

function readBytes(M: EmscriptenModule, path: string): Uint8Array | null {
  return M.FS.analyzePath(path).exists ? (M.FS.readFile(path, { encoding: 'binary' }) as Uint8Array) : null;
}

/** Whether two byte arrays hold the same bytes (an absent one is never the same). */
function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  return a !== undefined && a.length === b.length && a.every((v, i) => v === b[i]);
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
async function prepare(setup: WorkerSetup): Promise<Prepared> {
  const workerBootMs = Date.now() - setup.createdAt;
  const t0 = performance.now();
  const M = await createInstance(setup, push);
  const t1 = performance.now();
  mountStatic(M, setup);
  const header = M.HEAPU8.slice(0, HEADER_BYTES);
  const t2 = performance.now();
  return { M, header, workerBootMs, instantiateMs: Math.round(t1 - t0), mountMs: Math.round(t2 - t1), readyAt: t2 };
}

/** The job message: the job, fontconfig's cache when the host got it after this worker started, and data images. */
export interface WorkerJob {
  job: CompileJob;
  fontCache?: CacheFile[];
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
  const prepared = await preparing;
  const { M, header } = prepared;
  const warm = prepared.readyAt <= arrived;
  // A newer cache than the one this worker started with (another run added folders to it).
  if (message.fontCache) {
    writeFontCache(M, message.fontCache);
  }
  const givenCache = new Map([...setup.fontCache, ...(message.fontCache ?? [])].map((f) => [f.name, f.data]));
  const t1 = performance.now();
  mountExtras(M, message.extras ?? []);
  mountProject(M, job);
  const t2 = performance.now();

  // TeX gets the main file's own name ("Paper.TEX" stays as it is; the in-memory file system is case-sensitive),
  // and its outputs are named after that name without the extension (build gate 1, G1E-13).
  const mainName = posix.basename(job.main);
  const base = mainName.replace(/\.tex$/i, '');
  const steps: StepRecord[] = [];
  const step = (argv: string[]): number => {
    push(`$ ${argv.join(' ')}`);
    if (M.FS.analyzePath(TEXMFLOG).exists) {
      M.FS.unlink(TEXMFLOG);
    }
    const started = performance.now();
    let exitCode: number;
    try {
      exitCode = M.callMain([...argv]);
    } catch (err) {
      push(`(the step stopped with ${String(err)})`);
      exitCode = -1;
    }
    M._flush_streams?.();
    const texmflog = readText(M, TEXMFLOG);
    if (texmflog) {
      push(`[TEXMFLOG] ${texmflog}`);
    }
    steps.push({ argv, exitCode, ms: Math.round(performance.now() - started), heapBytes: M.HEAPU8.length });
    M.HEAPU8.fill(0);
    M.HEAPU8.set(header);
    return exitCode;
  };

  const synctex = `-synctex=${job.synctex ? 1 : 0}`;
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
      case 'luahbtex-ini':
        // docs/DESIGN.md#rules: any LuaTeX call passes --nosocket (a fixture may leave it out on purpose).
        return ['luahbtex', '-ini', shell, job.allowLuaSocketLibrary ? '--socket' : '--nosocket', '-interaction=nonstopmode', mainName];
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
  if (!job.steps && job.bibtex === 'auto' && job.engine !== 'luahbtex-ini' && aux.includes('\\bibdata') && bibliographyMayHaveChanged) {
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
  // The fontconfig cache files this run made or changed (fontconfig keeps one per folder: the first XeTeX run
  // writes them all, a run with a newly mounted add-on writes its folders' ones) go back to the host.
  const fontCache: CacheFile[] = M.FS.readdir(FC_CACHE)
    .filter((n) => n !== '.' && n !== '..')
    .map((name) => ({ name, data: readBytes(M, `${FC_CACHE}/${name}`) ?? new Uint8Array() }))
    .filter((f) => !sameBytes(givenCache.get(f.name), f.data));
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
    bibtexNeeded: !job.steps && !bibtexRan && job.engine !== 'luahbtex-ini' && aux.includes('\\bibdata') && bibliographyMayHaveChanged,
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
    fontCache: fontCache.length > 0 ? fontCache : undefined,
  };
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
      parentPort?.postMessage(failedResult(job.id, err instanceof Error ? `${err.message}\n${err.stack}` : String(err), stubReport()));
    },
  );
});
