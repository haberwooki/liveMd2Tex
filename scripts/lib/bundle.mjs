// The parts of B1's bundle builder that need no engine (docs/DESIGN.md#engine-and-data): choosing the packages of
// core-data and extra-data from the pinned tlpdb, fetching and checking their archives, unpacking them, making
// the generated files of the tree, and laying out the two images. scripts/build-bundle.mjs runs them in order;
// scripts/lib/bundle-engine.mjs adds the formats and the closure test, which need the engine.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { lsR, buildFontMaps, fmtutilCnf, languageDat, languageDef, languageLua, updmapCfg } from './texmf-config.mjs';
import { isLicenceFile } from './licence-texts.mjs';
import { installActions, isMeta, licenceClass, resolveSelection, texmfPath } from './tlpdb.mjs';
import { readTar, safePath } from './tar.mjs';
import { t1cPack, t1cUnpack } from './t1c.mjs';
import { unxz } from './xz.mjs';

/** Where the core's TeX tree sits in the engine's file system (the worker's TEXMFDIST). */
export const CORE_ROOT = 'texlive/texmf-dist';

/** Catalogue labels that say little about the terms, so a person's reading of the files may replace them. */
const VAGUE = ['collection', 'other-free'];

/**
 * The licences of a package: the Catalogue's, or, for a package whose Catalogue label is vague ("collection":
 * files under several licences; "other-free": a free licence the Catalogue does not name), the licences a person
 * read in its files (engine/bundle-sets.json, "licenceReviews"). So may a package with no Catalogue licence. A review
 * never replaces a named licence.
 */
export function licenceOf(pkg, reviews = {}) {
  const review = reviews[pkg.name];
  return review && (pkg.license.length === 0 || pkg.license.some((l) => VAGUE.includes(l))) ? review.licences : pkg.license;
}

/**
 * The packages of each set. core-data is what its selection names; extra-data is what its selection and groups
 * name, minus core-data. Licence rules: a set's "free" rule takes packages whose Catalogue licences are all free
 * (and TeX Live's own files, which have no Catalogue entry); a group's "licences" narrows it further. A set's
 * "exclude" (name: reason) leaves a package out on purpose, listed with its reason; in core-data, any other
 * package that is not free stops the build. core-data's "toExtra" (name: reason) leaves a package out of core-data,
 * also as a dependency, and gives it to extra-data. "licenceReviews" give the licences of "collection" packages.
 * @returns {{ core: Set<string>, extra: Set<string>, missing: string[], dropped: { package: string, set: string, reason: string }[], problems: string[], moved: { package: string, reason: string, inExtra: boolean }[] }}
 */
export function selectSets(db, sets) {
  const missing = [];
  const dropped = [];
  const problems = [];
  const reviews = sets.licenceReviews ?? {};
  const classOf = (pkg) => licenceClass({ ...pkg, license: licenceOf(pkg, reviews) });
  // toExtra (name: reason): left out of core-data, also as a dependency, and given to extra-data instead.
  const toExtra = sets['core-data'].toExtra ?? {};
  const coreSpec = sets['core-data'];
  const coreExcludeNames = Array.isArray(coreSpec.exclude) ? coreSpec.exclude : Object.keys(coreSpec.exclude ?? {});
  const coreSel = resolveSelection(db, { ...coreSpec, exclude: [...coreExcludeNames, ...Object.keys(toExtra)] });
  missing.push(...coreSel.missing.map((m) => `core-data: ${m}`));
  const core = new Set();
  // Left out on purpose, also as a dependency (resolveSelection skips them), and listed with the reason.
  const reasons = (spec) => (Array.isArray(spec.exclude) ? Object.fromEntries(spec.exclude.map((n) => [n, 'excluded'])) : (spec.exclude ?? {}));
  const coreExclude = reasons(sets['core-data']);
  for (const [name, reason] of Object.entries(coreExclude)) {
    dropped.push({ package: name, set: 'core-data', reason });
  }
  for (const name of coreSel.packages) {
    if (classOf(db.get(name)) === 'nonfree') {
      problems.push(`core-data: ${name} has a licence that is not free (${db.get(name).license.join(' ')})`);
    } else {
      core.add(name);
    }
  }
  const extraSpec = sets['extra-data'];
  const extraSel = resolveSelection(db, { ...extraSpec, packages: [...(extraSpec.packages ?? []), ...Object.keys(toExtra)] });
  missing.push(...extraSel.missing.map((m) => `extra-data: ${m}`));
  const candidates = new Map([...extraSel.packages].map((p) => [p, null]));
  for (const group of extraSpec.groups ?? []) {
    const sel = resolveSelection(db, group);
    missing.push(...sel.missing.map((m) => `extra-data group: ${m}`));
    // A group's own rules are for its own packages: its collections' members and the packages it names. A
    // package the set already selects, or one that a member only depends on (a font, a helper), keeps the set's
    // own rule. "licences" narrows the licences a member may have; "readFirst" names Catalogue labels whose
    // members come in only once a person has read their files (licenceReviews).
    const rule = { allow: (group.licences ?? []).map((r) => new RegExp(r)), readFirst: group.readFirst ?? [] };
    const members = new Set([...(group.collections ?? []).flatMap((c) => db.get(c)?.depends ?? []), ...(group.packages ?? [])]);
    for (const p of sel.packages) {
      if (!candidates.has(p)) {
        candidates.set(p, members.has(p) ? rule : null);
      }
    }
  }
  const extra = new Set();
  // Left out on purpose and listed with the reason, whether the set or one of its groups selects the package.
  const extraExclude = reasons(extraSpec);
  for (const [name, reason] of Object.entries(extraExclude)) {
    dropped.push({ package: name, set: 'extra-data', reason });
  }
  for (const [name, rule] of candidates) {
    if (core.has(name) || Object.hasOwn(coreExclude, name) || Object.hasOwn(extraExclude, name)) {
      continue;
    }
    const pkg = db.get(name);
    const licence = licenceOf(pkg, reviews);
    // "none" in readFirst stands for no Catalogue licence at all.
    const unread = rule?.readFirst.filter((l) => (l === 'none' ? pkg.license.length === 0 : pkg.license.includes(l)) && !reviews[name]) ?? [];
    if (classOf(pkg) === 'nonfree') {
      dropped.push({ package: name, set: 'extra-data', reason: `licence ${licence.join(' ')} is not free` });
    } else if (unread.length > 0) {
      dropped.push({ package: name, set: 'extra-data', reason: `licence ${unread.join(' ')}: its files are not read yet (licenceReviews)` });
    } else if (rule?.allow.length && !(licence.length > 0 && licence.every((l) => rule.allow.some((re) => re.test(l))))) {
      dropped.push({ package: name, set: 'extra-data', reason: `licence ${licence.join(' ') || '(none)'} is not one the group allows` });
    } else {
      extra.add(name);
    }
  }
  const moved = Object.entries(toExtra).map(([name, reason]) => ({ package: name, reason, inExtra: extra.has(name) }));
  return { core, extra, missing, dropped, problems, moved };
}

/** The SHA-512 of a buffer, as tlpdb's containerchecksum writes it. */
export const sha512 = (b) => createHash('sha512').update(b).digest('hex');
export const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/**
 * A package's archive in tlnet and the SHA-512 the tlpdb gives for it: its run files (archive/<name>.tar.xz), or its
 * doc or source files (<name>.doc.tar.xz, <name>.source.tar.xz), which the data packages' licence files come from.
 */
export function archiveFile(name, pkg, kind = 'run') {
  if (kind === 'doc') {
    return { file: `${name}.doc.tar.xz`, checksum: pkg.docContainerChecksum };
  }
  if (kind === 'source') {
    return { file: `${name}.source.tar.xz`, checksum: pkg.srcContainerChecksum };
  }
  return { file: `${name}.tar.xz`, checksum: pkg.containerChecksum };
}

/**
 * A package's archive (archive/<name>.tar.xz, or its doc or source archive: `kind`), from the cache when its SHA-512
 * matches the tlpdb, else from the first mirror that gives the right bytes. Never a file whose checksum is wrong.
 */
export async function fetchArchive(name, pkg, { cache, mirrors, fetchImpl = fetch, kind = 'run' }) {
  const { file: archiveName, checksum } = archiveFile(name, pkg, kind);
  const file = path.join(cache, 'archive', archiveName);
  if (existsSync(file)) {
    const cached = readFileSync(file);
    if (sha512(cached) === checksum) {
      return cached;
    }
  }
  const errors = [];
  for (const base of mirrors) {
    try {
      const res = await fetchImpl(`${base}archive/${archiveName}`);
      if (!res.ok) {
        errors.push(`${base}: HTTP ${res.status}`);
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (sha512(bytes) !== checksum) {
        errors.push(`${base}: the SHA-512 is not the tlpdb's`);
        continue;
      }
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      return bytes;
    } catch (err) {
      errors.push(`${base}: ${err instanceof Error ? err.message : err}`);
    }
  }
  throw new Error(`${archiveName} could not be fetched: ${errors.join('; ')}`);
}

/**
 * Trees TeX never reads: documentation, sources and programs. Both sets leave them out, also where TeX Live lists
 * them as run files (koma-script lists its whole tree), because the data sets hold what TeX reads and nothing else.
 */
export const NOT_TEX = /^(doc|source|scripts)\//;

/**
 * Whether a file is a program or a program archive, which no data set may ship: Java and Python archives, Python,
 * Perl and shell scripts, Windows and Unix binaries, and Lua outside the TeX tree (Lua under tex/ is LuaTeX's
 * data). The builder fails on one; a package that holds one is left out with its reason.
 */
export function isProgramFile(rel) {
  return /\.(jar|whl|egg|py|pyc|pyw|pl|pm|exe|dll|so|dylib|sh|bash|bat|cmd|ps1|vbs|class|msi)$/i.test(rel) || (/\.lua$/i.test(rel) && !/^(texmf-var\/)?tex\//.test(rel));
}

/**
 * The run files of a package from its archive: texmf-relative path -> bytes. A relocated archive holds paths
 * relative to the tree; another holds texmf-dist/...; tlpkg/ (the package's own record) is left out, and so are
 * doc/, source/ and scripts/ (NOT_TEX; their bytes are counted in skipped). Each other run file the tlpdb lists must
 * be there. A symbolic link inside the package is followed; one leading out of it is a problem. `licences` holds
 * the archive's licence files by name that the image leaves out (under doc/, or at the archive's root, as
 * texlive.infra's LICENSE.TL), for the data package's LICENSES/ (scripts/lib/licence-texts.mjs).
 */
export function unpackPackage(name, pkg, xzBytes) {
  const problems = [];
  const files = new Map();
  const licences = new Map();
  const links = [];
  const skipped = { files: 0, bytes: 0 };
  for (const entry of readTar(unxz(xzBytes))) {
    let rel = entry.path;
    if (rel.startsWith('tlpkg/')) {
      continue;
    }
    if (rel.startsWith('texmf-dist/')) {
      rel = rel.slice('texmf-dist/'.length);
    } else if (!pkg.relocated) {
      // A file outside the tree (bin/, readme files at the root); a licence file among them is kept for LICENSES/.
      if (entry.type === 'file' && isLicenceFile(rel)) {
        licences.set(rel, Buffer.from(entry.data));
      }
      continue;
    }
    if (NOT_TEX.test(rel)) {
      skipped.files++;
      skipped.bytes += entry.data?.length ?? 0;
      if (entry.type === 'file' && isLicenceFile(rel)) {
        licences.set(rel, Buffer.from(entry.data));
      }
      continue;
    }
    if (entry.type === 'file') {
      files.set(rel, Buffer.from(entry.data));
    } else if (entry.type === 'symlink' || entry.type === 'hardlink') {
      links.push({ rel, entry });
    }
  }
  for (const { rel, entry } of links) {
    const target = entry.type === 'hardlink' ? safePath(entry.link.replace(/^texmf-dist\//, '')) : safePath(path.posix.join(path.posix.dirname(rel), entry.link));
    if (target !== null && files.has(target)) {
      files.set(rel, files.get(target));
    } else {
      problems.push(`${name}: ${rel} is a link to ${entry.link}, which the package does not hold`);
    }
  }
  for (const listed of pkg.runfiles.map(texmfPath).filter((p) => p !== null && !NOT_TEX.test(p))) {
    if (!files.has(listed)) {
      problems.push(`${name}: the tlpdb lists ${listed}, which the archive does not hold`);
    }
  }
  return { files, problems, skipped, licences };
}

/** Finds a map file by name in the trees (updmap finds it with kpsewhich, by name). */
function mapFinder(...trees) {
  const byName = new Map();
  for (const tree of trees) {
    for (const [rel, bytes] of tree) {
      if (rel.startsWith('fonts/map/') && rel.endsWith('.map')) {
        const base = path.posix.basename(rel);
        if (!byName.has(base)) {
          byName.set(base, bytes);
        }
      }
    }
  }
  return (file) => byName.get(file)?.toString('latin1');
}

/**
 * The generated files of the core tree (texmf-relative): fmtutil.cnf and updmap.cfg in web2c/, the language files
 * and the font maps in texmf-var/. The hyphenation patterns and formats are the core's; the font maps cover both
 * sets, so a font of the add-on is embedded once the add-on is installed.
 */
export function generatedFiles(db, core, extra, coreFiles, extraFiles) {
  const text = (rel) => {
    const b = coreFiles.get(rel);
    if (!b) {
      throw new Error(`core-data has no ${rel}, which the generated files start from`);
    }
    return b.toString('utf8');
  };
  const coreActions = installActions(db, core);
  const allMaps = installActions(db, [...core, ...extra]).maps;
  const fonts = buildFontMaps(allMaps, mapFinder(coreFiles, extraFiles));
  const out = new Map([
    ['web2c/fmtutil.cnf', fmtutilCnf(text('web2c/fmtutil-hdr.cnf'), coreActions.formats)],
    ['web2c/updmap.cfg', updmapCfg(text('web2c/updmap-hdr.cfg'), allMaps)],
    ['texmf-var/tex/generic/config/language.dat', languageDat(text('tex/generic/config/language.us'), coreActions.hyphens)],
    ['texmf-var/tex/generic/config/language.def', languageDef(text('tex/generic/config/language.us.def'), coreActions.hyphens)],
    ['texmf-var/tex/generic/config/language.dat.lua', languageLua(text('tex/generic/config/language.us.lua'), coreActions.hyphens)],
    // pdftex.map only: pdfTeX reads it, and xdvipdfmx's configuration names it and kanjix.map. updmap's two copies
    // (pdftex_dl14.map, pdftex_ndl14.map) are read by nothing here.
    ['texmf-var/fonts/map/pdftex/updmap/pdftex.map', fonts.pdftexDl14],
    ['texmf-var/fonts/map/dvipdfmx/updmap/kanjix.map', fonts.kanjix],
  ]);
  return { files: new Map([...out].map(([k, v]) => [k, Buffer.from(v, 'utf8')])), formats: coreActions.formats, hyphens: coreActions.hyphens, mapProblems: { missing: fonts.missing, conflicts: fonts.conflicts } };
}

/** Files of one tree that another tree also has (core-data and extra-data may share none). */
export function overlap(a, b) {
  return [...b.keys()].filter((k) => a.has(k));
}

/**
 * The core image's files, by absolute path in the worker without the leading "/": the engine's own support files
 * (from the pinned engine build, outside the TeX tree), the TeX tree under texlive/texmf-dist, the generated
 * files, the formats when built, and one ls-R for the whole tree.
 *
 * The worker's TEXMFVAR (texmf-var, with the generated files and the formats) lies inside TEXMFDIST. kpathsea then
 * answers a search of TEXMFVAR from TEXMFDIST's ls-R alone, so that ls-R must list texmf-var too. Without it, the
 * generated language.dat was invisible and TeX Live's default one, which names every language, was read instead
 * (the second CI build).
 */
export function coreImageFiles(coreFiles, generated, engineFiles, formats = new Map()) {
  const out = new Map();
  for (const [p, b] of engineFiles) {
    out.set(p, b);
  }
  const tree = new Map([...coreFiles, ...generated, ...formats]);
  for (const [rel, b] of tree) {
    out.set(`${CORE_ROOT}/${rel}`, b);
  }
  out.set(`${CORE_ROOT}/ls-R`, Buffer.from(lsR([...tree.keys()])));
  return out;
}

/**
 * The image's Type 1 fonts packed with t1c (scripts/lib/t1c.mjs): each .pfb stored with its eexec section and
 * charstrings decrypted, so the LZ4 layer and the package's zip compress it. A file is packed only when unpacking
 * gives it back byte for byte, and not when `keep(path)` says to store it as it is (a font whose licence does not
 * plainly cover a stored form: engine/bundle-sets.json, core-data's "t1cSkip"). Returns the files to write and, by
 * the image's file name ("/" + path), the SHA-256 of each original, which the engine host checks when it unpacks
 * (src/engine-host/engine/t1c.ts).
 */
export function packType1(tree, keep = () => false) {
  const files = new Map();
  const packed = {};
  for (const [p, b] of tree) {
    if (/\.pfb$/i.test(p) && !keep(p)) {
      const q = t1cPack(b);
      if (q && Buffer.from(t1cUnpack(q)).equals(Buffer.from(b))) {
        files.set(p, q);
        packed[`/${p}`] = sha256(b);
        continue;
      }
    }
    files.set(p, b);
  }
  return { files, packed };
}

/**
 * The licence under which each package's packed Type 1 fonts are stored, for core-data's LICENSE.txt: "lppl" for
 * the LPPL 1.3 to 1.3c and the GUST Font License (the LPPL 1.3c or later, with one request), whose clause 9 speaks
 * to a stored form; "gpl" for the GNU GPL. A package with neither is "unread": its fonts must be stored as they
 * are, with the reason in core-data's "t1cSkip" (engine/bundle-sets.json).
 * @param {Iterable<string>} names  the packages that own packed files
 * @param {(name: string) => string[]} licencesOf  each package's licences (licenceOf)
 */
export function packedFontLicences(names, licencesOf) {
  const out = { lppl: [], gpl: [], unread: [] };
  for (const n of [...new Set(names)].sort()) {
    out[licenceGroup(licencesOf(n))].push(n);
  }
  return out;
}

/**
 * A package's class for its fonts, from its Catalogue licences (packedFontLicences): "lppl", "gpl" or "unread". A
 * font whose own header states nothing, or points to its package's licence, takes it (classifyFonts).
 */
export const licenceGroup = (licences) => (licences.some((l) => /^lppl1\.3[a-c]?$/.test(l) || l === 'gfl') ? 'lppl' : licences.some((l) => /^gpl/.test(l)) ? 'gpl' : 'unread');

/** The extra image's files: texmf-relative paths (mounted under /texmf-extra), with its own ls-R. */
export function extraImageFiles(extraFiles) {
  const out = new Map(extraFiles);
  out.set('ls-R', Buffer.from(lsR([...extraFiles.keys()])));
  return out;
}

/**
 * The files of the pinned engine build's image that are not part of the TeX tree: /bin/busytex, /etc/passwd,
 * fontconfig's file, the ICU data XeTeX needs, /texlive/texmf.cnf and the like. The TeX tree itself, its
 * texmf.cnf included, comes from the TeX Live snapshot.
 */
export function engineSupportFiles(imageFiles) {
  const out = new Map();
  for (const [p, b] of imageFiles) {
    if (!p.startsWith(`${CORE_ROOT}/`)) {
      out.set(p, b);
    }
  }
  return out;
}

/** The kind of a file in an image, for the size report: by folder and extension. */
export function fileKind(name) {
  const rel = name.replace(/^\/?(texlive\/texmf-dist\/)?/, '');
  if (/^doc\//.test(rel)) return 'documentation (doc/)';
  if (/^source\//.test(rel) || /\.(dtx|ins)$/i.test(rel)) return 'sources (.dtx, .ins, source/)';
  if (/\.fmt$/.test(rel)) return 'formats';
  if (/\.pfb$/i.test(rel)) return 'fonts: Type 1';
  if (/\.(otf|ttf|ttc)$/i.test(rel)) return 'fonts: OpenType and TrueType';
  if (/\.tfm$/i.test(rel)) return 'fonts: TFM';
  if (/\.vf$/i.test(rel)) return 'fonts: VF';
  if (/\.afm$/i.test(rel)) return 'fonts: AFM (metrics no engine here reads)';
  if (/\.(pfm|enc|map|fd|ofm|ovf|ovp|pl|vpl|mf)$/i.test(rel)) return 'fonts: other (enc, map, fd, mf, pfm)';
  if (/^tex\/generic\/(hyph-utf8|hyphen|dehyph[^/]*)\/|\.pat(\.txt)?$/i.test(rel)) return 'hyphenation patterns';
  if (/^scripts\//.test(rel)) return 'scripts/ (programs TeX never runs)';
  if (/^(bin|etc)\/|^texlive\/[^/]+$/.test(rel)) return 'engine support (ICU data, /bin, /etc)';
  if (/\.lua$/i.test(rel)) return 'Lua (LuaTeX only)';
  return 'TeX macros and the rest';
}

/**
 * Where an image's bytes go, for the size report: by kind of file, and its largest files. Documentation and
 * sources should be zero: only run files are unpacked.
 */
export function sizeBreakdown(imageFiles, top = 25) {
  const byKind = new Map();
  const all = [];
  for (const [name, b] of imageFiles) {
    byKind.set(fileKind(name), (byKind.get(fileKind(name)) ?? 0) + b.length);
    all.push({ name, bytes: b.length });
  }
  return {
    byKind: Object.fromEntries([...byKind].sort((a, b) => b[1] - a[1])),
    topFiles: all.sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : 1)).slice(0, top),
  };
}

/** Bytes per package and per set, for the size report. */
export function sizeTable(db, names, files) {
  const byPackage = [];
  for (const name of [...names].sort()) {
    const pkg = db.get(name);
    const own = (pkg?.runfiles ?? []).map(texmfPath).filter((p) => p !== null && files.has(p));
    byPackage.push({ name, files: own.length, bytes: own.reduce((n, p) => n + files.get(p).length, 0) });
  }
  return byPackage.sort((a, b) => b.bytes - a.bytes);
}

export { isMeta };
