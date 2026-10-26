#!/usr/bin/env node
// Private-marker scan (docs/DESIGN.md#store-and-packaging). Rejects text that would tie the repository to private files:
// a private surname, the laptop's user path, a coauthor's name, private manuscript file names and private
// commit hashes. Runs as the git pre-commit and commit-msg hooks (scripts/install-hooks.mjs), on its own,
// and as a CI job from G0.
//
//   node scripts/marker-scan.mjs              same as --tree
//   node scripts/marker-scan.mjs --tree       tracked files plus untracked files that are not ignored
//   node scripts/marker-scan.mjs --staged     the staged contents and paths (pre-commit hook)
//   node scripts/marker-scan.mjs --commit-msg FILE   a commit message (commit-msg hook)
//   node scripts/marker-scan.mjs --history    every commit: messages, paths and file contents
//   node scripts/marker-scan.mjs --files A B  the given files
//   ... --history --repo DIR                  the same history scan in another repository (the fresh public
//                                              history made by scripts/fresh-history.mjs)
//
// The markers are NOT in this repository, in any form (build gate 2, G2S-01): they come from a git-ignored
// .private-markers.json in the repository folder or in the folder above it (one file for every checkout on the
// laptop), and on CI from the secret LIVEMD2TEX_PRIVATE_MARKERS (the same JSON in an environment variable). The
// format: {"markers": [{"id": "surname", "kind": "text" | "word" | "user-path", "value": "..."}, ...]}; a plain
// string is a "text" marker. With no marker from any source the scan fails (exit 3) instead of passing: a scan
// that knows no marker would call everything clean.
//
// Each marker is also searched in encoded forms that would carry it as well: base64 (at every alignment, and in
// the URL-safe alphabet), hex and URL encoding; and every decoded view of a file is searched too
// (lib/marker-decode.mjs). Commit author and committer fields are not scanned
// (docs/DESIGN.md#store-and-packaging allows the commit author). Allowed places are listed in scripts/marker-allowlist.json.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodedViews } from './lib/marker-decode.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEP = '(?:[\\\\/]|%5c|%2f)+';

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
    }
  }
  return line;
}

function compile(marker) {
  const text = escapeRegExp(marker.value);
  const source =
    marker.kind === 'word'
      ? `(?<![a-z0-9])${text}(?![a-z0-9])`
      : marker.kind === 'user-path'
        ? `${SEP}users${SEP}${text}(?![a-z0-9])`
        : text;
  return { id: marker.id, regex: new RegExp(source, 'gi') };
}

/** The environment variable that carries the markers on CI (a repository secret). */
export const MARKERS_ENV = 'LIVEMD2TEX_PRIVATE_MARKERS';
const KINDS = new Set(['text', 'word', 'user-path']);

/** No marker came from any source: the scan cannot vouch for anything. */
export class NoMarkersError extends Error {
  constructor() {
    super(
      `No private markers: put them in .private-markers.json (git-ignored; in the repository folder or the folder above it) or, on CI, in the secret ${MARKERS_ENV}. The scan does not pass without them.`,
    );
    this.name = 'NoMarkersError';
  }
}

function parseMarkers(text, source) {
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : parsed?.markers;
  if (!Array.isArray(list)) {
    throw new Error(`${source}: no "markers" list`);
  }
  return list.map((m, i) => {
    const marker = typeof m === 'string' ? { id: `local-${i + 1}`, kind: 'text', value: m } : m;
    if (!marker || typeof marker.value !== 'string' || marker.value.length < 2 || !KINDS.has(marker.kind ?? 'text')) {
      throw new Error(`${source}: marker ${i + 1} needs a "value" of two or more characters and a kind of text, word or user-path`);
    }
    return { id: String(marker.id ?? `local-${i + 1}`), kind: marker.kind ?? 'text', value: marker.value };
  });
}

/**
 * The marker values: the git-ignored .private-markers.json in `repoRoot` and in the folder above it, and the CI
 * secret. Throws NoMarkersError when no source gives any.
 */
export function loadMarkerValues(repoRoot = root, env = process.env) {
  const values = [];
  for (const file of [path.join(repoRoot, '.private-markers.json'), path.join(repoRoot, '..', '.private-markers.json')]) {
    if (existsSync(file)) {
      values.push(...parseMarkers(readFileSync(file, 'utf8'), file));
    }
  }
  if (env[MARKERS_ENV]) {
    values.push(...parseMarkers(env[MARKERS_ENV], MARKERS_ENV));
  }
  if (values.length === 0) {
    throw new NoMarkersError();
  }
  const seen = new Set();
  return values.filter((m) => {
    const key = `${m.kind}:${m.value.toLowerCase()}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

/** The markers, compiled for the scan (see loadMarkerValues). */
export function loadMarkers(repoRoot = root, env = process.env) {
  return loadMarkerValues(repoRoot, env).map(compile);
}

/**
 * The encoded forms of a marker that could carry it into a file: base64 at the three byte alignments (standard
 * and URL-safe), hex and percent encoding, for the value as written, in lower case and in upper case. A base64
 * form shorter than 6 characters, and the hex of a marker shorter than 5 bytes, are left out: random base64
 * (hashes) and lists of numbers would match them by chance.
 */
export function encodedForms(value) {
  const forms = [];
  const title = value.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_, a, b) => a + b.toUpperCase());
  const variants = [...new Set([value, value.toLowerCase(), value.toUpperCase(), title])];
  for (const v of variants) {
    const bytes = Buffer.from(v, 'utf8');
    for (let k = 0; k < 3; k++) {
      const enc = Buffer.concat([Buffer.alloc(k), bytes]).toString('base64');
      const start = [0, 2, 3][k];
      const end = Math.floor(((k + bytes.length) * 8) / 6);
      const core = enc.slice(start, end);
      if (core.length >= 6) {
        forms.push({ form: 'base64', text: core, caseless: false });
        const url = core.replace(/\+/g, '-').replace(/\//g, '_');
        if (url !== core) {
          forms.push({ form: 'base64url', text: url, caseless: false });
        }
      }
    }
  }
  const bytes = Buffer.from(value, 'utf8');
  // Hex of a short marker (under 5 bytes) is all digits often enough to turn up in any list of numbers.
  if (bytes.length >= 5) {
    forms.push({ form: 'hex', text: bytes.toString('hex'), caseless: true });
  }
  forms.push({ form: 'percent', text: [...bytes].map((b) => `%${b.toString(16).padStart(2, '0')}`).join(''), caseless: true });
  return forms;
}

/**
 * Hidden markers in one text, with the same allow rules as the plain scan (build gate 2, G2S-01 and G2R-01):
 * - each marker's encoded forms (base64 of the value, lower, upper and title case, at every alignment; hex;
 *   percent encoding), searched as they stand;
 * - every decoded view of the text (lib/marker-decode.mjs: escapes, base64, base32, hex, percent, character
 *   codes, UTF-16, ROT13), searched like plain text, case-insensitively and with the word rules;
 * - a marker of five or more characters written backwards, and one of six or more split by spaces or zero-width
 *   characters.
 */
export function scanEncoded(text, file, values, allowRules = []) {
  const findings = [];
  const lines = text.split('\n');
  const lower = lines.map((l) => l.toLowerCase());
  const normalizedFile = file.replace(/\\/g, '/');
  const allowedLine = (id, line) => allowRules.some((r) => r.file === normalizedFile && (r.markers === '*' || r.markers.includes(id)) && r.lineRegex.test(line));
  if (values.length > 0) {
    const compiled = values.map((m) => ({ ...m, ...compile(m) }));
    for (const view of decodedViews(text)) {
      for (const m of compiled) {
        if (view.weak && m.value.length < 5) {
          continue;
        }
        m.regex.lastIndex = 0;
        const hit = m.regex.exec(view.text);
        if (!hit) {
          continue;
        }
        const line = view.line || lineAt(view.text, hit.index);
        if (!allowedLine(m.id, lines[line - 1] ?? '')) {
          findings.push({ file: normalizedFile, line, column: 1, marker: `${m.id} (${view.kind})` });
        }
      }
    }
    for (const m of values.filter((v) => v.value.length >= 5)) {
      const backwards = [...m.value].reverse().join('').toLowerCase();
      // Split letter by letter ("a b c d e f"), or with zero-width characters anywhere; a space between two
      // parts alone is how ordinary words follow each other, so it is not counted.
      const split =
        m.value.length >= 6
          ? new RegExp(`${[...m.value].map(escapeRegExp).join('[\\s\\u200b-\\u200d\\u2060\\ufeff]')}|${[...m.value].map(escapeRegExp).join('[\\u200b-\\u200d\\u2060\\ufeff]?')}`, 'gi')
          : null;
      lines.forEach((line, i) => {
        if (lower[i].includes(backwards) && !allowedLine(m.id, line)) {
          findings.push({ file: normalizedFile, line: i + 1, column: lower[i].indexOf(backwards) + 1, marker: `${m.id} (backwards)` });
        }
        if (split) {
          for (const hit of line.matchAll(split)) {
            if (hit[0].length > m.value.length && !allowedLine(m.id, line)) {
              findings.push({ file: normalizedFile, line: i + 1, column: (hit.index ?? 0) + 1, marker: `${m.id} (split)` });
            }
          }
        }
      });
    }
  }
  for (const m of values) {
    for (const f of encodedForms(m.value)) {
      const needle = f.caseless ? f.text.toLowerCase() : f.text;
      lines.forEach((line, i) => {
        const at = (f.caseless ? lower[i] : line).indexOf(needle);
        if (at < 0) {
          return;
        }
        const allowed = allowRules.some((r) => r.file === normalizedFile && (r.markers === '*' || r.markers.includes(m.id)) && r.lineRegex.test(line));
        if (!allowed) {
          findings.push({ file: normalizedFile, line: i + 1, column: at + 1, marker: `${m.id} (${f.form})` });
        }
      });
    }
  }
  return findings;
}

export function loadAllowRules(repoRoot = root) {
  const file = path.join(repoRoot, 'scripts', 'marker-allowlist.json');
  const { rules } = JSON.parse(readFileSync(file, 'utf8'));
  return rules.map((r) => ({ ...r, lineRegex: new RegExp(r.line) }));
}

/**
 * Scans one text (a file's contents, a path or a commit message).
 * @returns {{file: string, line: number, column: number, marker: string}[]}
 */
export function scanText(text, file, markers, allowRules = []) {
  const findings = [];
  const lines = text.split('\n');
  const normalizedFile = file.replace(/\\/g, '/');
  lines.forEach((lineTextValue, index) => {
    for (const { id, regex } of markers) {
      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(lineTextValue)) !== null) {
        const allowed = allowRules.some(
          (r) =>
            r.file === normalizedFile &&
            (r.markers === '*' || r.markers.includes(id)) &&
            r.lineRegex.test(lineTextValue),
        );
        if (!allowed) {
          findings.push({ file: normalizedFile, line: index + 1, column: m.index + 1, marker: id });
        }
        if (m[0].length === 0) {
          regex.lastIndex++;
        }
      }
    }
  });
  return findings;
}

/** Scans a path (file names are checked too; allow rules never apply to them). */
export function scanPath(file, markers) {
  return scanText(file.replace(/\\/g, '/'), `${file} (path)`, markers, []);
}

function git(args, options = {}, cwd = root) {
  const r = spawnSync('git', args, { cwd, maxBuffer: 1 << 30, ...options });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr?.toString() ?? r.error}`);
  }
  return r.stdout;
}

const asText = (buf) => buf.toString('latin1');

function scanFiles(entries, markers, rules, values = []) {
  const findings = [];
  for (const { file, content } of entries) {
    const text = asText(content);
    findings.push(...scanPath(file, markers), ...scanText(text, file, markers, rules), ...scanEncoded(text, file, values, rules));
  }
  return findings;
}

function treeEntries() {
  const list = asText(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean);
  return list
    .filter((f) => existsSync(path.join(root, f)))
    .map((file) => ({ file, content: readFileSync(path.join(root, file)) }));
}

function stagedEntries() {
  const list = asText(git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT'])).split('\0').filter(Boolean);
  return list.map((file) => ({ file, content: git(['cat-file', 'blob', `:${file}`]) }));
}

/** Every commit of the repository at `repoDir`: messages, paths and file contents. */
export function historyFindings(markers, rules, repoDir = root, values = []) {
  const g = (args) => git(args, {}, repoDir);
  const findings = [];
  const commits = asText(g(['rev-list', '--all'])).split('\n').filter(Boolean);
  const blobs = new Map();
  for (const commit of commits) {
    const message = asText(g(['log', '-1', '--format=%B', commit]));
    findings.push(...scanText(message, `commit ${commit.slice(0, 12)} message`, markers, []));
    for (const entry of asText(g(['ls-tree', '-r', '-z', '--full-tree', commit])).split('\0').filter(Boolean)) {
      const [meta, file] = entry.split('\t');
      const [, type, sha] = meta.split(' ');
      if (type === 'blob' && !blobs.has(sha)) {
        blobs.set(sha, file);
      }
      findings.push(...scanPath(`${commit.slice(0, 12)}:${file}`, markers));
    }
  }
  for (const [sha, file] of blobs) {
    const text = asText(g(['cat-file', 'blob', sha]));
    findings.push(...scanText(text, file, markers, rules), ...scanEncoded(text, file, values, rules));
  }
  const unique = new Map(findings.map((f) => [`${f.file}:${f.line}:${f.column}:${f.marker}`, f]));
  return { findings: [...unique.values()], commits: commits.length, blobs: blobs.size };
}

function main(argv) {
  let values;
  try {
    values = loadMarkerValues();
  } catch (err) {
    console.error(`marker scan: ${err instanceof Error ? err.message : String(err)}`);
    return 3;
  }
  const markers = values.map(compile);
  const rules = loadAllowRules();
  const mode = argv[0] ?? '--tree';
  let findings;
  let scope;
  if (mode === '--tree') {
    const entries = treeEntries();
    findings = scanFiles(entries, markers, rules, values);
    scope = `${entries.length} files in the working tree`;
  } else if (mode === '--staged') {
    const entries = stagedEntries();
    findings = scanFiles(entries, markers, rules, values);
    scope = `${entries.length} staged files`;
  } else if (mode === '--commit-msg') {
    findings = scanText(readFileSync(argv[1], 'utf8'), 'commit message', markers, []);
    scope = 'the commit message';
  } else if (mode === '--history') {
    const repoAt = argv.indexOf('--repo');
    const repoDir = repoAt >= 0 ? path.resolve(argv[repoAt + 1]) : root;
    const r = historyFindings(markers, rules, repoDir, values);
    findings = r.findings;
    scope = `${r.commits} commits, ${r.blobs} distinct files${repoDir === root ? '' : ` in ${path.basename(repoDir)}`}`;
  } else if (mode === '--files') {
    const entries = argv.slice(1).map((file) => ({ file, content: readFileSync(file) }));
    findings = scanFiles(entries, markers, rules, values);
    scope = `${entries.length} files`;
  } else {
    console.error(`Unknown mode ${mode}. See the header of scripts/marker-scan.mjs.`);
    return 2;
  }
  if (findings.length === 0) {
    console.log(`marker scan: clean (${scope}, ${markers.length} markers).`);
    return 0;
  }
  console.error(`marker scan: ${findings.length} private marker(s) found in ${scope}:`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}:${f.column}  ${f.marker}`);
  }
  console.error('Remove them, or, for a place docs/DESIGN.md#store-and-packaging allows, add a rule to scripts/marker-allowlist.json.');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
