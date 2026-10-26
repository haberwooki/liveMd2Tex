// The journal classes the engine image lacks, from the pinned CTAN set (../engine_assets, docs/DESIGN.md#testing),
// as project files for a compile: REVTeX 4.2 from its TDS ZIP, IEEEtran and llncs as shipped, elsarticle and
// acmart built from their .dtx by docstrip inside the engine. Each comes with its .bst file. Shared by the
// class-template test and the new-document test.

import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { CompileJob, CompileResult, ProjectFile } from '../../src/shared/engineJobs';
import { importScript, root } from '../support/helpers';
import { assetsRoot, job } from './support';

export type JournalClass = 'revtex' | 'ieeetran' | 'elsarticle' | 'llncs' | 'acmart';

/** The folder of a pinned CTAN source. */
export function ctan(id: string): string {
  const pins = JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8')) as { sources: { id: string; folder: string }[] };
  return path.join(assetsRoot, pins.sources.find((s) => s.id === id)?.folder ?? id);
}

/** True when the pinned CTAN set is on disk (npm run engine:assets). */
export function haveCtanClasses(): boolean {
  return existsSync(ctan('ctan-revtex'));
}

/** Files of a folder, flat (by base name). */
export function flat(dir: string, names: string[]): ProjectFile[] {
  return names.map((n) => ({ path: path.posix.basename(n), data: new Uint8Array(readFileSync(path.join(dir, ...n.split('/')))) }));
}

/** A class built from its .dtx by docstrip, inside the engine (docs/DESIGN.md#engine-and-data). */
async function docstrip(compile: (j: CompileJob) => Promise<CompileResult>, dir: string, ins: string, dtx: string, cls: string): Promise<ProjectFile> {
  const fmt = '/texlive/texmf-dist/texmf-var/web2c/pdftex/pdflatex.fmt';
  const built = await compile(
    job({ main: ins, files: flat(dir, [ins, dtx]), engine: 'pdflatex', bibtex: 'never', maxPasses: 1, synctex: false, steps: [['pdflatex', '-no-shell-escape', '-interaction=nonstopmode', '-fmt', fmt, ins]], readBack: [cls] }),
  );
  const body = built.readBack?.[cls];
  assert.ok(body && body.length > 1000, `docstrip did not build ${cls}`);
  return { path: cls, data: new TextEncoder().encode(body) };
}

/** The class and .bst files of a journal class, flat, for a compile. `compile` runs docstrip where needed. */
export async function journalClassFiles(name: JournalClass, compile: (j: CompileJob) => Promise<CompileResult>): Promise<ProjectFile[]> {
  switch (name) {
    case 'revtex': {
      const { readZip } = await importScript<{ readZip(b: Buffer): Map<string, Buffer> }>('scripts/lib/zip.mjs');
      const zip = readZip(readFileSync(path.join(ctan('ctan-revtex'), 'revtex.tds.zip')));
      const files: ProjectFile[] = [];
      for (const [entry, data] of zip) {
        if (/^tex\/latex\/revtex\/|^bibtex\/bst\/revtex\/apsrev4-2\.bst$/.test(entry)) {
          files.push({ path: path.posix.basename(entry), data: new Uint8Array(data) });
        }
      }
      return files;
    }
    case 'ieeetran':
      return flat(ctan('ctan-ieeetran'), ['IEEEtran.cls', 'bibtex/IEEEtran.bst']);
    case 'elsarticle': {
      const dir = ctan('ctan-elsarticle');
      return [await docstrip(compile, dir, 'elsarticle.ins', 'elsarticle.dtx', 'elsarticle.cls'), ...flat(dir, ['elsarticle-num.bst'])];
    }
    case 'llncs':
      return flat(ctan('ctan-llncs'), ['llncs.cls', 'splncs04.bst']);
    case 'acmart': {
      const dir = ctan('ctan-acmart');
      return [await docstrip(compile, dir, 'acmart.ins', 'acmart.dtx', 'acmart.cls'), ...flat(dir, ['ACM-Reference-Format.bst'])];
    }
  }
}
