// The per-folder configuration file, .latexpreview.json (docs/DESIGN.md#converter): converter
// defaults, the two switches the views need, and a preset (docs/DESIGN.md#presets) with its mode and this folder's
// own preset options. Preamble templates, figure layouts, Unicode tables and note patterns live in the preset.
//
//   {
//     "markdown": {
//       "citations": "natbib" | "biblatex",
//       "biblioStyle": "plainnat",
//       "cref": false,
//       "numbersections": true,
//       "documentclass": "article",
//       "classoption": ["11pt"],
//       "geometry": ["margin=1in"],
//       "engine": "xelatex",            // optional: else pdfLaTeX, or XeTeX when pdfLaTeX cannot print a character
//       "template": "notes",            // optional: the XeTeX notes template (DejaVu fonts) for every file here
//       "htmlView": false,             // switch on the HTML view plugin for this folder
//       "exportName": "{name}.tex",    // Export LaTeX's file name; {name} is the Markdown file's name
//       "preset": "presets/two-column-paper/preset.json",
//       "mode": "paper",               // optional: else the mode whose entry matches the file name
//       "presetOverrides": { "figures": { "wide": ["fig_overview"] } }
//     }
//   }

import { asEngine, asTemplate, type DocumentMeta, type EngineName, type MetaDefaults, type TemplateName } from './metadata';

export const CONFIG_FILE = '.latexpreview.json';

export interface MarkdownConfig {
  citations?: 'natbib' | 'biblatex';
  biblioStyle?: string;
  cref?: boolean;
  numbersections?: boolean;
  documentclass?: string;
  classoption?: string[];
  geometry?: string[];
  engine?: EngineName;
  template?: TemplateName;
  htmlView?: boolean;
  exportName?: string;
  /** A preset file (docs/DESIGN.md#presets), relative to this config file's folder. */
  preset?: string;
  /** The preset mode; by default the mode whose "entry" matches the Markdown file's name. */
  mode?: string;
  /** Preset options this folder sets on top of the preset (its figure lists, its note markers ...). */
  presetOverrides?: Record<string, unknown>;
}

export interface FolderConfig {
  markdown: MarkdownConfig;
}

const LATER = new Set(['preamble', 'figures', 'unicode', 'notes', 'modes']);

export function parseFolderConfig(text: string): { config: FolderConfig; problems: string[] } {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Not the parser's message: it quotes the start of the file (docs/DESIGN.md#confinement-and-trust).
    return { config: { markdown: {} }, problems: [`${CONFIG_FILE} is not valid JSON; it was ignored.`] };
  }
  const section = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).markdown : undefined;
  const md: MarkdownConfig = {};
  if (section === undefined) {
    return { config: { markdown: md }, problems };
  }
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    return { config: { markdown: md }, problems: [`"markdown" in ${CONFIG_FILE} must be an object; it was ignored.`] };
  }
  const s = section as Record<string, unknown>;
  const bool = (key: keyof MarkdownConfig) => {
    if (s[key] === undefined) {
      return undefined;
    }
    if (typeof s[key] === 'boolean') {
      return s[key] as boolean;
    }
    problems.push(`"markdown.${key}" must be true or false.`);
    return undefined;
  };
  const str = (key: keyof MarkdownConfig) => {
    if (s[key] === undefined) {
      return undefined;
    }
    if (typeof s[key] === 'string' && s[key] !== '') {
      return s[key] as string;
    }
    problems.push(`"markdown.${key}" must be a text value.`);
    return undefined;
  };
  const list = (key: keyof MarkdownConfig) => {
    const v = s[key];
    if (v === undefined) {
      return undefined;
    }
    if (typeof v === 'string') {
      return [v];
    }
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      return v as string[];
    }
    problems.push(`"markdown.${key}" must be a text value or a list of them.`);
    return undefined;
  };
  const citations = str('citations');
  if (citations !== undefined && citations !== 'natbib' && citations !== 'biblatex') {
    problems.push('"markdown.citations" must be "natbib" or "biblatex".');
  } else if (citations) {
    md.citations = citations;
  }
  md.biblioStyle = str('biblioStyle');
  md.cref = bool('cref');
  md.numbersections = bool('numbersections');
  md.documentclass = str('documentclass');
  md.classoption = list('classoption');
  md.geometry = list('geometry');
  for (const [key, read, what] of [
    ['engine', asEngine, '"xelatex" or "pdflatex"'],
    ['template', asTemplate, '"notes" or "default"'],
  ] as const) {
    if (s[key] !== undefined) {
      const value = read(s[key]);
      if (value === undefined) {
        problems.push(`"markdown.${key}" must be ${what}.`);
      } else {
        (md as Record<string, unknown>)[key] = value;
      }
    }
  }
  md.htmlView = bool('htmlView');
  md.preset = str('preset');
  md.mode = str('mode');
  if (s.presetOverrides !== undefined) {
    if (s.presetOverrides && typeof s.presetOverrides === 'object' && !Array.isArray(s.presetOverrides)) {
      md.presetOverrides = s.presetOverrides as Record<string, unknown>;
    } else {
      problems.push('"markdown.presetOverrides" must be an object of preset options.');
    }
  }
  const exportName = str('exportName');
  if (exportName !== undefined && (/[\\/]/.test(exportName.replace('{name}', '')) || !exportName.endsWith('.tex'))) {
    problems.push('"markdown.exportName" must be a file name ending in .tex, without folders.');
  } else {
    md.exportName = exportName;
  }
  for (const key of Object.keys(s)) {
    if (LATER.has(key)) {
      problems.push(`"markdown.${key}" belongs in a preset file (named by "markdown.preset"); it was ignored.`);
    } else if (!['citations', 'biblioStyle', 'cref', 'numbersections', 'documentclass', 'classoption', 'geometry', 'engine', 'template', 'htmlView', 'exportName', 'preset', 'mode', 'presetOverrides'].includes(key)) {
      problems.push(`"markdown.${key}" is not a setting the converter knows; it was ignored.`);
    }
  }
  for (const key of Object.keys(md) as (keyof MarkdownConfig)[]) {
    if (md[key] === undefined) {
      delete md[key];
    }
  }
  return { config: { markdown: md }, problems };
}

export function metaDefaults(config: FolderConfig): MetaDefaults {
  const md = config.markdown;
  return {
    citationPackage: md.citations,
    biblioStyle: md.biblioStyle,
    cref: md.cref,
    numbersections: md.numbersections,
    documentclass: md.documentclass,
    classoptions: md.classoption,
    geometry: md.geometry,
    engine: md.engine,
    template: md.template,
  };
}

/** The file name Export LaTeX writes for a Markdown file name ("notes.md" -> "notes.tex"). */
export function exportFileName(config: FolderConfig, markdownFileName: string): string {
  const name = markdownFileName.replace(/\.(md|markdown|mdown|mkd|mkdn)$/i, '');
  return (config.markdown.exportName ?? '{name}.tex').replace('{name}', name);
}

/** A starting folder config from a document's effective settings ("Create config from this document"). */
export function configFromMeta(meta: DocumentMeta): FolderConfig {
  return {
    markdown: {
      citations: meta.citationPackage,
      ...(meta.biblioStyle ? { biblioStyle: meta.biblioStyle } : {}),
      cref: meta.cref,
      numbersections: meta.numbersections,
      documentclass: meta.documentclass,
      classoption: meta.classoptions,
      geometry: meta.geometry,
      ...(meta.engine ? { engine: meta.engine } : {}),
      ...(meta.template ? { template: meta.template } : {}),
      htmlView: false,
      exportName: '{name}.tex',
    },
  };
}
