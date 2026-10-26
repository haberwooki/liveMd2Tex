// Helpers for the converter tests (compiled to out/test/converter/support.js).

import { existsSync, promises as fsp, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parsePresetFile, type PresetFile } from '../../src/converter/preset/load';
import { FsError, type ReadOnlyFs } from '../../src/git/fs';

/** The repository root (out/test/converter -> root). */
export const root = path.resolve(__dirname, '..', '..', '..');

/** The source folder of the converter tests (fixtures live beside the .ts files, not in out/). */
export const testDir = path.join(root, 'test', 'converter');

/** Checks the line map of a conversion: one entry per LaTeX line, each a real Markdown line. */
export function lineMapProblems(latex: string, lineMap: number[], markdown: string): string[] {
  const latexLines = latex.replace(/\n$/, '').split('\n').length;
  const sourceLines = markdown.replace(/\r\n?/g, '\n').split('\n').length;
  const problems: string[] = [];
  if (lineMap.length !== latexLines) {
    problems.push(`line map has ${lineMap.length} entries for ${latexLines} LaTeX lines`);
  }
  lineMap.forEach((n, i) => {
    if (!Number.isInteger(n) || n < 1 || n > sourceLines) {
      problems.push(`LaTeX line ${i + 1} maps to ${n}, outside 1..${sourceLines}`);
    }
  });
  return problems;
}

/** The Git reader's file system on node:fs (the extension uses workspace.fs). */
export function nodeFs(): ReadOnlyFs {
  const wrap = async <T>(p: string, f: () => Promise<T>) => {
    try {
      return await f();
    } catch (err) {
      const code = (err as { code?: string }).code;
      throw new FsError(code === 'ENOENT' ? 'ENOENT' : code === 'ENOTDIR' ? 'ENOTDIR' : 'EIO', `${p}: ${(err as Error).message}`);
    }
  };
  return {
    readFile: (p) => wrap(p, async () => new Uint8Array(await fsp.readFile(p))),
    stat: (p) =>
      wrap(p, async () => {
        const s = await fsp.lstat(p);
        return { type: s.isDirectory() ? 'directory' : s.isSymbolicLink() ? 'symlink' : 'file', size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs };
      }),
    readdir: (p) => wrap(p, () => fsp.readdir(p)),
  };
}

/** The example preset in examples/presets/two-column-paper, with its preamble files' text. */
export function examplePreset(): { preset: PresetFile; files: Record<string, string> } {
  return presetFolder(path.join(root, 'examples', 'presets', 'two-column-paper'));
}

/**
 * The private test overlay ("privateTests" in the git-ignored .private-fixtures.json, relative to the repository
 * root), or undefined when there is none. Tests there load their own presets from its presets/ folder.
 */
export function privateTestsFolder(): string | undefined {
  const file = path.join(root, '.private-fixtures.json');
  if (!existsSync(file)) {
    return undefined;
  }
  const dir = (JSON.parse(readFileSync(file, 'utf8')) as { privateTests?: unknown }).privateTests;
  return typeof dir === 'string' ? path.resolve(root, dir) : undefined;
}

/** A preset folder (preset.json and its preamble files), loaded with no problem or an error. */
export function presetFolder(dir: string): { preset: PresetFile; files: Record<string, string> } {
  const { preset, problems } = parsePresetFile(readFileSync(path.join(dir, 'preset.json'), 'utf8'));
  if (!preset || problems.length > 0) {
    throw new Error(`The preset in ${dir} does not load: ${problems.join(' ')}`);
  }
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    files[name] = readFileSync(path.join(dir, name), 'utf8');
  }
  return { preset, files };
}
