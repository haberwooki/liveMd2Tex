// Development tool: the stand-in for the "Extra packages" add-on (livemd2tex-extra-data, docs/DESIGN.md#store-and-packaging and
// 5.5) until B1 builds the real one on CI. It holds one package the interim image lacks, REVTeX 4.2 (class, .rtx
// options, .sty helpers and .bst styles), taken unchanged from the pinned CTAN file revtex.tds.zip, so that a
// corpus document (P2) can go from "revtex4-2.cls is not inside" to a PDF through the Install Extra Packages
// route. Never published; tests and the throwaway profile only.
//
// It ships the way every data extension must (build gate 2, G2E-02; the contract is DataManifest in
// src/extension/engine/dataSets.ts): one image (data/extra.data with data/extra.index.json, built by
// scripts/lib/data-image.mjs in the layout of the core image) and data/manifest.json, never a tree of files.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildDataImage } from './data-image.mjs';
import { buildPackageIndex } from './package-index.mjs';
import { readZip } from './zip.mjs';

export const STANDIN_VERSION = '0.0.1';

function pins(root) {
  return JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8'));
}

/** The engine ABI the data must match: the SHA-256 of the pinned engine WebAssembly. */
export function engineAbi(root) {
  const tl = pins(root).sources.find((s) => s.id === 'texlyre-busytex');
  return tl.files.find((f) => f.name === 'busytex.wasm').sha256;
}

/** The stand-in's texmf files (texmf-relative path -> bytes), from the pinned REVTeX zip after its SHA-256 check. */
export function standinFiles(root) {
  const src = pins(root).sources.find((s) => s.id === 'ctan-revtex');
  const pin = src.files.find((f) => f.name === 'revtex.tds.zip');
  const zip = readFileSync(path.join(root, '..', 'engine_assets', src.folder, 'revtex.tds.zip'));
  if (createHash('sha256').update(zip).digest('hex') !== pin.sha256) {
    throw new Error('revtex.tds.zip does not match its pin; run node scripts/engine-assets.mjs');
  }
  const out = new Map();
  for (const [name, data] of readZip(zip)) {
    if (/^(tex|bibtex)\//.test(name)) {
      out.set(name, data);
    }
  }
  return out;
}

/**
 * Writes the stand-in data extension into `target` (an empty folder): package.json, README.md, LICENSE.txt,
 * data/manifest.json, data/extra.data and data/extra.index.json. scripts/build-extra-standin.mjs packages it.
 */
export function writeStandinFolder(root, target) {
  const files = standinFiles(root);
  const image = buildDataImage(files);
  const manifest = {
    ...standinManifest(root),
    image: { file: 'extra.data', index: 'extra.index.json', bytes: image.data.length, sha256: image.sha256 },
  };
  const pkg = {
    name: 'livemd2tex-extra-data',
    displayName: 'liveMd2Tex Extra Packages (test stand-in)',
    description: 'Test stand-in for the liveMd2Tex Extra Packages add-on: REVTeX 4.2 only. Not published.',
    version: STANDIN_VERSION,
    publisher: 'haberwooki',
    license: 'SEE LICENSE IN LICENSE.txt',
    engines: { vscode: '^1.105.0' },
    categories: ['Other'],
    extensionKind: ['ui', 'workspace'],
    private: true,
  };
  const write = (rel, data) => {
    const file = path.join(target, ...rel.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
  };
  write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  write(
    'README.md',
    '# liveMd2Tex Extra Packages (test stand-in)\n\nA data-only extension for tests of the "Install Extra Packages" route. It holds REVTeX 4.2f, ' +
      'unchanged from CTAN\'s revtex.tds.zip, as one data image (data/extra.data with its index), and data/manifest.json with its package list. It is never published.\n',
  );
  write(
    'LICENSE.txt',
    'The files in data/extra.data are REVTeX 4.2f by the American Physical Society, unchanged from CTAN\n' +
      '(https://ctan.org/pkg/revtex), distributed under the LaTeX Project Public License 1.3c\n' +
      '(https://www.latex-project.org/lppl/lppl-1-3c/). The rest of this test package is GPL-3.0-or-later, as liveMd2Tex.\n',
  );
  write('data/manifest.json', `${JSON.stringify(manifest)}\n`);
  write('data/extra.data', image.data);
  write('data/extra.index.json', `${JSON.stringify(image.index)}\n`);
  return { manifest, files: files.size };
}

/** The stand-in's manifest: the same shape as the interim core manifest's (format 1). */
export function standinManifest(root) {
  const files = standinFiles(root);
  const index = buildPackageIndex([...files.keys()], (rel) => files.get(rel).toString('latin1'));
  return {
    format: 1,
    set: 'extra-data stand-in: REVTeX 4.2f from CTAN (revtex.tds.zip), for tests only',
    texLive: 2026,
    abi: engineAbi(root),
    version: STANDIN_VERSION,
    index,
  };
}
