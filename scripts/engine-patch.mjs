#!/usr/bin/env node
// Development tool: applies engine/patches/busytex-glue.mjs to the pinned glue busytex.js and writes the
// patched copy OUTSIDE the repository, in <engine_assets>/derived/. It also writes the patch as a unified diff,
// engine/patches/busytex.js.diff, for review. The input is checked against its pinned SHA-256 first.
//
//   node scripts/engine-patch.mjs [--root DIR]

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--root');
const assetsRoot = path.resolve(i >= 0 ? process.argv[i + 1] : path.join(repo, '..', 'engine_assets'));
const pins = JSON.parse(readFileSync(path.join(repo, 'engine', 'pins.json'), 'utf8'));
const texlyre = pins.sources.find((s) => s.id === 'texlyre-busytex');
const { input, patches } = await import(pathToFileURL(path.join(repo, 'engine', 'patches', 'busytex-glue.mjs')).href);

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const source = readFileSync(path.join(assetsRoot, texlyre.folder, input.file));
if (sha(source) !== input.sha256) {
  console.error(`${input.file}: SHA-256 ${sha(source)} is not the pinned ${input.sha256}`);
  process.exit(1);
}

let text = source.toString('utf8');
for (const p of patches) {
  const n = text.split(p.find).length - 1;
  if (n !== p.count) {
    console.error(`patch ${p.id}: expected ${p.count} match(es), found ${n}`);
    process.exit(1);
  }
  text = text.split(p.find).join(p.replace);
}
const header = `// PATCHED COPY of ${input.file} (sha256 ${input.sha256}); patches: ${patches.map((p) => p.id).join(', ')}.\n`;
const out = header + text;
const derived = path.join(assetsRoot, 'derived');
mkdirSync(derived, { recursive: true });
const outFile = path.join(derived, 'busytex.patched.js');
writeFileSync(outFile, out);
writeFileSync(`${outFile}.sha256`, `${sha(Buffer.from(out))}  busytex.patched.js\n`);

// A reviewable unified diff with neutral labels (no local paths).
const diff = spawnSync('git', ['diff', '--no-index', '--no-color', '-U3', path.join(assetsRoot, texlyre.folder, input.file), outFile], {
  encoding: 'utf8',
  maxBuffer: 1 << 28,
});
const body = diff.stdout
  .split('\n')
  .filter((l) => !l.startsWith('diff --git') && !l.startsWith('index '))
  .map((l) => (l.startsWith('--- ') ? '--- a/busytex.js' : l.startsWith('+++ ') ? '+++ b/busytex.js' : l))
  .join('\n');
writeFileSync(path.join(repo, 'engine', 'patches', 'busytex.js.diff'), body);
console.log(`patched ${patches.length} places; wrote ${outFile} (sha256 ${sha(Buffer.from(out))}) and engine/patches/busytex.js.diff`);
