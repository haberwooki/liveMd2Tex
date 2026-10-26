// A ProjectFs over Node's fs for the engine-level tests: the same contract as the extension's workspace.fs
// adapter (paths relative to the project folder, nothing outside it, links not followed out of it).

import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { LinkRefusedError, type ProjectFs } from '../../src/extension/project/collect';
import { insideProject } from '../../src/extension/project/confine';
import { realPathWithin } from '../../src/extension/project/realPath';

export function nodeFs(folder: string, reads: string[] = []): ProjectFs {
  const at = (rel: string) => {
    if (rel && !insideProject(rel)) {
      throw new Error(`refused a path outside the project folder: ${rel}`);
    }
    return path.join(folder, ...rel.split('/'));
  };
  return {
    async readDirectory(rel) {
      const entries = await readdir(at(rel), { withFileTypes: true });
      return entries.map((e) => [e.name, e.isSymbolicLink() ? 'other' : e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other']);
    },
    async readFile(rel) {
      const file = at(rel);
      if (!(await realPathWithin(folder, file))) {
        throw new LinkRefusedError(rel);
      }
      reads.push(rel);
      return new Uint8Array(await readFile(file));
    },
    async stat(rel) {
      const s = await stat(at(rel));
      return { size: s.size, mtime: s.mtimeMs };
    },
  };
}
