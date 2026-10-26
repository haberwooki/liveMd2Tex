// Confinement through links (docs/DESIGN.md#confinement-and-trust; build gate 1, G1S-02): a path inside the project folder can
// still lead outside it through a symbolic link or a Windows junction on the way, and an \input of it would put
// the target's text into the PDF. For files on this computer the real path (all links resolved) must lie in the
// project folder's real path. Remote file systems are checked segment by segment in the controller instead.
// Writes follow the same rule (writeTargetProblem; build gate 2, G2S-02).

import { lstat, realpath } from 'node:fs/promises';
import * as path from 'node:path';

const caseless = process.platform === 'win32' || process.platform === 'darwin';

/** Whether `child` (an absolute path) is `folder` or lies in it, comparing as the file system does. */
export function withinFolder(folder: string, child: string): boolean {
  const rel = path.relative(caseless ? folder.toLowerCase() : folder, caseless ? child.toLowerCase() : child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Whether `target` really lies in `folder` once every link on the way is resolved. */
export async function realPathWithin(folder: string, target: string): Promise<boolean> {
  const [realFolder, realTarget] = await Promise.all([realpath(folder), realpath(target)]);
  return withinFolder(realFolder, realTarget);
}

/**
 * Why `target` (a file to be written) may not be written inside `folder`, or undefined when it may: the target
 * must not be a link or a folder, and the nearest existing folder on its way must really lie in `folder`.
 */
export async function writeTargetProblem(folder: string, target: string): Promise<string | undefined> {
  if (!withinFolder(folder, target) || withinFolder(target, folder)) {
    return 'it is outside the project folder';
  }
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) {
      return 'it is a link';
    }
    if (!stat.isFile()) {
      return 'it is not a file';
    }
  } catch {
    // It does not exist yet: its folder decides.
  }
  let dir = path.dirname(target);
  for (;;) {
    try {
      await lstat(dir);
      break;
    } catch {
      const up = path.dirname(dir);
      if (up === dir) {
        return 'its folder does not exist';
      }
      dir = up;
    }
  }
  try {
    return (await realPathWithin(folder, dir)) ? undefined : 'a folder on its way is a link that leads outside the project folder';
  } catch {
    // A link whose target is gone (build gate 2, G2R-04).
    return 'a folder on its way is a broken link';
  }
}
