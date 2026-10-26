// The read-only file system the Git reader runs on (docs/DESIGN.md#architecture, #confinement-and-trust). In the extension
// it is VS Code's workspace.fs (workspaceFs.ts), so it works in remote windows too; in the tests it is node:fs.
// Paths are absolute, with forward slashes ("C:/repo/.git/HEAD" or "/home/u/repo/.git/HEAD"), the form
// isomorphic-git joins.
//
// isomorphicGitFs() adapts it to the fs client isomorphic-git takes: every write throws, because the reader
// never changes a repository.

export type EntryType = 'file' | 'directory' | 'symlink';

export interface ReadOnlyFs {
  readFile(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<{ type: EntryType; size: number; mtimeMs: number; ctimeMs: number }>;
  readdir(path: string): Promise<string[]>;
}

/** A Node-style error with a code, as isomorphic-git expects (it tests err.code === 'ENOENT'). */
export class FsError extends Error {
  constructor(
    readonly code: 'ENOENT' | 'ENOTDIR' | 'EROFS' | 'EIO',
    message: string,
  ) {
    super(message);
  }
}

const MODES: Record<EntryType, number> = { file: 0o100644, directory: 0o040000, symlink: 0o120000 };

function statObject(s: { type: EntryType; size: number; mtimeMs: number; ctimeMs: number }) {
  return {
    type: s.type === 'directory' ? 'dir' : s.type,
    mode: MODES[s.type],
    size: s.size,
    ino: 0,
    uid: 0,
    gid: 0,
    dev: 0,
    mtimeMs: s.mtimeMs,
    ctimeMs: s.ctimeMs,
    isFile: () => s.type === 'file',
    isDirectory: () => s.type === 'directory',
    isSymbolicLink: () => s.type === 'symlink',
  };
}

const readOnly = (name: string) => async () => {
  throw new FsError('EROFS', `${name}: the Git reader is read-only`);
};

/** The fs client isomorphic-git takes ({ promises: {...} }), read-only. */
export function isomorphicGitFs(fs: ReadOnlyFs) {
  const decoder = new TextDecoder('utf-8');
  return {
    promises: {
      async readFile(path: string, options?: string | { encoding?: string }) {
        const bytes = await fs.readFile(path);
        const encoding = typeof options === 'string' ? options : options?.encoding;
        return encoding === 'utf8' || encoding === 'utf-8' ? decoder.decode(bytes) : bytes;
      },
      readdir: (path: string) => fs.readdir(path),
      stat: async (path: string) => statObject(await fs.stat(path)),
      lstat: async (path: string) => statObject(await fs.stat(path)),
      readlink: async (path: string) => {
        throw new FsError('ENOENT', `${path}: symbolic links are not followed`);
      },
      writeFile: readOnly('writeFile'),
      unlink: readOnly('unlink'),
      mkdir: readOnly('mkdir'),
      rmdir: readOnly('rmdir'),
      symlink: readOnly('symlink'),
      chmod: readOnly('chmod'),
    },
  };
}

export function joinPath(...parts: string[]): string {
  const joined = parts.filter(Boolean).join('/').replace(/\\/g, '/');
  const prefix = joined.startsWith('//') ? '/' : '';
  return prefix + joined.replace(/\/{2,}/g, '/');
}

/** Resolves "." and ".." segments of an absolute forward-slash path. */
export function normalizePath(path: string): string {
  const p = path.replace(/\\/g, '/');
  const drive = /^[A-Za-z]:/.exec(p)?.[0] ?? '';
  const rest = p.slice(drive.length);
  const out: string[] = [];
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') {
      continue;
    }
    if (seg === '..') {
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return `${drive}/${out.join('/')}`;
}

export function dirname(path: string): string {
  const p = path.replace(/\/+$/, '');
  const i = p.lastIndexOf('/');
  if (i <= 0) {
    return '/';
  }
  const parent = p.slice(0, i);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}
