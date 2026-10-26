#!/usr/bin/env node
// B1's reference comparison (docs/DESIGN.md#engine-and-data, #testing), on CI only. It compiles the public corpus that
// test/engine/bundleCorpus.test.ts materialized into the bundle's folder with a TeX Live installed on the runner (the
// one place a TeX Live is installed, as the reference), counts each PDF's pages, and compares them with the bundle's
// counts (corpus-bundle.json). It writes corpus-reference.json and exits 1 when a count differs. It never runs on a
// development machine: it starts TeX Live's programs.
//
// The reference holds what the bundle draws from, not all of TeX Live (build gate B1, GB1E-07): install-tl gets a
// scheme-custom profile with the collections engine/bundle-sets.json names (and collection-xetex, for xelatex),
// installed under one folder without root; then tlmgr adds every package of the build's selection.json. Both are
// TeX Live's own Perl programs and run in the bundle workflow's reference job only, after the data packages are
// sealed; the builder itself starts no Perl.
//
//   node scripts/bundle-reference.mjs --profile DIR      prints the install-tl profile for a TeX Live in DIR
//   node scripts/bundle-reference.mjs --packages FILE    prints the package names of selection.json, one line
//   node scripts/bundle-reference.mjs --out ../bundle-out   compares (CI only)

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The collections the bundle draws from: both sets and their groups, and collection-xetex for xelatex. */
export function referenceCollections(sets) {
  const names = new Set(['collection-xetex']);
  for (const set of [sets['core-data'], sets['extra-data']]) {
    for (const c of [...(set?.collections ?? []), ...(set?.groups ?? []).flatMap((g) => g.collections ?? [])]) {
      names.add(c);
    }
  }
  return [...names].sort();
}

/** The install-tl profile: scheme-custom with those collections, everything under `dir`, no documentation. */
export function referenceProfile(sets, dir) {
  const d = dir.replace(/\/+$/, '');
  return [
    'selected_scheme scheme-custom',
    `TEXDIR ${d}`,
    `TEXMFLOCAL ${d}/texmf-local`,
    `TEXMFSYSVAR ${d}/texmf-var`,
    `TEXMFSYSCONFIG ${d}/texmf-config`,
    `TEXMFVAR ${d}/user/texmf-var`,
    `TEXMFCONFIG ${d}/user/texmf-config`,
    `TEXMFHOME ${d}/user/texmf`,
    ...referenceCollections(sets).map((c) => `${c} 1`),
    'instopt_adjustpath 0',
    'instopt_adjustrepo 0',
    'tlpdbopt_autobackup 0',
    'tlpdbopt_install_docfiles 0',
    'tlpdbopt_install_srcfiles 0',
    '',
  ].join('\n');
}

/** Every package of the build's selection (both sets), for tlmgr install. */
export function referencePackages(selection) {
  return [...new Set([...(selection.core ?? []), ...(selection.extra ?? [])])].filter((n) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n)).sort();
}

async function compare(out) {
  const { PDFDocument } = await import('pdf-lib');
  const bundle = JSON.parse(readFileSync(path.join(out, 'corpus-bundle.json'), 'utf8'));
  const tex = (cwd, program, args) => spawnSync(program, args, { cwd, encoding: 'utf8', timeout: 300000 });
  const reference = {};
  const differences = [];
  for (const [id, doc] of Object.entries(bundle.documents)) {
    const work = mkdtempSync(path.join(os.tmpdir(), `b1-ref-${id}-`));
    try {
      cpSync(path.join(out, doc.folder), work, { recursive: true });
      const base = doc.main.replace(/\.tex$/i, '');
      const program = doc.engine === 'xelatex' ? 'xelatex' : 'pdflatex';
      const run = () => tex(work, program, ['-interaction=nonstopmode', doc.main]);
      run();
      const aux = path.join(work, `${base}.aux`);
      if (existsSync(aux) && /\\bibdata\{/.test(readFileSync(aux, 'utf8'))) {
        tex(work, 'bibtex', [base]);
      }
      for (let i = 0; i < 3; i++) {
        const r = run();
        if (!/Rerun to get|Label\(s\) may have changed/.test(readFileSync(path.join(work, `${base}.log`), 'latin1')) || r.status === null) {
          break;
        }
      }
      const pdf = path.join(work, `${base}.pdf`);
      const pages = existsSync(pdf) ? (await PDFDocument.load(readFileSync(pdf))).getPageCount() : null;
      reference[id] = { engine: program, pages };
      if (pages !== doc.pages) {
        differences.push(`${id}: ${doc.pages ?? 'no PDF'} page(s) on the bundle, ${pages ?? 'no PDF'} on TeX Live`);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  const version = tex(os.tmpdir(), 'pdflatex', ['--version']).stdout?.split('\n')[0] ?? '';
  writeFileSync(path.join(out, 'corpus-reference.json'), `${JSON.stringify({ texLive: version, documents: reference, differences }, null, 2)}\n`);
  console.log(`reference: ${version}`);
  for (const [id, r] of Object.entries(reference)) {
    console.log(`  ${id}: ${r.pages ?? 'no PDF'} page(s) on TeX Live, ${bundle.documents[id].pages ?? 'no PDF'} on the bundle`);
  }
  if (differences.length > 0) {
    console.error(`page counts differ:\n  ${differences.join('\n  ')}`);
    return 1;
  }
  console.log('every page count matches');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
  if (arg('--profile')) {
    process.stdout.write(referenceProfile(readJson(path.join(root, 'engine', 'bundle-sets.json')), arg('--profile')));
  } else if (arg('--packages')) {
    console.log(referencePackages(readJson(arg('--packages'))).join(' '));
  } else if (process.env.CI !== 'true') {
    console.error('bundle-reference.mjs compares on CI only: it starts TeX Live\'s programs.');
    process.exitCode = 2;
  } else {
    process.exitCode = await compare(path.resolve(arg('--out') ?? path.join(root, '..', 'bundle-out')));
  }
}
