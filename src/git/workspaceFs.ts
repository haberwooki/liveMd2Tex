// The Git reader's file system in the extension: VS Code's workspace.fs, so the reader works on the local disk
// and, in a remote window, over the remote link (docs/DESIGN.md#confinement-and-trust). Paths are mapped to URIs of the same
// scheme and authority as the document's folder.

import * as vscode from 'vscode';
import { FsError, type EntryType, type ReadOnlyFs } from './fs';

/** The forward-slash path the Git reader uses for a URI (a drive-letter path for file: URIs). */
export function readerPath(uri: vscode.Uri): string {
  return uri.scheme === 'file' ? uri.fsPath.replace(/\\/g, '/') : uri.path;
}

function toFsError(err: unknown, path: string): FsError {
  if (err instanceof vscode.FileSystemError && (err.code === 'FileNotFound' || err.code === 'EntryNotFound')) {
    return new FsError('ENOENT', `${path}: not found`);
  }
  if (err instanceof vscode.FileSystemError && err.code === 'FileNotADirectory') {
    return new FsError('ENOTDIR', `${path}: not a folder`);
  }
  return new FsError('EIO', `${path}: ${(err as Error)?.message ?? String(err)}`);
}

function entryType(type: vscode.FileType): EntryType {
  if (type & vscode.FileType.SymbolicLink && !(type & vscode.FileType.Directory) && !(type & vscode.FileType.File)) {
    return 'symlink';
  }
  return type & vscode.FileType.Directory ? 'directory' : 'file';
}

/** A read-only file system on workspace.fs for paths in the same space (scheme and authority) as `base`. */
export function workspaceReadOnlyFs(base: vscode.Uri): ReadOnlyFs {
  const toUri = (path: string) => (base.scheme === 'file' ? vscode.Uri.file(path) : base.with({ path, query: '', fragment: '' }));
  return {
    async readFile(path) {
      try {
        return await vscode.workspace.fs.readFile(toUri(path));
      } catch (err) {
        throw toFsError(err, path);
      }
    },
    async stat(path) {
      try {
        const s = await vscode.workspace.fs.stat(toUri(path));
        return { type: entryType(s.type), size: s.size, mtimeMs: s.mtime, ctimeMs: s.ctime };
      } catch (err) {
        throw toFsError(err, path);
      }
    },
    async readdir(path) {
      try {
        return (await vscode.workspace.fs.readDirectory(toUri(path))).map(([name]) => name);
      } catch (err) {
        throw toFsError(err, path);
      }
    },
  };
}
