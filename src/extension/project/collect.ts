// The in-memory project for a compile (docs/DESIGN.md#live-behaviour): every input file in the root document's folder
// tree, with unsaved editor text written over the saved copies, and no build leftovers. File access goes
// through ProjectFs (workspace.fs in VS Code, Node's fs in tests), with paths relative to the project folder.
// The adapters refuse a path that leaves the folder, also through a link (a symbolic link or a Windows
// junction; build gate 1, G1S-02), and FileCache keeps what was read until a file watcher says it changed, so a
// compile reads only changed files (G1E-03). The cache never answers for a file open in an editor (the save that
// just wrote it may be newer than the watcher's news; re-gate G1BE-01), and on a full pass it checks each kept
// file's size and time, because watchers miss changes on some drives (G1BE-02).

import type { ProjectFile } from '../../shared/engineJobs';
import { insideProject } from './confine';

export interface ProjectFs {
  /** Entries of a folder given relative to the project folder ('' for the folder itself). Links are 'other'. */
  readDirectory(rel: string): Promise<[string, 'file' | 'dir' | 'other'][]>;
  /** A file's bytes; throws LinkRefusedError when the path reaches outside the folder through a link. */
  readFile(rel: string): Promise<Uint8Array>;
  /** A file's size and modification time, when the file system can tell them cheaply (for FileCache). */
  stat?(rel: string): Promise<FileStamp>;
}

export interface FileStamp {
  size: number;
  mtime: number;
}

export interface CacheOptions {
  /**
   * Files open in an editor: read from the file system every time, never from the cache, and a kept folder
   * listing that lacks one of them is read again (a new file whose watcher event has not come yet).
   */
  open?: ReadonlySet<string>;
  /** Check each kept file's size and time, and each folder listing, against the file system (full passes). */
  verify?: boolean;
}

/** A path inside the project folder that leads outside it through a link (symbolic link or junction). */
export class LinkRefusedError extends Error {
  constructor(readonly rel: string) {
    super(`${rel} is reached through a link that leads outside the project folder`);
    this.name = 'LinkRefusedError';
  }
}

/**
 * What the compiles of one project folder have read, kept until a file watcher reports a change (invalidate) or
 * the user asks for a fresh read (clear). wrap() puts it in front of a ProjectFs.
 */
export class FileCache {
  private readonly files = new Map<string, { data: Uint8Array; stamp?: FileStamp }>();
  private readonly dirs = new Map<string, [string, 'file' | 'dir' | 'other'][]>();
  /** Reads that went to the file system (for the tests and the log). */
  reads = 0;

  /** A file or folder changed, appeared or went away. */
  invalidate(rel: string): void {
    const under = (k: string) => k === rel || k.startsWith(`${rel}/`);
    for (const k of [...this.files.keys()].filter(under)) {
      this.files.delete(k);
    }
    for (const k of [...this.dirs.keys()].filter((d) => under(d) || d === folderOf(rel))) {
      this.dirs.delete(k);
    }
  }

  clear(): void {
    this.files.clear();
    this.dirs.clear();
  }

  wrap(fs: ProjectFs, options: CacheOptions = {}): ProjectFs {
    const verify = options.verify === true && fs.stat !== undefined;
    return {
      readDirectory: async (rel) => {
        let entries = verify ? undefined : this.dirs.get(rel);
        const names = new Set(entries?.map(([name]) => name));
        const missing = [...(options.open ?? [])].some((p) => folderOf(p) === rel && !names.has(p.slice(rel ? rel.length + 1 : 0)));
        if (!entries || missing) {
          entries = await fs.readDirectory(rel);
          this.dirs.set(rel, entries);
        }
        return entries;
      },
      readFile: async (rel) => {
        const kept = options.open?.has(rel) ? undefined : this.files.get(rel);
        if (kept && !verify) {
          return kept.data;
        }
        // The stamp is taken before the read, so a change during the read shows at the next check.
        const stamp = await fs.stat?.(rel).catch(() => undefined);
        if (kept && stamp && kept.stamp && stamp.size === kept.stamp.size && stamp.mtime === kept.stamp.mtime) {
          return kept.data;
        }
        this.reads++;
        const data = await fs.readFile(rel);
        this.files.set(rel, { data, stamp });
        return data;
      },
      stat: fs.stat ? (rel) => (fs.stat as (r: string) => Promise<FileStamp>)(rel) : undefined,
    };
  }
}

/** What TeX, BibTeX and graphics read; everything else in the folder is left out. */
const INPUT = new Set([
  // TeX and LaTeX: classes, packages, class options (REVTeX's .rtx, KOMA's .lco), language and font files.
  'tex', 'ltx', 'sty', 'cls', 'clo', 'cfg', 'def', 'fd', 'dtx', 'ins', 'rtx', 'lco', 'ldf', 'dict', 'tcx',
  // Bibliographies.
  'bib', 'bst', 'bbx', 'cbx', 'lbx', 'dbx',
  // Figures and the files TikZ, PGF and PSTricks read.
  'pdf', 'png', 'jpg', 'jpeg', 'jbig2', 'jb2', 'eps', 'ps', 'svg', 'tikz', 'pgf', 'pdf_tex', 'eps_tex', 'xbb', 'bb',
  // Fonts.
  'otf', 'ttf', 'ttc', 'pfb', 'pfa', 'pfm', 'afm', 'tfm', 'vf', 'ofm', 'ovf', 'enc', 'map',
  // Data that documents read with \input or with packages such as pgfplots and csvsimple.
  'txt', 'dat', 'csv', 'tsv', 'table', 'gnuplot', 'mp', 'lua', 'ist', 'xmpdata',
]);

/** Build leftovers are never read from the real folder (docs/DESIGN.md#live-behaviour); the engine keeps its own. */
const LEFTOVER = /\.(aux|bbl|blg|log|synctex(\.gz)?|fls|fdb_latexmk|toc|out|xdv|lof|lot|loa|nav|snm|vrb|idx|ind|ilg|bcf|run\.xml)$/i;

export interface CollectLimits {
  maxFiles: number;
  maxBytes: number;
  maxDepth: number;
}

export const DEFAULT_LIMITS: CollectLimits = { maxFiles: 3000, maxBytes: 300 * 1024 * 1024, maxDepth: 6 };

export interface CollectedProject {
  files: ProjectFile[];
  /** Paths that were named but refused because a link leads outside the project folder. */
  refused?: string[];
  bytes: number;
  /** True when a limit stopped the walk; the compile still runs with what was read. */
  truncated: boolean;
}

/** The folder part of a project path ('' for the project folder itself). */
export function folderOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

const within = (rel: string, scope: string) => scope === '' || rel === scope || rel.startsWith(`${scope}/`);

/**
 * Reads the project. `mainRel` is the root document's path relative to the project folder; its own PDF is
 * left out (the PDF written next to the source on save). `overrides` holds unsaved editor text by path. Only the
 * main file's folder and its subfolders are walked; files elsewhere in the project folder come in through
 * collectReferenced when a document names them.
 */
export async function collectProject(
  fs: ProjectFs,
  mainRel: string,
  overrides: Map<string, Uint8Array> = new Map(),
  limits: CollectLimits = DEFAULT_LIMITS,
): Promise<CollectedProject> {
  const scope = folderOf(mainRel);
  const mainPdf = mainRel.replace(/\.tex$/i, '.pdf');
  const files: ProjectFile[] = [];
  let bytes = 0;
  let truncated = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: [string, 'file' | 'dir' | 'other'][];
    try {
      entries = await fs.readDirectory(dir);
    } catch {
      return;
    }
    for (const [name, kind] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
      const rel = dir ? `${dir}/${name}` : name;
      if (kind === 'dir') {
        if (depth < limits.maxDepth && !name.startsWith('.') && name !== 'node_modules' && name !== '__pycache__') {
          await walk(rel, depth + 1);
        }
        continue;
      }
      const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
      if (kind !== 'file' || LEFTOVER.test(name) || rel === mainPdf || !INPUT.has(ext)) {
        continue;
      }
      if (files.length >= limits.maxFiles) {
        truncated = true;
        return;
      }
      const data = overrides.get(rel) ?? (await fs.readFile(rel));
      if (bytes + data.length > limits.maxBytes) {
        truncated = true;
        return;
      }
      bytes += data.length;
      files.push({ path: rel, data });
    }
  };
  await walk(scope, 0);
  // Unsaved editors for input files the walk did not reach (a new file not yet on disk).
  for (const [rel, data] of overrides) {
    const ext = /\.([^.]+)$/.exec(rel)?.[1]?.toLowerCase() ?? '';
    if (within(rel, scope) && insideProject(rel) && INPUT.has(ext) && !files.some((f) => f.path === rel)) {
      files.push({ path: rel, data });
      bytes += data.length;
    }
  }
  return { files, bytes, truncated };
}

/**
 * Adds the first existing candidate of each reference that the walk did not reach (a file the documents name in
 * another folder of the project). Paths that are not plain project paths are never read.
 */
export async function collectReferenced(
  fs: ProjectFs,
  project: CollectedProject,
  references: string[][],
  overrides: Map<string, Uint8Array> = new Map(),
  limits: CollectLimits = DEFAULT_LIMITS,
): Promise<ProjectFile[]> {
  const added: ProjectFile[] = [];
  const have = new Set(project.files.map((f) => f.path));
  for (const candidates of references) {
    if (candidates.some((c) => have.has(c))) {
      continue;
    }
    for (const rel of candidates) {
      if (!insideProject(rel) || LEFTOVER.test(rel)) {
        continue;
      }
      if (project.files.length >= limits.maxFiles) {
        project.truncated = true;
        return added;
      }
      let data = overrides.get(rel);
      if (!data) {
        try {
          data = await fs.readFile(rel);
        } catch (err) {
          if (err instanceof LinkRefusedError) {
            (project.refused ??= []).push(rel);
            break;
          }
          continue;
        }
      }
      if (project.bytes + data.length > limits.maxBytes) {
        project.truncated = true;
        return added;
      }
      const file = { path: rel, data };
      project.files.push(file);
      project.bytes += data.length;
      have.add(rel);
      added.push(file);
      break;
    }
  }
  return added;
}

/** A short content fingerprint, to tell whether .bib files changed between compiles. */
export function fingerprint(data: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0;
  for (let i = 0; i < data.length; i++) {
    h1 = Math.imul(h1 ^ data[i], 0x01000193) >>> 0;
    h2 = (h2 + data[i] * (i + 1)) >>> 0;
  }
  return `${data.length}:${h1.toString(16)}:${h2.toString(16)}`;
}
