// The package index of a data set (docs/DESIGN.md#architecture, #engine-and-data): which package each file name belongs to, and
// which files each package's .sty and .cls files load. B1 writes it into each data package; until then
// scripts/stage-engine.mjs builds it from TeXlyre's interim image (dist/data/packages.json) and
// scripts/lib/extra-standin.mjs from the stand-in add-on. Pure; no VS Code, no file access.

/** The index format this code reads (scripts/lib/package-index.mjs writes the same). */
export const INDEX_FORMAT = 1;

export interface PackageEntry {
  /** 'fonts' when the package has font files (.tfm, .pfb, .vf, .enc, .map): a .sty alone is not enough. */
  kind: 'tex' | 'bibtex' | 'fonts';
  /** texmf-relative paths ("tex/latex/natbib/natbib.sty"). */
  files: string[];
  /** File names the package's .sty and .cls files load from other packages. */
  requires: string[];
}

export interface PackageIndex {
  format: number;
  packages: Record<string, PackageEntry>;
  /** File name ("natbib.sty") -> package. */
  files: Record<string, string>;
}

const LOADS = /\\(RequirePackage|RequirePackageWithOptions|usepackage|LoadClass|LoadClassWithOptions)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
const INPUTS = /\\input\s*(?:\{([^}\s]+)\}|([A-Za-z0-9_.\-/]+\.tex))/g;

/**
 * The file names one .sty or .cls file loads (comments removed; names with macros left out). The same rules as
 * scripts/lib/package-index.mjs's loadsOf (a unit test keeps them equal).
 */
export function loadsOf(text: string): string[] {
  const clean = text
    .split('\n')
    .map((line) => line.replace(/(^|[^\\])%.*$/, '$1'))
    .join('\n');
  const out = new Set<string>();
  for (const m of clean.matchAll(LOADS)) {
    const isClass = m[1].startsWith('LoadClass');
    for (const raw of m[2].split(',')) {
      const name = raw.trim();
      if (name && !/[\\#@]/.test(name)) {
        out.add(isClass ? `${name}.cls` : `${name}.sty`);
      }
    }
  }
  for (const m of clean.matchAll(INPUTS)) {
    const name = (m[1] ?? m[2]).trim();
    if (name && !/[\\#@]/.test(name)) {
      out.add(name.slice(name.lastIndexOf('/') + 1));
    }
  }
  return [...out];
}

// Folders pdfTeX and XeTeX search first win when two packages have a file of the same name.
const PRIORITY = ['tex/latex/', 'tex/generic/', 'tex/xelatex/', 'tex/xetex/', 'tex/plain/', 'bibtex/', 'fonts/'];
const rank = (rel: string) => {
  const i = PRIORITY.findIndex((p) => rel.startsWith(p));
  return i < 0 ? PRIORITY.length : i;
};

/**
 * The package a texmf-relative path belongs to, and its kind; null for files that are not part of a package a
 * document can load (formats, configuration, documentation).
 */
export function packageOfPath(rel: string): { name: string; kind: PackageEntry['kind'] } | null {
  const parts = rel.split('/');
  if (parts[0] === 'tex' && parts.length >= 4) {
    return { name: parts[2], kind: 'tex' };
  }
  if (parts[0] === 'bibtex' && (parts[1] === 'bst' || parts[1] === 'bib' || parts[1] === 'csf') && parts.length >= 4) {
    return { name: parts[2], kind: 'bibtex' };
  }
  // fonts/<type>/<supplier>/<family>/... and fonts/{map,enc}/<driver>/<package>/...
  if (parts[0] === 'fonts' && parts.length >= 5) {
    return { name: parts[3], kind: 'fonts' };
  }
  return null;
}

/**
 * Builds an index from texmf-relative paths; `read(rel)` returns a .sty or .cls file's text. The same rules as
 * scripts/lib/package-index.mjs's buildPackageIndex (a unit test keeps them equal).
 */
export function buildPackageIndex(files: string[], read: (rel: string) => string): PackageIndex {
  const packages: Record<string, PackageEntry> = {};
  const byName: Record<string, string> = {};
  const sorted = [...files].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const rel of sorted) {
    const pkg = packageOfPath(rel);
    if (!pkg) {
      continue;
    }
    const entry = (packages[pkg.name] ??= { kind: pkg.kind, files: [], requires: [] });
    if (entry.kind !== pkg.kind) {
      entry.kind = entry.kind === 'fonts' || pkg.kind === 'fonts' ? 'fonts' : entry.kind;
    }
    entry.files.push(rel);
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (!(base in byName)) {
      byName[base] = pkg.name;
    }
  }
  for (const [name, entry] of Object.entries(packages)) {
    const own = new Set(entry.files.map((f) => f.slice(f.lastIndexOf('/') + 1)));
    const requires = new Set<string>();
    for (const rel of entry.files) {
      if (!/\.(sty|cls)$/i.test(rel)) {
        continue;
      }
      for (const file of loadsOf(read(rel))) {
        if (!own.has(file) && (file.endsWith('.sty') || file.endsWith('.cls') || byName[file] !== undefined)) {
          requires.add(file);
        }
      }
    }
    entry.requires = [...requires].filter((f) => byName[f] !== name).sort();
  }
  return { format: INDEX_FORMAT, packages, files: byName };
}

/** Checks that `value` is a package index this code can read. */
export function isPackageIndex(value: unknown): value is PackageIndex {
  const v = value as PackageIndex | null;
  return (
    v !== null &&
    typeof v === 'object' &&
    v.format === INDEX_FORMAT &&
    typeof v.packages === 'object' &&
    v.packages !== null &&
    typeof v.files === 'object' &&
    v.files !== null
  );
}
