// The preamble scan of docs/DESIGN.md#architecture, #engine-and-data: before a compile, every file the document's packages need
// that is not in the installed data sets, dependencies included, in one list with plain words, and what to do
// about each. It reads \documentclass, \usepackage and \RequirePackage (options and lists), \usetikzlibrary,
// \usepgfplotslibrary, Beamer's \usetheme and \usecolortheme (and the font, inner and outer themes),
// \bibliographystyle, and the \input and \include files that do not come from the project. Pure: the caller
// passes the project's files and the data sets' package indexes.

import { posix } from 'node:path';
import { DISPLAY_NAME } from '../../shared/identity';
import type { PackageIndex } from '../../shared/packageIndex';
import type { TexDiagnostic } from '../diagnostics/logParser';
import { preamble, stripComments } from './texText';

export interface PackageRequest {
  /** What asked: "\usepackage", "\documentclass", ... */
  command: string;
  /** The name as written ("hyperref", "calc", "Darmstadt"). */
  name: string;
  /** The file names TeX would look for, in order ("hyperref.sty"; "tikzlibrarycalc.code.tex", ...). */
  candidates: string[];
  /** The options, for the few checks that read them (biblatex's backend, glossaries-extra's record). */
  options: string;
  /** Where: project-relative file and 1-based line. */
  file: string;
  line: number;
}

const LIST_COMMANDS: Record<string, (name: string) => string[]> = {
  documentclass: (n) => [`${n}.cls`],
  usepackage: (n) => [`${n}.sty`],
  RequirePackage: (n) => [`${n}.sty`],
  RequirePackageWithOptions: (n) => [`${n}.sty`],
  usetikzlibrary: (n) => [`tikzlibrary${n}.code.tex`, `pgflibrary${n}.code.tex`],
  usepgfplotslibrary: (n) => [`pgfplotslibrary${n}.code.tex`],
  usetheme: (n) => [`beamertheme${n}.sty`],
  usecolortheme: (n) => [`beamercolortheme${n}.sty`],
  usefonttheme: (n) => [`beamerfonttheme${n}.sty`],
  useinnertheme: (n) => [`beamerinnertheme${n}.sty`],
  useoutertheme: (n) => [`beameroutertheme${n}.sty`],
  bibliographystyle: (n) => [`${n}.bst`],
};

const COMMAND =
  /\\(documentclass|usepackage|RequirePackage|RequirePackageWithOptions|usetikzlibrary|usepgfplotslibrary|usetheme|usecolortheme|usefonttheme|useinnertheme|useoutertheme|bibliographystyle|input|include)\*?\s*(\[[^\]]*\])?\s*\{([^}]*)\}/g;

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
    }
  }
  return line;
}

/**
 * The requests in one project .tex file. In the root document, package commands count only in the preamble;
 * \input, \include and \bibliographystyle (which usually stands beside \bibliography, near the end) count
 * anywhere (build gate 2, G2E-04).
 */
export function packageRequests(text: string, file: string, isRoot: boolean): PackageRequest[] {
  const clean = stripComments(text);
  const pre = isRoot ? preamble(text) : clean;
  const out: PackageRequest[] = [];
  for (const m of clean.matchAll(COMMAND)) {
    const command = m[1];
    const index = m.index ?? 0;
    if (command !== 'input' && command !== 'include' && command !== 'bibliographystyle' && index >= pre.length) {
      continue;
    }
    const options = (m[2] ?? '').slice(1, -1);
    const names = command === 'input' || command === 'include' ? [m[3]] : m[3].split(',');
    for (const raw of names) {
      const name = raw.trim();
      if (!name || /[\\#]/.test(name)) {
        continue;
      }
      const candidates =
        command === 'input' || command === 'include' ? (/\.[A-Za-z]+$/.test(name) ? [name] : [name, `${name}.tex`]) : LIST_COMMANDS[command](name);
      out.push({ command: `\\${command}`, name, candidates, options, file, line: lineAt(clean, index) });
    }
  }
  return out;
}

/** An installed data set other than the core: the Extra Packages add-on, or the user's own package folder. */
export interface InstalledSet {
  id: string;
  label: string;
  index: PackageIndex;
}

/** A data set that is not installed but whose file list is known (the core manifest names the add-on's files). */
export interface KnownSet {
  id: string;
  label: string;
  files: Record<string, string>;
  /** Each package's own requires (files), when the manifest gives them. */
  requires?: Record<string, string[]>;
}

export interface ScanInput {
  /** Project files, project-relative. */
  projectFiles: string[];
  /** The main file, project-relative (TeX's working folder is its folder). */
  mainRel: string;
  /** The core data set's index (the bundle); null when it has none (then nothing is reported missing). */
  core: PackageIndex | null;
  installed: InstalledSet[];
  elsewhere: KnownSet[];
}

export interface MissingFile {
  file: string;
  /** The package it belongs to, when an index knows it (else the file's own name). */
  package: string;
  /** The document line that asked for it, or the package that loads it. */
  via: { file: string; line: number } | { package: string };
  /** The data set that has it, when one is known but not installed. */
  offer?: { id: string; label: string };
  font: boolean;
  command: string;
}

export interface OutsideProgram {
  name: string;
  program: string;
  file: string;
  line: number;
  advice: string;
}

export interface ScanResult {
  requests: number;
  missing: MissingFile[];
  outside: OutsideProgram[];
  /** Packages of installed non-core sets the compile needs, by set id (their files go into the compile). */
  needed: Map<string, Set<string>>;
}

/**
 * Packages that need a program outside TeX (docs/DESIGN.md#engine-and-data): named with the reason, never run.
 * makeindex is not here: it is part of the engine build.
 */
const OUTSIDE: Record<string, { program: string; advice: string }> = {
  minted: { program: 'Pygments, a Python program', advice: 'use the listings package for code instead' },
  svg: { program: 'Inkscape', advice: 'put a PDF copy of each .svg figure beside it and include the PDF' },
  gnuplottex: { program: 'gnuplot', advice: 'include the plots as PDF files made beforehand' },
  epstopdf: { program: 'Ghostscript (to turn .eps figures into PDF)', advice: 'put a PDF copy beside each .eps figure' },
  pythontex: { program: 'Python', advice: 'run the code beforehand and include its output' },
  sagetex: { program: 'SageMath', advice: 'run the code beforehand and include its output' },
  'auto-pst-pdf': { program: 'Ghostscript and a shell (for PSTricks)', advice: 'include the PSTricks figures as PDF files made beforehand' },
  pstool: { program: 'Ghostscript and a shell (for PSTricks)', advice: 'include the figures as PDF files made beforehand' },
  bashful: { program: 'a shell', advice: 'run the commands beforehand and include their output' },
};

/** Font packages: a .sty alone does not work; they need font files and map entries (docs/DESIGN.md#engine-and-data). */
const FONT_PACKAGES = new Set([
  'newtxtext', 'newtxmath', 'newtx', 'newpxtext', 'newpxmath', 'newpx', 'libertine', 'libertinus', 'libertinust1math',
  'inconsolata', 'zi4', 'stix', 'stix2', 'fira', 'FiraSans', 'FiraMono', 'sourcecodepro', 'sourcesanspro', 'sourceserifpro',
  'roboto', 'lato', 'opensans', 'noto', 'notomath', 'baskervillef', 'ebgaramond', 'garamondx', 'cochineal', 'mathpazo',
  'mathptmx', 'tgtermes', 'tgpagella', 'tgheros', 'tgcursor', 'mtpro2', 'MnSymbol', 'fourier', 'kpfonts', 'charter',
  'XCharter', 'utopia', 'erewhon', 'cabin', 'raleway', 'montserrat', 'merriweather', 'plex-sans', 'plex-serif', 'plex-mono',
]);

const nameOf = (file: string) => file.replace(/\.(sty|cls|bst|code\.tex|tex)$/i, '');

export function scanPackages(requests: PackageRequest[], input: ScanInput): ScanResult {
  const result: ScanResult = { requests: requests.length, missing: [], outside: [], needed: new Map() };
  if (!input.core) {
    return result;
  }
  const mainDir = input.mainRel.includes('/') ? input.mainRel.slice(0, input.mainRel.lastIndexOf('/')) : '';
  const project = new Set(input.projectFiles);
  // TeX looks in its working folder (the main file's folder) by name, and follows relative paths from there.
  const inProject = (file: string) => {
    const rel = posix.normalize(mainDir ? `${mainDir}/${file}` : file);
    return project.has(rel) ? rel : undefined;
  };
  const seen = new Set<string>();
  const missingSeen = new Set<string>();
  type Item = { candidates: string[]; via: MissingFile['via']; command: string };
  const queue: Item[] = requests.map((r) => ({ candidates: r.candidates, via: { file: r.file, line: r.line }, command: r.command }));

  while (queue.length > 0) {
    const item = queue.shift() as Item;
    const key = item.candidates.join('|');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    // 1. The project (read into the compile ahead of the bundle). A project class or package often loads some
    //    packages only for some options (IEEEtran.cls and mtpro2, for one), so its loads are not walked: the
    //    log names any that is really missing, with the package that has it.
    if (item.candidates.some((c) => inProject(c) !== undefined)) {
      continue;
    }
    // 2. The core bundle: its own dependencies are B1's closure test's job, so they are not walked here.
    if (item.candidates.some((c) => c in (input.core as PackageIndex).files)) {
      continue;
    }
    // 3. An installed add-on or the user's package folder: its package's files go into the compile.
    let found = false;
    for (const set of input.installed) {
      const file = item.candidates.find((c) => c in set.index.files);
      if (file) {
        const pkg = set.index.files[file];
        const needed = result.needed.get(set.id) ?? new Set<string>();
        if (!needed.has(pkg)) {
          needed.add(pkg);
          result.needed.set(set.id, needed);
          for (const req of set.index.packages[pkg]?.requires ?? []) {
            queue.push({ candidates: [req], via: { package: pkg }, command: req.endsWith('.cls') ? '\\LoadClass' : '\\RequirePackage' });
          }
        }
        found = true;
        break;
      }
    }
    if (found) {
      continue;
    }
    // 4. Missing: say where it is, if anywhere.
    const file = item.candidates[0];
    if (missingSeen.has(file)) {
      continue;
    }
    missingSeen.add(file);
    let offer: MissingFile['offer'];
    let pkg = nameOf(file);
    for (const set of input.elsewhere) {
      const hit = item.candidates.find((c) => c in set.files);
      if (hit) {
        offer = { id: set.id, label: set.label };
        pkg = set.files[hit];
        // Its dependencies too, so a file that no set has is named now, not after the add-on is installed.
        for (const req of set.requires?.[pkg] ?? []) {
          if (!(req in set.files)) {
            queue.push({ candidates: [req], via: { package: pkg }, command: req.endsWith('.cls') ? '\\LoadClass' : '\\RequirePackage' });
          }
        }
        break;
      }
    }
    // An \input or \include that is in no data set is most likely the project's own (a typo, a file made by the
    // compile, or a path the confinement already refused): TeX's own message covers it, so only a file a known
    // data set has is listed here.
    if ((item.command === '\\input' || item.command === '\\include') && !offer) {
      continue;
    }
    result.missing.push({ file, package: pkg, via: item.via, offer, font: FONT_PACKAGES.has(nameOf(file)) || FONT_PACKAGES.has(pkg), command: item.command });
  }

  for (const r of requests) {
    const outside = r.command === '\\usepackage' || r.command === '\\RequirePackage' ? OUTSIDE[r.name] : undefined;
    if (outside) {
      result.outside.push({ name: r.name, program: outside.program, advice: outside.advice, file: r.file, line: r.line });
    }
    if (r.command === '\\usepackage' && r.name === 'biblatex' && !/backend\s*=\s*bibtex/.test(r.options)) {
      result.outside.push({ name: 'biblatex', program: 'Biber (its default backend)', advice: 'load it with \\usepackage[backend=bibtex]{biblatex}', file: r.file, line: r.line });
    }
    if (r.command === '\\usepackage' && r.name === 'glossaries-extra' && /\brecord\b/.test(r.options)) {
      result.outside.push({ name: 'glossaries-extra', program: 'bib2gls, a Java program (the record option)', advice: 'leave out the record option', file: r.file, line: r.line });
    }
  }
  return result;
}

/** Whether the document calls \makeglossaries (which needs the makeglossaries Perl script). */
export function makeglossariesLine(text: string): number | undefined {
  const clean = stripComments(text);
  const at = clean.search(/\\makeglossaries\b/);
  return at < 0 ? undefined : lineAt(clean, at);
}

const what = (m: MissingFile) =>
  m.file.endsWith('.cls') ? `class ${m.package}` : m.file.endsWith('.bst') ? `bibliography style ${nameOf(m.file)}` : `package ${m.package}`;

/** The plain-words message for one missing file (docs/DESIGN.md#engine-and-data). */
export function missingMessage(m: MissingFile): string {
  const head = 'package' in m.via ? `"${m.file}", which ${m.via.package} loads,` : `"${m.file}" (${what(m)})`;
  if (m.font) {
    return (
      `${head} is not inside the installed packages. It is part of a font package: font packages need their font ` +
      'files and map entries as well as the .sty, so a copy of the .sty is not enough. ' +
      (m.offer ? `The ${m.offer.label} has it.` : 'It is not in any data package yet.')
    );
  }
  if (m.offer) {
    return `${head} is not inside the installed packages. The ${m.offer.label} has it: run "${DISPLAY_NAME}: Install Extra Packages".`;
  }
  return (
    `${head} is not inside the installed packages. Add it with "${DISPLAY_NAME}: Add a package from a file" ` +
    `(download it from CTAN: https://ctan.org/pkg/${encodeURIComponent(m.package)}), or put a copy in the project folder.`
  );
}

/** Problems-panel entries for the scan: one per missing file and per package that needs an outside program. */
export function scanDiagnostics(result: ScanResult, mainRel: string): TexDiagnostic[] {
  const out: TexDiagnostic[] = [];
  for (const m of result.missing) {
    const at = 'file' in m.via ? m.via : { file: mainRel, line: 0 };
    out.push({ file: at.file, line: at.line, severity: 'warning', message: missingMessage(m), source: DISPLAY_NAME });
  }
  for (const o of result.outside) {
    out.push({
      file: o.file,
      line: o.line,
      severity: 'warning',
      message: `${o.name} needs ${o.program}, which ${DISPLAY_NAME} cannot run: ${o.advice}.`,
      source: DISPLAY_NAME,
    });
  }
  return out;
}
