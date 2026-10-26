// Reading a preset file and resolving one of its modes (docs/DESIGN.md#presets).
//
//   {
//     "name": "two-column-paper",
//     "description": "...",
//     "defaults": { ...options shared by every mode... },
//     "modes": {
//       "paper":  { "entry": "manuscript.md", "preambleFile": "paper-preamble.tex", ...options... },
//       "letter": { ... }
//     }
//   }
//
// A mode's options are the defaults of types.ts, then "defaults", then the mode's own, merged key by key.
// Pure: the preamble files' text is passed in by the caller, which reads them beside the preset file.

import { globMatches, MAX_GLOB_LENGTH } from './glob';
import { compileSafePattern } from './safePattern';
import { defaultMode, type PresetMode } from './types';

export interface PresetFile {
  name: string;
  description?: string;
  defaults?: Record<string, unknown>;
  modes: Record<string, Record<string, unknown> & { entry?: string | string[]; preambleFile?: string; xetexPreambleFile?: string; appendixEntry?: string }>;
}

/** At most this many entry globs are read from a preset, and this many appendix.dropLines patterns per mode. */
export const MAX_ENTRIES = 100;
export const MAX_DROP_LINES = 20;

export interface ResolvedMode {
  mode: PresetMode;
  /** The Markdown files this mode converts (file names or globs relative to the folder), if any. */
  entries: string[];
  /** A second Markdown file appended after the bibliography (relative to the folder), if the mode has one. */
  appendixEntry?: string;
  problems: string[];
}

const META_KEYS = new Set(['entry', 'preambleFile', 'xetexPreambleFile', 'appendixEntry', 'description']);

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Merges `over` into `base` key by key (objects recursively, arrays and values replaced). Reports unknown keys. */
function merge(base: Record<string, unknown>, over: Record<string, unknown>, path: string, problems: string[]): void {
  for (const [key, value] of Object.entries(over)) {
    if (META_KEYS.has(key) && path === '') {
      continue;
    }
    if (!(key in base)) {
      // Record-valued options (heading commands) accept any key.
      if (path === 'headings.commands') {
        base[key] = value;
        continue;
      }
      if (key === 'appendix' && path === '' && isObject(value)) {
        base[key] = { heading: 'Appendix', dropLines: [], starred: true, clearpage: true, ...value };
        continue;
      }
      problems.push(`"${path ? `${path}.` : ''}${key}" is not a preset option; it was ignored.`);
      continue;
    }
    const current = base[key];
    if (isObject(current) && isObject(value)) {
      merge(current, value, path ? `${path}.${key}` : key, problems);
    } else if (current !== undefined && current !== null && typeof current !== typeof value && !(Array.isArray(current) && Array.isArray(value))) {
      problems.push(`"${path ? `${path}.` : ''}${key}" should be ${Array.isArray(current) ? 'a list' : typeof current}; it was ignored.`);
    } else {
      base[key] = value;
    }
  }
}

export function parsePresetFile(text: string): { preset?: PresetFile; problems: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Not the parser's message: it quotes the start of the file (docs/DESIGN.md#confinement-and-trust).
    return { problems: ['The preset file is not valid JSON.'] };
  }
  if (!isObject(raw) || typeof raw.name !== 'string' || !isObject(raw.modes)) {
    return { problems: ['A preset file needs a "name" and a "modes" object.'] };
  }
  const preset = raw as unknown as PresetFile;
  return { preset, problems: entryProblems(preset) };
}

/** Every mode's entry globs, in order, at most MAX_ENTRIES of them. */
function entryGlobs(preset: PresetFile): { mode: string; glob: string }[] {
  const out: { mode: string; glob: string }[] = [];
  for (const [mode, spec] of Object.entries(preset.modes)) {
    const entries = !isObject(spec) || spec.entry === undefined ? [] : Array.isArray(spec.entry) ? spec.entry : [spec.entry];
    for (const glob of entries) {
      if (out.length >= MAX_ENTRIES) {
        return out;
      }
      if (typeof glob === 'string') {
        out.push({ mode, glob });
      }
    }
  }
  return out;
}

/** The entry globs a preset gives that are not used: past the first MAX_ENTRIES, or too long. */
function entryProblems(preset: PresetFile): string[] {
  const problems: string[] = [];
  let count = 0;
  for (const spec of Object.values(preset.modes)) {
    const entries = !isObject(spec) || spec.entry === undefined ? [] : Array.isArray(spec.entry) ? spec.entry : [spec.entry];
    count += entries.length;
  }
  if (count > MAX_ENTRIES) {
    problems.push(`The preset gives ${count} entry patterns; only the first ${MAX_ENTRIES} are used.`);
  }
  for (const { mode, glob } of entryGlobs(preset)) {
    if (glob.length > MAX_GLOB_LENGTH) {
      problems.push(`An entry pattern of mode "${mode}" is longer than ${MAX_GLOB_LENGTH} characters and is not used.`);
    }
  }
  return problems;
}

/**
 * Resolves one mode of a preset. `files` maps a file name named by the preset (preambleFile) to its text;
 * `overrides` (from the folder config) are merged last.
 */
export function resolveMode(preset: PresetFile, modeName: string, files: Record<string, string> = {}, overrides?: Record<string, unknown>): ResolvedMode {
  const problems: string[] = [];
  const modeSpec = preset.modes[modeName];
  if (!modeSpec) {
    return { mode: defaultMode(), entries: [], problems: [`The preset "${preset.name}" has no mode "${modeName}".`] };
  }
  const mode = defaultMode() as unknown as Record<string, unknown>;
  if (preset.defaults) {
    merge(mode, structuredClone(preset.defaults), '', problems);
  }
  merge(mode, structuredClone(modeSpec), '', problems);
  if (overrides) {
    // A folder's own adjustments (its figure lists, its note markers) on top of the preset.
    merge(mode, structuredClone(overrides), '', problems);
  }
  mode.name = modeName;
  for (const [key, target] of [
    ['preambleFile', 'preamble'],
    ['xetexPreambleFile', 'xetexPreamble'],
  ] as const) {
    const file = modeSpec[key] ?? (preset.defaults?.[key] as string | undefined);
    if (file) {
      const text = files[file];
      if (text === undefined) {
        const fallback = key === 'preambleFile' ? 'the default template is used' : 'the mode stays on pdfLaTeX';
        problems.push(`The preamble file "${file}" of mode "${modeName}" could not be read; ${fallback}.`);
      } else {
        mode[target] = text;
      }
    }
  }
  checkPatterns(mode as unknown as PresetMode, modeName, problems);
  const entry = modeSpec.entry;
  return {
    mode: mode as unknown as PresetMode,
    entries: entry === undefined ? [] : Array.isArray(entry) ? entry : [entry],
    appendixEntry: modeSpec.appendixEntry,
    problems,
  };
}

/**
 * The mode of a preset whose entry matches a Markdown file name (exact name, or * and ? wildcards). The globs are
 * untrusted, so they are matched by glob.ts, never as a RegExp (docs/DESIGN.md#presets).
 */
export function modeForFile(preset: PresetFile, fileName: string): string | undefined {
  return entryGlobs(preset).find(({ glob }) => globMatches(glob, fileName))?.mode;
}

/**
 * A preset's patterns (the caption labels, the appendix's dropLines) come from a repository and are untrusted
 * (docs/DESIGN.md#presets): each must be in the safe pattern language (safePattern.ts); one that is not is reported
 * and dropped.
 */
function checkPatterns(mode: PresetMode, modeName: string, problems: string[]): void {
  const reason = (source: string): string | undefined => {
    try {
      compileSafePattern(source);
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  for (const [where, label] of [
    ['figures.label', mode.figures?.label],
    ['tables.label', mode.tables?.label],
  ] as const) {
    // The same text blocks.ts compiles, so a label that passes here also works there.
    const why = typeof label === 'string' ? reason(`^(?:${label})\\b`) : undefined;
    if (why) {
      problems.push(`The ${where} pattern "${label}" of mode "${modeName}" is not used: ${why}.`);
    }
  }
  if (mode.appendix && mode.appendix.dropLines.length > MAX_DROP_LINES) {
    problems.push(`Mode "${modeName}" gives ${mode.appendix.dropLines.length} appendix.dropLines patterns; only the first ${MAX_DROP_LINES} are used.`);
    mode.appendix.dropLines = mode.appendix.dropLines.slice(0, MAX_DROP_LINES);
  }
  if (mode.appendix) {
    mode.appendix.dropLines = mode.appendix.dropLines.filter((p) => {
      const why = reason(p);
      if (why) {
        problems.push(`The appendix.dropLines pattern "${p}" of mode "${modeName}" is not used: ${why}.`);
      }
      return why === undefined;
    });
  }
}
