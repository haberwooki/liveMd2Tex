// Paths of documents inside a project folder. On Windows and macOS the file system ignores case, and VS Code may
// spell the same folder two ways (a workspace folder opened as "C:\..." has the path "/C:/...", while a
// document opened from it has "/c:/..."), so the comparison ignores case there.

import * as vscode from 'vscode';

const caseless = process.platform === 'win32' || process.platform === 'darwin';

/** `uri`'s path relative to `base` ("sub/a.tex"), or undefined when it is not below it. */
export function relativeTo(base: vscode.Uri, uri: vscode.Uri): string | undefined {
  if (uri.scheme !== base.scheme || uri.authority !== base.authority) {
    return undefined;
  }
  const prefix = `${base.path.replace(/\/$/, '')}/`;
  const same = caseless ? uri.path.toLowerCase().startsWith(prefix.toLowerCase()) : uri.path.startsWith(prefix);
  return same ? uri.path.slice(prefix.length) : undefined;
}
