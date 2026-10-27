#!/usr/bin/env node
// Development tool for the engine's notices (engine/engine-notices.json, "search"; THIRD_PARTY_NOTICES.md,
// "Inside the engine"; the licence gates, F2-M1 to L5-01). A library on TeXlyre's link line can hold code by other
// authors under terms of their own, and the link-line test cannot see below the archive. This tool helps a person
// find that code; it is an aid to reading, not a proof. It reads the engine's pinned source archives and searches
// the compiled sources of every linked library for licence clauses, written out or stated by reference: each of
// the patterns in "clauses" ("Permission is hereby granted", "Redistribution and use in source and binary forms",
// "Released under", "licensed under", "SPDX-License-Identifier", "public domain" and others).
//
// What it guarantees: every clause that matches one of those patterns within one line or two adjacent lines (each
// line joined with the next, without comment marks), in a searched file, is either covered by one of the folder's
// own licences that may cover that kind of clause, or its file is named by a rule a person wrote. A clause in words
// none of the patterns knows, or split over three lines or more, is not seen.
//   - covered: an own licence ("own") lists the clause kinds it may cover ("clauses"), and its words are on the
//     clause's own line (or, for a named licence, in the clause's paragraph); every copyright holder on the
//     copyright lines up to 25 lines above the clause ("window") is named in its notice files, and a holder named
//     only by generic words ("the authors") names nobody. An own licence marked "reference" (a pointer to a notice
//     that ships) needs no holder of its own; one marked "anyHolder" (a licence that asks for no list of holders in
//     a copy) covers any holder, and says why. These two hold only when their words start on the clause's own line.
//     "unless" rules an own licence out when its pattern matches the clause's lines (the public-domain dedication's
//     catches "not", "n't", "no longer", "never" and "no" up to 40 characters before "public domain" in the same
//     sentence, stopping at "." and ";"), and "files" limits it to some of the folder's files;
//   - otherwise a rule must name the file: "notice" (a notice file that ships, which must be one of the folder's),
//     "covered" (why the shipped notices cover it) or "skip" (why it is not compiled into the engine).
// A file that is neither covered nor named, and a rule that names no flagged file, are problems. Known limits, which
// the person's reading is for: a clause split over three lines or more; a holder more than 25 lines above its
// clause; a denial of a dedication in other words; and a second author's grant of the same kind, with no copyright
// line of its own, which is checked against the first author's holder above it. On every engine pin change a
// person runs it, reads every new hit (--since the recorded report, engine/engine-notice-search.report.json)
// and every problem, and writes the rules before a release (docs/DEVELOPING.md, "When the engine pin changes").
//
//   node scripts/engine-notice-search.mjs --archives DIR [--report FILE] [--since FILE]
// DIR holds the archives of engine/engine-notices.json's "sources", by their names. --since lists the files whose
// hits are new or changed since an earlier report. It starts no program and opens no connection. Exit code 0 when
// every hit is accounted for; 1 with the problems.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { readTar } from './lib/tar.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Lower case, every run of other characters as one space, with a space at each end. */
const normal = (s) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** A line without its comment marks: leading slashes, stars, hashes and the like, and a trailing star-slash. */
const uncomment = (l) => l.replace(/^[\s*/#;%!|\\-]+/, '').replace(/\s*\*+\/\s*$/, '').trim();

/** A glob over a path relative to the folder: "*" within a name, "**" across folders. */
function globToRegExp(glob) {
  const body = glob
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
    .join('.*');
  return new RegExp(`^${body}$`);
}

/**
 * The holder a copyright line names, as its first two words in normal form ("francesco zappa"), or null for a line
 * that is no copyright statement ("the above copyright notice"). `next` is the following line, for a statement
 * whose holder is on the next line ("Copyright 2001-2015" then "Francesco Zappa Nardelli").
 */
export function holderOf(line, next = '') {
  const strip = (l) => l.replace(/^[\s*/#;%!|\\-]+/, '').replace(/\s*\*+\/\s*$/, '').trim();
  const s = strip(line);
  if (!/^(?:portions\s+)?(?:copyright\b|\(c\)\s*\d|©)/i.test(s)) {
    return null;
  }
  let rest = s
    .replace(/^(?:portions\s+)?copyright\s*/i, '')
    .replace(/^(?:\(c\)|©|Â©)\s*/i, '')
    .replace(/^[\d\s,\-–]+/, '')
    .replace(/^present\b,?\s*/i, '')
    .replace(/^and\s+later:?\s*/i, '')
    .replace(/^by\b\s*/i, '');
  if (/^(?:notice|holder|owner|and\b|statement|is\b|of\b)/i.test(rest)) {
    return null;
  }
  if (!rest.replace(/[^a-z]/gi, '')) {
    rest = strip(next);
  }
  const words = normal(rest.replace(/<[^>]*>/g, ' ').replace(/all rights reserved\.?/i, ' '))
    .trim()
    .split(' ')
    .filter((w) => !/^\d+$/.test(w) && w !== 'by');
  const key = words.slice(0, 2);
  // A holder named only by generic words ("the authors", "its contributors") names nobody: every MIT disclaimer
  // holds those words, so it must not count as named (the licence re-gate, L3-06).
  return key.length && !key.every((w) => GENERIC_HOLDER.has(w)) ? key.join(' ') : null;
}

/** Words that name no one in a copyright line. */
const GENERIC_HOLDER = new Set(['the', 'its', 'all', 'and', 'others', 'author', 'authors', 'contributor', 'contributors', 'copyright', 'holder', 'holders', 'owner', 'owners', 'respective', 'developers']);

/**
 * Searches one folder's files (relative path -> text) and sorts each file with a clause: covered, by a rule, or a
 * problem. `noticeText(file)` gives a notice file's text.
 *
 * Which own licence a clause is (the licence re-gates, L4-01, L4-02 and L5-01):
 *   - an own licence covers only the clause kinds it lists ("clauses", ids of the spec's clauses), so a clause of
 *     another kind is judged on its own, wherever it sits;
 *   - an exception ("anyHolder", "reference") covers a clause only when its words start on the clause's own line;
 *   - a named licence's words may also be elsewhere in the clause's paragraph (its non-blank lines, from 8 before
 *     to 5 after), as in "Permission to use, copy, modify ... the above copyright notice appear in all copies";
 *   - an own licence's words are a phrase ("text") or a pattern ("pattern"), and "unless" (a pattern) on the
 *     clause's lines rules it out, as "not in the public domain" rules out a public-domain dedication.
 * @returns {{ covered: string[], ruled: { file: string, how: string, why: string }[], problems: string[], hits: Record<string, string[]> }}
 */
export function searchFolder(files, folder, spec, noticeText) {
  const clauses = spec.clauses.map((c) => ({ id: c.id, re: new RegExp(c.pattern, 'i') }));
  const window = spec.window ?? 25;
  const problems = [];
  // Each own licence, with the files it may cover ("files", globs; all the folder's when it names none).
  const own = (folder.own ?? []).map((o) => {
    if (!o.clauses?.length || o.clauses.some((id) => !clauses.some((c) => c.id === id))) {
      problems.push(`${folder.path}: the own licence "${o.text ?? o.pattern}" must list the clause kinds it covers, by the ids of "clauses"`);
    }
    return {
      ...o,
      marker: o.text ? normal(o.text) : undefined,
      re: o.pattern ? new RegExp(o.pattern, 'i') : undefined,
      unlessRe: o.unless ? new RegExp(o.unless, 'i') : undefined,
      names: normal(o.notices.map(noticeText).join('\n')),
      res: (o.files ?? ['**']).map(globToRegExp),
    };
  });
  const rules = (folder.rules ?? []).map((r) => ({ ...r, res: r.files.map(globToRegExp), used: false }));
  const out = { covered: [], ruled: [], problems, hits: {} };
  for (const [rel, text] of [...files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const lines = text.split('\n');
    // Each line with the next, without comment marks, so a clause split over two lines is found too.
    const bare = lines.map(uncomment);
    const kindsAt = (i) => clauses.filter((c) => c.re.test(`${bare[i]} ${bare[i + 1] ?? ''}`) && !c.re.test(bare[i + 1] ?? '')).map((c) => c.id);
    const hits = bare.map((_, i) => [i, kindsAt(i)]).filter(([, kinds]) => kinds.length > 0);
    if (hits.length === 0) {
      continue;
    }
    out.hits[rel] = [...new Set(hits.flatMap(([, kinds]) => kinds))].sort();
    const applies = own.filter((o) => o.res.some((re) => re.test(rel)));
    const paragraph = (i) => {
      let a = i;
      while (a > Math.max(0, i - 8) && bare[a - 1] !== '') {
        a--;
      }
      let b = i;
      while (b < Math.min(bare.length - 1, i + 5) && bare[b + 1] !== '') {
        b++;
      }
      return bare.slice(a, b + 1).join(' ');
    };
    /** Whether an own licence's words are in a text; with `startBy`, they must start before that many characters. */
    const holds = (o, raw, startBy = Infinity) => {
      if (o.re) {
        const m = o.re.exec(raw);
        return Boolean(m) && m.index < startBy;
      }
      const n = normal(raw);
      const at = n.indexOf(o.marker);
      return at >= 0 && at < (startBy === Infinity ? Infinity : normal(raw.slice(0, startBy)).length);
    };
    const why = [];
    // Every clause kind on a hit's line must be covered, each by a licence of that kind: a line that holds two
    // kinds ("Redistribution and use ..., released under the libpng license") needs both.
    const covers = (i, kind) => {
      // The clause's own lines: its line, and the next one only for a clause or phrase that runs on to it.
      const lineText = `${bare[i]} ${bare[i + 1] ?? ''}`;
      const at = `line ${i + 1} ("${bare[i].slice(0, 60)}")`;
      const candidates = applies.filter((o) => o.clauses?.includes(kind) && !(o.unlessRe && o.unlessRe.test(lineText)));
      const group =
        candidates.find((o) => holds(o, lineText, bare[i].length + 1)) ?? candidates.find((o) => !o.anyHolder && !o.reference && holds(o, paragraph(i)));
      if (!group) {
        why.push(`${at}: no own licence of the folder covers this clause (${kind})`);
        return false;
      }
      // A licence that asks for no list of holders in a copy (FreeType's taken under its GPL option, a public-domain
      // dedication) covers any holder; the group says why ("anyHolder").
      if (group.anyHolder) {
        return true;
      }
      const holders = lines
        .slice(Math.max(0, i - window), i + 1)
        .map((l, j, a) => holderOf(l, a[j + 1]))
        .filter(Boolean);
      const unnamed = [...new Set(holders.filter((h) => !group.names.includes(` ${h} `)))];
      // A clause that points to a notice that ships ("See Copyright Notice in lua.h") needs no holder of its own
      // ("reference"); any holder it does name must still be named in the notices.
      if ((holders.length === 0 && !group.reference) || unnamed.length > 0) {
        why.push(`${at}: ${holders.length === 0 ? 'no copyright line above it' : `holders the notices do not name: ${unnamed.join(', ')}`}`);
        return false;
      }
      return true;
    };
    const isCovered = hits.every(([i, kinds]) => kinds.every((kind) => covers(i, kind)));
    const rule = rules.find((r) => r.res.some((re) => re.test(rel)));
    if (rule) {
      rule.used = true;
      if (rule.notice && !(folder.notices ?? []).includes(rule.notice)) {
        out.problems.push(`${folder.path}/${rel}: its rule names ${rule.notice}, which is not one of the folder's notices`);
      }
      out.ruled.push({ file: rel, how: rule.notice ? 'notice' : rule.skip ? 'skip' : 'covered', why: rule.notice ?? rule.skip ?? rule.covered });
    } else if (isCovered) {
      out.covered.push(rel);
    } else {
      out.problems.push(`${folder.path}/${rel}: ${[...new Set(why)].slice(0, 3).join('; ')}. Read it, then add its notice or a rule (engine/engine-notices.json, "search")`);
    }
  }
  for (const r of rules.filter((x) => !x.used)) {
    out.problems.push(`${folder.path}: the rule for ${r.files.join(', ')} names no file with a licence clause any more`);
  }
  return out;
}

/**
 * The hits of a run that an earlier run (its report) did not have: each file, by its folder, its path and the clause
 * kinds it holds. The archive's name is left out of the key, since it changes with every pin (it holds the commit).
 * @returns {string[]} "folder/file (kinds)", one per new or changed hit
 */
export function newHits(before, after) {
  const key = (f, rel, kinds) => `${f.path}|${rel}|${kinds.join(',')}`;
  const seen = new Set((before.folders ?? []).flatMap((f) => Object.entries(f.hits ?? {}).map(([rel, kinds]) => key(f, rel, kinds))));
  return after.folders.flatMap((f) =>
    Object.entries(f.hits ?? {})
      .filter(([rel, kinds]) => !seen.has(key(f, rel, kinds)))
      .map(([rel, kinds]) => `${f.path ? `${f.path}/` : ''}${rel} (${kinds.join(', ')})`),
  );
}

/** The files of an archive under a folder, relative to it: text of the compiled kinds only. */
export function folderFiles(entries, folderPath, extensions) {
  const ext = new RegExp(extensions, 'i');
  const prefix = folderPath ? `${folderPath.replace(/\/$/, '')}/` : '';
  const files = new Map();
  for (const e of entries) {
    if (e.type !== 'file') {
      continue;
    }
    const rel = e.path.slice(e.path.indexOf('/') + 1);
    if (rel.startsWith(prefix) && ext.test(rel)) {
      files.set(rel.slice(prefix.length), Buffer.from(e.data).toString('utf8'));
    }
  }
  return files;
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = arg('--archives');
  if (!dir) {
    console.error('usage: engine-notice-search.mjs --archives DIR [--report FILE] [--since FILE]');
    return 2;
  }
  const manifest = JSON.parse(readFileSync(path.join(root, 'engine', 'engine-notices.json'), 'utf8'));
  const spec = manifest.search;
  const noticeText = (f) => readFileSync(path.join(root, f), 'utf8');
  const archives = new Map();
  const report = { date: new Date().toISOString().slice(0, 10), folders: [], problems: [] };
  for (const folder of spec.folders) {
    if (!archives.has(folder.archive)) {
      archives.set(folder.archive, readTar(gunzipSync(readFileSync(path.join(dir, folder.archive)))));
    }
    const files = folderFiles(archives.get(folder.archive), folder.path, spec.extensions);
    if (files.size === 0) {
      report.problems.push(`${folder.archive}: ${folder.path} holds no source file; is the folder still there?`);
    }
    const r = searchFolder(files, folder, spec, noticeText);
    report.folders.push({ archive: folder.archive, path: folder.path, files: files.size, covered: r.covered.length, ruled: r.ruled, hits: r.hits });
    report.problems.push(...r.problems);
    console.log(`${folder.path || folder.archive}: ${files.size} files; ${r.covered.length} covered by the folder's notices; ${r.ruled.length} by a rule`);
  }
  // The hits since an earlier run (its report): the files a person reads first after a new engine pin.
  const sinceFile = arg('--since');
  if (sinceFile) {
    const before = JSON.parse(readFileSync(sinceFile, 'utf8'));
    const fresh = newHits(before, report);
    console.log(fresh.length === 0 ? `no new hits since ${before.date ?? sinceFile}` : `${fresh.length} new or changed hit(s) since ${before.date ?? sinceFile}, to read:`);
    fresh.forEach((text) => console.log(`  ${text}`));
  }
  const reportFile = arg('--report');
  if (reportFile) {
    writeFileSync(reportFile, `${JSON.stringify(report, null, 1)}\n`);
  }
  report.problems.forEach((p) => console.error(p));
  console.log(report.problems.length === 0 ? 'every licence clause is accounted for' : `${report.problems.length} problem(s)`);
  return report.problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
