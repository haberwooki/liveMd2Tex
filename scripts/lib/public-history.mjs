// What the two public-history tools share (scripts/fresh-history.mjs makes the first public commit;
// scripts/public-sync.mjs adds one commit per sync; docs/DESIGN.md#store-and-packaging): reading the files of a
// commit of this repository, the private-marker scans of those files, and the 8-word comparison with the private
// texts. Neither tool ever adds a remote or pushes.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAllowRules, loadMarkers, loadMarkerValues, scanEncoded, scanPath, scanText } from '../marker-scan.mjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The author and committer of the public history, chosen by the owner on 2026-10-16. */
export const PUBLIC_AUTHOR = 'haberwooki <189794217+haberwooki@users.noreply.github.com>';

/** NAME and EMAIL of "NAME <EMAIL>", or null. */
export function parseAuthor(author) {
  const m = author ? /^(.+?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(author) : null;
  return m ? { name: m[1], email: m[2] } : null;
}

export function git(args, cwd, input, env) {
  const r = spawnSync('git', args, { cwd, input, maxBuffer: 1 << 30, env: env ? { ...process.env, ...env } : process.env });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr?.toString() ?? r.error}`);
  }
  return r.stdout;
}

/** The words of a text, lower case, for the 8-word comparison. */
export function words(text) {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Every run of `n` consecutive words. */
export function runs(text, n = 8) {
  const w = words(text);
  const out = new Set();
  for (let i = 0; i + n <= w.length; i++) {
    out.add(w.slice(i, i + n).join(' '));
  }
  return out;
}

/** The files and modes of commit `ref` of the repository at `repo`: [{ file, mode, content }]. Plain files only. */
export function filesAt(ref, repo = repoRoot) {
  const list = git(['ls-tree', '-r', '-z', '--full-tree', ref], repo).toString('latin1').split('\0').filter(Boolean);
  return list.map((entry) => {
    const [meta, file] = entry.split('\t');
    const [mode, type, sha] = meta.split(' ');
    if (type !== 'blob' || mode === '120000') {
      throw new Error(`${file}: a ${type === 'blob' ? 'symbolic link' : type}; the public history holds plain files only`);
    }
    return { file: Buffer.from(file, 'latin1').toString('utf8'), mode, content: git(['cat-file', 'blob', sha], repo) };
  });
}

const PRIVATE_TEXT = /\.(tex|md|bib|txt|sty|cls|json)$/i;

/** Every text file under a folder (the private folder), recursively. */
function textFilesUnder(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') {
      textFilesUnder(full, out);
    } else if (entry.isFile() && PRIVATE_TEXT.test(entry.name)) {
      out.push(readFileSync(full, 'utf8'));
    }
  }
  return out;
}

/**
 * The private texts, from .private-fixtures.json: every text file under its root folder and under its private test
 * folder ("privateTests"; its presets and documents, not its TypeScript, which is built from the public tests),
 * and the reference pairs' files at their commits (read with git show). Empty without the file.
 */
export function privateTexts(root = repoRoot) {
  const config = path.join(root, '.private-fixtures.json');
  if (!existsSync(config)) {
    return [];
  }
  const c = JSON.parse(readFileSync(config, 'utf8'));
  const base = path.resolve(root, c.root ?? '.');
  const out = existsSync(base) ? textFilesUnder(base) : [];
  const overlay = typeof c.privateTests === 'string' ? path.resolve(root, c.privateTests) : undefined;
  if (overlay && existsSync(overlay)) {
    textFilesUnder(overlay, out);
  }
  for (const pair of Object.values(c.pairs ?? {})) {
    const repo = path.resolve(base, pair.repo);
    for (const rel of [pair.markdown, pair.appendix, pair.reference].filter(Boolean)) {
      try {
        out.push(git(['show', `${pair.commit}:${rel}`], repo).toString('utf8'));
      } catch {
        // A pair whose repository or commit is not on this computer adds nothing.
      }
    }
  }
  return out;
}

/**
 * The private texts, read strictly (for the public sync, which must not go ahead without them): the same sources as
 * privateTexts, but a missing .private-fixtures.json, a missing root or private test folder, or a reference pair
 * that cannot be read is a problem, not a skip.
 * @returns {{ texts: string[], problems: string[] }}
 */
export function loadPrivateTexts(root = repoRoot) {
  const problems = [];
  const config = path.join(root, '.private-fixtures.json');
  if (!existsSync(config)) {
    return { texts: [], problems: ['there is no .private-fixtures.json'] };
  }
  let c;
  try {
    c = JSON.parse(readFileSync(config, 'utf8'));
  } catch (err) {
    return { texts: [], problems: [`.private-fixtures.json is not valid JSON (${err instanceof Error ? err.message : err})`] };
  }
  const texts = [];
  const base = path.resolve(root, c.root ?? '.');
  if (existsSync(base)) {
    textFilesUnder(base, texts);
  } else {
    problems.push('the private fixtures folder that .private-fixtures.json names is absent');
  }
  const overlay = typeof c.privateTests === 'string' ? path.resolve(root, c.privateTests) : undefined;
  if (overlay && existsSync(overlay)) {
    textFilesUnder(overlay, texts);
  } else {
    problems.push(overlay ? 'the private test folder that .private-fixtures.json names is absent' : '.private-fixtures.json names no private test folder ("privateTests")');
  }
  for (const [name, pair] of Object.entries(c.pairs ?? {})) {
    const repo = path.resolve(base, pair.repo);
    for (const rel of [pair.markdown, pair.appendix, pair.reference].filter(Boolean)) {
      try {
        texts.push(git(['show', `${pair.commit}:${rel}`], repo).toString('utf8'));
      } catch {
        problems.push(`the reference pair "${name}" cannot be read at its commit`);
      }
    }
  }
  return { texts, problems };
}

/**
 * The runs of 8 words that `files` share with the private texts and that the reviewed allow-list does not hold:
 * [{ file, runs }]. Every such run stops a public sync.
 */
export function blockingRuns(files, privateRuns, allowed) {
  const out = [];
  for (const { file, content } of files.filter((f) => TEXT.test(f.file))) {
    const runsHere = [...runs(content.toString('utf8'))].filter((r) => privateRuns.has(r) && !allowed.has(r));
    if (runsHere.length > 0) {
      out.push({ file, runs: runsHere });
    }
  }
  return out;
}

/** A run that holds a LaTeX setting word: shared preambles look alike everywhere; prose overlaps are listed first. */
export const SETTING = /(^| )(usepackage|documentclass|newcommand|renewcommand|setlength|hypersetup|includegraphics|titleformat|captionsetup|geometry|fontenc|inputenc|begin|end|def|let|setmainfont|newenvironment)( |$)/;

export const TEXT = /\.(ts|js|mjs|cjs|json|md|tex|sty|cls|bib|txt|yml|yaml|cnf|conf|css|html|diff)$|(^|\/)(LICENSE|\.[a-z]+ignore|\.gitattributes)$/i;

/** The marker list, its values and the allow rules, loaded once (the scan fails without markers). */
export function loadScan() {
  return { markers: loadMarkers(), values: loadMarkerValues(), rules: loadAllowRules() };
}

/** The private-marker findings in the files' paths and contents: plain, encoded and decoded. */
export function scanFiles(files, scan = loadScan()) {
  return files.flatMap(({ file, content }) => {
    const text = content.toString('latin1');
    return [...scanPath(file, scan.markers), ...scanText(text, file, scan.markers, scan.rules), ...scanEncoded(text, file, scan.values, scan.rules)];
  });
}

/**
 * Whether a path is one of the private files (.private-fixtures.json, .private-markers.json, any .private-*), by
 * name. The published template .private-fixtures.example.json is the one exception.
 */
export const isPrivatePath = (file) => file.split('/').some((seg) => seg.startsWith('.private-') && seg !== '.private-fixtures.example.json');

/** Words a public commit message may not hold: they name the private material or the development setup. */
const MESSAGE_WORDS = /\b(private\w*|overlay\w*|laptop\w*|worklog\w*)\b/gi;

/**
 * What a public commit message may not say (besides markers): a development branch name (main and master are
 * ordinary words), something that looks like a commit hash, and the words about the private material.
 */
export function messageProblems(message, branches) {
  const problems = [];
  for (const m of message.matchAll(MESSAGE_WORDS)) {
    problems.push(`the word "${m[1]}"`);
  }
  for (const m of message.matchAll(/\b[0-9a-f]{7,40}\b/gi)) {
    if (/[0-9]/.test(m[0])) {
      problems.push(`"${m[0]}", which looks like a commit hash`);
    }
  }
  for (const branch of branches) {
    if (branch === 'main' || branch === 'master') {
      continue;
    }
    const re = new RegExp(`(?<![\\w/-])${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-])`, 'i');
    if (re.test(message)) {
      problems.push(`the branch name "${branch}"`);
    }
  }
  return problems;
}

/** The private-marker findings in a commit message (plain, encoded and decoded). */
export function scanMessage(message, scan = loadScan()) {
  return [...scanText(message, 'the commit message', scan.markers, scan.rules), ...scanEncoded(message, 'the commit message', scan.values, scan.rules)];
}

/** Every run of 8 words a text file shares with the private texts: [{ file, count, settings, examples }]. */
export function overlapsWith(files, privateRuns) {
  const overlaps = [];
  if (privateRuns.size === 0) {
    return overlaps;
  }
  for (const { file, content } of files.filter((f) => TEXT.test(f.file))) {
    const shared = [...runs(content.toString('utf8'))].filter((r) => privateRuns.has(r));
    if (shared.length > 0) {
      const other = shared.filter((r) => !SETTING.test(r));
      overlaps.push({ file, count: shared.length, settings: shared.length - other.length, examples: [...other, ...shared.filter((r) => SETTING.test(r))].slice(0, 5) });
    }
  }
  return overlaps;
}

/** The report lines of an 8-word comparison. */
export function overlapLines(overlaps, privateRuns, what = 'the private fixtures') {
  return [
    privateRuns.size === 0
      ? `Runs of 8 words shared with ${what}: not checked (no .private-fixtures.json)`
      : `Runs of 8 words shared with ${what} (${privateRuns.size} private runs): ${overlaps.length === 0 ? 'none' : `${overlaps.reduce((n, o) => n + o.count, 0)} in ${overlaps.length} file(s)`}`,
    ...overlaps.flatMap((o) => [`  ${o.file}: ${o.count} (${o.settings} with a LaTeX setting word, ${o.count - o.settings} other)`, ...o.examples.map((e) => `    "${e}"`)]),
  ];
}
