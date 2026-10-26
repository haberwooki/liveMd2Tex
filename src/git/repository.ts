// The Git reader (docs/DESIGN.md#architecture): isomorphic-git (MIT, pure JavaScript) reading a file at a commit and a
// file's state straight from .git, on a read-only file system. No git.exe, ever; VS Code's Git extension is
// lint-banned.
//
// Two rules isomorphic-git does not apply by itself:
//   - Linked worktrees. A worktree's .git is a file ("gitdir: <main>/.git/worktrees/<name>"), and that folder's
//     commondir file names the main .git folder, which holds the objects, the branch refs, packed-refs and the
//     config. isomorphic-git follows the pointer but ignores commondir, so the reader wraps the file system and
//     sends every shared path (git's own list, path.c common_list) to the common folder.
//   - Line endings. Git for Windows sets core.autocrlf=true in its own config, which isomorphic-git never reads;
//     so a file whose only difference from the committed copy is CRLF line endings counts as unchanged.

import { currentBranch, expandOid, readBlob, readCommit, resolveRef } from 'isomorphic-git';
import { dirname, isAbsolutePath, isomorphicGitFs, joinPath, normalizePath, type ReadOnlyFs } from './fs';

export interface RepositoryLocation {
  /** The working tree's root folder. */
  worktree: string;
  /** The folder isomorphic-git is given as gitdir (a linked worktree's private folder, or .git). */
  gitdir: string;
  /** The folder with the objects, refs and config (equal to gitdir unless this is a linked worktree). */
  commondir: string;
  linked: boolean;
}

export type FileStatus = 'unmodified' | 'modified' | 'new' | 'deleted' | 'absent';

export class GitReaderError extends Error {}

const decoder = new TextDecoder('utf-8');

async function exists(fs: ReadOnlyFs, path: string): Promise<'file' | 'directory' | 'symlink' | undefined> {
  try {
    return (await fs.stat(path)).type;
  } catch {
    return undefined;
  }
}

/**
 * Finds the repository that contains `startDir` by walking up to the first folder with a .git folder or file.
 * Returns undefined outside any repository.
 */
export async function findRepository(fs: ReadOnlyFs, startDir: string): Promise<RepositoryLocation | undefined> {
  let dir = normalizePath(startDir);
  for (;;) {
    const dotgit = joinPath(dir, '.git');
    const kind = await exists(fs, dotgit);
    if (kind === 'directory') {
      const commondir = await readCommondir(fs, dotgit);
      return { worktree: dir, gitdir: dotgit, commondir: commondir ?? dotgit, linked: false };
    }
    if (kind === 'file') {
      const text = decoder.decode(await fs.readFile(dotgit)).trim();
      const m = /^gitdir:\s*(.+)$/m.exec(text);
      if (!m) {
        throw new GitReaderError(`${dotgit} is a file but does not name a git folder.`);
      }
      const target = m[1].trim().replace(/\\/g, '/');
      const gitdir = normalizePath(isAbsolutePath(target) ? target : joinPath(dir, target));
      if ((await exists(fs, gitdir)) !== 'directory') {
        throw new GitReaderError(`The git folder this worktree points to (${gitdir}) is missing.`);
      }
      const commondir = await readCommondir(fs, gitdir);
      if (commondir && (await exists(fs, commondir)) !== 'directory') {
        throw new GitReaderError(`The common git folder of this linked worktree (${commondir}) cannot be found.`);
      }
      return { worktree: dir, gitdir, commondir: commondir ?? gitdir, linked: !!commondir };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

async function readCommondir(fs: ReadOnlyFs, gitdir: string): Promise<string | undefined> {
  try {
    const value = decoder.decode(await fs.readFile(joinPath(gitdir, 'commondir'))).trim().replace(/\\/g, '/');
    return normalizePath(isAbsolutePath(value) ? value : joinPath(gitdir, value));
  } catch {
    return undefined;
  }
}

/** git's per-worktree paths (path.c common_list): everything else under a linked worktree's gitdir is shared. */
const PER_WORKTREE = ['info/sparse-checkout', 'logs/HEAD', 'logs/refs/bisect', 'logs/refs/rewritten', 'logs/refs/worktree', 'refs/bisect', 'refs/rewritten', 'refs/worktree'];
const COMMON = ['branches', 'common', 'hooks', 'info', 'logs', 'lost-found', 'objects', 'refs', 'remotes', 'worktrees', 'rr-cache', 'svn', 'config', 'gc.pid', 'packed-refs', 'shallow'];

const under = (rel: string, prefix: string) => rel === prefix || rel.startsWith(`${prefix}/`);

/** True if a path relative to the gitdir lives in the common folder of a linked worktree. */
export function isCommonPath(rel: string): boolean {
  if (PER_WORKTREE.some((p) => under(rel, p))) {
    return false;
  }
  return COMMON.some((p) => under(rel, p));
}

/** Wraps a file system so that shared paths under a linked worktree's gitdir are read from the common folder. */
export function commondirFs(fs: ReadOnlyFs, gitdir: string, commondir: string): ReadOnlyFs {
  const prefix = `${gitdir}/`;
  const redirect = (path: string): string => {
    const p = normalizePath(path);
    const fold = (s: string) => (/^[A-Za-z]:/.test(s) ? s.toLowerCase() : s);
    if (!fold(p).startsWith(fold(prefix))) {
      return path;
    }
    const rel = p.slice(prefix.length);
    return isCommonPath(rel) ? joinPath(commondir, rel) : path;
  };
  return {
    readFile: (path) => fs.readFile(redirect(path)),
    stat: (path) => fs.stat(redirect(path)),
    readdir: (path) => fs.readdir(redirect(path)),
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** CRLF to LF, on bytes. */
export function toLf(bytes: Uint8Array): Uint8Array {
  if (!bytes.includes(13)) {
    return bytes;
  }
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) {
      continue;
    }
    out[n++] = bytes[i];
  }
  return out.subarray(0, n);
}

/** True if two versions of a file differ only in CRLF against LF line endings, or not at all. */
export function sameContent(a: Uint8Array, b: Uint8Array): boolean {
  return sameBytes(a, b) || sameBytes(toLf(a), toLf(b));
}

export interface HeadInfo {
  oid: string;
  short: string;
  branch?: string;
  summary: string;
}

export class GitReader {
  private readonly cache = {};
  private readonly gitFs: ReturnType<typeof isomorphicGitFs>;

  private constructor(
    readonly location: RepositoryLocation,
    private readonly fs: ReadOnlyFs,
  ) {
    const wrapped = location.linked ? commondirFs(fs, location.gitdir, location.commondir) : fs;
    this.gitFs = isomorphicGitFs(wrapped);
  }

  /** The reader for the repository holding `filePath`, or undefined when there is none. */
  static async open(fs: ReadOnlyFs, filePath: string): Promise<GitReader | undefined> {
    const location = await findRepository(fs, dirname(normalizePath(filePath)));
    if (!location) {
      return undefined;
    }
    const reader = new GitReader(location, fs);
    await reader.checkSupported();
    return reader;
  }

  private async checkSupported(): Promise<void> {
    let config: string;
    try {
      config = decoder.decode(await this.fs.readFile(joinPath(this.location.commondir, 'config')));
    } catch {
      return;
    }
    if (/^\s*objectformat\s*=\s*sha256\s*$/im.test(config)) {
      throw new GitReaderError('This repository uses SHA-256 object names, which the Git reader does not support yet.');
    }
  }

  private get base() {
    return { fs: this.gitFs, dir: this.location.worktree, gitdir: this.location.gitdir, cache: this.cache };
  }

  /** The path of a file relative to the working tree (forward slashes), or undefined if it lies outside. */
  relative(filePath: string): string | undefined {
    const p = normalizePath(filePath);
    const root = `${this.location.worktree.replace(/\/$/, '')}/`;
    const fold = (s: string) => (/^[A-Za-z]:/.test(s) ? s.toLowerCase() : s);
    return fold(p).startsWith(fold(root)) ? p.slice(root.length) : undefined;
  }

  /** The commit HEAD points to, or undefined in a repository with no commits. */
  async head(): Promise<HeadInfo | undefined> {
    let oid: string;
    try {
      oid = await resolveRef({ ...this.base, ref: 'HEAD' });
    } catch {
      return undefined;
    }
    const commit = await readCommit({ ...this.base, oid });
    const branch = (await currentBranch({ ...this.base, fullname: false }).catch(() => undefined)) ?? undefined;
    return { oid, short: oid.slice(0, 7), branch, summary: commit.commit.message.split('\n')[0] };
  }

  /**
   * A file's bytes at a commit, or undefined when the commit does not have it. `ref` is a ref name (HEAD, a
   * branch or tag) or a commit id, full or abbreviated; revision expressions such as HEAD~1 are not parsed.
   */
  async readCommitted(filePath: string, ref = 'HEAD'): Promise<Uint8Array | undefined> {
    const rel = this.relative(filePath);
    if (rel === undefined) {
      return undefined;
    }
    let oid: string;
    try {
      oid = /^[0-9a-f]{40}$/.test(ref) ? ref : /^[0-9a-f]{4,39}$/.test(ref) ? await expandOid({ ...this.base, oid: ref }) : await resolveRef({ ...this.base, ref });
    } catch {
      return undefined;
    }
    try {
      const { blob } = await readBlob({ ...this.base, oid, filepath: rel });
      return blob;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'NotFoundError') {
        return undefined;
      }
      throw new GitReaderError(`Could not read ${rel} at ${ref}: ${(err as Error).message}`);
    }
  }

  /**
   * The state of a working-tree file against HEAD: unmodified (CRLF-only differences included), modified,
   * new (not in HEAD), deleted (in HEAD, not on disk) or absent (neither).
   */
  async status(filePath: string): Promise<FileStatus> {
    const committed = await this.readCommitted(filePath);
    let working: Uint8Array | undefined;
    try {
      working = await this.fs.readFile(normalizePath(filePath));
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') {
        throw err;
      }
    }
    if (!working) {
      return committed ? 'deleted' : 'absent';
    }
    if (!committed) {
      return 'new';
    }
    return sameContent(committed, working) ? 'unmodified' : 'modified';
  }
}
