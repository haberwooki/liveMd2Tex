// Converting an open Markdown document in the extension host: the folder config (.latexpreview.json, found by
// walking up to the workspace folder), and the image rule of docs/DESIGN.md#converter (a .pdf beside a .png is
// preferred; an .svg, .gif or .eps uses a .pdf or .png of the same name). Files are read through
// workspace.fs only. A preset named by the folder config (and its preamble and appendix files) is read the
// same way, and only from inside the project folder, links included (confinePaths.ts). Results are cached per
// document version, and one service serves the compile and the generated-LaTeX view; the image twins found last
// time are used again, so a version is usually converted once (build gate 1, G1E-15).

import * as vscode from 'vscode';
import { CONFIG_FILE, exportFileName, metaDefaults, parseFolderConfig, type FolderConfig } from '../../converter/config';
import { convertMarkdown, type ConversionResult } from '../../converter/markdownToLatex';
import { modeForFile, parsePresetFile, resolveMode } from '../../converter/preset/load';
import type { PresetMode } from '../../converter/preset/types';
import { noLinkOnTheWay } from '../project/linkWalk';
import { relativeTo } from '../project/uris';
import { confinedRelative, realPathStaysInside } from './confinePaths';

export interface DocumentConversion extends ConversionResult {
  config: FolderConfig;
  configUri?: vscode.Uri;
  configProblems: string[];
  /** Where Export LaTeX writes. */
  exportUri: vscode.Uri;
  /** A preset mode's appendix file, relative to the Markdown file's folder, when it was read. */
  appendixFile?: string;
  /** Time spent in the converter, on the extension host's thread (passes: every converter pass for this version). */
  convertMs: number;
}

const TWINS: Record<string, string[]> = {
  png: ['pdf'],
  jpg: ['pdf'],
  jpeg: ['pdf'],
  svg: ['pdf', 'png'],
  gif: ['png', 'pdf'],
  eps: ['pdf'],
  webp: ['png', 'pdf'],
  bmp: ['png', 'pdf'],
  tif: ['png', 'pdf'],
  tiff: ['png', 'pdf'],
};

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * The nearest .latexpreview.json from the document's folder up to its workspace folder (or just its folder). A
 * config that is a link leading out of the project folder, or larger than the cap, is not read (build gate 1,
 * G1B-S-03): a problem says so, and the search goes on upward.
 */
export async function findFolderConfig(document: vscode.Uri): Promise<{ uri?: vscode.Uri; config: FolderConfig; problems: string[] }> {
  const root = vscode.workspace.getWorkspaceFolder(document)?.uri;
  const project = projectOf(document);
  const problems: string[] = [];
  let dir = vscode.Uri.joinPath(document, '..');
  for (;;) {
    const candidate = vscode.Uri.joinPath(dir, CONFIG_FILE);
    const dirRel = folderRel(project, dir);
    const read = dirRel === undefined ? undefined : await readInsideProject(project, dirRel ? `${dirRel}/${CONFIG_FILE}` : CONFIG_FILE);
    if (read === 'link' || read === 'large') {
      problems.push(refusal(`The folder config ${dirRel ? `${dirRel}/${CONFIG_FILE}` : CONFIG_FILE}`, read));
    } else if (read !== undefined) {
      const parsed = parseFolderConfig(read.text);
      return { uri: candidate, config: parsed.config, problems: [...problems, ...parsed.problems] };
    }
    if (!root || dir.path === root.path || !dir.path.startsWith(root.path)) {
      return { config: { markdown: {} }, problems };
    }
    const parent = vscode.Uri.joinPath(dir, '..');
    if (parent.path === dir.path) {
      return { config: { markdown: {} }, problems };
    }
    dir = parent;
  }
}

function fileName(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

/** The project folder of a file: its workspace folder, else its own folder. */
export function projectOf(file: vscode.Uri): vscode.Uri {
  return vscode.workspace.getWorkspaceFolder(file)?.uri ?? vscode.Uri.joinPath(file, '..');
}

/**
 * A folder's path relative to the project folder ('' for the project folder itself); undefined outside it. The
 * shared relativeTo (project/uris.ts) decides, with its rule for case.
 */
export function folderRel(project: vscode.Uri, folder: vscode.Uri): string | undefined {
  const probe = relativeTo(project, vscode.Uri.joinPath(folder, 'f'));
  return probe === undefined ? undefined : probe === 'f' ? '' : probe.slice(0, -2);
}

/** At most this many bytes are read from a folder config, or from a file a config or preset names. */
export const MAX_CONFIG_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Reads a file of the project folder (`rel` is project-relative) when no link on the way leads out of the folder
 * and it is no larger than MAX_CONFIG_FILE_BYTES: its text; 'link' or 'large' when refused; undefined when it
 * cannot be read (a missing file).
 */
export async function readInsideProject(project: vscode.Uri, rel: string): Promise<{ text: string } | 'link' | 'large' | undefined> {
  const uri = vscode.Uri.joinPath(project, ...rel.split('/'));
  const inside = uri.scheme === 'file' ? await realPathStaysInside(project.fsPath, uri.fsPath) : await noLinkOnTheWay(project, rel);
  if (!inside) {
    return 'link';
  }
  try {
    if ((await vscode.workspace.fs.stat(uri)).size > MAX_CONFIG_FILE_BYTES) {
      return 'large';
    }
    return { text: new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri)) };
  } catch {
    return undefined;
  }
}

/** The message for a refused file. */
export function refusal(what: string, why: 'link' | 'large'): string {
  return why === 'link'
    ? `${what} leads outside the project folder through a link, so it was not read.`
    : `${what} is larger than ${MAX_CONFIG_FILE_BYTES / 1024 / 1024} MB, so it was not read.`;
}

/**
 * Reads a file that a folder config or a preset names (`name`, relative to the folder `base`), only when it is
 * inside the project folder, links included (build gate 1, G1S-03 and G1E-04). A refused path is added to
 * `refused` (shown in the Problems panel); a missing file returns undefined.
 */
async function readConfined(project: vscode.Uri, base: vscode.Uri, name: string, what: string, refused: string[]): Promise<{ text: string; rel: string } | undefined> {
  const baseRel = folderRel(project, base);
  const rel = baseRel === undefined ? undefined : confinedRelative(baseRel, name);
  if (rel === undefined) {
    refused.push(`The ${what} "${name}" is outside the project folder, so it was not read.`);
    return undefined;
  }
  const read = await readInsideProject(project, rel);
  if (read === 'link' || read === 'large') {
    refused.push(refusal(`The ${what} "${name}"`, read));
    return undefined;
  }
  return read === undefined ? undefined : { text: read.text, rel };
}

/**
 * The preset mode a folder config asks for (docs/DESIGN.md#presets): the preset file relative to the config file,
 * the preamble files beside the preset, the mode by name or by the Markdown file's name, the folder's
 * overrides, and the mode's appendix file beside the Markdown. Every path is confined to the project folder
 * (readConfined). Problems are added to `problems`, refused paths to `refused`.
 */
async function loadPreset(
  configUri: vscode.Uri,
  config: FolderConfig,
  markdown: vscode.Uri,
  problems: string[],
  refused: string[],
): Promise<{ mode: PresetMode; appendix?: string; appendixFile?: string } | undefined> {
  const project = projectOf(markdown);
  const presetName = config.markdown.preset ?? '';
  const presetFile = await readConfined(project, vscode.Uri.joinPath(configUri, '..'), presetName, 'preset file', refused);
  if (presetFile === undefined) {
    problems.push(`The preset file "${presetName}" could not be read; the general dialect is used.`);
    return undefined;
  }
  const presetFolder = vscode.Uri.joinPath(project, ...presetFile.rel.split('/'), '..');
  const parsed = parsePresetFile(presetFile.text);
  if (!parsed.preset) {
    problems.push(...parsed.problems);
    return undefined;
  }
  const modeName = config.markdown.mode ?? modeForFile(parsed.preset, fileName(markdown));
  if (!modeName) {
    return undefined; // this file is not one of the preset's entries: the general dialect
  }
  const files: Record<string, string> = {};
  const names = new Set<string>();
  for (const spec of [parsed.preset.defaults ?? {}, ...Object.values(parsed.preset.modes)]) {
    for (const file of [spec.preambleFile, spec.xetexPreambleFile]) {
      if (typeof file === 'string') {
        names.add(file);
      }
    }
  }
  for (const name of names) {
    const read = await readConfined(project, presetFolder, name, 'preamble file', refused);
    if (read !== undefined) {
      files[name] = read.text;
    }
  }
  const resolved = resolveMode(parsed.preset, modeName, files, config.markdown.presetOverrides);
  problems.push(...resolved.problems);
  const appendix = resolved.appendixEntry
    ? await readConfined(project, vscode.Uri.joinPath(markdown, '..'), resolved.appendixEntry, 'appendix file', refused)
    : undefined;
  return { mode: resolved.mode, appendix: appendix?.text, appendixFile: appendix !== undefined ? resolved.appendixEntry : undefined };
}

export class ConversionService {
  private readonly cache = new Map<string, { version: number; result: Promise<DocumentConversion> }>();
  /** Per document: the image twins found last time, used on the next run so that it usually converts once. */
  private readonly twins = new Map<string, Map<string, string>>();

  /** Converts a Markdown document (cached per version). */
  convert(document: vscode.TextDocument): Promise<DocumentConversion> {
    const key = document.uri.toString();
    const cached = this.cache.get(key);
    if (cached && cached.version === document.version && !document.isClosed) {
      return cached.result;
    }
    const result = this.run(document.uri, document.getText());
    this.cache.set(key, { version: document.version, result });
    result.catch(() => this.cache.delete(key));
    return result;
  }

  /** Converts Markdown text that belongs to `uri` (open or not). */
  async run(uri: vscode.Uri, text: string): Promise<DocumentConversion> {
    const { uri: configUri, config, problems } = await findFolderConfig(uri);
    const dir = vscode.Uri.joinPath(uri, '..');
    const refused: string[] = [];
    const preset = configUri && config.markdown.preset ? await loadPreset(configUri, config, uri, problems, refused) : undefined;
    const options = { sourceName: fileName(uri), defaults: metaDefaults(config), preset: preset?.mode, appendix: preset?.appendix };
    // The converter is synchronous and runs on this thread, so it runs as few times as it can (build gate 1,
    // G1E-15): with the image twins found last time, and again only when the twins on disk differ.
    const key = uri.toString();
    const known = this.twins.get(key) ?? new Map<string, string>();
    const started = performance.now();
    let result = convertMarkdown(text, { ...options, resolveImage: (path) => known.get(path) });
    let passes = result.passes;
    // The image files that exist beside the referenced ones.
    const replacements = new Map<string, string>();
    const dirRel = folderRel(projectOf(uri), dir);
    for (const image of result.images) {
      const dot = image.lastIndexOf('.');
      const ext = dot > 0 ? image.slice(dot + 1).toLowerCase() : '';
      for (const twin of TWINS[ext] ?? []) {
        const candidate = `${image.slice(0, dot)}.${twin}`;
        // Only inside the project folder (the engine reads the file through the project model's own rules).
        const inside = dirRel !== undefined && confinedRelative(dirRel, candidate) !== undefined;
        if (inside && (await exists(vscode.Uri.joinPath(dir, candidate)))) {
          replacements.set(image, candidate);
          break;
        }
      }
    }
    this.twins.set(key, replacements);
    let convertMs = performance.now() - started;
    if (result.images.some((image) => replacements.get(image) !== known.get(image))) {
      const again = performance.now();
      result = convertMarkdown(text, { ...options, resolveImage: (path) => replacements.get(path) });
      passes += result.passes;
      convertMs += performance.now() - again;
    }
    // A path the folder config or the preset names outside the project folder: a warning on the Markdown file.
    const diagnostics = [...result.diagnostics, ...refused.map((message) => ({ kind: 'warning' as const, code: 'config-path', message, lines: [1] }))];
    return {
      ...result,
      diagnostics,
      config,
      configUri,
      configProblems: problems,
      exportUri: vscode.Uri.joinPath(dir, exportFileName(config, fileName(uri))),
      appendixFile: preset?.appendixFile,
      passes,
      convertMs: Math.round(convertMs),
    };
  }

  forget(uri: vscode.Uri): void {
    this.cache.delete(uri.toString());
    this.twins.delete(uri.toString());
  }

  clear(): void {
    this.cache.clear();
    this.twins.clear();
  }
}
