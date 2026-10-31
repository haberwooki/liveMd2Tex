// engine/build/tools/scripts-tree.mjs: the scripts' tree hash, which ties an engine build to the commit of its
// scripts. write-manifest.mjs records it in engine-build.json; the release job (scripts/engine-release.mjs) checks
// it against the checkout and against the archive of the scripts it attaches, and, once the extension ships this
// engine, scripts/release-sources.mjs will check it too.
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

export const TREE_METHOD = 'sha256 over the lines "<file sha256>  <path>\\n", paths in byte order';

/** Whether a repository path belongs to the scripts' tree: engine/build/ and engine/engine-build-pins.json. */
export const inScriptsTree = (rel) => rel.startsWith('engine/build/') || rel === 'engine/engine-build-pins.json';

/**
 * The tree hash of files given as [repository path, bytes]: the lines "<sha256 of the file>  <path>\n", paths with
 * '/' separators in byte order; the hash is the SHA-256 of those lines (the format of sha256sum's output, so it can
 * be checked with standard tools:
 * find engine/build engine/engine-build-pins.json -type f | LC_ALL=C sort | xargs sha256sum | sha256sum).
 */
export function treeOfFiles(files) {
  const sorted = [...files].sort(([a], [b]) => (Buffer.from(a) < Buffer.from(b) ? -1 : Buffer.from(a) > Buffer.from(b) ? 1 : 0));
  const lines = sorted.map(([f, bytes]) => `${sha256(bytes)}  ${f}\n`).join('');
  return { files: sorted.length, treeSha256: sha256(lines), method: TREE_METHOD };
}

/** The tree hash of a checkout's engine/build/ and engine/engine-build-pins.json. */
export function scriptsTree(repo) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(path.join(repo, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(path.join(repo, rel)).isDirectory()) walk(rel);
      else files.push(rel);
    }
  };
  walk('engine/build');
  files.push('engine/engine-build-pins.json');
  return treeOfFiles(files.map((f) => [f, readFileSync(path.join(repo, f))]));
}
