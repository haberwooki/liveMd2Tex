#!/usr/bin/env node
// Development tool: puts the engine (and, with --data, the interim TeX data) inside dist/ so that F5, the
// integration tests and a test-copy VSIX find them where the extension looks (src/extension/engine/
// engineService.ts):
//   dist/engine/  busytex.js (the patched glue), busytex.wasm, texmf-override.cnf, fonts.conf
//   dist/data/    texlive-extra.data (TeXlyre's image, unchanged), texlive-extra.index.json (its loader's
//                 metadata as JSON, so no loader script ships), manifest.json, packages.json (the package index
//                 of docs/DESIGN.md#architecture, #engine-and-data, built from the image's own .sty and .cls files and cached in
//                 ../engine_assets/derived/; the interim stand-in for B1's manifest), fonts/ (the Markdown notes
//                 template's DejaVu files from the pinned CTAN set, until B1)
// Large files are hard links to ../engine_assets when the file system allows, so nothing is copied twice.
// Every input is checked against engine/pins.json first. build.mjs empties dist/, so run this after it.
//
//   node scripts/stage-engine.mjs [--data] [--if-present]
// --if-present: without the engine downloads (a fresh clone, CI), say so and stop without an error; the engine
// tests then skip.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { engineAbi, standinManifest } from './lib/extra-standin.mjs';
import { openImage } from './lib/image-files.mjs';
import { buildPackageIndex, INDEX_FORMAT } from './lib/package-index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function linkOrCopy(from, to) {
  rmSync(to, { force: true });
  try {
    linkSync(from, to);
    return 'linked';
  } catch {
    copyFileSync(from, to);
    return 'copied';
  }
}

/** The JSON object that starts at the first "{" at or after `from` (brace counting outside strings). */
function jsonAt(source, from) {
  const start = source.indexOf('{', from);
  let depth = 0;
  let inString = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(source.slice(start, i + 1));
  }
  throw new Error('unbalanced JSON in the loader');
}

export function stageEngine({ data = false } = {}) {
  const assets = path.join(root, '..', 'engine_assets');
  const pins = JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8'));
  const tl = pins.sources.find((s) => s.id === 'texlyre-busytex');
  const pinOf = (name) => tl.files.find((f) => f.name === name);
  const dir = path.join(assets, tl.folder);
  const check = (name) => {
    const file = path.join(dir, name);
    const pin = pinOf(name);
    if (!existsSync(file) || statSync(file).size !== pin.size) {
      throw new Error(`${name} is missing or has the wrong size; run node scripts/engine-assets.mjs`);
    }
    return file;
  };
  const glue = path.join(assets, 'derived', 'busytex.patched.js');
  if (!existsSync(glue)) {
    throw new Error('the patched glue is missing; run node scripts/engine-patch.mjs');
  }
  // The patched glue is pinned too: a glue without one of the patches must not reach a package (G1S-08).
  if (tl.patchedGlue && sha256File(glue) !== tl.patchedGlue.sha256) {
    throw new Error(`the patched glue's SHA-256 is not the pinned ${tl.patchedGlue.sha256}; run node scripts/engine-patch.mjs and review the patches`);
  }
  const engineDir = path.join(root, 'dist', 'engine');
  mkdirSync(engineDir, { recursive: true });
  copyFileSync(glue, path.join(engineDir, 'busytex.js'));
  const how = linkOrCopy(check('busytex.wasm'), path.join(engineDir, 'busytex.wasm'));
  copyFileSync(path.join(root, 'engine', 'texmf-override.cnf'), path.join(engineDir, 'texmf-override.cnf'));
  copyFileSync(path.join(root, 'engine', 'fonts.conf'), path.join(engineDir, 'fonts.conf'));
  const report = [`dist/engine: glue, wasm (${how}), texmf-override.cnf, fonts.conf`];

  const dataDir = path.join(root, 'dist', 'data');
  rmSync(dataDir, { recursive: true, force: true });
  if (data) {
    mkdirSync(dataDir, { recursive: true });
    const image = check('texlive-extra.data');
    const imageHow = linkOrCopy(image, path.join(dataDir, 'texlive-extra.data'));
    const loader = readFileSync(check('texlive-extra.js'), 'utf8');
    const index = {
      compressed: jsonAt(loader, loader.indexOf('var compressedData = ')),
      metadata: jsonAt(loader, loader.lastIndexOf('loadPackage({"files"')),
    };
    writeFileSync(path.join(dataDir, 'texlive-extra.index.json'), JSON.stringify(index));
    const manifest = {
      format: 1,
      set: 'interim: TeXlyre texlive-extra image, unchanged (docs/DESIGN.md#engine-and-data, #testing, V0)',
      texLive: 2026,
      release: tl.release,
      image: { file: 'texlive-extra.data', bytes: pinOf('texlive-extra.data').size, sha256: pinOf('texlive-extra.data').sha256 },
      engine: { file: '../engine/busytex.wasm', sha256: pinOf('busytex.wasm').sha256 },
      glue: { file: '../engine/busytex.js', sha256: sha256File(path.join(engineDir, 'busytex.js')), patchedFrom: pinOf('busytex.js').sha256 },
      files: index.metadata.files.length,
      // The data must match the engine: the SHA-256 of the engine WebAssembly is its ABI (docs/DESIGN.md#store-and-packaging).
      abi: engineAbi(root),
    };
    // The package index (cached per image and index format: reading every .sty and .cls takes a few seconds).
    const cache = path.join(assets, 'derived', `package-index-${pinOf('texlive-extra.data').sha256.slice(0, 16)}-v${INDEX_FORMAT}.json`);
    let packages;
    if (existsSync(cache)) {
      packages = JSON.parse(readFileSync(cache, 'utf8'));
    } else {
      const reader = openImage(image, index.compressed);
      const prefix = '/texlive/texmf-dist/';
      const entries = new Map(index.metadata.files.filter((f) => f.filename.startsWith(prefix)).map((f) => [f.filename.slice(prefix.length), f]));
      packages = buildPackageIndex([...entries.keys()], (rel) => reader.read(entries.get(rel).start, entries.get(rel).end).toString('latin1'));
      writeFileSync(cache, JSON.stringify(packages));
    }
    writeFileSync(path.join(dataDir, 'packages.json'), JSON.stringify(packages));
    manifest.index = { file: 'packages.json', format: packages.format, packages: Object.keys(packages.packages).length, files: Object.keys(packages.files).length };
    // What the Extra Packages add-on holds, so the missing-package message can offer it (docs/DESIGN.md#engine-and-data).
    // Until B1 the add-on is the test stand-in (scripts/lib/extra-standin.mjs).
    try {
      const extra = standinManifest(root);
      // With each package's requires, so the first message can also name a dependency no set has (G2S-04).
      const requires = Object.fromEntries(Object.entries(extra.index.packages).map(([p, v]) => [p, v.requires ?? []]));
      manifest.elsewhere = { 'livemd2tex-extra-data': { set: extra.set, files: extra.index.files, requires } };
    } catch {
      // without the pinned REVTeX zip, nothing is listed elsewhere
    }
    // The Markdown notes template's DejaVu fonts (pinned CTAN set; docs/DESIGN.md#engine-and-data), which the image lacks.
    // The extension hands them to XeTeX as project files (src/extension/engine/interimFonts.ts) until B1.
    const dejavu = pins.sources.find((s) => s.id === 'ctan-dejavu');
    if (dejavu) {
      const fontsDir = path.join(dataDir, 'fonts');
      mkdirSync(fontsDir, { recursive: true });
      const ttf = dejavu.files.filter((x) => /\.ttf$/.test(x.name));
      for (const f of ttf) {
        const from = path.join(assets, dejavu.folder, ...f.name.split('/'));
        if (!existsSync(from) || statSync(from).size !== f.size) {
          throw new Error(`${f.name} is missing or has the wrong size; run node scripts/engine-assets.mjs`);
        }
        linkOrCopy(from, path.join(fontsDir, path.posix.basename(f.name)));
      }
      // The fonts' licence goes with every copy (Bitstream Vera licence; build gate 1, G1S-04).
      const licence = dejavu.files.find((x) => /(^|\/)LICENSE$/.test(x.name));
      if (!licence || !existsSync(path.join(assets, dejavu.folder, ...licence.name.split('/')))) {
        throw new Error('the DejaVu LICENSE is missing; run node scripts/engine-assets.mjs');
      }
      copyFileSync(path.join(assets, dejavu.folder, ...licence.name.split('/')), path.join(fontsDir, 'LICENSE'));
      manifest.interimFonts = { package: dejavu.package, licence: dejavu.licence, files: ttf.map((f) => ({ file: `fonts/${path.posix.basename(f.name)}`, sha256: f.sha256 })) };
    }
    // The licence files inside TeXlyre's image, as readable copies beside it: TeX Live's and CTAN's licence
    // notes and the LPPL (build gate 1, G1S-04). The image itself is unchanged.
    const reader = openImage(image, index.compressed);
    const licenceDir = path.join(dataDir, 'licenses');
    mkdirSync(licenceDir, { recursive: true });
    for (const [name, out] of [['/texlive/LICENSE.TL', 'TeX-Live-LICENSE.TL.txt'], ['/texlive/LICENSE.CTAN', 'TeX-Live-LICENSE.CTAN.txt'], ['/texlive/texmf-dist/tex/latex/base/lppl.tex', 'lppl.tex']]) {
      const entry = index.metadata.files.find((f) => f.filename === name);
      if (!entry) {
        throw new Error(`${name} is not in the image`);
      }
      writeFileSync(path.join(licenceDir, out), reader.read(entry.start, entry.end));
    }
    manifest.licences = 'licenses/ (TeX Live, CTAN, LPPL); fonts/LICENSE (DejaVu)';
    writeFileSync(path.join(dataDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    report.push(`dist/data: image (${imageHow}, ${manifest.image.bytes} bytes), index (${manifest.files} files), packages.json (${manifest.index.packages} packages), ${manifest.interimFonts ? `fonts/ (${manifest.interimFonts.files.length} DejaVu files), ` : ''}manifest.json`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(stageEngine({ data: process.argv.includes('--data') }).join('\n'));
  } catch (err) {
    if (!process.argv.includes('--if-present')) {
      throw err;
    }
    console.log(`stage-engine: skipped (${err.message})`);
  }
}
