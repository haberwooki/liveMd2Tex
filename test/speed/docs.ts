// The speed benchmark set (docs/DEVELOPING.md, "Measuring speed"): six documents that every speed change
// reports against. Four come from the public corpus (test/corpus, test/converter/corpus and the pinned CTAN files
// in ../engine_assets); two are written here and dedicated to the public domain (CC0 1.0): a XeLaTeX document
// that names its fonts, and a long article. Each is laid out as a project folder under a temporary folder.

import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { materializeMarkdownCorpus, responseFigure } from '../support/corpusProjects';
import { root } from '../support/helpers';

export interface BenchDoc {
  /** Short name used in tables and in the results. */
  id: string;
  /** What it stands for. */
  what: string;
  folder: string;
  main: string;
  source: 'tex' | 'markdown';
}

interface Pins {
  sources: { id: string; folder: string }[];
}

function ctanFolder(id: string): string {
  const pins = JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8')) as Pins;
  return path.join(root, '..', 'engine_assets', pins.sources.find((s) => s.id === id)?.folder ?? id);
}

/** XeLaTeX with fonts chosen by family name (fontspec, unicode-math). Written for this benchmark; CC0 1.0. */
export const XEFONTS_TEX = String.raw`% Speed benchmark document (test/speed/docs.ts): XeLaTeX with fonts chosen by name. Written by the
% project; dedicated to the public domain (CC0 1.0).
\documentclass[11pt]{article}
\usepackage{fontspec}
\usepackage{unicode-math}
\setmainfont{TeX Gyre Pagella}
\setsansfont{TeX Gyre Heros}
\setmathfont{Latin Modern Math}
\begin{document}
\section{Heat flow through a bar}
The sample sits between two copper blocks at T₁ = 300 K and T₂ = 310 K, so ΔT ≈ 10 K. Heat flows from the hot
block to the cold one, and Fourier's law gives the flux,
\begin{equation}
  q = -k \nabla T, \qquad k = \frac{P L}{A\,\Delta T}.
\end{equation}
\textsf{Sans serif text in TeX Gyre Heros}, then back to Pagella: café, naïve, Straße, Ångström, and an en dash in 1–2.

\section{A sum and an integral}
\begin{equation}
  \sum_{n=1}^{\infty} \frac{1}{n^{2}} = \frac{\pi^{2}}{6}, \qquad \int_{0}^{\infty} e^{-x^{2}}\,dx = \frac{\sqrt{\pi}}{2}.
\end{equation}
Greek in text and math: α, β, γ and $\alpha + \beta = \gamma$; arrows → and ⇒; a bold vector $\symbf{v}$.

\section{A list}
\begin{itemize}
  \item The main font is found by its family name, not its file name.
  \item The sans serif and math fonts are found the same way.
\end{itemize}
\end{document}
`;

/**
 * Filler sentences for the long article, written for this benchmark (CC0 1.0). The core data set has no lipsum,
 * so the text is made here: paragraph k of section s takes seven of these in a fixed order.
 */
const FILLER = [
  'The sample was cooled slowly, and its temperature was logged every ten seconds.',
  'Each run started from the same state, so the runs can be compared directly.',
  'The heater power was held constant while the two thermocouples were read.',
  'A small drift in the baseline was removed before the data were fitted.',
  'The fit used every point, and none was dropped as an outlier.',
  'Repeating the measurement on a second sample gave the same slope within the error.',
  'The table below lists the values used in the figures of this section.',
  'Where two runs disagreed, the later one was taken, because its contacts were cleaner.',
  'The model has two free parameters, and both were fixed by the first three runs.',
  'Its prediction for the remaining runs was then compared with the measured values.',
  'The agreement is good at low temperature and gets worse as the sample warms.',
  'A likely cause is heat lost to the wires, which the model leaves out.',
  'A thinner wire would reduce that loss, and the next set of runs will use one.',
  'The uncertainty of each point comes from the spread of ten repeated readings.',
  'Systematic errors, such as the calibration of the thermocouples, are listed separately.',
  'None of them changes the conclusion of this section.',
  'The same procedure is repeated in every section, with a different sample each time.',
  'Readers who want the raw numbers can rebuild them from the tables.',
  'The method is simple on purpose, so that each step can be checked by hand.',
  'The next section turns to the second sample and repeats the analysis.',
];

function filler(s: number, k: number): string {
  return Array.from({ length: 7 }, (_, i) => FILLER[(s * 7 + k * 11 + i * 3) % FILLER.length]).join(' ');
}

/** A long article: a table of contents and 30 sections of text, an equation and a table each, with cross references. */
export function longTex(sections = 30): string {
  const body: string[] = [];
  for (let s = 1; s <= sections; s++) {
    body.push(
      `\\section{Section ${s}}\\label{sec:${s}}`,
      'This section repeats the pattern of the others: text, an equation, a table and a reference back.',
      filler(s, 1),
      '',
      filler(s, 2),
      '',
      filler(s, 3),
      '\\begin{equation}\\label{eq:' + s + '}',
      `  E_{${s}} = \\sum_{k=1}^{${s + 2}} \\frac{k^{2}}{${s}+k} \\, \\int_{0}^{1} x^{k} \\, dx`,
      '\\end{equation}',
      s > 1 ? `Equation~\\eqref{eq:${s}} follows from Equation~\\eqref{eq:${s - 1}} in Section~\\ref{sec:${s - 1}} on page~\\pageref{sec:${s - 1}}.` : 'This is the first section.',
      '\\begin{table}[ht]\\centering',
      `\\caption{Values for section ${s}.}\\label{tab:${s}}`,
      '\\begin{tabular}{lrr}\\toprule Run & $x$ & $y$ \\\\ \\midrule',
      ...[1, 2, 3, 4].map((r) => `${r} & ${(s * r * 1.5).toFixed(1)} & ${(s + r * 0.25).toFixed(2)} \\\\`),
      '\\bottomrule\\end{tabular}\\end{table}',
      filler(s, 4),
    );
  }
  return [
    '% Speed benchmark document: a long article. Generated by test/speed/docs.ts;',
    '% dedicated to the public domain (CC0 1.0), its filler text included.',
    '\\documentclass[11pt]{article}',
    '\\usepackage{amsmath,booktabs,graphicx}',
    '\\usepackage{hyperref}',
    '\\title{A long article for the speed benchmark}',
    '\\author{The liveMd2Tex project}',
    '\\date{1 January 2026}',
    '\\begin{document}',
    '\\maketitle',
    '\\tableofcontents',
    '\\listoftables',
    ...body,
    '\\end{document}',
    '',
  ].join('\n');
}

/** Writes the benchmark set into `target` and returns it, in table order. */
export async function materializeBenchSet(target: string): Promise<BenchDoc[]> {
  const out: BenchDoc[] = [];
  const md = path.join(target, '_markdown');
  const markdown = await materializeMarkdownCorpus(md);
  const p9 = markdown.find((p) => p.id === 'P9');
  if (!p9) {
    throw new Error('the Markdown corpus has no P9');
  }
  out.push({ id: 'md', what: 'short Markdown notes (P9, XeLaTeX notes template)', folder: p9.folder, main: p9.main, source: 'markdown' });

  const p3 = path.join(target, 'article');
  mkdirSync(p3, { recursive: true });
  for (const n of ['IEEEtran.cls', 'bare_jrnl.tex', 'bibtex/IEEEtran.bst']) {
    cpSync(path.join(ctanFolder('ctan-ieeetran'), ...n.split('/')), path.join(p3, path.basename(n)));
  }
  out.push({ id: 'article', what: 'IEEEtran journal article (P3, pdfLaTeX)', folder: p3, main: 'bare_jrnl.tex', source: 'tex' });

  const p1 = path.join(target, 'bib');
  cpSync(path.join(root, 'test', 'corpus', 'P1'), p1, { recursive: true });
  writeFileSync(path.join(p1, 'fig-response.pdf'), await responseFigure());
  out.push({ id: 'bib', what: 'two-column article with natbib and BibTeX (P1, pdfLaTeX + bibtex8)', folder: p1, main: 'paper.tex', source: 'tex' });

  const p6 = path.join(target, 'beamer');
  mkdirSync(p6, { recursive: true });
  cpSync(path.join(ctanFolder('ctan-beamer-example'), 'beamerexample-conference-talk.tex'), path.join(p6, 'beamerexample-conference-talk.tex'));
  out.push({ id: 'beamer', what: 'beamer conference talk, Darmstadt theme (P6, pdfLaTeX)', folder: p6, main: 'beamerexample-conference-talk.tex', source: 'tex' });

  const xe = path.join(target, 'xefonts');
  mkdirSync(xe, { recursive: true });
  writeFileSync(path.join(xe, 'xefonts.tex'), XEFONTS_TEX);
  out.push({ id: 'xefonts', what: 'XeLaTeX, fonts by family name, fontspec + unicode-math (written here)', folder: xe, main: 'xefonts.tex', source: 'tex' });

  const long = path.join(target, 'long');
  mkdirSync(long, { recursive: true });
  writeFileSync(path.join(long, 'long.tex'), longTex());
  out.push({ id: 'long', what: 'long article, 30 sections with TOC, tables, cross references (written here)', folder: long, main: 'long.tex', source: 'tex' });
  return out;
}
