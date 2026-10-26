// One compile of a root document, without VS Code (so Node tests drive it too): collect the project, choose
// the engine, carry the previous compile's auxiliary files, and turn the logs into diagnostics. A converted
// Markdown file compiles the same way: its generated LaTeX is the root document (an in-memory file named after
// the Markdown file), and the diagnostics on that generated file go back to Markdown lines by the line map.

import { imageKey, type CompileJob, type CompileResult, type DataImageRef, type ProjectFile } from '../../shared/engineJobs';
import { latexToMarkdownLine } from '../../converter/markdownToLatex';
import { parseBlg, parseTexLog, type TexDiagnostic } from '../diagnostics/logParser';
import { collectProject, collectReferenced, fingerprint, folderOf, type CollectLimits, type ProjectFs } from '../project/collect';
import { insideProject, scanGraphicsPaths, scanReferences } from '../project/confine';
import {
  makeglossariesLine,
  packageRequests,
  scanDiagnostics,
  scanPackages,
  type InstalledSet,
  type KnownSet,
  type ScanResult,
} from '../project/packageScan';
import type { PackageIndex } from '../../shared/packageIndex';
import { chooseEngine, type EngineChoice } from '../project/texText';

/** What one compile hands to the next compile of the same root document. */
export interface DocumentState {
  aux: ProjectFile[];
  bibFingerprints: Record<string, string>;
  /** A quick pass saw a bibliography change it did not run bibtex8 for; the next full pass must run it. */
  bibtexPending?: boolean;
}

/** The Markdown file behind a generated root document. */
export interface MarkdownOrigin {
  /** The Markdown file, relative to the project folder. */
  source: string;
  /** The converter's line map: lineMap[i] is the Markdown line of generated line i + 1. */
  lineMap: number[];
  /** For SyncTeX (M2-A): where the body starts, the generated text, and a preset appendix's own line map. */
  bodyStartLine?: number;
  latex?: string;
  appendix?: { file: string; map: number[] };
}

/**
 * Where packages come from (docs/DESIGN.md#store-and-packaging, #engine-and-data): the core data set's index, the installed sets beyond
 * it, and the sets that are known but not installed. A data extension (the Extra Packages add-on) comes as an
 * image the engine host mounts whole (build gate 2, G2E-02); the user's package folder is a small tree whose
 * files are copied into the compile (and cross in its change sets).
 */
export interface PackageContext {
  core: PackageIndex | null;
  installed: ({ set: InstalledSet; image: DataImageRef } | { set: InstalledSet; read(rel: string): Promise<Uint8Array> })[];
  elsewhere: KnownSet[];
}

export interface PreparedCompile {
  job: CompileJob;
  /** The preamble scan: files the document needs that no installed data set has (docs/DESIGN.md#engine-and-data). */
  packageScan?: ScanResult;
  packages?: PackageContext;
  markdown?: MarkdownOrigin;
  engine: EngineChoice;
  bibFingerprints: Record<string, string>;
  collectMs: number;
  bytes: number;
  truncated: boolean;
  /** References the project model refused to read (absolute paths, paths that leave the project folder). */
  confinement: TexDiagnostic[];
}

let nextJobId = 1;

export async function prepareCompile(options: {
  fs: ProjectFs;
  mainRel: string;
  engineSetting: 'pdflatex' | 'xelatex';
  overrides?: Map<string, Uint8Array>;
  previous?: DocumentState;
  /** TeX passes in all; 4 allows LaTeX, BibTeX, LaTeX, LaTeX on a first compile. */
  maxPasses?: number;
  /**
   * 'quick': one TeX pass on the carried .aux and .bbl, no bibtex8 (the live preview while typing);
   * 'full' (default): LaTeX, bibtex8 when needed, and the passes the log asks for (docs/DESIGN.md#live-behaviour).
   */
  pass?: 'quick' | 'full';
  /** How much of the project folder to read (DEFAULT_LIMITS; depth 0 for a home folder or a drive's top). */
  limits?: CollectLimits;
  /** The data sets for the preamble scan; without them nothing is scanned. */
  packages?: PackageContext;
  /** Data images to mount even when the scan needs none of their packages (an earlier "not found"; G2E-02). */
  mountSets?: ReadonlySet<string>;
}): Promise<PreparedCompile> {
  if (!insideProject(options.mainRel)) {
    throw new Error(`${options.mainRel} is not inside the project folder.`);
  }
  const t0 = performance.now();
  const project = await collectProject(options.fs, options.mainRel, options.overrides, options.limits);
  // References: refuse what leaves the project folder; collect what lies in it outside the main file's folder.
  const confinement: TexDiagnostic[] = [];
  let scan = project.files.filter((f) => /\.(tex|ltx)$/i.test(f.path));
  const graphicsDirs: string[] = [];
  for (let round = 0; round < 4 && scan.length > 0; round++) {
    const wanted: string[][] = [];
    const origins: { candidates: string[]; target: string; file: string; line: number }[] = [];
    const texts = scan.map((file) => ({ file, text: new TextDecoder().decode(file.data) }));
    // \graphicspath folders first, from every file of this round, so a figure named in any file finds them.
    for (const { file, text } of texts) {
      const paths = scanGraphicsPaths(text, file.path, options.mainRel);
      confinement.push(...paths.refused);
      graphicsDirs.push(...paths.dirs.filter((d) => !graphicsDirs.includes(d)));
    }
    for (const { file, text } of texts) {
      const refs = scanReferences(text, file.path, options.mainRel, graphicsDirs);
      confinement.push(...refs.refused);
      wanted.push(...refs.references.map((r) => r.candidates));
      origins.push(...refs.references);
    }
    const before = project.refused?.length ?? 0;
    const added = await collectReferenced(options.fs, project, wanted, options.overrides, options.limits);
    // A named file that a link (symbolic link or junction) takes outside the project folder: refused, said plainly.
    for (const rel of (project.refused ?? []).slice(before)) {
      const origin = origins.find((o) => o.candidates.includes(rel));
      confinement.push({
        file: origin?.file ?? options.mainRel,
        line: origin?.line ?? 0,
        severity: 'error',
        message: `Not read: "${origin?.target ?? rel}" is reached through a link that leads outside the project folder. The preview reads only files inside the open folder.`,
        source: 'liveMd2Tex',
      });
    }
    scan = added.filter((f) => /\.(tex|ltx)$/i.test(f.path));
  }
  const collectMs = Math.round(performance.now() - t0);
  const main = project.files.find((f) => f.path === options.mainRel);
  if (!main) {
    throw new Error(`${options.mainRel} is not in the project folder.`);
  }
  const engine = chooseEngine(new TextDecoder().decode(main.data), options.engineSetting);
  const bibFingerprints = Object.fromEntries(
    project.files.filter((f) => /\.bib$/i.test(f.path)).map((f) => [f.path, fingerprint(f.data)]),
  );
  const previous = options.previous;
  const bibChanged =
    previous !== undefined &&
    (previous.bibtexPending === true ||
      JSON.stringify(Object.entries(bibFingerprints).sort()) !== JSON.stringify(Object.entries(previous.bibFingerprints).sort()));
  const quick = options.pass === 'quick';
  const job: CompileJob = {
    id: nextJobId++,
    main: options.mainRel,
    files: project.files,
    engine: engine.engine,
    bibtex: quick ? 'never' : 'auto',
    maxPasses: quick ? 1 : (options.maxPasses ?? 4),
    synctex: true,
    state: previous?.aux,
    bibChanged,
  };
  const prepared: PreparedCompile = { job, engine, bibFingerprints, collectMs, bytes: project.bytes, truncated: project.truncated, confinement };
  if (options.packages) {
    await scanAndMount(prepared, options.packages, options.mountSets);
  }
  return prepared;
}

/**
 * The preamble scan before the compile (docs/DESIGN.md#architecture, #engine-and-data), and the files of the packages it needs
 * from installed sets beyond the core, which go into the compile's own texmf tree.
 */
async function scanAndMount(prepared: PreparedCompile, packages: PackageContext, mountSets?: ReadonlySet<string>): Promise<void> {
  const job = prepared.job;
  const text = new Map(job.files.filter((f) => /\.(tex|ltx|sty|cls)$/i.test(f.path)).map((f) => [f.path, f.data]));
  const decode = (rel: string) => {
    const data = text.get(rel);
    return data ? new TextDecoder().decode(data) : undefined;
  };
  const requests = job.files
    .filter((f) => /\.(tex|ltx)$/i.test(f.path))
    .flatMap((f) => packageRequests(decode(f.path) ?? '', f.path, f.path === job.main));
  const scan = scanPackages(requests, {
    projectFiles: job.files.map((f) => f.path),
    mainRel: job.main,
    core: packages.core,
    installed: packages.installed.map((i) => i.set),
    elsewhere: packages.elsewhere,
  });
  const glossaries = makeglossariesLine(decode(job.main) ?? '');
  if (glossaries !== undefined && requests.some((r) => /^glossaries/.test(r.name))) {
    scan.outside.push({
      name: 'glossaries',
      program: 'makeglossaries, a Perl script (for \\makeglossaries)',
      advice: 'use \\makenoidxglossaries and \\printnoidxglossaries instead, which need no program',
      file: job.main,
      line: glossaries,
    });
  }
  const texmf: ProjectFile[] = [];
  const images: DataImageRef[] = [];
  for (const installed of packages.installed) {
    const needed = [...(scan.needed.get(installed.set.id) ?? [])];
    if ('image' in installed) {
      // A data image is mounted whole when the scan needs one of its packages, or when an earlier compile's
      // "not found" named one of its files (mountSets): files its packages load indirectly are then found too.
      if (needed.length > 0 || mountSets?.has(installed.set.id)) {
        images.push(installed.image);
      }
      continue;
    }
    for (const pkg of needed) {
      for (const rel of installed.set.index.packages[pkg]?.files ?? []) {
        texmf.push({ path: rel, data: await installed.read(rel) });
      }
    }
  }
  if (texmf.length > 0) {
    job.texmfFiles = texmf;
    prepared.bytes += texmf.reduce((n, f) => n + f.data.length, 0);
  }
  if (images.length > 0) {
    job.dataImages = images;
  }
  // Every image installed now: the engine host forgets the others (a removed or updated add-on; G2E-R1).
  job.knownImages = packages.installed.flatMap((i) => ('image' in i ? [imageKey(i.image)] : []));
  prepared.packageScan = scan;
  prepared.packages = packages;
}

/** The files a log reports as missing: "File `x' not found", a style file BibTeX cannot open, and a Type 1 font file pdfTeX cannot open. */
const MISSING_FILE = /(?:File|file) `([^']+)' not found|I couldn't open style file ([^\s]+)|\(file ([^)\s]+)\): cannot open Type 1 font file/g;

/**
 * The file names (no folder) of the packed fonts the result reports as damaged (CompileResult.damaged): pdfTeX
 * reports each as a font file it "cannot open", which is not a missing file, so no help or add-on is offered for it.
 */
function damagedNames(result: CompileResult): Set<string> {
  return new Set((result.damaged ?? []).map((p) => p.slice(p.lastIndexOf('/') + 1)));
}

/** fontspec's message for a font name XeTeX cannot find ("The font "X" cannot be found"). */
const MISSING_FONT_NAME = /The font "([^"]+)" cannot be\s+found/;

/**
 * The installed data images that hold a file this compile's log reports as not found, and that the compile did
 * not mount: a package loaded one of their files indirectly, or a font's Type 1 file is there (G2E-02). A font
 * that fontspec cannot find by name names no file, so every installed image with OpenType or TrueType fonts that
 * is not mounted yet is offered. The next compile mounts them.
 */
export function imagesForNotFound(result: CompileResult, prepared: PreparedCompile): string[] {
  const packages = prepared.packages;
  if (!packages) {
    return [];
  }
  const mounted = new Set((prepared.job.dataImages ?? []).map((i) => i.id));
  const log = `${result.log}\n${result.blg ?? ''}`;
  const damaged = damagedNames(result);
  const files = [...log.matchAll(MISSING_FILE)]
    .filter((m) => m[3] === undefined || !damaged.has(m[3]))
    .map((m) => {
      const name = m[1] ?? m[2] ?? m[3];
      return name.includes('.') ? name : `${name}.tex`;
    });
  const byName = MISSING_FONT_NAME.test(log);
  const out = new Set<string>();
  for (const installed of packages.installed) {
    if (!('image' in installed) || mounted.has(installed.set.id)) {
      continue;
    }
    const held = installed.set.index.files;
    if (files.some((f) => f in held) || (byName && Object.keys(held).some((f) => /\.(otf|ttf)$/i.test(f)))) {
      out.add(installed.set.id);
    }
  }
  return [...out];
}

/** A "File `x' not found" error, or a Type 1 font file pdfTeX cannot open, names the package and data set that have it. */
function withPackageHint(d: TexDiagnostic, prepared: PreparedCompile): TexDiagnostic {
  const m = /File `([^']+)' not found|\(file ([^)\s]+)\): cannot open Type 1 font file/.exec(d.message);
  const packages = prepared.packages;
  if (!m || !packages) {
    return d;
  }
  const name = m[1] ?? m[2];
  const file = name.includes('.') ? name : `${name}.tex`;
  const where = [
    ...packages.installed.map((i) => ({ label: i.set.label, files: i.set.index.files })),
    ...packages.elsewhere.map((e) => ({ label: e.label, files: e.files })),
  ].find((s) => file in s.files);
  return where ? { ...d, message: `${d.message} (${file} is in package ${where.files[file]}, in the ${where.label})` } : d;
}

/** The in-memory root document for a Markdown file: "notes.md" -> "notes.tex", in the same folder. */
export function generatedMainFor(markdownRel: string): string {
  return `${markdownRel.replace(/\.(md|markdown|mdown|mkd|mkdn)$/i, '')}.tex`;
}

/**
 * A compile of a converted Markdown file. The generated LaTeX is handed over as an unsaved file, so it never
 * touches the disk and wins over a real file of the same name; the rest of the folder (figures, .bib files) is
 * collected as for a .tex document.
 */
export async function prepareMarkdownCompile(options: {
  fs: ProjectFs;
  markdownRel: string;
  latex: string;
  lineMap: number[];
  engine: 'pdflatex' | 'xelatex';
  overrides?: Map<string, Uint8Array>;
  previous?: DocumentState;
  pass?: 'quick' | 'full';
  limits?: CollectLimits;
  packages?: PackageContext;
  mountSets?: ReadonlySet<string>;
  /**
   * Files the generated LaTeX needs from outside the project folder: the notes template's DejaVu fonts until
   * B1 (engine/interimFonts.ts). A project file of the same name wins.
   */
  extraFiles?: ProjectFile[];
  /** For SyncTeX (M2-A), carried in the result's markdown origin. */
  bodyStartLine?: number;
  appendix?: { file: string; map: number[] };
}): Promise<PreparedCompile> {
  const mainRel = generatedMainFor(options.markdownRel);
  const overrides = new Map(options.overrides ?? []);
  overrides.set(mainRel, new TextEncoder().encode(options.latex));
  const prepared = await prepareCompile({
    fs: options.fs,
    mainRel,
    engineSetting: options.engine,
    overrides,
    previous: options.previous,
    pass: options.pass,
    limits: options.limits,
    packages: options.packages,
    mountSets: options.mountSets,
  });
  // Beside the generated main file, where XeTeX finds a font by its file name (its working folder).
  const dir = folderOf(mainRel);
  for (const extra of options.extraFiles ?? []) {
    const path = dir ? `${dir}/${extra.path}` : extra.path;
    if (!prepared.job.files.some((f) => f.path === path)) {
      prepared.job.files.push({ path, data: extra.data });
      prepared.bytes += extra.data.length;
    }
  }
  return {
    ...prepared,
    markdown: { source: options.markdownRel, lineMap: options.lineMap, bodyStartLine: options.bodyStartLine, latex: options.latex, appendix: options.appendix },
  };
}

export function diagnosticsFor(result: CompileResult, prepared: PreparedCompile): TexDiagnostic[] {
  const all = texAndBibDiagnostics(result, prepared);
  const md = prepared.markdown;
  if (!md) {
    return all;
  }
  return all.map((d) =>
    d.file === prepared.job.main ? { ...d, file: md.source, line: d.line > 0 ? latexToMarkdownLine(md, d.line) : 0 } : d,
  );
}

function texAndBibDiagnostics(result: CompileResult, prepared: PreparedCompile): TexDiagnostic[] {
  const tex = parseTexLog(result.log, prepared.job.main);
  const bibs = prepared.job.files
    .filter((f) => /\.bib$/i.test(f.path))
    .map((f) => ({ path: f.path, text: new TextDecoder().decode(f.data) }));
  const bib = result.blg && result.bibtexRan ? parseBlg(result.blg, bibs, prepared.job.main) : [];
  // Damaged TeX data (B1, t1c): the plain message alone, and none of pdfTeX's "cannot open" errors for the fonts
  // concerned, whose help would say the core lacks a font it has (t1c gate, S-3).
  const damaged = damagedNames(result);
  const shown = tex.filter((d) => {
    const m = /\(file ([^)\s]+)\): cannot open Type 1 font file/.exec(d.message);
    return !m || !damaged.has(m[1]);
  });
  if (!result.ok && result.error && result.error !== 'cancelled') {
    const first = result.error.split('\n')[0];
    shown.unshift({ file: prepared.job.main, line: 0, severity: 'error', message: result.damaged ? first : `The engine stopped: ${first}`, source: 'TeX' });
  }
  const scan = prepared.packageScan ? scanDiagnostics(prepared.packageScan, prepared.job.main) : [];
  return [...prepared.confinement, ...scan, ...shown.map((d) => withPackageHint(d, prepared)), ...bib];
}

export function nextState(result: CompileResult, prepared: PreparedCompile): DocumentState {
  return {
    aux: result.state,
    bibFingerprints: prepared.bibFingerprints,
    bibtexPending: !result.bibtexRan && (result.bibtexNeeded === true || prepared.job.bibChanged === true),
  };
}
