#!/usr/bin/env node
// Release tool, run on GitHub's runners by .github/workflows/release-sources.yml (docs/DEVELOPING.md, "Licences,
// notices and releases"; the licence gates, M1, M4, M6, F2-S1, F2-S2, L2-01, L2-03 and L2-06). Each release carries
// the sources of what its packages ship, so the offer of the source does not depend on another project's server:
//   - a package with the engine (extension/dist/engine/busytex.wasm): the engine's corresponding source, the archives
//     engine/engine-notices.json lists (TeXlyre's tree at its commit, TeX Live's source tree at its commit, Expat,
//     fontconfig), each with its SHA-256;
//   - a data package (extension/data/licences.json): the archives of the pinned TeX Live snapshot that its
//     licences.json lists for each package under the GPL, LGPL or AGPL, or with a packed font under the GPL. Each
//     address must be under a mirror of engine/bundle-pins.json's snapshot, and each SHA-512 must be the one the
//     pinned package database (tlpkg/texlive.tlpdb.xz, checked against its pinned SHA-256) gives.
// The checks on the archives:
//   - each archive's bytes against its hash;
//   - each archive GitHub makes from a commit (TeXlyre's, TeX Live's): its files against the commit's tree, from
//     "git ls-tree -r" that the workflow writes to DIR/trees/<name>.ls-tree. GitHub promises the same contents for a
//     commit, not the same bytes: when only the bytes differ, the archive passes with a note and its new SHA-256;
//   - TeXlyre's archive: its Makefile has the SHA-256 the manifest records, and the link lines the manifest copies.
// A package of the extension itself (extension/dist/extension.js) must be released under the tag v<version>, its
// package.json's version, and its README.md must name that tag of this repository as the source of the version, so
// its source pointer finds this tree.
// The tool starts no program and opens no connection: `list` writes a curl config and the commits for git, the
// workflow's curl and git do the fetching, and `check` checks every file.
//
//   node scripts/release-sources.mjs list --out DIR --tag TAG VSIX...   writes DIR/sources.curl, sources.json, git.tsv
//   node scripts/release-sources.mjs check --out DIR                    checks DIR/files/<group>/ and DIR/meta/

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { readTar } from './lib/tar.mjs';
import { parseTlpdb } from './lib/tlpdb.mjs';
import { unxz } from './lib/xz.mjs';
import { readZip } from './lib/zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'https://github.com/haberwooki/liveMd2Tex';
/** A group or file name the tool accepts: a plain name, never a path. */
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * How README.md and THIRD_PARTY_NOTICES.md name the source of this version: the tag of its version in this
 * repository. They name the tag, not its tree's address, which opens only once the release has made the tag; the
 * release's own page links the tree (sourceTree).
 */
export const sourceStatement = (tag) => `for this version, the tag \`${tag}\` of ${REPOSITORY}`;

/** Whether a text (README.md, THIRD_PARTY_NOTICES.md) names a tag as the source, whatever its line breaks. */
export const namesSource = (text, tag) => text.replace(/\s+/g, ' ').includes(sourceStatement(tag));

/** The address of a tag's tree, for the release's own page. */
export const sourceTree = (tag) => `${REPOSITORY}/tree/${tag}`;

const sha = (algo, b) => createHash(algo).update(b).digest('hex');

/** The pinned snapshot's mirrors, each with the snapshot's date in it (engine/bundle-pins.json). */
export function snapshotMirrors(bundlePins) {
  return bundlePins.mirrors.map((m) => m.replace('{snapshot}', bundlePins.snapshot));
}

/**
 * What a release must carry, by group ("engine", or the data set's name), from its packages' entries (VSIX file
 * name -> entry name -> bytes). Throws when the tag does not fit a package of the extension, when a name is not a
 * plain name, when a data archive is not under the pinned snapshot, or when two packages name one file with
 * different bytes.
 * @param {Map<string, Map<string, Buffer>>} packages
 * @param {string} tag
 * @param {{ sources: { name: string, url: string, sha256: string, mirror?: string, commit?: string, repository?: string }[] }} engineNotices
 * @param {{ snapshot: string, mirrors: string[] }} bundlePins
 */
export function releaseSources(packages, tag, engineNotices, bundlePins) {
  const mirrors = snapshotMirrors(bundlePins);
  const groups = new Map();
  const add = (group, s, why) => {
    if (!PLAIN.test(group) || !PLAIN.test(s.name)) {
      throw new Error(`${why}: "${group}/${s.name}" is not a plain group and file name`);
    }
    const list = groups.get(group) ?? new Map();
    groups.set(group, list);
    const prev = list.get(s.name);
    if (prev && (prev.url !== s.url || prev.sha256 !== s.sha256 || prev.sha512 !== s.sha512)) {
      throw new Error(`${group}/${s.name}: two packages name it with different addresses or hashes`);
    }
    list.set(s.name, { ...s, for: [...(prev?.for ?? []), why] });
  };
  for (const [file, entries] of packages) {
    const manifest = entries.get('extension/package.json');
    const identity = manifest ? JSON.parse(manifest.toString('utf8')) : {};
    if (entries.has('extension/dist/extension.js')) {
      if (tag !== `v${identity.version}`) {
        throw new Error(`${file}: the extension's version is ${identity.version}, so its release tag must be v${identity.version}, not ${tag}`);
      }
      // vsce stores README.md as extension/readme.md.
      const readmeName = [...entries.keys()].find((n) => n.toLowerCase() === 'extension/readme.md');
      const readme = readmeName ? entries.get(readmeName).toString('utf8') : '';
      if (!namesSource(readme, tag)) {
        throw new Error(`${file}: README.md does not name the tag ${tag} of ${REPOSITORY} as the source of this version`);
      }
    }
    if (entries.has('extension/dist/engine/busytex.wasm')) {
      for (const s of engineNotices.sources) {
        // A fixed copy in a release of our own (s.mirror), once there is one, comes before the upstream address.
        add('engine', { name: s.name, url: s.mirror ?? s.url, sha256: s.sha256, ...(s.commit ? { commit: s.commit, repository: s.repository } : {}) }, `${file}: the engine`);
      }
    }
    const licences = entries.get('extension/data/licences.json');
    if (licences) {
      const set = String(identity.name ?? 'data').replace(/^livemd2tex-/, '');
      for (const [pkg, l] of Object.entries(JSON.parse(licences.toString('utf8')))) {
        for (const a of l.archives ?? []) {
          const base = mirrors.find((m) => a.url.startsWith(`${m}archive/`));
          const name = base ? a.url.slice(`${base}archive/`.length) : '';
          if (!base || !PLAIN.test(name) || !/\.tar\.xz$/.test(name)) {
            throw new Error(`${file}: ${pkg}'s archive ${a.url} is not an archive of the pinned snapshot (${mirrors.join(', ')})`);
          }
          add(set, { name, url: a.url, sha512: a.sha512 }, `${file}: ${pkg} (${a.kind})`);
        }
      }
    }
  }
  const byName = (a, b) => (a.name < b.name ? -1 : 1);
  return Object.fromEntries([...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([g, list]) => [g, [...list.values()].sort(byName)]));
}

/** The curl config: each source under DIR/files/<group>/, and for a data group the pinned tlpdb under DIR/meta/. */
export function curlConfig(groups, dir, bundlePins) {
  const out = (...p) => path.join(dir, ...p).replace(/\\/g, '/');
  const lines = Object.entries(groups).flatMap(([g, list]) => list.map((s) => `url = ${JSON.stringify(s.url)}\noutput = ${JSON.stringify(out('files', g, s.name))}\n`));
  if (Object.keys(groups).some((g) => g !== 'engine')) {
    lines.push(`url = ${JSON.stringify(`${snapshotMirrors(bundlePins)[0]}${bundlePins.tlpdb.file}`)}\noutput = ${JSON.stringify(out('meta', 'texlive.tlpdb.xz'))}\n`);
  }
  return lines.join('');
}

/** The commit archives, one "name, repository, commit" line each, for the workflow's git ls-tree. */
export function gitList(groups) {
  return Object.values(groups)
    .flat()
    .filter((s) => s.commit)
    .map((s) => `${s.name}\t${s.repository}\t${s.commit}\n`)
    .join('');
}

/**
 * An archive's files against a commit's tree ("git ls-tree -r" output: mode, type, object id, tab, path). Each file
 * of the archive, below its one top folder, must be a blob of the tree with the same git object id and the same
 * executable bit, and each blob of the tree must be in the archive. Submodules are left out, as GitHub's archives
 * leave them out.
 */
export function treeDifferences(tarEntries, lsTree) {
  const want = new Map();
  for (const line of lsTree.split('\n').filter(Boolean)) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.*)$/.exec(line);
    if (!m) {
      return [`a line of the tree listing is not "mode type id<TAB>path": ${line.slice(0, 80)}`];
    }
    if (m[2] === 'blob') {
      want.set(m[4], { mode: m[1], id: m[3] });
    }
  }
  const problems = [];
  const seen = new Set();
  for (const e of tarEntries) {
    const rel = e.path.slice(e.path.indexOf('/') + 1);
    if (!rel || e.type === 'dir') {
      continue;
    }
    const body = e.type === 'symlink' ? Buffer.from(e.link) : e.type === 'file' ? Buffer.from(e.data) : null;
    if (!body) {
      problems.push(`${rel}: a ${e.type} entry`);
      continue;
    }
    const blobId = (b) => sha('sha1', Buffer.concat([Buffer.from(`blob ${b.length}\0`), b]));
    const id = blobId(body);
    const mode = e.type === 'symlink' ? '120000' : e.mode & 0o100 ? '100755' : '100644';
    const w = want.get(rel);
    seen.add(rel);
    // git archive writes a file with "eol=crlf" in .gitattributes (TeX Live's .bat files) with CRLF line ends, so a
    // file whose CRLF-to-LF form is the blob is the commit's.
    const sameAfterEol = () => body.includes(13) && blobId(Buffer.from(body.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')) === w.id;
    if (!w) {
      problems.push(`${rel}: in the archive, not in the commit`);
    } else if ((w.id !== id && !sameAfterEol()) || w.mode !== mode) {
      problems.push(`${rel}: ${w.id !== id ? 'other contents' : `mode ${mode}, the commit has ${w.mode}`}`);
    }
  }
  for (const rel of want.keys()) {
    if (!seen.has(rel)) {
      problems.push(`${rel}: in the commit, not in the archive`);
    }
  }
  return problems;
}

/** TeXlyre's archive: its Makefile is the one the manifest records, and holds the link lines the manifest copies. */
export function makefileDifferences(tarEntries, makefile) {
  const entry = tarEntries.find((e) => e.type === 'file' && e.path.slice(e.path.indexOf('/') + 1) === 'Makefile');
  if (!entry) {
    return ['the archive has no Makefile at its top'];
  }
  const problems = [];
  const have = sha('sha256', entry.data);
  if (have !== makefile.sha256) {
    problems.push(`Makefile: SHA-256 ${have} is not the manifest's ${makefile.sha256}`);
  }
  const lines = Buffer.from(entry.data).toString('utf8').split('\n');
  for (const [n, text] of Object.entries(makefile.lines)) {
    if (lines[Number(n) - 1] !== text) {
      problems.push(`Makefile line ${n} is not the manifest's copy`);
    }
  }
  return problems;
}

/** The pinned tlpdb's SHA-512 for an archive file name (<pkg>.tar.xz, <pkg>.doc.tar.xz, <pkg>.source.tar.xz). */
function tlpdbChecksum(db, name) {
  const m = /^(.+?)(\.doc|\.source)?\.tar\.xz$/.exec(name);
  const pkg = m && db.get(m[1]);
  if (!pkg) {
    return undefined;
  }
  return m[2] === '.doc' ? pkg.docContainerChecksum : m[2] === '.source' ? pkg.srcContainerChecksum : pkg.containerChecksum;
}

/**
 * The files that are missing or whose bytes are not the listed ones, and the notes. `context`: the manifest (for
 * TeXlyre's Makefile) and the bundle pins (for the tlpdb). A commit archive whose bytes differ passes when its files
 * are the commit's.
 * @returns {{ problems: string[], notes: string[] }}
 */
export function checkSources(groups, dir, context = {}) {
  const problems = [];
  const notes = [];
  let db;
  const dataGroups = Object.keys(groups).filter((g) => g !== 'engine');
  if (dataGroups.length > 0) {
    const tlpdbFile = path.join(dir, 'meta', 'texlive.tlpdb.xz');
    const pin = context.bundlePins?.tlpdb?.sha256;
    if (!existsSync(tlpdbFile) || !pin) {
      problems.push(`meta/texlive.tlpdb.xz: ${pin ? 'not downloaded' : 'engine/bundle-pins.json pins no tlpdb'}; the data archives cannot be checked against it`);
    } else if (sha('sha256', readFileSync(tlpdbFile)) !== pin) {
      problems.push(`meta/texlive.tlpdb.xz: not the pinned tlpdb (${pin})`);
    } else {
      db = parseTlpdb(unxz(readFileSync(tlpdbFile)).toString('utf8'));
    }
  }
  for (const [g, list] of Object.entries(groups)) {
    for (const s of list) {
      const file = path.join(dir, 'files', g, s.name);
      if (!existsSync(file)) {
        problems.push(`${g}/${s.name}: not downloaded (${s.url})`);
        continue;
      }
      const bytes = readFileSync(file);
      const [algo, want] = s.sha256 ? ['sha256', s.sha256] : ['sha512', s.sha512];
      const got = sha(algo, bytes);
      if (g !== 'engine' && db && tlpdbChecksum(db, s.name) !== s.sha512) {
        problems.push(`${g}/${s.name}: its SHA-512 in licences.json is not the pinned tlpdb's`);
      }
      let entries;
      if (s.commit || (context.manifest && s.name === texlyreArchive(context.manifest))) {
        entries = readTar(gunzipSync(bytes));
      }
      if (s.commit) {
        const listing = path.join(dir, 'trees', `${s.name}.ls-tree`);
        const diff = existsSync(listing) ? treeDifferences(entries, readFileSync(listing, 'utf8')) : [`no tree listing of commit ${s.commit} (trees/${s.name}.ls-tree)`];
        if (diff.length > 0) {
          problems.push(...diff.slice(0, 20).map((d) => `${g}/${s.name}: ${d}`));
        } else if (got !== want) {
          notes.push(`${g}/${s.name}: its bytes are not the pinned ones (GitHub made the archive again), but its files are commit ${s.commit}'s; attached with SHA-256 ${got}`);
          s.attachedSha256 = got;
        }
      }
      if (got !== want && !(s.commit && s.attachedSha256)) {
        problems.push(`${g}/${s.name}: ${algo.toUpperCase()} ${got} is not the listed ${want} (${s.url})`);
      }
      if (context.manifest && s.name === texlyreArchive(context.manifest)) {
        problems.push(...makefileDifferences(entries, context.manifest.makefile).map((d) => `${g}/${s.name}: ${d}`));
      }
    }
  }
  return { problems, notes };
}

/** The name of TeXlyre's archive among the manifest's sources: the one of its build commit. */
const texlyreArchive = (manifest) => manifest.sources.find((s) => s.commit === manifest.build.texlyre.commit)?.name;

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = arg('--out');
  if (!dir || !['list', 'check'].includes(argv[0])) {
    console.error('usage: release-sources.mjs list --out DIR --tag TAG VSIX... | check --out DIR');
    return 2;
  }
  const manifest = JSON.parse(readFileSync(path.join(root, 'engine', 'engine-notices.json'), 'utf8'));
  const bundlePins = JSON.parse(readFileSync(path.join(root, 'engine', 'bundle-pins.json'), 'utf8'));
  if (argv[0] === 'list') {
    const tag = arg('--tag');
    const files = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !['--out', '--tag'].includes(all[i - 1]));
    if (!tag || files.length === 0) {
      console.error('list needs --tag TAG and at least one VSIX');
      return 2;
    }
    const packages = new Map(files.map((f) => [path.basename(f), readZip(readFileSync(f))]));
    const groups = releaseSources(packages, tag, manifest, bundlePins);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'sources.json'), `${JSON.stringify({ tag, groups }, null, 1)}\n`);
    writeFileSync(path.join(dir, 'sources.curl'), curlConfig(groups, dir, bundlePins));
    writeFileSync(path.join(dir, 'git.tsv'), gitList(groups));
    for (const [g, list] of Object.entries(groups)) {
      console.log(`${g}: ${list.length} archives`);
    }
    return 0;
  }
  const listed = JSON.parse(readFileSync(path.join(dir, 'sources.json'), 'utf8'));
  const { problems, notes } = checkSources(listed.groups, dir, { manifest, bundlePins });
  notes.forEach((n) => console.log(`note: ${n}`));
  problems.forEach((p) => console.error(p));
  // The list as attached: with the SHA-256 of any commit archive that GitHub made again.
  writeFileSync(path.join(dir, 'sources.json'), `${JSON.stringify(listed, null, 1)}\n`);
  console.log(problems.length === 0 ? `every source is the listed one (${Object.values(listed.groups).flat().length} files)` : `${problems.length} problem(s)`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
