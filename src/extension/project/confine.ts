// Confinement of the project model (docs/DESIGN.md#confinement-and-trust, Workspace Trust). A stranger's repository may hold
// hostile .tex, so the files handed to the engine come only from inside the project folder (the workspace folder
// that holds the document, or the document's own folder when none is open) and from the extension's own data.
// This reads the references in the project's .tex files: an absolute path, or a ".." that leaves the project
// folder, is refused with a plain message, so `\input{../../.ssh/id_rsa}` gets nothing; a relative path that
// stays inside the project folder but outside the document's folder is collected. Pure functions, no file access.
// Named files: \input, \include, graphics and listings commands, bibliographies, the import package, the folders
// of \graphicspath, and \usepackage, \documentclass and \bibliographystyle when the name holds a path (a plain
// package name comes from the TeX tree). Not followed: \openin and names built by macros (build gate 1, G1S-11).

import { posix } from 'node:path';
import type { TexDiagnostic } from '../diagnostics/logParser';
import { stripComments } from './texText';

/** A reference that may be read: candidate project paths, tried in order (with the extensions TeX would add). */
export interface Reference {
  candidates: string[];
  /** The name as written, and where. */
  target: string;
  file: string;
  line: number;
}

export interface ReferenceScan {
  references: Reference[];
  refused: TexDiagnostic[];
}

const SINGLE =
  /\\(input|include|subfile|includegraphics|includepdf|includestandalone|lstinputlisting|verbatiminput|VerbatimInput|BVerbatimInput|LVerbatimInput|InputIfFileExists|addbibresource|bibliography|includesvg|usepackage|RequirePackage|documentclass|bibliographystyle)\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]*)\}/g;
const GRAPHICSPATH = /\\graphicspath\s*\{((?:\s*\{[^{}]*\})*)\s*\}/g;
/** \usepackage and its kin name a project file only when the name holds a path; the extension TeX adds. */
const PATH_ONLY: Record<string, string> = { usepackage: '.sty', RequirePackage: '.sty', documentclass: '.cls', bibliographystyle: '.bst' };
const DOUBLE = /\\(import|subimport|inputfrom|subinputfrom|includefrom|subincludefrom)\*?\s*\{([^}]*)\}\s*\{([^}]*)\}/g;

const GRAPHICS = ['', '.pdf', '.png', '.jpg', '.jpeg', '.eps'];

/** Is `rel` a plain path inside the project folder (no absolute path, no ".." that leaves it)? */
export function insideProject(rel: string): boolean {
  if (rel === '' || /^([\\/]|[A-Za-z]:|~)/.test(rel) || rel.includes('\0')) {
    return false;
  }
  const n = posix.normalize(rel.replace(/\\/g, '/'));
  return n !== '..' && !n.startsWith('../') && !n.startsWith('/');
}

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
 * The folders named by \graphicspath in one .tex file, relative to the main file's folder (TeX's working
 * folder), as project paths ending in "/". A folder outside the project is refused like any other reference.
 */
export function scanGraphicsPaths(text: string, file: string, mainRel: string): { dirs: string[]; refused: TexDiagnostic[] } {
  const clean = stripComments(text);
  const cwd = posix.dirname(mainRel) === '.' ? '' : posix.dirname(mainRel);
  const dirs: string[] = [];
  const refused: TexDiagnostic[] = [];
  for (const m of clean.matchAll(GRAPHICSPATH)) {
    for (const d of m[1].matchAll(/\{([^{}]*)\}/g)) {
      const dir = d[1].trim();
      if (!dir) {
        continue;
      }
      const where = { file, line: lineAt(clean, m.index ?? 0), severity: 'error' as const, source: 'liveMd2Tex' as const };
      const rel = posix.normalize(posix.join(cwd, dir));
      if (/^([\\/]|[A-Za-z]:|~)/.test(dir) || !insideProject(rel)) {
        refused.push({ ...where, message: `Not read: the graphics folder "${dir}" is outside the project folder. The preview reads only files inside the open folder.` });
      } else if (rel !== '.' && rel !== './') {
        dirs.push(`${rel.replace(/\/$/, '')}/`);
      }
    }
  }
  return { dirs, refused };
}

/**
 * The references of one .tex file. `file` and `mainRel` are project-relative; TeX resolves \input and graphics
 * paths against the main file's folder (its working folder), \subimport against the including file's folder.
 */
export function scanReferences(text: string, file: string, mainRel: string, graphicsDirs: string[] = []): ReferenceScan {
  const clean = stripComments(text);
  const cwd = posix.dirname(mainRel) === '.' ? '' : posix.dirname(mainRel);
  const here = posix.dirname(file) === '.' ? '' : posix.dirname(file);
  const references: Reference[] = [];
  const refused: TexDiagnostic[] = [];

  const consider = (target: string, base: string, extensions: string[], index: number, alsoIn: string[] = []) => {
    const t = target.trim();
    if (!t || t.includes('#')) {
      return;
    }
    const where = { file, line: lineAt(clean, index), severity: 'error' as const, source: 'liveMd2Tex' as const };
    if (/^([\\/]|[A-Za-z]:|~)/.test(t)) {
      refused.push({ ...where, message: `Not read: "${t}" is an absolute path. The preview reads only files inside the project folder; give the path relative to ${posix.basename(mainRel)}.` });
      return;
    }
    const rel = posix.normalize(posix.join(base, t));
    if (!insideProject(rel)) {
      refused.push({ ...where, message: `Not read: "${t}" is outside the project folder. The preview reads only files inside the open folder.` });
      return;
    }
    // TeX tries the name as given first, then each \graphicspath folder.
    const bases = [rel, ...alsoIn.map((dir) => posix.normalize(posix.join(dir, t))).filter((r) => insideProject(r))];
    references.push({
      candidates: bases
        .flatMap((b) => extensions.map((e) => (e && b.toLowerCase().endsWith(e) ? b : `${b}${e}`)))
        .filter((c, i, a) => a.indexOf(c) === i),
      target: t,
      file: where.file,
      line: where.line,
    });
  };

  for (const m of clean.matchAll(SINGLE)) {
    const command = m[1];
    const index = m.index ?? 0;
    if (command === 'bibliography') {
      for (const name of m[2].split(',')) {
        consider(name.trim().replace(/\.bib$/i, ''), cwd, ['.bib'], index);
      }
    } else if (command === 'addbibresource') {
      consider(m[2], cwd, [''], index);
    } else if (command === 'includegraphics' || command === 'includepdf' || command === 'includesvg') {
      consider(m[2], cwd, GRAPHICS, index, graphicsDirs);
    } else if (command in PATH_ONLY) {
      for (const name of m[2].split(',').map((n) => n.trim())) {
        if (name.includes('/')) {
          consider(name, cwd, [PATH_ONLY[command]], index);
        }
      }
    } else {
      consider(m[2], cwd, ['', '.tex'], index);
    }
  }
  for (const m of clean.matchAll(DOUBLE)) {
    const relativeToHere = m[1].startsWith('sub');
    const dir = m[2].trim();
    const index = m.index ?? 0;
    if (/^([\\/]|[A-Za-z]:|~)/.test(dir)) {
      consider(`${dir.replace(/\/?$/, '/')}${m[3].trim()}`, '', ['', '.tex'], index);
    } else {
      consider(posix.join(dir, m[3].trim()), relativeToHere ? here : cwd, ['', '.tex'], index);
    }
  }
  return { references, refused };
}
