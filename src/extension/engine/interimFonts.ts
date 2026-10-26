// Font files the converter's XeTeX notes template names that the interim TeX image lacks: DejaVu, from the
// pinned CTAN set (docs/DESIGN.md#engine-and-data), staged by scripts/stage-engine.mjs into dist/data/fonts/. They reach
// the engine as project files (the project-folder route of docs/DESIGN.md#engine-and-data) until B1's data packages
// carry them; then this folder goes and the converter's fontFiles list is empty. Read once, kept in memory.

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ProjectFile } from '../../shared/engineJobs';

const cache = new Map<string, Promise<Uint8Array | null>>();

/** The folder of the interim fonts inside this copy of the extension. */
export function interimFontsFolder(extensionPath: string): string {
  return path.join(extensionPath, 'dist', 'data', 'fonts');
}

/**
 * The named font files from the folder, as project files at the project's top level (where XeTeX finds a font
 * by its file name). Names that are not plain file names, or files that are missing, are left out; the compile
 * then reports the missing font.
 */
export async function readInterimFonts(folder: string, names: string[]): Promise<ProjectFile[]> {
  const out: ProjectFile[] = [];
  for (const name of names) {
    if (!/^[A-Za-z0-9._-]+\.(ttf|otf)$/.test(name)) {
      continue;
    }
    const file = path.join(folder, name);
    let data = cache.get(file);
    if (!data) {
      data = readFile(file).then(
        (b) => new Uint8Array(b),
        () => null,
      );
      cache.set(file, data);
    }
    const bytes = await data;
    if (bytes) {
      out.push({ path: name, data: bytes });
    } else {
      cache.delete(file);
    }
  }
  return out;
}
