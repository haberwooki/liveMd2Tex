// Compile jobs and results exchanged with the engine host (docs/DESIGN.md#architecture, #engine-and-data). Plain data only, so the
// same types serve the IPC channel and the worker_threads channel.

import type { StubReport } from './engineProtocol';

/** pdflatex and xelatex use the formats in the bundle; luahbtex-ini runs LuaHBTeX with no format (fixtures). */
export type EngineName = 'pdflatex' | 'xelatex' | 'luahbtex-ini';

export interface ProjectFile {
  /** Path relative to the project root, with "/" separators. */
  path: string;
  data: Uint8Array;
}

export interface CompileJob {
  id: number;
  /** The main .tex file, relative to the project root. */
  main: string;
  /** The project's files; with `project`, only the files that changed since the base version. */
  files: ProjectFile[];
  /**
   * A change set (docs/DESIGN.md#engine-and-data, #live-behaviour: only changed files cross the process boundary). The engine host
   * keeps each project's files; `base` is the version this change set applies to (null: `files` is the whole
   * project), `version` the one it makes, and `removed` the paths that are gone. A host that does not hold
   * `base` answers with error 'need-full'.
   */
  project?: { key: string; base: number | null; version: number; removed: string[] };
  engine: EngineName;
  /**
   * 'auto' runs bibtex8 when the first pass wrote \bibdata to the .aux file and the bibliography may have
   * changed: no .bbl from an earlier compile, different citations than last time, or bibChanged.
   */
  bibtex: 'auto' | 'never';
  /** A .bib file changed since the state's compile (the extension compares their contents). */
  bibChanged?: boolean;
  /**
   * Auxiliary files from the previous compile of the same document (.aux, .bbl, .toc ...), written after the
   * project files, so a save usually needs a single pass (docs/DESIGN.md#engine-and-data, persistent aux state).
   */
  state?: ProjectFile[];
  /**
   * The user's own package files (the user's package folder; docs/DESIGN.md#engine-and-data), with texmf-relative paths
   * ("tex/latex/tensor/tensor.sty"). The worker writes them into a texmf tree of their own (TEXMFHOME), which TeX
   * searches first, before the data images and the bundle, without an ls-R file. They cross as change sets with
   * the project files.
   */
  texmfFiles?: ProjectFile[];
  /**
   * Data extension images to mount (the Extra Packages add-on; build gate 2, G2E-02): each one's `.data` file and
   * index on this computer, by the data set's id. The engine host reads each image once and mounts it whole in
   * every worker under /texmf-extra, searched after TEXMFHOME and before the bundle, so files a package loads
   * indirectly (.fd, .def, .cfg, .ldf) are found too.
   */
  dataImages?: DataImageRef[];
  /**
   * The keys (imageKey) of every data image installed now, needed by this job or not. The engine host forgets
   * any image it has read that is not in this list: an add-on that was removed or updated (build gate 2, G2E-R1).
   */
  knownImages?: string[];
  /** TeX passes in all; 1 is the quick pass of docs/DESIGN.md#live-behaviour. */
  maxPasses: number;
  synctex: boolean;
  /** Fixtures only: LuaHBTeX with --socket instead of --nosocket, to test the glue's socket patch on its own. */
  allowLuaSocketLibrary?: boolean;
  /** Fixtures only: -shell-escape instead of -no-shell-escape, to test the glue's no-shell patch on its own. */
  forceShellEscape?: boolean;
  /**
   * Explicit tool runs instead of the recipe (each an argv without the program name), for builds such as
   * docstrip's .ins files (docs/DESIGN.md#engine-and-data) and for diagnostics. Never a shell: each is one callMain.
   */
  steps?: string[][];
  /** Extra files to return as text after the run (paths relative to the main file's folder, or absolute in MEMFS). */
  readBack?: string[];
  /**
   * Return every file the steps made in the project folder (except logs), as bytes: what a docstrip run of an
   * .ins file generates ("Add a package from a file", docs/DESIGN.md#engine-and-data).
   */
  returnNewFiles?: boolean;
}

/**
 * In a change set (CompileJob.project), the user's package files travel with the project files under this
 * prefix, which no file name can hold; the engine host splits them out again (build gate 2, G2E-02).
 */
export const TEXMF_PREFIX = '\u0000texmf/';

/**
 * The one way a data image may store some of its files packed (its manifest's and index's "packed"): t1c, the Type 1
 * fonts decrypted (B1; src/engine-host/engine/t1c.ts). A data set packed any other way is refused.
 */
export const PACKING_T1C = 't1c';

/** A data extension's image on this computer (see CompileJob.dataImages). */
export interface DataImageRef {
  id: string;
  /** The data set's version and its image's SHA-256 (from its manifest): with the id, the image's identity. */
  version: string;
  sha256: string;
  /** The image's `.data` file. */
  data: string;
  /** Its index: the JSON with the file list and chunk table ({ compressed, metadata }). */
  index: string;
}

/** An image's identity: an update of an add-on (a new version or new content) is a new image (G2E-R1). */
export function imageKey(ref: Pick<DataImageRef, 'id' | 'version' | 'sha256'>): string {
  return `${ref.id}@${ref.version}#${ref.sha256}`;
}

/** The prebuilt formats inside the engine's file system, for explicit steps such as a docstrip run. */
export const ENGINE_FORMATS = {
  pdflatex: '/texlive/texmf-dist/texmf-var/web2c/pdftex/pdflatex.fmt',
  xelatex: '/texlive/texmf-dist/texmf-var/web2c/xetex/xelatex.fmt',
} as const;

export interface StepRecord {
  argv: string[];
  exitCode: number;
  ms: number;
  /** Size of the WebAssembly memory after the step. */
  heapBytes: number;
}

export interface CompileTimings {
  /** From the host's new Worker() to the worker's first line of code. */
  workerBootMs: number;
  /** Emscripten runtime and WebAssembly instance from the compiled module. */
  instantiateMs: number;
  /** Mounting the image's file list (LZ4, nothing decompressed yet) and writing the project files. */
  mountMs: number;
  /** The tool runs. */
  runMs: number;
  /** Host side, from the job's arrival to the result. */
  totalMs: number;
  /**
   * True when the job went to a standby worker that had already instantiated and mounted (the boot, instantiate
   * and mount times were then spent before the job arrived and are not in totalMs).
   */
  warm?: boolean;
}

export interface CompileResult {
  id: number;
  ok: boolean;
  error?: string;
  pdf: Uint8Array | null;
  synctex: Uint8Array | null;
  /** The .log of the last TeX pass. */
  log: string;
  blg: string | null;
  /** Auxiliary files to give the next compile of this document (see CompileJob.state). */
  state: ProjectFile[];
  /** TeX passes run, and whether bibtex8 ran. */
  passes: number;
  bibtexRan: boolean;
  /** The job's files that TeX opened (its -recorder list) or BibTeX read: what the extension watches. */
  readFiles?: string[];
  /** The last pass's log asks for another pass (labels, citations or outlines changed). */
  rerunRequested?: boolean;
  /** bibtex8 did not run (bibtex 'never', the quick pass) but the bibliography may have changed. */
  bibtexNeeded?: boolean;
  /** The files named in the job's readBack that exist, as text. */
  readBack?: Record<string, string>;
  /** With returnNewFiles: the files the steps made, project-relative. */
  newFiles?: ProjectFile[];
  /**
   * The TeX data is damaged (B1, t1c): a packed font did not pass its check, or an image's packed list does not
   * match its manifest. The files concerned (image paths); `error` holds the plain message, and there is no PDF.
   */
  damaged?: string[];
  /** Everything the tools printed, step by step, and kpathsea's TEXMFLOG. */
  transcript: string;
  steps: StepRecord[];
  timings: CompileTimings;
  /** The worker thread's own stub record (null when no stub is loaded, as in production). */
  stubs: StubReport | null;
  /** Engine-internal: a fontconfig cache made by this compile; the engine host keeps it and removes it here. */
  fontCache?: { name: string; data: Uint8Array }[];
}

/** A compile that produced nothing: `error` says why (the engine host and its worker both answer with it). */
export function failedResult(id: number, error: string, stubs: StubReport | null = null): CompileResult {
  return {
    id,
    ok: false,
    error,
    pdf: null,
    synctex: null,
    log: '',
    blg: null,
    transcript: '',
    steps: [],
    state: [],
    passes: 0,
    bibtexRan: false,
    timings: { workerBootMs: 0, instantiateMs: 0, mountMs: 0, runMs: 0, totalMs: 0 },
    stubs,
  };
}

export interface EngineAssetPaths {
  /** The patched glue (busytex.patched.js). */
  glue: string;
  wasm: string;
  /** The file_packager image (.data) and its loader (.js), whose metadata is read as data, never run. */
  data: string;
  loader: string;
  /** Our texmf.cnf override (engine/texmf-override.cnf). */
  cnfOverride: string;
  /** Our fontconfig file (engine/fonts.conf). */
  fontsConf: string;
}

export interface EngineInitInfo {
  compileMs: number;
  readImageMs: number;
  metadataMs: number;
  imageBytes: number;
  files: number;
}

export interface EngineMemory {
  rss: number;
  /** Peak resident set size of the engine-host process so far (bytes). */
  maxRss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}
