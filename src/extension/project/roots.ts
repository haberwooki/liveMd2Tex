// Multiple root documents in one folder (docs/DESIGN.md#multiple-documents, M2-B): each .tex file with \documentclass is its
// own document; "% !TEX root" names the root of a file that has none; a file without either belongs to a
// document in its folder or the folder above that includes it. Which documents a change compiles: the root
// of the edited file, and every document whose last compile read it, but for a file several documents read
// (a shared .bib, a shared section) only the documents being previewed. Pure: paths relative to the project
// folder, a small file-system interface, no VS Code.

import { posix } from 'node:path';
import { hasDocumentClass, includesFile, magicComment } from './texText';

export interface RootFs {
  /** Entries of a folder relative to the project folder ('' for the project folder itself). */
  readDirectory(rel: string): Promise<[string, 'file' | 'dir' | 'other'][]>;
  readFile(rel: string): Promise<Uint8Array>;
  exists(rel: string): Promise<boolean>;
}

/**
 * The root document of the .tex file `rel` (with text `text`), relative to the project folder: its "% !TEX root"
 * (inside the project), else itself when it has \documentclass, else the first .tex file (by name) in its
 * folder or the folder above that has \documentclass and includes it, else itself.
 */
export async function findRoot(fs: RootFs, rel: string, text: string, warn: (message: string) => void = () => undefined): Promise<string> {
  const dir = posix.dirname(rel) === '.' ? '' : posix.dirname(rel);
  const magic = magicComment(text, 'root');
  if (magic) {
    const target = posix.normalize(posix.join(dir, magic.replace(/\\/g, '/')));
    if (target.startsWith('..') || posix.isAbsolute(target)) {
      warn(`ignored "% !TEX root = ${magic}": it leaves the project folder`);
    } else if (await fs.exists(target)) {
      return target;
    } else {
      warn(`"% !TEX root = ${magic}" names a file that does not exist`);
    }
  }
  if (hasDocumentClass(text)) {
    return rel;
  }
  const name = posix.basename(rel);
  const folders = [dir];
  if (dir !== '') {
    folders.push(posix.dirname(dir) === '.' ? '' : posix.dirname(dir));
  }
  for (const folder of folders) {
    let entries: [string, 'file' | 'dir' | 'other'][];
    try {
      entries = await fs.readDirectory(folder);
    } catch {
      continue;
    }
    const relName = folder === dir ? name : `${posix.basename(dir)}/${name}`;
    for (const [entry, kind] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
      const candidate = folder ? `${folder}/${entry}` : entry;
      if (kind !== 'file' || !/\.tex$/i.test(entry) || candidate === rel) {
        continue;
      }
      let candidateText: string;
      try {
        candidateText = new TextDecoder().decode(await fs.readFile(candidate));
      } catch {
        continue;
      }
      if (hasDocumentClass(candidateText) && includesFile(candidateText, relName)) {
        return candidate;
      }
    }
  }
  return rel;
}

/**
 * The documents a change compiles, from the candidates (the edited file's root, and every document whose last
 * compile read the file). One candidate: it. Several (a file they share): the ones being previewed; when none
 * is, the edited file's own root, else the one previewed most recently.
 */
export function previewedTargets(
  candidates: string[],
  previewed: (key: string) => boolean,
  ownRoot: string | undefined,
  recent: readonly string[],
): string[] {
  if (candidates.length <= 1) {
    return candidates;
  }
  const shown = candidates.filter(previewed);
  if (shown.length > 0) {
    return shown;
  }
  if (ownRoot && candidates.includes(ownRoot)) {
    return [ownRoot];
  }
  const latest = recent.find((k) => candidates.includes(k));
  return [latest ?? candidates[0]];
}
