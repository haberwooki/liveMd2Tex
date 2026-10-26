// Confinement of the files a folder config or a preset names (docs/DESIGN.md#confinement-and-trust; build gate 1, G1S-03 and the
// config part of G1E-04). A repository can ship .latexpreview.json and a preset, and their paths (the preset file,
// its preamble files, its appendix) are read and their text put into the generated LaTeX, the "Show generated
// LaTeX" view, an exported .tex and the PDF. So each path must stay inside the project folder (the workspace folder
// that holds the Markdown file, or the file's own folder when none is open): no absolute path, drive letter, UNC
// path, "~", URI or ".." that leaves it, and no link (a symbolic link or a Windows junction) that leads out of it.
// No VS Code here, so Node tests check it with real links.

import { promises as fsp } from 'node:fs';
import { posix } from 'node:path';
import { insideProject } from '../project/confine';
import { withinFolder } from '../project/realPath';

/**
 * The project-relative path of `name` as a config writes it, from the project-relative folder `baseRel` ('' for
 * the project folder); undefined when it is absolute, a URI, or leaves the project folder.
 */
export function confinedRelative(baseRel: string, name: string): string | undefined {
  const n = name.trim();
  if (n === '' || /^([\\/]|[A-Za-z]:|~)/.test(n) || /^[A-Za-z][A-Za-z0-9+.-]+:/.test(n) || n.includes('\0')) {
    return undefined;
  }
  const joined = posix.normalize(posix.join(baseRel, n.replace(/\\/g, '/')));
  // The project folder itself ("." after normalising) is not a file a config can name.
  return joined !== '.' && insideProject(joined) ? joined : undefined;
}

/**
 * For files on disk: resolves the real paths of the project folder and of the file (every symbolic link and
 * junction on the way) and checks that the file is still inside. A file that does not exist is "inside" (nothing
 * will be read from it).
 */
export async function realPathStaysInside(projectFsPath: string, fileFsPath: string, realpath: (p: string) => Promise<string> = fsp.realpath): Promise<boolean> {
  let file: string;
  try {
    file = await realpath(fileFsPath);
  } catch {
    return true;
  }
  // The same comparison as the project model's (project/realPath.ts), case as the file system does.
  return withinFolder(await realpath(projectFsPath), file);
}
