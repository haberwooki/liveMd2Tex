// Typesets a Markdown file the way the extension's compile route does (src/extension/compile/runner.ts):
// the converter, with the image rule of ConversionService (a .pdf beside a .png is preferred); the pipeline's
// prepareMarkdownCompile with the interim fonts the conversion names (dist/data/fonts, staged by
// scripts/stage-engine.mjs --data); the engine service with the engine-host stubs. Shared by the M1 tests.

import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { convertMarkdown, type ConversionResult, type ConvertOptions } from '../../src/converter/markdownToLatex';
import { diagnosticsFor, prepareMarkdownCompile, type PreparedCompile } from '../../src/extension/compile/pipeline';
import type { TexDiagnostic } from '../../src/extension/diagnostics/logParser';
import { bundledEngineAssets, EngineService } from '../../src/extension/engine/engineService';
import { interimFontsFolder, readInterimFonts } from '../../src/extension/engine/interimFonts';
import type { ProjectFs } from '../../src/extension/project/collect';
import type { CompileResult } from '../../src/shared/engineJobs';
import { root } from '../support/helpers';

/** The engine service on the staged engine, or null when dist/engine and dist/data are not staged. */
export function markdownEngineService(): EngineService | null {
  if (!bundledEngineAssets(root)) {
    return null;
  }
  const service = new EngineService({
    modulePath: path.join(root, 'dist', 'engine-host.js'),
    assets: () => bundledEngineAssets(root),
    idleMinutes: () => 0,
    log: () => undefined,
  });
  service.execArgv = ['--require', path.join(root, 'test', 'stubs', 'register-engine-host.cjs')];
  return service;
}

/** A project folder on disk. */
export function folderFs(folder: string): ProjectFs {
  return {
    async readDirectory(rel) {
      const entries = await readdir(path.join(folder, rel), { withFileTypes: true });
      return entries.map((e) => [e.name, e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other']);
    },
    readFile: async (rel) => new Uint8Array(await readFile(path.join(folder, rel))),
  };
}

/** A project held in memory (files read from a Git commit, say), by "/" path. */
export function memoryFs(files: Map<string, Uint8Array>): ProjectFs {
  return {
    async readDirectory(rel) {
      const prefix = rel ? `${rel}/` : '';
      const out = new Map<string, 'file' | 'dir'>();
      for (const p of files.keys()) {
        if (p.startsWith(prefix)) {
          const rest = p.slice(prefix.length);
          const slash = rest.indexOf('/');
          out.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? 'file' : 'dir');
        }
      }
      return [...out];
    },
    async readFile(rel) {
      const data = files.get(rel);
      if (!data) {
        throw new Error(`no file ${rel}`);
      }
      return data;
    },
  };
}

export interface TypesetMarkdown {
  conversion: ConversionResult;
  prepared: PreparedCompile;
  result: CompileResult;
  diagnostics: TexDiagnostic[];
  /** The "Missing character" lines of the last pass's log. */
  missing: string[];
}

const TWINS: Record<string, string[]> = { png: ['pdf'], jpg: ['pdf'], jpeg: ['pdf'], svg: ['pdf', 'png'], gif: ['png', 'pdf'], eps: ['pdf'] };

/** Converts `text` (the Markdown file `markdownRel` of the project) and typesets it through the extension's route. */
export async function typesetMarkdown(service: EngineService, fs: ProjectFs, markdownRel: string, text: string, options: ConvertOptions = {}): Promise<TypesetMarkdown> {
  const dir = path.posix.dirname(markdownRel) === '.' ? '' : `${path.posix.dirname(markdownRel)}/`;
  const exists = async (rel: string) => {
    try {
      await fs.readFile(rel);
      return true;
    } catch {
      return false;
    }
  };
  const base = { sourceName: path.posix.basename(markdownRel), ...options };
  let conversion = convertMarkdown(text, base);
  const replacements = new Map<string, string>();
  for (const image of conversion.images) {
    const dot = image.lastIndexOf('.');
    for (const twin of TWINS[image.slice(dot + 1).toLowerCase()] ?? []) {
      const candidate = `${image.slice(0, dot)}.${twin}`;
      if (await exists(`${dir}${candidate}`)) {
        replacements.set(image, candidate);
        break;
      }
    }
  }
  if (replacements.size > 0) {
    conversion = convertMarkdown(text, { ...base, resolveImage: (p) => replacements.get(p) });
  }
  const prepared = await prepareMarkdownCompile({
    fs,
    markdownRel,
    latex: conversion.latex,
    lineMap: conversion.lineMap,
    engine: conversion.engine,
    extraFiles: await readInterimFonts(interimFontsFolder(root), conversion.fontFiles),
  });
  const { result } = await service.compile(prepared.job);
  const missing = result.log.split('\n').filter((l) => /Missing character: There is no/.test(l));
  return { conversion, prepared, result, diagnostics: diagnosticsFor(result, prepared), missing };
}
