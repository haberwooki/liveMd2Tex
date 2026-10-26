// "Add a package from a file" (docs/DESIGN.md#engine-and-data): the user downloads a package from CTAN in the browser and
// picks it: a .sty or .cls file (and the small files that come with one), a .dtx with its .ins, or the package's
// .zip. A .ins file runs on the extension's own engine (docstrip, in memory) to make the .sty and .cls files; no
// outside program runs. The result goes into the user's package folder (under VS Code's global storage, a texmf
// tree that every compile reads) or, if the user prefers, into the document's folder. No VS Code here; the
// caller passes the engine run.

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ProjectFile } from '../../shared/engineJobs';
import { buildPackageIndex, type PackageIndex } from '../../shared/packageIndex';
import { insideProject } from '../project/confine';
import type { InstalledSet } from '../project/packageScan';
import { readZip } from './zip';

/** Runs one .ins file with the given files in an engine project and returns the files it made. */
export type RunIns = (files: ProjectFile[], ins: string) => Promise<ProjectFile[]>;

const TEX_INPUT = /\.(sty|cls|clo|cfg|def|fd|ldf|tex|ltx|bbx|cbx|lbx|dbx|rtx|lco|dict|tikz)$/i;
const FONT_FOLDER: Record<string, string> = {
  tfm: 'fonts/tfm/public',
  pfb: 'fonts/type1/public',
  pfa: 'fonts/type1/public',
  vf: 'fonts/vf/public',
  afm: 'fonts/afm/public',
  enc: 'fonts/enc/dvips',
  map: 'fonts/map/dvips',
  otf: 'fonts/opentype/public',
  ttf: 'fonts/truetype/public',
};

/** Where a file of package `pkg` goes in a texmf tree; null for files a compile does not read (README, PDF). */
export function texmfPathFor(pkg: string, name: string): string | null {
  const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  if (TEX_INPUT.test(name)) {
    return `tex/latex/${pkg}/${name}`;
  }
  if (ext === 'bst') {
    return `bibtex/bst/${pkg}/${name}`;
  }
  if (ext === 'bib') {
    return `bibtex/bib/${pkg}/${name}`;
  }
  if (FONT_FOLDER[ext]) {
    return `${FONT_FOLDER[ext]}/${pkg}/${name}`;
  }
  return null;
}

export interface PreparedPackages {
  /** texmf-relative path -> bytes. */
  files: Map<string, Uint8Array>;
  packages: string[];
  /** Files docstrip made from .ins and .dtx files. */
  built: string[];
  /** Files left out (documentation, sources, unknown kinds). */
  skipped: string[];
  /** Plain-words notes for the user. */
  notes: string[];
}

const stem = (name: string) => name.replace(/\.[^.]+$/, '');
const safeName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name);

/**
 * Turns the picked files into texmf files: ZIPs are opened (a TDS ZIP keeps its tex/, bibtex/ and fonts/
 * trees), .ins files are run on the engine, and every other file is placed by its kind.
 */
export async function preparePackages(picked: { name: string; data: Uint8Array }[], runIns: RunIns): Promise<PreparedPackages> {
  const out: PreparedPackages = { files: new Map(), packages: [], built: [], skipped: [], notes: [] };
  const packages = new Set<string>();
  // Loose files by package: a ZIP's top folder, or a picked file's own name for single files.
  const groups = new Map<string, { name: string; data: Uint8Array }[]>();
  const addLoose = (pkg: string, name: string, data: Uint8Array) => {
    const list = groups.get(pkg) ?? [];
    list.push({ name, data });
    groups.set(pkg, list);
  };
  const pickedStems = new Set(picked.filter((p) => /\.(ins|dtx)$/i.test(p.name)).map((p) => stem(p.name)));
  for (const p of picked) {
    if (/\.zip$/i.test(p.name)) {
      const entries = readZip(Buffer.from(p.data));
      const tds = [...entries.keys()].some((n) => /^(tex|bibtex|fonts)\//.test(n));
      for (const [entry, data] of entries) {
        const parts = entry.split('/');
        const base = parts[parts.length - 1];
        if (tds) {
          if (/^(tex|bibtex|fonts)\//.test(entry) && insideProject(entry) && safeName(base)) {
            out.files.set(entry, new Uint8Array(data));
            const pkg = parts[0] === 'fonts' ? parts[3] : parts[2];
            if (pkg) {
              packages.add(pkg);
            }
          } else {
            out.skipped.push(entry);
          }
        } else if (safeName(base) && parts.every((s) => s !== '..')) {
          addLoose(parts.length > 1 ? parts[0] : stem(p.name), base, new Uint8Array(data));
        } else {
          out.skipped.push(entry);
        }
      }
    } else if (safeName(p.name)) {
      // A .dtx and its .ins picked together share the .ins file's name.
      const ins = picked.find((q) => /\.ins$/i.test(q.name));
      const pkg = /\.(ins|dtx)$/i.test(p.name) && ins && pickedStems.size > 0 ? stem(ins.name) : stem(p.name);
      addLoose(pkg, p.name, p.data);
    } else {
      out.skipped.push(p.name);
    }
  }
  for (const [pkg, files] of groups) {
    if (!safeName(pkg)) {
      out.skipped.push(...files.map((f) => f.name));
      continue;
    }
    const projectFiles = files.map((f) => ({ path: f.name, data: f.data }));
    const generated: ProjectFile[] = [];
    for (const ins of files.filter((f) => /\.ins$/i.test(f.name))) {
      const made = await runIns(projectFiles, ins.name);
      if (made.length === 0) {
        out.notes.push(`${ins.name} made no files.`);
      }
      generated.push(...made);
    }
    for (const g of generated) {
      const base = path.posix.basename(g.path);
      const target = safeName(base) ? texmfPathFor(pkg, base) : null;
      if (target) {
        out.files.set(target, g.data);
        out.built.push(base);
        packages.add(pkg);
      }
    }
    for (const f of files) {
      if (/\.(ins|dtx)$/i.test(f.name)) {
        continue;
      }
      const target = texmfPathFor(pkg, f.name);
      if (target) {
        out.files.set(target, f.data);
        packages.add(pkg);
      } else {
        out.skipped.push(f.name);
      }
    }
  }
  out.packages = [...packages].sort();
  if ([...out.files.keys()].some((f) => f.startsWith('fonts/'))) {
    out.notes.push(
      'The package has font files. A font package also needs its map file registered, which this version does not do; ' +
        'the Extra Packages add-on is the route for font packages.',
    );
  }
  return out;
}

/** The user's package folder: a texmf tree under VS Code's global storage that every compile reads. */
export class UserPackages {
  private cached: Promise<{ set: InstalledSet; read(rel: string): Promise<Uint8Array> } | null> | undefined;

  constructor(private readonly root: string) {}

  get texmf(): string {
    return path.join(this.root, 'texmf');
  }

  private async walk(dir: string, rel = ''): Promise<string[]> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push(...(await this.walk(path.join(dir, e.name), r)));
      } else if (e.isFile()) {
        out.push(r);
      }
    }
    return out;
  }

  /** The folder as a data set (null when it is empty). */
  set(): Promise<{ set: InstalledSet; read(rel: string): Promise<Uint8Array> } | null> {
    this.cached ??= (async () => {
      const files = await this.walk(this.texmf);
      if (files.length === 0) {
        return null;
      }
      const texts = new Map<string, string>();
      for (const f of files.filter((x) => /\.(sty|cls)$/i.test(x))) {
        texts.set(f, await readFile(path.join(this.texmf, ...f.split('/')), 'latin1'));
      }
      const index: PackageIndex = buildPackageIndex(files, (rel) => texts.get(rel) ?? '');
      return {
        set: { id: 'user', label: 'your package folder', index },
        read: async (rel: string) => {
          if (!insideProject(rel)) {
            throw new Error(`refused a path outside the package folder: ${rel}`);
          }
          return new Uint8Array(await readFile(path.join(this.texmf, ...rel.split('/'))));
        },
      };
    })();
    return this.cached;
  }

  /** Writes prepared packages into the folder (a package already there is replaced). */
  async add(prepared: PreparedPackages): Promise<void> {
    for (const pkg of prepared.packages) {
      for (const top of ['tex/latex', 'bibtex/bst', 'bibtex/bib']) {
        await rm(path.join(this.texmf, ...top.split('/'), pkg), { recursive: true, force: true });
      }
    }
    for (const [rel, data] of prepared.files) {
      const target = path.join(this.texmf, ...rel.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data);
    }
    this.cached = undefined;
  }

  /** Removes one package from the folder. */
  async remove(pkg: string): Promise<void> {
    if (!safeName(pkg)) {
      return;
    }
    for (const top of ['tex/latex', 'bibtex/bst', 'bibtex/bib']) {
      await rm(path.join(this.texmf, ...top.split('/'), pkg), { recursive: true, force: true });
    }
    this.cached = undefined;
  }
}

/** The files a document folder takes when the user adds a package to the project instead: TeX inputs only. */
export function projectCopies(prepared: PreparedPackages): ProjectFile[] {
  return [...prepared.files]
    .filter(([rel]) => rel.startsWith('tex/') || rel.startsWith('bibtex/bst/'))
    .map(([rel, data]) => ({ path: path.posix.basename(rel), data }));
}
