#!/usr/bin/env node
// Release tool, run on GitHub's runners by .github/workflows/test-inputs.yml (docs/DEVELOPING.md, "The TeX engine"):
// assembles the test inputs' release, test-inputs-<snapshot date>-<n>, from the pinned TeX Live snapshot and CTAN's
// revtex.tds.zip (scripts/lib/test-inputs.mjs says what it holds and why). Like scripts/release-sources.mjs, it
// starts no program and opens no connection: it writes curl configs, the workflow's curl fetches, and `check` checks
// every byte before the draft exists:
//   - the tlpdb against the SHA-256 engine/bundle-pins.json pins (that pin rests on TeX Live's signature);
//   - each archive against the tlpdb's size and SHA-512;
//   - CTAN's zip against its pin's size and SHA-256;
//   - each pinned test file, unpacked from its archive, against its pin's size and SHA-256, so the release is known
//     to give the pinned bytes.
// Then it writes the release's files (DIR/assets/: the archives, the zip, the tlpdb and test-inputs.json, the list
// of every file with its hashes and where it comes from) and its notes (DIR/notes.md).
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later.
//
//   node scripts/test-inputs.mjs meta --out DIR      writes DIR/meta.curl: the pinned tlpdb into DIR/meta/
//   node scripts/test-inputs.mjs list --out DIR      checks the tlpdb; writes DIR/files.curl: the archives and the zip
//   node scripts/test-inputs.mjs check --out DIR --candidate N --commit SHA --repository URL
//                                                    checks everything; writes DIR/assets/, DIR/notes.md, DIR/tag

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotMirrors } from './release-sources.mjs';
import { REVTEX, TEST_INPUTS, archiveName, archiveProblem, fileProblem, releaseContents, testInputsTag, unpackMembers } from './lib/test-inputs.mjs';
import { parseTlpdb } from './lib/tlpdb.mjs';
import { unxz } from './lib/xz.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const sha = (algo, b) => createHash(algo).update(b).digest('hex');
const curlEntry = (url, file) => `url = ${JSON.stringify(url)}\noutput = ${JSON.stringify(file.replace(/\\/g, '/'))}\n`;

/** The pinned tlpdb from DIR/meta/, checked against its pin, parsed. */
function pinnedTlpdb(dir, bundlePins) {
  const file = path.join(dir, 'meta', 'texlive.tlpdb.xz');
  const bytes = readFileSync(file);
  if (sha('sha256', bytes) !== bundlePins.tlpdb.sha256) {
    throw new Error(`${file} is not the pinned tlpdb (engine/bundle-pins.json: SHA-256 ${bundlePins.tlpdb.sha256})`);
  }
  return { bytes, db: parseTlpdb(Buffer.from(unxz(bytes)).toString('utf8')) };
}

/**
 * The release's notes: where the files come from, that they are unchanged, and each package's version and licence,
 * with what its licence asks (llncs: credit and a link; DejaVu: its notice, which its doc archive holds).
 */
export function releaseNotes({ tag, contents, snapshotUrl, bundlePins, commit, repository }) {
  const sizeMb = (n) => `${(n / 1e6).toFixed(1)} MB`;
  const rows = Object.values(TEST_INPUTS).map((t) => {
    const names = contents.archives.filter((a) => a.package === t.package).map((a) => `\`${a.name}\``);
    return `| ${t.package} | ${t.version} | ${t.licence} | ${names.join(', ')} |`;
  });
  return [
    `# ${tag}`,
    '',
    "The files liveMd2Tex's tests take from CTAN's packages, as whole works and unchanged. They are used only by the tests and are in no store package.",
    '',
    `- **From the pinned TeX Live snapshot,** ${snapshotUrl}: every archive TeX Live has for each package (its run, documentation and source archives), so each package is complete, as its licence asks (the LaTeX Project Public License counts the distribution of part of a work as a modification). Each archive's SHA-512 is the one in the snapshot's package database, \`texlive.tlpdb.xz\`, which is here too: its SHA-256 is \`${bundlePins.tlpdb.sha256}\`, pinned in \`engine/bundle-pins.json\` after TeX Live's signature was checked (${bundlePins.tlpdb.signatureChecked}).`,
    `- **From CTAN,** \`${REVTEX.file}\`: REVTeX ${REVTEX.version} as CTAN gives it (https://ctan.org/pkg/revtex, ${REVTEX.licence}), which TeX Live does not ship as one file. SHA-256 \`${contents.zip.sha256}\`.`,
    `- \`test-inputs.json\` lists every file with its size, SHA-256 (and SHA-512 for the archives) and where it comes from, and each test file the archives hold, with its path and SHA-256.`,
    `- Made by \`.github/workflows/test-inputs.yml\` at ${repository}/commit/${commit}, which checked every file, and each test file after unpacking, before this release was made.`,
    '',
    '| Package | Version | Licence (TeX Catalogue) | Archives |',
    '|---|---|---|---|',
    ...rows,
    '',
    "- **llncs:** Copyright (c) 1996-2025 Springer, under the Creative Commons Attribution license, version 4.0 or later (its README, `doc/latex/llncs/README.md` in `llncs.doc.tar.xz`; https://creativecommons.org/licenses/by/4.0/). Nothing in it is changed. Its `splncs04.bst`, generated with makebst, carries Patrick W Daly's notice: the LaTeX Project Public License, version 1 or later.",
    '- **DejaVu:** the fonts are (c) Bitstream under the Bitstream Vera terms, with the DejaVu changes in the public domain and the glyphs from the Arev fonts (c) Tavmjong Bah under their terms; both notices are `doc/fonts/dejavu/LICENSE` in `dejavu.doc.tar.xz`. No font is sold by itself.',
    "- **GPL and GNU FDL parts** (beamer, pgf): the archives are their TeX sources, as their licences ask. beamer's licence texts are in `doc/latex/beamer/licenses/` in `beamer.doc.tar.xz` (the GNU FDL, the GPL 2 and the LPPL 1.3c), with its `LICENSE.md`; pgf's terms are its manual's licence chapter, `doc/generic/pgf/pgfmanual-en-license.tex` in `pgf.doc.tar.xz`.",
    '',
    `In all: ${contents.archives.length} archives (${sizeMb(contents.archives.reduce((n, a) => n + a.size, 0))}), the zip (${sizeMb(contents.zip.size)}), the tlpdb and the list.`,
    '',
  ].join('\n');
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const [command] = argv;
  const dir = path.resolve(arg('--out') ?? '');
  if (!arg('--out')) throw new Error('give --out DIR');
  const pins = readJson(path.join(root, 'engine', 'pins.json'));
  const bundlePins = readJson(path.join(root, 'engine', 'bundle-pins.json'));
  const snapshotUrl = snapshotMirrors(bundlePins)[0];
  if (command === 'meta') {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'meta.curl'), curlEntry(`${snapshotUrl}${bundlePins.tlpdb.file}`, path.join(dir, 'meta', 'texlive.tlpdb.xz')));
    console.log(`meta.curl: the pinned tlpdb (${bundlePins.snapshot})`);
    return 0;
  }
  const { bytes: tlpdbBytes, db } = pinnedTlpdb(dir, bundlePins);
  const contents = releaseContents(db, pins, bundlePins);
  const zipPin = pins.sources.find((s) => s.id === REVTEX.source).files.find((f) => f.name === REVTEX.file);
  if (command === 'list') {
    const lines = contents.archives.map((a) => curlEntry(`${snapshotUrl}archive/${a.name}`, path.join(dir, 'files', a.name)));
    lines.push(curlEntry(zipPin.url, path.join(dir, 'files', REVTEX.file)));
    writeFileSync(path.join(dir, 'files.curl'), lines.join(''));
    console.log(`files.curl: ${contents.archives.length} archives and ${REVTEX.file}`);
    return 0;
  }
  if (command !== 'check') throw new Error(`unknown command: ${command ?? '(none)'}`);
  const tag = testInputsTag(bundlePins.snapshot, arg('--candidate'));
  const problems = [];
  const read = (name) => {
    const file = path.join(dir, 'files', name);
    return existsSync(file) ? readFileSync(file) : null;
  };
  const archives = new Map();
  for (const a of contents.archives) {
    const bytes = read(a.name);
    const problem = bytes ? archiveProblem(bytes, a) : `${a.name} is not downloaded`;
    if (problem) problems.push(problem);
    else archives.set(a.name, bytes);
  }
  const zip = read(REVTEX.file);
  const zipProblem = zip ? fileProblem(zip, { name: REVTEX.file, size: zipPin.size, sha256: zipPin.sha256 }) : `${REVTEX.file} is not downloaded`;
  if (zipProblem) problems.push(zipProblem);
  // Each pinned test file, from its archive.
  const members = {};
  for (const [id, t] of Object.entries(TEST_INPUTS)) {
    const source = pins.sources.find((s) => s.id === id);
    members[id] = [];
    const byArchive = new Map();
    for (const entry of Object.entries(t.files)) {
      const name = archiveName(t.package, entry[1][0]);
      byArchive.set(name, [...(byArchive.get(name) ?? []), entry]);
    }
    for (const [name, list] of byArchive) {
      if (!contents.archives.some((a) => a.name === name)) {
        problems.push(`${id}: ${list.map(([n]) => n).join(', ')} would come from ${name}, which the pinned tlpdb does not list for ${t.package}`);
        continue;
      }
      const bytes = archives.get(name);
      if (!bytes) continue; // its problem is listed above
      let unpacked;
      try {
        unpacked = unpackMembers(bytes, list.map(([, [, p]]) => p));
      } catch (err) {
        problems.push(`${name}: ${err.message}`);
        continue;
      }
      for (const [fileName, [, p]] of list) {
        const pin = source.files.find((f) => f.name === fileName);
        const problem = fileProblem(unpacked.get(p), pin);
        if (problem) problems.push(`${id}: ${problem}, unpacked from ${name}`);
        members[id].push({ name: fileName, archive: name, path: p, size: pin.size, sha256: pin.sha256 });
      }
    }
  }
  if (problems.length > 0) {
    problems.forEach((p) => console.error(p));
    console.error(`${problems.length} problem(s): no release files written`);
    return 1;
  }
  const assets = path.join(dir, 'assets');
  mkdirSync(assets, { recursive: true });
  for (const a of contents.archives) copyFileSync(path.join(dir, 'files', a.name), path.join(assets, a.name));
  copyFileSync(path.join(dir, 'files', REVTEX.file), path.join(assets, REVTEX.file));
  copyFileSync(path.join(dir, 'meta', 'texlive.tlpdb.xz'), path.join(assets, 'texlive.tlpdb.xz'));
  const list = {
    tag,
    snapshot: snapshotUrl,
    tlpdb: { name: 'texlive.tlpdb.xz', size: tlpdbBytes.length, sha256: bundlePins.tlpdb.sha256 },
    archives: contents.archives.map((a) => ({ name: a.name, package: a.package, kind: a.kind, size: a.size, sha512: a.sha512, sha256: sha('sha256', archives.get(a.name)), from: `${snapshotUrl}archive/${a.name}` })),
    files: [{ name: REVTEX.file, size: zipPin.size, sha256: zipPin.sha256, from: zipPin.url }],
    members,
  };
  writeFileSync(path.join(assets, 'test-inputs.json'), `${JSON.stringify(list, null, 2)}\n`);
  writeFileSync(path.join(dir, 'notes.md'), releaseNotes({ tag, contents, snapshotUrl, bundlePins, commit: arg('--commit') ?? '(local)', repository: arg('--repository') ?? 'https://github.com/haberwooki/liveMd2Tex' }));
  writeFileSync(path.join(dir, 'tag'), `${tag}\n`);
  const count = Object.values(members).reduce((n, m) => n + m.length, 0);
  console.log(`${tag}: ${contents.archives.length} archives, ${REVTEX.file} and the tlpdb checked; ${count} test files unpacked and checked against their pins; ${contents.archives.length + 3} release files in ${assets}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export { main };
