// The link check for file systems other than the disk (a remote window), where real paths cannot be resolved:
// no folder or file on the way from the project folder to a file may be a symbolic link (build gate 1, G1S-02
// and G1S-03). One rule for every reader: a segment that does not exist ends the walk as "no link", because
// nothing can be read through it (the read itself then fails).

import * as vscode from 'vscode';

/** True when no entry on the way from `folder` to `rel` (a project-relative path with "/") is a symbolic link. */
export async function noLinkOnTheWay(folder: vscode.Uri, rel: string): Promise<boolean> {
  let at = folder;
  for (const part of rel.split('/')) {
    at = vscode.Uri.joinPath(at, part);
    let type: vscode.FileType;
    try {
      type = (await vscode.workspace.fs.stat(at)).type;
    } catch {
      return true;
    }
    if (type & vscode.FileType.SymbolicLink) {
      return false;
    }
  }
  return true;
}
