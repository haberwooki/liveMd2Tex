// Every write into a project folder (build gate 2, G2S-02): the PDF next to the source, "Add a package from a
// file" with "Only for this project", Export LaTeX and "Create folder config". A write must never follow a link
// out of the folder: VS Code's file system writes through a symbolic link at the target, so a repository that
// ships `foo.sty` as a link to a file in the user's home would get that file overwritten.
//
// The rule: the target may not be a link (or anything but a plain file), and the real path of the nearest existing
// folder on its way must lie in the project folder's real path; on a remote file system no part of the path may be
// a symbolic link. The bytes then go to a temporary file beside the target and are renamed over it, which
// replaces a link instead of writing through it.

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { noLinkOnTheWay } from './linkWalk';
import { writeTargetProblem } from './realPath';
import { relativeTo } from './uris';

/** The write was refused; the message says why, in plain words. */
export class WriteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteRefusedError';
  }
}

/** On a remote file system: the one link walk of every reader (project/linkWalk.ts). */
async function remoteProblem(folder: vscode.Uri, rel: string): Promise<string | undefined> {
  return (await noLinkOnTheWay(folder, rel)) ? undefined : 'a link is on its way';
}

/** Why `target` may not be written inside `folder`, or undefined when it may. */
export async function confinedWriteProblem(folder: vscode.Uri, target: vscode.Uri): Promise<string | undefined> {
  const rel = relativeTo(folder, target);
  if (!rel) {
    return 'it is outside the project folder';
  }
  return folder.scheme === 'file' ? writeTargetProblem(folder.fsPath, target.fsPath) : remoteProblem(folder, rel);
}

/** Writes `data` to `target`, which must stay inside `folder` with no link on the way (see the header). */
export async function writeConfined(folder: vscode.Uri, target: vscode.Uri, data: Uint8Array): Promise<void> {
  const problem = await confinedWriteProblem(folder, target);
  if (problem) {
    const name = relativeTo(folder, target) ?? target.path;
    throw new WriteRefusedError(`Not written: ${name}, because ${problem}. Nothing outside the project folder is written.`);
  }
  const name = target.path.slice(target.path.lastIndexOf('/') + 1);
  const temp = vscode.Uri.joinPath(target, '..', `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await vscode.workspace.fs.writeFile(temp, data);
    await vscode.workspace.fs.rename(temp, target, { overwrite: true });
  } catch (err) {
    await vscode.workspace.fs.delete(temp).then(
      () => undefined,
      () => undefined,
    );
    throw err;
  }
}

/** The folder a write is confined to: the workspace folder that holds `target`, else the folder it is in. */
export function writeBoundary(target: vscode.Uri): vscode.Uri {
  return vscode.workspace.getWorkspaceFolder(target)?.uri ?? vscode.Uri.joinPath(target, '..');
}
