// Reading a .tex file's text for the project model (docs/DESIGN.md#architecture, #engine-and-data): the root document, the engine
// for a document, and what a file includes. Pure functions; no file access.

import type { EngineName } from '../../shared/engineJobs';

/** The text with TeX comments removed (a % not preceded by a backslash ends the line's content). */
export function stripComments(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '%' && (i === 0 || line[i - 1] !== '\\')) {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

/** The part before \begin{document} (the whole text when there is none). */
export function preamble(text: string): string {
  const clean = stripComments(text);
  const at = clean.indexOf('\\begin{document}');
  return at < 0 ? clean : clean.slice(0, at);
}

/** A magic comment such as "% !TEX root = ../main.tex" in the first 30 lines. */
export function magicComment(text: string, key: 'root' | 'program'): string | null {
  const head = text.split(/\r?\n/).slice(0, 30).join('\n');
  const re = key === 'root' ? /^\s*%\s*!\s*TEX\s+root\s*=\s*(.+?)\s*$/im : /^\s*%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*(.+?)\s*$/im;
  return re.exec(head)?.[1] ?? null;
}

export function hasDocumentClass(text: string): boolean {
  return /\\documentclass\s*(\[[^\]]*\])?\s*\{/.test(stripComments(text));
}

/** True when the text includes `name` (without extension) through \input, \include, \subfile or \import. */
export function includesFile(text: string, name: string): boolean {
  const bare = name.replace(/\.tex$/i, '');
  const clean = stripComments(text);
  const re = /\\(?:input|include|subfile|includeonly)\s*\{([^}]+)\}|\\(?:sub)?import\*?\s*\{[^}]*\}\s*\{([^}]+)\}/g;
  for (const m of clean.matchAll(re)) {
    for (const target of (m[1] ?? m[2] ?? '').split(',')) {
      const t = target.trim().replace(/\.tex$/i, '');
      if (t === bare || t.endsWith(`/${bare}`)) {
        return true;
      }
    }
  }
  return false;
}

export interface EngineChoice {
  engine: Exclude<EngineName, 'luahbtex-ini'>;
  reason: string;
}

/**
 * Engine per document (docs/DESIGN.md#engine-and-data): a "% !TEX program" comment first, then the preamble (fontspec,
 * unicode-math or polyglossia mean XeTeX), then the user's setting. v1.0 offers no LuaLaTeX (no lualatex
 * format in the bundle), so a LuaLaTeX request runs on XeTeX, which reads the same fontspec preambles.
 */
export function chooseEngine(text: string, setting: 'pdflatex' | 'xelatex'): EngineChoice {
  const program = magicComment(text, 'program')?.toLowerCase();
  if (program) {
    if (/^(pdf)?latex$|^pdftex$/.test(program)) {
      return { engine: 'pdflatex', reason: `magic comment "% !TEX program = ${program}"` };
    }
    if (/^xe(la)?tex$/.test(program)) {
      return { engine: 'xelatex', reason: `magic comment "% !TEX program = ${program}"` };
    }
    if (/^lua(hb)?(la)?tex$/.test(program)) {
      return { engine: 'xelatex', reason: `magic comment asks for ${program}; LuaLaTeX is not offered yet, so XeTeX is used` };
    }
  }
  const pre = preamble(text);
  const packages = [...pre.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)].flatMap((m) =>
    m[1].split(',').map((p) => p.trim()),
  );
  const unicode = packages.find((p) => p === 'fontspec' || p === 'unicode-math' || p === 'polyglossia');
  if (unicode) {
    return { engine: 'xelatex', reason: `the preamble loads ${unicode}` };
  }
  return { engine: setting, reason: `the setting (${setting})` };
}
