// TeX Live's package database, texlive.tlpdb (B1; docs/DESIGN.md#engine-and-data): which packages exist, their run
// files, their dependencies, their install actions (maps, hyphenation patterns, formats), their licences, and the
// SHA-512 of each package archive. The bundle builder reads one pinned tlpdb and checks every archive it fetches
// against the SHA-512 listed here, so one pin covers the whole snapshot.
//
// Format: records separated by blank lines; "key value" lines; a line that starts with a space continues the
// file list of the last *files key (runfiles, docfiles, srcfiles, binfiles).

/**
 * @typedef {{ name: string, category: string, revision: number, depends: string[], executes: string[],
 *   runfiles: string[], runSize: number, containerSize: number, containerChecksum: string, license: string[],
 *   ctan: string, shortdesc: string, relocated: boolean, docfiles: string[], docContainerChecksum: string,
 *   docContainerSize: number, srcContainerChecksum: string, srcContainerSize: number, topics: string[] }} TlPackage
 * docfiles and the doc and source archives' SHA-512 serve the data packages' licence files (scripts/lib/licence-texts.mjs);
 * docfiles, the doc archives and the Catalogue topics also serve M5's frame without arXiv (scripts/lib/coverage.mjs).
 */

/** Parses texlive.tlpdb text into packages by name. */
export function parseTlpdb(text) {
  /** @type {Map<string, TlPackage>} */
  const out = new Map();
  let pkg = null;
  let list = null;
  const finish = () => {
    if (pkg) {
      out.set(pkg.name, pkg);
    }
    pkg = null;
    list = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') {
      finish();
      continue;
    }
    if (line.startsWith(' ')) {
      if (list) {
        // " RELOC/tex/latex/foo/foo.sty details=..." : the path is the first word.
        list.push(line.trim().split(' ')[0]);
      }
      continue;
    }
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'name') {
      finish();
      pkg = { name: value, category: '', revision: 0, depends: [], executes: [], runfiles: [], runSize: 0, containerSize: 0, containerChecksum: '', license: [], ctan: '', shortdesc: '', relocated: false, docfiles: [], docContainerChecksum: '', docContainerSize: 0, srcContainerChecksum: '', srcContainerSize: 0, topics: [] };
      continue;
    }
    if (!pkg) {
      continue;
    }
    list = null;
    switch (key) {
      case 'category':
        pkg.category = value;
        break;
      case 'revision':
        pkg.revision = Number(value);
        break;
      case 'shortdesc':
        pkg.shortdesc = value;
        break;
      case 'relocated':
        pkg.relocated = value === '1';
        break;
      case 'depend':
        pkg.depends.push(value);
        break;
      case 'execute':
        pkg.executes.push(value);
        break;
      case 'containersize':
        pkg.containerSize = Number(value);
        break;
      case 'containerchecksum':
        pkg.containerChecksum = value;
        break;
      case 'doccontainerchecksum':
        pkg.docContainerChecksum = value;
        break;
      case 'doccontainersize':
        pkg.docContainerSize = Number(value);
        break;
      case 'srccontainerchecksum':
        pkg.srcContainerChecksum = value;
        break;
      case 'srccontainersize':
        pkg.srcContainerSize = Number(value);
        break;
      case 'catalogue-license':
        pkg.license = value.split(/\s+/).filter(Boolean);
        break;
      case 'catalogue-topics':
        pkg.topics = value.split(/\s+/).filter(Boolean);
        break;
      case 'catalogue-ctan':
        pkg.ctan = value;
        break;
      case 'runfiles':
        pkg.runSize = Number(/size=(\d+)/.exec(value)?.[1] ?? 0);
        list = pkg.runfiles;
        break;
      case 'docfiles':
        list = pkg.docfiles;
        break;
      case 'srcfiles':
      case 'binfiles':
        list = [];
        break;
      default:
        break;
    }
  }
  finish();
  return out;
}

/** The texmf-relative path of a run file ("RELOC/tex/..." or "texmf-dist/tex/..."), or null outside texmf-dist. */
export function texmfPath(file) {
  if (file.startsWith('RELOC/')) {
    return file.slice('RELOC/'.length);
  }
  if (file.startsWith('texmf-dist/')) {
    return file.slice('texmf-dist/'.length);
  }
  return null;
}

/**
 * Whether a name is a platform package ("foo.ARCH" in a depend line, or "foo.x86_64-linux": programs) or one of the
 * installer's records (00texlive.*). texlive.infra, which holds the fmtutil and updmap headers, is neither.
 */
export const isPlatform = (name) =>
  /^00texlive\./.test(name) || /\.(ARCH|windows|win32|universal-darwin|[a-z0-9_]+-(linux|linuxmusl|darwin|darwinlegacy|cygwin|freebsd|netbsd|solaris))$/.test(name);

/** Whether a package is a collection or a scheme (a list of other packages, with no files of its own). */
export const isMeta = (name) => name.startsWith('collection-') || name.startsWith('scheme-');

/**
 * The packages a selection names, with their dependencies. A selection lists collections (their packages are
 * included; a collection they depend on is included only if the selection names it too) and packages (with every
 * package they depend on). Platform packages ("foo.ARCH", programs) and excluded names are left out, also as a
 * dependency. "exclude" is a list of names, or an object of name: reason.
 * @param {Map<string, TlPackage>} db
 * @param {{ collections?: string[], packages?: string[], match?: string[], exclude?: string[] | Record<string, string> }} selection
 * @returns {{ packages: Set<string>, missing: string[] }}
 */
export function resolveSelection(db, selection) {
  const exclude = new Set(Array.isArray(selection.exclude) ? selection.exclude : Object.keys(selection.exclude ?? {}));
  const packages = new Set();
  const missing = [];
  const addPackage = (name, from) => {
    if (isPlatform(name) || isMeta(name) || exclude.has(name) || packages.has(name)) {
      return;
    }
    const pkg = db.get(name);
    if (!pkg) {
      missing.push(from ? `${name} (needed by ${from})` : name);
      return;
    }
    packages.add(name);
    for (const dep of pkg.depends) {
      addPackage(dep, name);
    }
  };
  for (const name of selection.collections ?? []) {
    const coll = db.get(name);
    if (!coll) {
      missing.push(name);
      continue;
    }
    for (const dep of coll.depends) {
      if (!isMeta(dep)) {
        addPackage(dep, name);
      }
    }
  }
  for (const name of selection.packages ?? []) {
    addPackage(name, undefined);
  }
  // Packages by name pattern (all hyphenation patterns, all babel languages).
  for (const pattern of selection.match ?? []) {
    const re = new RegExp(pattern);
    for (const name of [...db.keys()].sort()) {
      if (re.test(name)) {
        addPackage(name, undefined);
      }
    }
  }
  return { packages, missing };
}

/** Parses "key=value key2=\"quoted value\" ..." as TeX Live's execute lines write them. */
export function parseKeyValues(text) {
  const out = {};
  const re = /(\w+)=("([^"]*)"|\S*)/g;
  let m;
  while ((m = re.exec(text))) {
    out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  }
  return out;
}

/**
 * The install actions of the selected packages, in package-name order: font maps (Map, MixedMap, KanjiMap),
 * hyphenation patterns (AddHyphen) and formats (AddFormat), each with its package.
 */
export function installActions(db, names) {
  const maps = new Map();
  const hyphens = [];
  const formats = [];
  for (const name of [...names].sort()) {
    const pkg = db.get(name);
    for (const ex of pkg?.executes ?? []) {
      const [verb, ...rest] = ex.split(' ');
      const args = rest.join(' ');
      if (verb === 'addMap' || verb === 'addMixedMap' || verb === 'addKanjiMap') {
        maps.set(args.trim(), { kind: verb === 'addMap' ? 'Map' : verb === 'addMixedMap' ? 'MixedMap' : 'KanjiMap', package: name });
      } else if (verb === 'AddHyphen') {
        const kv = parseKeyValues(args);
        hyphens.push({
          package: name,
          name: kv.name,
          file: kv.file ?? '',
          lefthyphenmin: kv.lefthyphenmin ?? '',
          righthyphenmin: kv.righthyphenmin ?? '',
          synonyms: (kv.synonyms ?? '').split(',').filter(Boolean),
          filePatterns: kv.file_patterns || undefined,
          fileExceptions: kv.file_exceptions || undefined,
          luaspecial: kv.luaspecial || undefined,
          databases: (kv.databases ?? 'dat,def,lua').split(','),
          comment: kv.comment || undefined,
        });
      } else if (verb === 'AddFormat') {
        const kv = parseKeyValues(args);
        formats.push({ package: name, name: kv.name, engine: kv.engine, patterns: kv.patterns ?? '-', options: kv.options ?? '', mode: kv.mode !== 'disabled', triggers: (kv.fmttriggers ?? '').split(',').filter(Boolean) });
      }
    }
  }
  return { maps, hyphens, formats };
}

/**
 * The licences a free data set may carry (the Catalogue's names), by prefix. gfl and gfsl are the GUST Font
 * License and the GUST Font Source License (Latin Modern, TeX Gyre); build gate B1, GB1E-01. 0bsd is the
 * zero-clause BSD licence (added 2026-10-22, with the publisher classes).
 */
const FREE = [/^lppl/, /^gfl$/, /^gfsl$/, /^gpl/, /^lgpl/, /^agpl/, /^fdl/, /^ofl/, /^apache/, /^bsd/, /^0bsd$/, /^mit$/, /^pd$/, /^cc0$/, /^cc-by(-sa)?(-\d)?/, /^knuth$/, /^artistic/, /^other-free$/, /^eupl/, /^isc$/, /^x11$/, /^zlib$/];

/**
 * The licence class of a package: "free" (every licence the Catalogue gives it is free), "nonfree" (one is not:
 * nosell, nocommercial, cc-by-nc, other-nonfree, noinfo, nosource and the like), or "none" (no Catalogue entry:
 * TeX Live's own infrastructure, under TeX Live's licences).
 */
export function licenceClass(pkg) {
  if (pkg.license.length === 0) {
    return 'none';
  }
  return pkg.license.every((l) => FREE.some((re) => re.test(l)) && !/-nc\b|-nd\b/.test(l)) ? 'free' : 'nonfree';
}
