// Lays out the test documents as ready-to-compile project folders under a temporary folder (never inside the
// repository): P1-P8 from test/corpus and the pinned CTAN files in ../engine_assets, the Markdown corpus P9, P10,
// P16 and P17 from test/converter/corpus with the figures and bibliography they use, and T1-T5 copied from the
// private fixtures when .private-fixtures.json exists. Used by the V0 tests, in Node and in VS Code.

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { PDFDocument, rgb } from 'pdf-lib';
import { convertMarkdown } from '../../src/converter/markdownToLatex';
import { importScript, root } from './helpers';

export interface CorpusProject {
  id: string;
  /** The project folder (absolute). */
  folder: string;
  /** The main file, relative to the folder. */
  main: string;
  private: boolean;
}

interface Pins {
  sources: { id: string; folder: string }[];
}

const assets = path.resolve(root, '..', 'engine_assets');

function ctanFolder(id: string): string {
  const pins = JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8')) as Pins;
  return path.join(assets, pins.sources.find((s) => s.id === id)?.folder ?? id);
}

function copyFlat(fromDir: string, names: string[], toDir: string): void {
  mkdirSync(toDir, { recursive: true });
  for (const n of names) {
    cpSync(path.join(fromDir, ...n.split('/')), path.join(toDir, path.basename(n)));
  }
}

/** A figure for P1, drawn in code (CC0): a resonance curve. */
export async function responseFigure(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 180]);
  let last: { x: number; y: number } | null = null;
  for (let i = 0; i <= 200; i++) {
    const w = 0.5 + i / 100;
    const y = 1 / Math.sqrt((1 - w * w) ** 2 + (w / 8) ** 2);
    const p = { x: 20 + i * 1.3, y: 20 + Math.min(y, 9) * 16 };
    if (last) {
      page.drawLine({ start: last, end: p, thickness: 1.5, color: rgb(0.1, 0.2, 0.7) });
    }
    last = p;
  }
  page.drawLine({ start: { x: 20, y: 20 }, end: { x: 290, y: 20 }, thickness: 1 });
  page.drawLine({ start: { x: 20, y: 20 }, end: { x: 20, y: 170 }, thickness: 1 });
  doc.setCreationDate(new Date(Date.UTC(2026, 0, 1)));
  doc.setModificationDate(new Date(Date.UTC(2026, 0, 1)));
  return doc.save();
}

/** A small RGB PNG drawn in code (a diagonal gradient), for the Markdown corpus's figures. */
export function tinyPng(width = 64, height = 40): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (width * 3 + 1);
    rows[at] = 0;
    for (let x = 0; x < width; x++) {
      rows[at + 1 + x * 3] = Math.round((255 * x) / width);
      rows[at + 2 + x * 3] = Math.round((255 * y) / height);
      rows[at + 3 + x * 3] = 160;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The Markdown corpus (agent B's test/converter/corpus, CC0) as project folders, with the figures and the
 * bibliography the documents refer to, drawn or written here: P9 notes, P10 paper (references.bib with an entry
 * for every cited key, figures/ratio.png, figures/spectrum.pdf), P16 README (docs/logo.png), P17 Obsidian note;
 * and two of M1's stand-ins (test/converter/m1, CC0): M1-unsupported (one warning per unsupported construct)
 * and M1-tex-error (a TeX error on a known Markdown line).
 */
export async function materializeMarkdownCorpus(target: string): Promise<CorpusProject[]> {
  const corpus = path.join(root, 'test', 'converter', 'corpus');
  const out: CorpusProject[] = [];
  const put = (id: string, file: string, assets: Record<string, Uint8Array | string>, from = corpus) => {
    const folder = path.join(target, id);
    mkdirSync(folder, { recursive: true });
    cpSync(path.join(from, file), path.join(folder, file));
    for (const [name, data] of Object.entries(assets)) {
      mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
      writeFileSync(path.join(folder, name), data);
    }
    out.push({ id, folder, main: file, private: false });
  };
  put('P9', 'P9-notes.md', {});
  const paper = convertMarkdown(readFileSync(path.join(corpus, 'P10-paper.md'), 'utf8'));
  const bib = paper.citationKeys
    .map((key, i) => `@article{${key},\n  author = {Author, A. and Writer, B.},\n  title = {Test entry ${i + 1}},\n  journal = {Journal of Tests},\n  year = {${2001 + i}},\n  volume = {${i + 1}},\n  pages = {1--10}\n}\n`)
    .join('\n');
  put('P10', 'P10-paper.md', { 'references.bib': bib, 'figures/ratio.png': tinyPng(), 'figures/spectrum.pdf': await responseFigure() });
  put('P16', 'P16-github-readme.md', { 'docs/logo.png': tinyPng(48, 48) });
  put('P17', 'P17-obsidian-note.md', { 'phonon-dispersion.png': tinyPng(), 'spectrum-sketch.png': tinyPng(80, 50) });
  const m1 = path.join(root, 'test', 'converter', 'm1');
  put('M1-unsupported', 'unsupported.md', {}, m1);
  put('M1-tex-error', 'tex-error.md', {}, m1);
  return out;
}

/**
 * Writes the projects into `target`. `buildClass` turns a .dtx/.ins pair into its class text (P4's elsarticle
 * ships only as .dtx; the tests build it with the engine's docstrip). `includePrivate: false` leaves T1 to T5 out
 * even when .private-fixtures.json exists (for a sample folder that someone else may see).
 */
export async function materializeCorpus(
  target: string,
  buildClass: (folder: string, ins: string, cls: string) => Promise<string>,
  options: { includePrivate?: boolean } = {},
): Promise<CorpusProject[]> {
  const out: CorpusProject[] = [];
  const add = (id: string, folder: string, main: string, isPrivate = false) => out.push({ id, folder, main, private: isPrivate });

  const p1 = path.join(target, 'P1');
  cpSync(path.join(root, 'test', 'corpus', 'P1'), p1, { recursive: true });
  writeFileSync(path.join(p1, 'fig-response.pdf'), await responseFigure());
  add('P1', p1, 'paper.tex');

  const p2 = path.join(target, 'P2');
  mkdirSync(p2, { recursive: true });
  const { readZip } = await importScript<{ readZip(b: Buffer): Map<string, Buffer> }>('scripts/lib/zip.mjs');
  for (const [name, data] of readZip(readFileSync(path.join(ctanFolder('ctan-revtex'), 'revtex.tds.zip')))) {
    if (/^tex\/latex\/revtex\/|^bibtex\/bst\/revtex\/apsrev4-2\.bst$|^doc\/latex\/revtex\/sample\/aps\/(apssamp\.(tex|bib)|.*\.eps)$/.test(name)) {
      writeFileSync(path.join(p2, path.posix.basename(name)), data);
    }
  }
  add('P2', p2, 'apssamp.tex');

  const p3 = path.join(target, 'P3');
  copyFlat(ctanFolder('ctan-ieeetran'), ['IEEEtran.cls', 'bare_jrnl.tex', 'bibtex/IEEEtran.bst'], p3);
  add('P3', p3, 'bare_jrnl.tex');

  const p4 = path.join(target, 'P4');
  copyFlat(ctanFolder('ctan-elsarticle'), ['elsarticle-template-num.tex', 'elsarticle-num.bst'], p4);
  const build = path.join(target, '_build-elsarticle');
  copyFlat(ctanFolder('ctan-elsarticle'), ['elsarticle.dtx', 'elsarticle.ins'], build);
  writeFileSync(path.join(p4, 'elsarticle.cls'), await buildClass(build, 'elsarticle.ins', 'elsarticle.cls'));
  add('P4', p4, 'elsarticle-template-num.tex');

  const p5 = path.join(target, 'P5');
  cpSync(path.join(root, 'test', 'corpus', 'P5'), p5, { recursive: true });
  add('P5', p5, 'manuscript.tex');

  const p6 = path.join(target, 'P6');
  copyFlat(ctanFolder('ctan-beamer-example'), ['beamerexample-conference-talk.tex'], p6);
  add('P6', p6, 'beamerexample-conference-talk.tex');

  const p7 = path.join(target, 'P7');
  copyFlat(ctanFolder('ctan-ucbthesis'), ['ucbthesis.cls', 'thesis.tex', 'abstract.tex', 'chap1.tex', 'chap2.tex', 'references.bib'], p7);
  // biblatex's default backend is Biber, which is not in version 0; its bibtex8 backend is used instead.
  const thesis = path.join(p7, 'thesis.tex');
  writeFileSync(thesis, readFileSync(thesis, 'utf8').replace('\\usepackage{biblatex}', '\\usepackage[backend=bibtex8]{biblatex}'));
  add('P7', p7, 'thesis.tex');

  const p8 = path.join(target, 'P8');
  cpSync(path.join(root, 'test', 'corpus', 'P8'), p8, { recursive: true });
  const tutorial = readFileSync(path.join(ctanFolder('ctan-pgf-manual'), 'pgfmanual-en-tutorial.tex'), 'utf8');
  const pictures = [...tutorial.matchAll(/\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/g)].map((m) => m[0]).slice(0, 2);
  writeFileSync(
    path.join(p8, 'manual-pictures.tex'),
    ['\\documentclass[border=4pt]{standalone}', '\\usepackage{tikz}', '\\usetikzlibrary{arrows.meta,calc,intersections,through,backgrounds}', '\\begin{document}', ...pictures, '\\end{document}', ''].join('\n'),
  );
  add('P8', p8, 'pictures.tex');
  add('P8-manual', p8, 'manual-pictures.tex');

  out.push(...(await materializeMarkdownCorpus(target)));

  // M2-B: two root documents in one folder, sharing refs.bib and a section (test/corpus/multiroot, CC0).
  const multi = path.join(target, 'multiroot');
  cpSync(path.join(root, 'test', 'corpus', 'multiroot'), multi, { recursive: true });
  add('MR-paper', multi, 'paper.tex');
  add('MR-notes', multi, 'notes.tex');

  const configFile = path.join(root, '.private-fixtures.json');
  if (options.includePrivate !== false && existsSync(configFile)) {
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as { root: string; fixtures: Record<string, { main: string }> };
    const base = path.resolve(root, config.root);
    for (const id of ['T1', 'T2', 'T3', 'T4', 'T5']) {
      const entry = config.fixtures[id];
      if (!entry) {
        continue;
      }
      const main = path.resolve(base, entry.main);
      const folder = path.join(target, id);
      if (id === 'T5') {
        mkdirSync(folder, { recursive: true });
        cpSync(main, path.join(folder, path.basename(main)));
      } else {
        cpSync(path.dirname(main), folder, { recursive: true });
      }
      add(id, folder, path.basename(main), true);
    }
  }
  // Copies of the read-only private files stay read-only on Windows; the tests edit and save them.
  const writable = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        writable(full);
      } else {
        chmodSync(full, 0o666);
      }
    }
  };
  writable(target);
  return out;
}
