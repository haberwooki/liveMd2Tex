#!/usr/bin/env node
// Development tool (G0 preparation; docs/DESIGN.md#store-and-packaging): makes the fresh, scanned history that the GitHub
// repository starts from. "The first commit is made from a scanned tree, never from the laptop's history, and
// the repository's owner reviews the scan's output before the push."
//
// It copies the files of one commit of this repository (default: main) into a NEW folder outside it, makes a new
// git repository there with ONE commit, and scans it. It never adds a remote and never pushes; the push is the owner's,
// after he has read the report.
//
//   node scripts/fresh-history.mjs [--author "NAME <EMAIL>"] [--ref main] [--out ../public_candidate]
//                                  [--message "..."] [--watch word1,word2]
//
// --author   the author and committer of the one commit. The default is the one the owner chose for the public
//            history (PUBLIC_AUTHOR: the GitHub account and its no-reply address; build gate 1, G1S-12).
// --watch    extra words to count and list (for example a name that is not yet a marker).
//
// The report, beside the new folder (never inside it), has: the commit (SHA, author, message), the file list
// with sizes, the private-marker scan of the tree and of the history (the same scan as the hook and the CI job,
// with each marker also searched encoded and in every decoded view of a file; G2S-01, G2R-01), the --watch words
// with file and line, and, when .private-fixtures.json is present, every run of 8 words that a public file shares
// with any text file under the private folder or the private test folder (its presets and documents; not its
// TypeScript, which is built from the public tests), or with a reference pair's files at their commits (G1S-13,
// G2S-07).
//
// The commit's dates are in UTC (G2S-07), and its file list is checked against the source commit's: `git add`
// would otherwise drop a tracked file that matches a .gitignore pattern without a word (G2E-13).

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesAt, git, loadScan, overlapLines, overlapsWith, parseAuthor, privateTexts, PUBLIC_AUTHOR, repoRoot as root, runs, scanFiles, words } from './lib/public-history.mjs';
import { isOutside } from './lib/paths.mjs';
import { historyFindings } from './marker-scan.mjs';

export { PUBLIC_AUTHOR, runs, words };

export function main(argv) {
  const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const author = parseAuthor(arg('--author', PUBLIC_AUTHOR));
  if (!author) {
    console.error('Give the author of the one commit as --author "NAME <EMAIL>", or leave it out for the default (build gate 1, G1S-12).');
    return 2;
  }
  const ref = arg('--ref', 'main');
  const out = path.resolve(arg('--out', path.join(root, '..', 'public_candidate')));
  const message = arg('--message', 'liveMd2Tex: the first commit of the public history');
  const watch = (arg('--watch', '') ?? '').split(',').map((w) => w.trim()).filter(Boolean);
  if (!isOutside(root, out)) {
    console.error(`The new folder must be outside this repository: ${out}`);
    return 2;
  }
  if (existsSync(out) && readdirSync(out).length > 0) {
    console.error(`The new folder must be new or empty: ${out}`);
    return 2;
  }

  // 1. The files of the commit, written into the new folder.
  const files = filesAt(ref);
  for (const { file, content } of files) {
    const target = path.join(out, ...file.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const source = git(['rev-parse', ref], root).toString().trim();

  // 2. One commit, in a new repository with no remote.
  const id = ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`];
  git(['init', '-q', '-b', 'main'], out);
  // --force: exactly the source commit's files, even one that matches a pattern in the copied .gitignore.
  git(['add', '-A', '--force'], out);
  for (const { file } of files.filter((f) => f.mode === '100755')) {
    git(['update-index', '--chmod=+x', '--', file], out);
  }
  const now = `${Math.floor(Date.now() / 1000)} +0000`;
  git([...id, 'commit', '-q', '-F', '-'], out, Buffer.from(`${message}\n`), { GIT_AUTHOR_DATE: now, GIT_COMMITTER_DATE: now });
  const committed = git(['ls-tree', '-r', '-z', '--name-only', 'HEAD'], out).toString('utf8').split('\0').filter(Boolean).sort();
  const expected = files.map((f) => f.file).sort();
  if (committed.length !== expected.length || committed.some((f, i) => f !== expected[i])) {
    throw new Error(`the new commit holds ${committed.length} files, the source commit ${expected.length}`);
  }
  const remotes = git(['remote'], out).toString().trim();
  if (remotes) {
    throw new Error(`the new repository has a remote (${remotes}); it must have none`);
  }
  const head = git(['log', '-1', '--format=%H%n%an <%ae>%n%cn <%ce>%n%B'], out).toString().split('\n');
  const dates = git(['log', '-1', '--format=%ad | %cd', '--date=iso'], out).toString().trim();

  // 3. The scans.
  const scan = loadScan();
  const { markers } = scan;
  const treeFindings = scanFiles(files, scan);
  const history = historyFindings(markers, scan.rules, out, scan.values);
  const watched = [];
  for (const word of watch) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu');
    for (const { file, content } of files) {
      if (re.test(file)) {
        watched.push(`${word}: ${file} (path)`);
      }
      re.lastIndex = 0;
      content.toString('utf8').split('\n').forEach((line, i) => {
        re.lastIndex = 0;
        if (re.test(line)) {
          watched.push(`${word}: ${file}:${i + 1}`);
        }
      });
    }
    re.lastIndex = 0;
    if (re.test(head.slice(1, 3).join(' '))) {
      watched.push(`${word}: the commit's author or committer`);
    }
  }
  const privateRuns = new Set(privateTexts().flatMap((t) => [...runs(t)]));
  const overlaps = overlapsWith(files, privateRuns);

  // 4. The report, beside the new folder.
  const bytes = files.reduce((n, f) => n + f.content.length, 0);
  const report = [
    `Fresh history for the public repository (scripts/fresh-history.mjs), ${new Date().toISOString()}`,
    '',
    `Folder: ${out}`,
    `Made from: ${ref} at ${source} (${files.length} files, ${bytes} bytes)`,
    `Commit: ${head[0]}`,
    `Author: ${head[1]}`,
    `Committer: ${head[2]}`,
    `Dates (author | committer): ${dates}`,
    `Message: ${head.slice(3).join(' ').trim()}`,
    `Remotes: none. Nothing was pushed.`,
    '',
    `Private-marker scan, tree (${markers.length} markers, plain, encoded and decoded: lib/marker-decode.mjs): ${treeFindings.length === 0 ? 'clean' : `${treeFindings.length} finding(s)`}`,
    ...treeFindings.map((f) => `  ${f.file}:${f.line}:${f.column} ${f.marker}`),
    `Private-marker scan, history (${history.commits} commit, ${history.blobs} files): ${history.findings.length === 0 ? 'clean' : `${history.findings.length} finding(s)`}`,
    ...history.findings.map((f) => `  ${f.file}:${f.line}:${f.column} ${f.marker}`),
    '',
    `Watched words (${watch.length === 0 ? 'none given' : watch.join(', ')}): ${watch.length === 0 ? '-' : watched.length === 0 ? 'none found' : `${watched.length} place(s)`}`,
    ...watched.map((w) => `  ${w}`),
    '',
    ...overlapLines(overlaps, privateRuns),
    '',
    'Files:',
    ...files.map((f) => `  ${String(f.content.length).padStart(9)}  ${f.mode === '100755' ? 'x ' : '  '}${f.file}`),
    '',
  ].join('\n');
  const reportFile = `${out}.report.txt`;
  writeFileSync(reportFile, report);
  console.log(report.split('\nFiles:')[0]);
  console.log(`Report with the file list: ${reportFile}`);
  return treeFindings.length + history.findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
