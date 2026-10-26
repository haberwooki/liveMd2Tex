#!/usr/bin/env node
// Development tool: downloads the small CTAN set S1 needs (docs/DESIGN.md#engine-and-data: corpus samples, the six
// publisher classes with their .bst files, DejaVu) from one fixed CTAN mirror into ../engine_assets/ctan-<id>/,
// computes each file's SHA-256 and writes the entries into engine/pins.json. CTAN publishes no checksums, so
// these pins record the files as first downloaded on the date below; scripts/engine-assets.mjs rechecks them
// on every later fetch, and a changed file fails until it is reviewed and re-pinned here.
//
//   node scripts/pin-ctan.mjs              every set below
//   node scripts/pin-ctan.mjs ctan-tensor  only the named sets (the others keep their pins)

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsRoot = path.join(repo, '..', 'engine_assets');
const MIRROR = 'https://mirrors.ibiblio.org/pub/mirrors/CTAN';

const sets = [
  {
    id: 'ctan-revtex',
    package: 'revtex 4.2f',
    licence: 'LPPL 1.3c (docs/DESIGN.md#testing, P2)',
    dir: '/install/macros/latex/contrib',
    files: ['revtex.tds.zip'],
  },
  {
    id: 'ctan-ieeetran',
    package: 'IEEEtran 1.8b',
    licence: 'LPPL 1.3 (P3)',
    dir: '/macros/latex/contrib/IEEEtran',
    files: ['IEEEtran.cls', 'bare_jrnl.tex', 'bibtex/IEEEtran.bst'],
  },
  {
    id: 'ctan-elsarticle',
    package: 'elsarticle 3.5',
    licence: 'LPPL 1.3 or later (P4)',
    dir: '/macros/latex/contrib/elsarticle',
    files: ['elsarticle.dtx', 'elsarticle.ins', 'elsarticle-template-num.tex', 'elsarticle-num.bst'],
  },
  {
    id: 'ctan-beamer-example',
    package: 'beamer 3.78 documentation example',
    licence: 'FDL 1.3 or LPPL 1.3c, the LPPL option taken (P6)',
    dir: '/macros/latex/contrib/beamer/doc/examples/a-conference-talk',
    files: ['beamerexample-conference-talk.tex'],
  },
  {
    id: 'ctan-ucbthesis',
    package: 'ucbthesis 3.6',
    licence: 'LPPL 1.3 or later (P7)',
    dir: '/macros/latex/contrib/ucbthesis',
    files: ['ucbthesis.cls', 'thesis.tex', 'abstract.tex', 'chap1.tex', 'chap2.tex', 'references.bib'],
  },
  {
    id: 'ctan-acmart',
    package: 'acmart 2.20',
    licence: 'LPPL 1.3 or later (P12)',
    dir: '/macros/latex/contrib/acmart',
    files: [
      'acmart.dtx',
      'acmart.ins',
      'ACM-Reference-Format.bst',
      'samples/samples.dtx',
      'samples/samples.ins',
      'samples/sample-base.bib',
      'samples/sampleteaser.pdf',
    ],
  },
  {
    id: 'ctan-llncs',
    package: 'llncs 2.26',
    licence: 'CC BY 4.0 (P13)',
    dir: '/macros/latex/contrib/llncs',
    files: ['llncs.cls', 'splncs04.bst', 'llncsdoc.tex'],
  },
  {
    id: 'ctan-pgf-manual',
    package: 'pgf 3.1.12 manual source (tutorial chapter)',
    licence: 'FDL 1.2 or LPPL 1.3c, the LPPL option taken (P8)',
    dir: '/graphics/pgf/base/doc/generic/pgf',
    files: ['pgfmanual-en-tutorial.tex'],
  },
  {
    // M6 (docs/DESIGN.md#engine-and-data): a real .dtx and .ins package that the interim image lacks, built by
    // "Add a package from a file" with the bundled engine.
    id: 'ctan-tensor',
    package: 'tensor 2.2',
    licence: 'LPPL 1.3c or later (M6 .dtx/.ins test; 2023/07/18 v2.2)',
    dir: '/macros/latex/contrib/tensor',
    files: ['tensor.dtx', 'tensor.ins'],
  },
  {
    id: 'ctan-dejavu',
    package: 'DejaVu 2.34 (TrueType)',
    licence: 'Bitstream Vera licence with DejaVu changes; LPPL 1.3 for the TeX support (CTAN)',
    dir: '/fonts/dejavu',
    files: [
      ...['DejaVuSans', 'DejaVuSans-Bold', 'DejaVuSans-Oblique', 'DejaVuSans-BoldOblique'],
      ...['DejaVuSerif', 'DejaVuSerif-Bold', 'DejaVuSerif-Italic', 'DejaVuSerif-BoldItalic'],
      ...['DejaVuSansMono', 'DejaVuSansMono-Bold', 'DejaVuSansMono-Oblique', 'DejaVuSansMono-BoldOblique'],
    ]
      .map((f) => `truetype/${f}.ttf`)
      .concat(['doc/font-doc/LICENSE']),
  },
];

const pinsFile = path.join(repo, 'engine', 'pins.json');
const pins = JSON.parse(readFileSync(pinsFile, 'utf8'));
let total = 0;
const only = process.argv.slice(2);
for (const set of sets.filter((s) => only.length === 0 || only.includes(s.id))) {
  const folder = set.id;
  const files = [];
  for (const rel of set.files) {
    const url = `${MIRROR}${set.dir}/${rel}`;
    const res = await fetch(url, { headers: { 'user-agent': 'latex-preview-s1-assets' } });
    if (!res.ok) {
      throw new Error(`${url}: HTTP ${res.status}`);
    }
    const data = Buffer.from(await res.arrayBuffer());
    const target = path.join(assetsRoot, folder, ...rel.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
    files.push({ name: rel, url, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    total += data.length;
  }
  const entry = {
    id: set.id,
    folder,
    package: set.package,
    licence: set.licence,
    note: 'SHA-256 recorded at first download from the mirror named in each URL (CTAN publishes no checksums).',
    pinned: new Date().toISOString().slice(0, 10),
    files,
  };
  const i = pins.sources.findIndex((s) => s.id === set.id);
  if (i >= 0) {
    pins.sources[i] = entry;
  } else {
    pins.sources.push(entry);
  }
  console.log(`${set.id}: ${files.length} files, ${files.reduce((n, f) => n + f.size, 0)} bytes`);
}
writeFileSync(pinsFile, `${JSON.stringify(pins, null, 2)}\n`);
console.log(`pinned ${total} bytes in engine/pins.json`);
