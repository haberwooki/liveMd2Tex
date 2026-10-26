#!/usr/bin/env node
// Development tool (G0 onward; docs/DESIGN.md#store-and-packaging): brings the public repository up to a commit of
// this repository with ONE new commit, made from the scanned tree of that commit, never from this repository's
// history. It never fetches, never adds a remote and never pushes: the owner pushes after the review.
//
//   node scripts/public-sync.mjs --message "..." | --message-file FILE  [--ref main] [--public ../public_candidate]
//                                [--allow FILE] [--replace-unpushed] [--no-private-check]
//
// --message, --message-file  the public commit message, written by the person who runs the sync. It is required:
//                     the message is never made from this repository's history (gate G0-sync, GS-02). It is
//                     scanned for markers, branch names of this repository, anything that looks like a commit
//                     hash, and the words "private", "overlay", "laptop" and "worklog"; any of them stops the sync.
// --ref               the commit of this repository to publish (default: main).
// --public            the public clone (default: ../public_candidate), whose "origin/main" is the public history as
//                     last fetched. Run "git fetch" there first if the public history may have moved.
// --allow             the reviewed allow-list of 8-word runs that may be shared with the private texts (default:
//                     ../public-sync-allow.json, outside the repository): generic LaTeX lines and phrases.
// --replace-unpushed  the clone's main holds a commit that was never pushed (an earlier sync): make the new one in
//                     its place, on top of origin/main.
// --no-private-check  skip the 8-word comparison on purpose. Refused wherever the private markers file exists,
//                     that is, wherever private texts may be.
//
// What it does, in order:
// 1. Decides (planSync): nothing to do when the public tree already equals the commit's tree; the same answer when
//    an unpushed sync of this tree is waiting; a stop when another unpushed commit is waiting.
// 2. Checks the commit's files and the message before anything is written. Any of these stops it:
//    - a private file by name (.private-fixtures.json, .private-markers.json, any .private-* path);
//    - a private-marker finding, plain, encoded or decoded, in a file, a file name or the message;
//    - a word, branch name or hash in the message (above);
//    - a run of 8 words that a changed file shares with the private texts (the private fixtures, the reference
//      pairs and the private test folder) and that neither the allow-list nor the public history already holds
//      (GS-01; a run the public history holds passed the review of an earlier sync or gate). The private texts
//      must all be readable: a missing .private-fixtures.json, folder or pair stops it too.
// 3. Makes the commit on top of origin/main: author and committer PUBLIC_AUTHOR, times in UTC, exactly the commit's
//    files and modes (the tree is built from the blobs, without the clone's filters, and must equal the source
//    tree), then brings the clone's main and working tree to it.
// 4. Scans the clone's whole history again (a finding takes the commit back), records which commit of this
//    repository each public commit came from in <public>.sync.json, and writes the report to
//    <public>.sync-report.txt. Both stay beside the clone, never in it, and the report is private: it lists the
//    runs shared with the private texts. Keep it out of any upload or issue.
// Run it again with the same commit and it changes nothing (idempotent).

import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockingRuns, filesAt, git, isPrivatePath, loadPrivateTexts, loadScan, messageProblems, parseAuthor, PUBLIC_AUTHOR, repoRoot, runs, scanFiles, scanMessage, TEXT } from './lib/public-history.mjs';
import { isOutside } from './lib/paths.mjs';
import { historyFindings } from './marker-scan.mjs';

/**
 * What a sync should do. `state`: the laptop commit's tree, the clone's origin/main and main (commit and tree),
 * and whether main descends from origin/main.
 *   - "nothing": the public history already holds this tree;
 *   - "prepared": an unpushed commit with this tree is waiting on main (an earlier run);
 *   - "stop": another unpushed commit is waiting, or main has left origin/main;
 *   - "reset": with replaceUnpushed, when origin/main already holds this tree: main goes back to origin/main;
 *   - "commit": make the new commit on top of origin/main.
 */
export function planSync(state, replaceUnpushed = false) {
  if (state.headSha === state.originSha) {
    return state.originTree === state.laptopTree ? { action: 'nothing', reason: 'the public history already holds this tree' } : { action: 'commit' };
  }
  if (!state.headDescends) {
    return { action: 'stop', reason: "the clone's main has left origin/main; fetch, and put main back on origin/main" };
  }
  if (state.headTree === state.laptopTree) {
    return { action: 'prepared', reason: 'an unpushed commit with this tree is already waiting on main' };
  }
  if (!replaceUnpushed) {
    return { action: 'stop', reason: "the clone's main holds a commit that was never pushed; push it first, or run again with --replace-unpushed" };
  }
  return state.originTree === state.laptopTree ? { action: 'reset', reason: 'origin/main already holds this tree; main goes back to it' } : { action: 'commit' };
}

/** The sync record beside the clone: { syncs: [{ public, laptop, ref, tree, date }] }. */
export function readRecord(file) {
  if (!existsSync(file)) {
    return { about: 'Which commit of the development repository each public commit came from (scripts/public-sync.mjs). Local only; never committed.', syncs: [] };
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The reviewed allow-list of 8-word runs: { runs: [...] } in a local file outside the repository. */
export function readAllowList(file) {
  if (!existsSync(file)) {
    return new Set();
  }
  const json = JSON.parse(readFileSync(file, 'utf8'));
  return new Set(Array.isArray(json.runs) ? json.runs : []);
}

/** "mode sha" of every file of a tree, by path. */
function treeEntries(ref, repo) {
  const out = new Map();
  for (const entry of git(['ls-tree', '-r', '-z', '--full-tree', ref], repo).toString('latin1').split('\0').filter(Boolean)) {
    const [meta, file] = entry.split('\t');
    const [mode, , sha] = meta.split(' ');
    out.set(Buffer.from(file, 'latin1').toString('utf8'), `${mode} ${sha}`);
  }
  return out;
}

/** Whether a git command exits 0. */
function spawnOk(args, cwd) {
  try {
    git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

/** Whether the private markers file is on this computer (then private texts may be here too). */
const markersFilePresent = () => [path.join(repoRoot, '.private-markers.json'), path.join(repoRoot, '..', '.private-markers.json')].some((f) => existsSync(f));

export function main(argv) {
  const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const ref = arg('--ref', 'main');
  const pub = path.resolve(arg('--public', path.join(repoRoot, '..', 'public_candidate')));
  const allowFile = path.resolve(arg('--allow', path.join(repoRoot, '..', 'public-sync-allow.json')));
  const replaceUnpushed = argv.includes('--replace-unpushed');
  const noPrivateCheck = argv.includes('--no-private-check');
  const messageFile = arg('--message-file');
  const message = (messageFile ? readFileSync(messageFile, 'utf8') : (arg('--message') ?? '')).replace(/\r\n/g, '\n').trim();
  const author = parseAuthor(PUBLIC_AUTHOR);
  if (message === '') {
    console.error('Give the public commit message: --message "..." or --message-file FILE. It is never made from this repository\'s history.');
    return 2;
  }
  if (noPrivateCheck && markersFilePresent()) {
    console.error('--no-private-check is refused here: the private markers file is on this computer, so private texts may be too.');
    return 2;
  }
  if (!isOutside(repoRoot, pub) || !existsSync(path.join(pub, '.git'))) {
    console.error(`The public clone must be a git repository outside this one: ${pub}`);
    return 2;
  }
  const recordFile = `${pub}.sync.json`;
  const reportFile = `${pub}.sync-report.txt`;
  if (git(['status', '--porcelain'], pub).toString().trim() !== '') {
    console.error(`The public clone has changes that are not committed; it must be clean: ${pub}`);
    return 2;
  }
  if (git(['symbolic-ref', '--short', 'HEAD'], pub).toString().trim() !== 'main') {
    console.error('The public clone must have main checked out.');
    return 2;
  }

  // 1. The plan.
  const laptopSha = git(['rev-parse', '--verify', `${ref}^{commit}`], repoRoot).toString().trim();
  const laptopTree = git(['rev-parse', `${laptopSha}^{tree}`], repoRoot).toString().trim();
  const originSha = git(['rev-parse', '--verify', 'refs/remotes/origin/main'], pub).toString().trim();
  const headSha = git(['rev-parse', 'HEAD'], pub).toString().trim();
  const state = {
    laptopTree,
    originSha,
    originTree: git(['rev-parse', `${originSha}^{tree}`], pub).toString().trim(),
    headSha,
    headTree: git(['rev-parse', 'HEAD^{tree}'], pub).toString().trim(),
    headDescends: spawnOk(['merge-base', '--is-ancestor', originSha, headSha], pub),
  };
  const plan = planSync(state, replaceUnpushed);
  const record = readRecord(recordFile);
  if (plan.action === 'reset') {
    git(['update-ref', '-m', 'public-sync: back to origin/main', 'refs/heads/main', originSha, headSha], pub);
    git(['reset', '-q', '--hard', 'main'], pub);
  }
  if (plan.action !== 'commit') {
    console.log(`public-sync: ${plan.action}: ${plan.reason} (${ref} at ${laptopSha.slice(0, 7)}).`);
    if (plan.action === 'prepared' && !record.syncs.some((s) => s.public === headSha)) {
      record.syncs.push({ public: headSha, laptop: laptopSha, ref, tree: laptopTree, date: new Date().toISOString() });
      writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
    }
    return plan.action === 'stop' ? 1 : 0;
  }

  // 2. The checks, before anything is written.
  const files = filesAt(laptopSha);
  const before = treeEntries(originSha, pub);
  const after = treeEntries(laptopSha, repoRoot);
  const changed = files.filter((f) => before.get(f.file) !== after.get(f.file));
  const removed = [...before.keys()].filter((f) => !after.has(f));
  const privateNames = files.filter((f) => isPrivatePath(f.file)).map((f) => f.file);
  const scan = loadScan();
  const findings = [...scanFiles(files, scan), ...scanMessage(message, scan)];
  // Branch names, local and remote-tracking (in a clone the branches are origin/...).
  const branches = [
    ...new Set(
      git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], repoRoot)
        .toString()
        .split('\n')
        .filter(Boolean)
        .map((r) => r.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/[^/]+\//, ''))
        .filter((b) => b !== 'HEAD'),
    ),
  ];
  const wording = messageProblems(message, branches);
  const priv = noPrivateCheck ? { texts: [], problems: [] } : loadPrivateTexts();
  const privateRuns = new Set(priv.texts.flatMap((t) => [...runs(t)]));
  const allowList = readAllowList(allowFile);
  // Runs the public history already holds were reviewed when they were published.
  const published = new Set();
  if (!noPrivateCheck) {
    for (const f of filesAt(originSha, pub).filter((x) => TEXT.test(x.file))) {
      for (const r of runs(f.content.toString('utf8'))) {
        if (privateRuns.has(r)) {
          published.add(r);
        }
      }
    }
  }
  const allowed = new Set([...allowList, ...published]);
  const blocking = noPrivateCheck ? [] : blockingRuns(changed, privateRuns, allowed);
  const stops = [
    ...privateNames.map((f) => `a private file by name: ${f}`),
    ...findings.map((f) => `a private marker: ${f.file}:${f.line}:${f.column} ${f.marker}`),
    ...wording.map((w) => `the message holds ${w}`),
    ...priv.problems.map((p) => `the private texts cannot be compared: ${p}`),
    ...blocking.map((b) => `${b.file} shares ${b.runs.length} run(s) of 8 words with the private texts that the allow-list does not hold`),
  ];
  const report = [
    `Public sync (scripts/public-sync.mjs), ${new Date().toISOString()}. PRIVATE: keep this report out of any upload or issue.`,
    '',
    `From: ${ref} at ${laptopSha} (${files.length} files)`,
    `Onto: origin/main at ${originSha} in ${pub}`,
    `Changes: ${changed.length} file(s) added or changed, ${removed.length} removed`,
    ...changed.map((f) => `  ${before.has(f.file) ? 'changed' : 'added  '} ${f.file}`),
    ...removed.map((f) => `  removed ${f}`),
    '',
    'Message:',
    ...message.split('\n').map((l) => `  ${l}`),
    '',
    `Private-marker scan, files and message (${scan.markers.length} markers, plain, encoded and decoded): ${findings.length === 0 ? 'clean' : `${findings.length} finding(s)`}`,
    noPrivateCheck
      ? '8-word check: skipped on purpose (--no-private-check)'
      : `8-word check of the changed files against ${privateRuns.size} private runs, with ${allowList.size} runs on the allow-list (${allowFile}) and ${published.size} the public history already holds: ${blocking.length === 0 ? 'clean' : `${blocking.reduce((n, b) => n + b.runs.length, 0)} run(s) in ${blocking.length} file(s) not on the allow-list`}`,
    ...blocking.flatMap((b) => [`  ${b.file}:`, ...b.runs.map((r) => `    "${r}"`)]),
    '',
  ];
  if (stops.length > 0) {
    report.push('Stopped, with nothing written:', ...stops.map((s) => `  - ${s}`));
    writeFileSync(reportFile, `${report.join('\n')}\n`);
    console.error(`public-sync: stopped, nothing was written:\n${stops.map((s) => `  - ${s}`).join('\n')}\nReport (private): ${reportFile}`);
    return 1;
  }

  // 3. The commit, built from the blobs, on top of origin/main.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-sync-'));
  let newSha;
  try {
    const blobs = files.map((f, i) => {
      const p = path.join(tmp, `${i}.blob`);
      writeFileSync(p, f.content);
      return p;
    });
    const shas = git(['hash-object', '-w', '--no-filters', '--stdin-paths'], pub, Buffer.from(`${blobs.join('\n')}\n`)).toString().trim().split('\n');
    const index = { GIT_INDEX_FILE: path.join(tmp, 'index') };
    git(['read-tree', '--empty'], pub, undefined, index);
    git(['update-index', '--index-info'], pub, Buffer.from(files.map((f, i) => `${f.mode} ${shas[i]}\t${f.file}`).join('\n') + '\n'), index);
    const tree = git(['write-tree'], pub, undefined, index).toString().trim();
    if (tree !== laptopTree) {
      throw new Error(`the tree built in the clone (${tree}) is not the source tree (${laptopTree})`);
    }
    const now = `${Math.floor(Date.now() / 1000)} +0000`;
    newSha = git(['commit-tree', tree, '-p', originSha, '-F', '-'], pub, Buffer.from(`${message}\n`), {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: now,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_COMMITTER_DATE: now,
    })
      .toString()
      .trim();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  git(['update-ref', '-m', 'public-sync', 'refs/heads/main', newSha, headSha], pub);
  git(['reset', '-q', '--hard', 'main'], pub);

  // 4. The whole history again, the record and the report.
  const history = historyFindings(scan.markers, scan.rules, pub, scan.values);
  const remotes = git(['remote'], pub).toString().trim();
  report.push(
    `Commit: ${newSha} (author and committer ${PUBLIC_AUTHOR}, ${git(['log', '-1', '--format=%ad', '--date=iso', newSha], pub).toString().trim()})`,
    `Private-marker scan, the clone's history (${history.commits} commit(s), ${history.blobs} files): ${history.findings.length === 0 ? 'clean' : `${history.findings.length} finding(s)`}`,
    ...history.findings.map((f) => `  ${f.file}:${f.line}:${f.column} ${f.marker}`),
    `Remotes of the clone: ${remotes || 'none'}. Nothing was pushed.`,
  );
  if (history.findings.length > 0) {
    git(['update-ref', '-m', 'public-sync: taken back', 'refs/heads/main', headSha, newSha], pub);
    git(['reset', '-q', '--hard', 'main'], pub);
    report.push('Taken back: main is where it was.');
    writeFileSync(reportFile, `${report.join('\n')}\n`);
    console.error(`public-sync: the history scan found ${history.findings.length} finding(s); the commit was taken back. Report (private): ${reportFile}`);
    return 1;
  }
  record.syncs.push({ public: newSha, laptop: laptopSha, ref, tree: laptopTree, date: new Date().toISOString() });
  writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(reportFile, `${report.join('\n')}\n`);
  console.log(`public-sync: ${newSha.slice(0, 7)} on top of origin/main ${originSha.slice(0, 7)}, from ${ref} at ${laptopSha.slice(0, 7)}; ${changed.length} changed, ${removed.length} removed. Not pushed. Report (private): ${reportFile}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
