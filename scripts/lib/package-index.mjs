// Development tool: the package index of a TeX file tree (docs/DESIGN.md#architecture, #engine-and-data): which package each file
// name belongs to, and which files each package's .sty and .cls files load (\RequirePackage, \usepackage,
// \LoadClass, and \input of another package's file). The extension's preamble scan resolves a document's
// packages through it (src/extension/project/packageIndex.ts). B1 writes the real one into each data set's
// manifest.json; until then scripts/stage-engine.mjs builds it from TeXlyre's interim image, and
// scripts/build-extra-standin.mjs from the stand-in add-on's files.

import path from 'node:path';

/** Index format; the extension refuses an index with another number. */
export const INDEX_FORMAT = 1;

// Folders pdfTeX and XeTeX search first win when two packages have a file of the same name.
const PRIORITY = ['tex/latex/', 'tex/generic/', 'tex/xelatex/', 'tex/xetex/', 'tex/plain/', 'bibtex/', 'fonts/'];
const rank = (rel) => {
  const i = PRIORITY.findIndex((p) => rel.startsWith(p));
  return i < 0 ? PRIORITY.length : i;
};

/**
 * The package a texmf-relative path belongs to, and its kind; null for files that are not part of a package a
 * document can load (formats, configuration, documentation).
 */
export function packageOfPath(rel) {
  const parts = rel.split('/');
  if (parts[0] === 'tex' && parts.length >= 4) {
    return { name: parts[2], kind: 'tex' };
  }
  if (parts[0] === 'bibtex' && (parts[1] === 'bst' || parts[1] === 'bib' || parts[1] === 'csf') && parts.length >= 4) {
    return { name: parts[2], kind: 'bibtex' };
  }
  if (parts[0] === 'fonts' && parts.length >= 4) {
    // fonts/<type>/<supplier>/<family>/... ; fonts/map/dvips/<package>/... ; fonts/enc/dvips/<package>/...
    if ((parts[1] === 'map' || parts[1] === 'enc') && parts.length >= 5) {
      return { name: parts[3], kind: 'fonts' };
    }
    if (parts.length >= 5) {
      return { name: parts[3], kind: 'fonts' };
    }
  }
  return null;
}

const LOADS = /\\(RequirePackage|RequirePackageWithOptions|usepackage|LoadClass|LoadClassWithOptions)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
const INPUTS = /\\input\s*(?:\{([^}\s]+)\}|([A-Za-z0-9_.\-/]+\.tex))/g;

/** The file names one .sty or .cls file loads (comments removed; names with macros left out). */
export function loadsOf(text) {
  const clean = text
    .split('\n')
    .map((line) => line.replace(/(^|[^\\])%.*$/, '$1'))
    .join('\n');
  const out = new Set();
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
      out.add(path.posix.basename(name));
    }
  }
  return [...out];
}

/**
 * Builds the index. `files` are texmf-relative paths ("tex/latex/natbib/natbib.sty"); `read(rel)` returns a
 * file's text (called only for .sty and .cls files).
 */
export function buildPackageIndex(files, read) {
  const packages = {};
  const byName = {};
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
    const base = path.posix.basename(rel);
    if (!(base in byName)) {
      byName[base] = pkg.name;
    }
  }
  for (const [name, entry] of Object.entries(packages)) {
    const own = new Set(entry.files.map((f) => path.posix.basename(f)));
    const requires = new Set();
    for (const rel of entry.files) {
      if (!/\.(sty|cls)$/i.test(rel)) {
        continue;
      }
      for (const file of loadsOf(read(rel))) {
        // An \input of a file that is not a package file elsewhere (a .cfg, a data file) is the package's own.
        if (!own.has(file) && (file.endsWith('.sty') || file.endsWith('.cls') || byName[file] !== undefined)) {
          requires.add(file);
        }
      }
    }
    entry.requires = [...requires].filter((f) => byName[f] !== name).sort();
  }
  return { format: INDEX_FORMAT, packages, files: byName };
}
