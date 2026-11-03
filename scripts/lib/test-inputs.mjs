// The test inputs' release (docs/DEVELOPING.md, "The TeX engine"): the CTAN files the tests use (engine/pins.json's
// ctan-* sources) from a release of this repository, test-inputs-<snapshot date>-<n>, whose files never change. It
// holds whole works, unchanged: each package's archives from the pinned TeX Live snapshot (engine/bundle-pins.json),
// every archive TeX Live has for the package, since the LPPL counts the distribution of part of a work as a
// modification (clause 2), and CTAN's revtex.tds.zip, which TeX Live does not ship. Each pinned file is a member of
// one of those archives; scripts/engine-assets.mjs unpacks it and checks its SHA-256, as for a file fetched alone.
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later.

import { createHash } from 'node:crypto';
import { readTar } from './tar.mjs';
import { unxz } from './xz.mjs';

/**
 * Each ctan-* source by its TeX Live package, with the package's version and licence as the snapshot's tlpdb and
 * the TeX Catalogue give them, and each pinned file's archive and path in that package (kind: run, doc or source).
 * ctan-revtex is CTAN's revtex.tds.zip, a release file of its own.
 */
export const TEST_INPUTS = {
  'ctan-ieeetran': {
    package: 'ieeetran',
    version: '1.8b',
    licence: 'LPPL 1.3',
    files: {
      'IEEEtran.cls': ['run', 'tex/latex/ieeetran/IEEEtran.cls'],
      'bare_jrnl.tex': ['doc', 'doc/latex/ieeetran/bare_jrnl.tex'],
      'bibtex/IEEEtran.bst': ['run', 'bibtex/bst/ieeetran/IEEEtran.bst'],
    },
  },
  'ctan-elsarticle': {
    package: 'elsarticle',
    version: '3.5',
    licence: 'LPPL 1.3',
    files: {
      'elsarticle.dtx': ['source', 'source/latex/elsarticle/elsarticle.dtx'],
      'elsarticle.ins': ['source', 'source/latex/elsarticle/elsarticle.ins'],
      'elsarticle-template-num.tex': ['doc', 'doc/latex/elsarticle/elsarticle-template-num.tex'],
      'elsarticle-num.bst': ['run', 'bibtex/bst/elsarticle/elsarticle-num.bst'],
    },
  },
  'ctan-beamer-example': {
    package: 'beamer',
    version: '3.78',
    licence: 'the code: GPL 2 or later, or LPPL 1.3c or later; the documentation: GNU FDL 1.3 or later, or LPPL 1.3c or later',
    files: {
      'beamerexample-conference-talk.tex': ['doc', 'doc/latex/beamer/examples/a-conference-talk/beamerexample-conference-talk.tex'],
    },
  },
  'ctan-ucbthesis': {
    package: 'ucbthesis',
    version: '3.6',
    licence: 'LPPL 1.3',
    files: {
      'ucbthesis.cls': ['run', 'tex/latex/ucbthesis/ucbthesis.cls'],
      ...Object.fromEntries(['thesis.tex', 'abstract.tex', 'chap1.tex', 'chap2.tex', 'references.bib'].map((n) => [n, ['doc', `doc/latex/ucbthesis/example/${n}`]])),
    },
  },
  'ctan-acmart': {
    package: 'acmart',
    version: '2.20',
    licence: 'LPPL 1.3',
    files: {
      'acmart.dtx': ['source', 'source/latex/acmart/acmart.dtx'],
      'acmart.ins': ['source', 'source/latex/acmart/acmart.ins'],
      'ACM-Reference-Format.bst': ['run', 'bibtex/bst/acmart/ACM-Reference-Format.bst'],
      ...Object.fromEntries(['samples.dtx', 'samples.ins', 'sample-base.bib', 'sampleteaser.pdf'].map((n) => [`samples/${n}`, ['doc', `doc/latex/acmart/samples/${n}`]])),
    },
  },
  'ctan-llncs': {
    package: 'llncs',
    version: '2.26',
    licence: 'CC BY 4.0 or later; splncs04.bst: LPPL 1 or later',
    files: {
      'llncs.cls': ['run', 'tex/latex/llncs/llncs.cls'],
      'splncs04.bst': ['run', 'bibtex/bst/llncs/splncs04.bst'],
      'llncsdoc.tex': ['doc', 'doc/latex/llncs/llncsdoc.tex'],
    },
  },
  'ctan-pgf-manual': {
    package: 'pgf',
    version: '3.1.12',
    licence: 'LPPL 1.3c, GPL 2, GNU FDL 1.2 (the manual)',
    files: {
      'pgfmanual-en-tutorial.tex': ['doc', 'doc/generic/pgf/pgfmanual-en-tutorial.tex'],
    },
  },
  'ctan-dejavu': {
    package: 'dejavu',
    version: '2.34',
    licence: '(c) Bitstream under the Bitstream Vera terms, the DejaVu changes in the public domain, the glyphs from the Arev fonts (c) Tavmjong Bah under their terms; LPPL 1.3 for the TeX support',
    files: {
      ...Object.fromEntries(
        ['Sans', 'Sans-Bold', 'Sans-Oblique', 'Sans-BoldOblique', 'Serif', 'Serif-Bold', 'Serif-Italic', 'Serif-BoldItalic', 'SansMono', 'SansMono-Bold', 'SansMono-Oblique', 'SansMono-BoldOblique']
          .map((s) => `DejaVu${s}.ttf`)
          .map((f) => [`truetype/${f}`, ['run', `fonts/truetype/public/dejavu/${f}`]]),
      ),
      'doc/font-doc/LICENSE': ['doc', 'doc/fonts/dejavu/LICENSE'],
    },
  },
  'ctan-tensor': {
    package: 'tensor',
    version: '2.2',
    licence: 'LPPL 1.3c',
    files: {
      'tensor.dtx': ['source', 'source/latex/tensor/tensor.dtx'],
      'tensor.ins': ['source', 'source/latex/tensor/tensor.ins'],
    },
  },
};

/** CTAN's REVTeX zip, which the release holds as it is (TeX Live has its files, but not the zip). */
export const REVTEX = { source: 'ctan-revtex', file: 'revtex.tds.zip', version: '4.2f', licence: 'LPPL 1.3c' };

/** The release's tag: test-inputs-<the snapshot's date, YYYYMMDD>-<candidate>. */
export const TAG = /^test-inputs-\d{8}-[1-9]\d*$/;

/** The tag for a snapshot date ("2026/10/15") and a candidate number (1, 2, ...). */
export function testInputsTag(snapshot, candidate) {
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(snapshot)) throw new Error(`not a snapshot date: ${snapshot}`);
  if (!/^[1-9]\d*$/.test(String(candidate))) throw new Error(`the candidate must be a number from 1, not ${candidate}`);
  return `test-inputs-${snapshot.replaceAll('/', '')}-${candidate}`;
}

/** A package's archive file name in the snapshot: <name>.tar.xz, <name>.doc.tar.xz or <name>.source.tar.xz. */
export const archiveName = (pkg, kind) => `${pkg}${kind === 'run' ? '' : `.${kind}`}.tar.xz`;

/**
 * Every archive the snapshot's tlpdb (parseTlpdb) has for a package, with its size and SHA-512: the whole work.
 * @returns {{ name: string, kind: string, size: number, sha512: string }[]}
 */
export function packageArchives(db, pkg) {
  const p = db.get(pkg);
  if (!p) throw new Error(`the pinned snapshot has no package ${pkg}`);
  const out = [{ name: archiveName(pkg, 'run'), kind: 'run', size: p.containerSize, sha512: p.containerChecksum }];
  if (p.docContainerChecksum) out.push({ name: archiveName(pkg, 'doc'), kind: 'doc', size: p.docContainerSize, sha512: p.docContainerChecksum });
  if (p.srcContainerChecksum) out.push({ name: archiveName(pkg, 'source'), kind: 'source', size: p.srcContainerSize, sha512: p.srcContainerChecksum });
  for (const a of out) {
    if (!/^[0-9a-f]{128}$/.test(a.sha512 ?? '') || !(a.size > 0)) throw new Error(`the tlpdb gives ${a.name} no size or SHA-512`);
  }
  return out;
}

/**
 * The release's contents, from the snapshot's tlpdb and engine/pins.json: every archive of each package, CTAN's
 * zip (as its pin gives it) and the tlpdb itself. Throws when a ctan-* source has no entry here, or the reverse, or
 * when a pinned file has no archive and path.
 */
export function releaseContents(db, pins, bundlePins) {
  const ctan = pins.sources.filter((s) => s.id.startsWith('ctan-'));
  const known = new Set([...Object.keys(TEST_INPUTS), REVTEX.source]);
  const problems = [
    ...ctan.filter((s) => !known.has(s.id)).map((s) => `${s.id} is pinned, but the release has no entry for it`),
    ...[...known].filter((id) => !ctan.some((s) => s.id === id)).map((id) => `${id} has an entry, but engine/pins.json does not pin it`),
  ];
  for (const s of ctan.filter((x) => TEST_INPUTS[x.id])) {
    const files = TEST_INPUTS[s.id].files;
    problems.push(...s.files.filter((f) => !files[f.name]).map((f) => `${s.id}: ${f.name} has no archive and path`));
    problems.push(...Object.keys(files).filter((n) => !s.files.some((f) => f.name === n)).map((n) => `${s.id}: ${n} has an archive and path, but no pin`));
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
  const archives = Object.values(TEST_INPUTS).flatMap((t) => packageArchives(db, t.package).map((a) => ({ ...a, package: t.package })));
  const zip = ctan.find((s) => s.id === REVTEX.source).files.find((f) => f.name === REVTEX.file);
  return {
    archives,
    zip: { name: REVTEX.file, size: zip.size, sha256: zip.sha256 },
    tlpdb: { name: 'texlive.tlpdb.xz', sha256: bundlePins.tlpdb.sha256 },
  };
}

const sha = (algo, b) => createHash(algo).update(b).digest('hex');

/** Why an archive's bytes are not the pinned ones, or null. */
export function archiveProblem(bytes, { name, size, sha512 }) {
  if (bytes.length !== size) return `${name} has ${bytes.length} bytes, not the pinned ${size}`;
  if (sha('sha512', bytes) !== sha512) return `${name} is not the pinned archive (SHA-512 ${sha512.slice(0, 16)}...)`;
  return null;
}

/**
 * The named members of a .tar.xz archive (path -> bytes). Throws when a member is missing, so a pin that names a
 * path the archive does not hold fails with that path.
 * @param {Uint8Array} archive
 * @param {string[]} paths
 * @returns {Map<string, Buffer>}
 */
export function unpackMembers(archive, paths) {
  const want = new Set(paths);
  const out = new Map();
  for (const e of readTar(unxz(archive))) {
    if (want.has(e.path)) out.set(e.path, Buffer.from(e.data));
  }
  const missing = paths.filter((p) => !out.has(p));
  if (missing.length > 0) throw new Error(`the archive does not hold ${missing.join(', ')}`);
  return out;
}

/** Why a file's bytes are not the pinned ones, or null. */
export function fileProblem(bytes, { name, size, sha256 }) {
  if (bytes.length !== size) return `${name} has ${bytes.length} bytes, not the pinned ${size}`;
  if (sha('sha256', bytes) !== sha256) return `${name} is not the pinned file (SHA-256 ${sha256.slice(0, 16)}...)`;
  return null;
}
