// TeX and BibTeX logs to Problems-panel entries (docs/DESIGN.md#live-behaviour). Written for this project; the idea of
// following the "(file" ... ")" nesting to know which file a warning belongs to is the usual one (LaTeX
// Workshop's MIT parser does the same). The engine runs with -file-line-error and max_print_line = 10000, so
// errors read "./file.tex:12: message" and no line is wrapped.

import { posix } from 'node:path';

export type Severity = 'error' | 'warning' | 'info';

export interface TexDiagnostic {
  /** Path relative to the project folder, with "/" separators. */
  file: string;
  /** 1-based; 0 when the log gives no line. */
  line: number;
  severity: Severity;
  message: string;
  /** 'liveMd2Tex' (the display name) for the extension's own messages, such as a refused file. */
  source: 'TeX' | 'BibTeX' | 'liveMd2Tex';
}

/**
 * Maps a path printed by the engine to the project. The engine's working folder is the main file's folder
 * inside /project, so "./x.tex" is relative to it. Paths outside the project (the bundle, /texlive/...) give
 * null: such messages are shown on the main file.
 */
export function projectPath(printed: string, mainDir: string): string | null {
  if (printed.startsWith('/project/')) {
    return printed.slice('/project/'.length);
  }
  if (printed.startsWith('/')) {
    return null;
  }
  const rel = posix.normalize(posix.join(mainDir, printed));
  return rel.startsWith('..') ? null : rel;
}

const FILE_TOKEN = /^\(([^\s()"{}]+\.[A-Za-z0-9]+)/;

export function parseTexLog(log: string, mainRel: string): TexDiagnostic[] {
  const mainDir = posix.dirname(mainRel) === '.' ? '' : posix.dirname(mainRel);
  const out: TexDiagnostic[] = [];
  const stack: (string | null)[] = [];
  const current = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i];
      if (f) {
        const p = projectPath(f, mainDir);
        if (p) {
          return p;
        }
      }
    }
    return mainRel;
  };
  const lines = log.replace(/\r\n?/g, '\n').split('\n');

  const add = (file: string | null, line: number, severity: Severity, message: string) => {
    const text = message.replace(/\s+/g, ' ').trim();
    if (!out.some((d) => d.file === (file ?? mainRel) && d.line === line && d.message === text)) {
      out.push({ file: file ?? mainRel, line, severity, message: text, source: 'TeX' });
    }
  };

  /** The lines that continue a multi-line warning, joined. */
  const continuation = (start: number, prefix: RegExp): { text: string; end: number } => {
    let text = '';
    let i = start + 1;
    while (i < lines.length && lines[i].trim() !== '' && prefix.test(lines[i])) {
      text += ` ${lines[i].replace(prefix, '').trim()}`;
      i++;
    }
    return { text, end: i - 1 };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Errors in -file-line-error form: "./file.tex:12: message".
    const fle = /^((?:\.{1,2}\/|\/)[^:]*?|[^\s:]+\.(?:tex|sty|cls|ltx|bib|bbl|aux|toc|def|cfg)):(\d+): (.*)$/.exec(line);
    if (fle) {
      let message = fle[3];
      // A package's or class's error goes on over lines that start with its name in parentheses ("(fontspec)
      // The font ... cannot be found"); fontspec puts the whole message there.
      const pkgError = /^(?:Package|Class) (\S+) Error:/.exec(message);
      if (pkgError) {
        message += continuation(i, new RegExp(`^\\(${pkgError[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\s*`)).text;
      }
      // TeX's first context line ends where it stopped. For an undefined command inside a macro or an argument
      // that is not the "l.12" line ("\mymacro ->\foo", "<argument> \foo"), so it is kept: it names the command
      // TeX did not know (errorHelp.ts).
      const first = lines[i + 1] ?? '';
      if (/^Undefined control sequence/.test(message) && first.trim() && !/^l\.\d+/.test(first)) {
        message += ` (in: ${first.trim()})`;
      }
      // The context line ("l.12 \foo") helps; it follows within a few lines.
      for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
        const ctx = /^l\.\d+\s?(.*)$/.exec(lines[j]);
        if (ctx) {
          if (ctx[1].trim()) {
            message += ` (at: ${ctx[1].trim()})`;
          }
          break;
        }
      }
      const file = projectPath(fle[1], mainDir);
      add(file, file ? Number(fle[2]) : 0, 'error', file ? message : `${message} [in ${posix.basename(fle[1])}]`);
      continue;
    }

    // pdfTeX's own errors: "!pdfTeX error: /bin/busytex (file sfrm1000.pfb): cannot open Type 1 font file for
    // reading". They stop the PDF; the program's path is left out of the message.
    const pdftex = /^!pdfTeX error: (?:\S+ )?(\(file [^)]+\): .*)$/.exec(line);
    if (pdftex) {
      add(current(), 0, 'error', `pdfTeX error: ${pdftex[1]}`);
      continue;
    }

    // Errors without a file: "! message" with "l.12" below.
    if (line.startsWith('! ')) {
      let lineNo = 0;
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
        const ctx = /^l\.(\d+)/.exec(lines[j]);
        if (ctx) {
          lineNo = Number(ctx[1]);
          break;
        }
      }
      add(current(), lineNo, 'error', line.slice(2));
      continue;
    }

    const latex = /^(LaTeX|Package (\S+)|Class (\S+)) (Warning|Font Warning|Info)?:? ?(.*)$/.exec(line);
    if (latex && /Warning/.test(line.slice(0, 60))) {
      const pkg = latex[2] ?? latex[3];
      const prefix = pkg ? new RegExp(`^\\(${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\s*`) : /^\s+/;
      const more = continuation(i, prefix);
      const message = `${line.replace(/^(LaTeX|Package \S+|Class \S+) (Font )?Warning: /, '')}${more.text}`;
      const at = /on input line (\d+)/.exec(message);
      const severity: Severity = /Font Warning/.test(line) ? 'info' : 'warning';
      add(current(), at ? Number(at[1]) : 0, severity, `${pkg ? `${pkg}: ` : ''}${message}`);
      i = more.end;
      continue;
    }

    const overfull = /^(Overfull|Underfull) \\[hv]box .*(?:at lines? (\d+)(?:--\d+)?)?/.exec(line);
    if (overfull?.[1] === 'Overfull') {
      const at = /at lines? (\d+)/.exec(line);
      add(current(), at ? Number(at[1]) : 0, 'info', line.replace(/\s*\[\]\s*$/, ''));
    }

    if (/^Missing character: There is no/.test(line)) {
      add(current(), 0, 'warning', line);
    }

    // File nesting: "(./chap1.tex" opens a file, ")" closes the innermost one.
    for (let k = 0; k < line.length; k++) {
      const c = line[k];
      if (c === '(') {
        const m = FILE_TOKEN.exec(line.slice(k));
        stack.push(m ? m[1] : null);
        if (m) {
          k += m[0].length - 1;
        }
      } else if (c === ')') {
        stack.pop();
      }
    }
  }
  return out;
}

export interface BibSource {
  path: string;
  text: string;
}

/** BibTeX's .blg: warnings and errors, placed on the .bib entry or line where possible. */
export function parseBlg(blg: string, bibs: BibSource[], mainRel: string): TexDiagnostic[] {
  const out: TexDiagnostic[] = [];
  const findKey = (key: string): { file: string; line: number } | null => {
    for (const b of bibs) {
      const at = b.text.search(new RegExp(`@\\w+\\s*\\{\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,`));
      if (at >= 0) {
        return { file: b.path, line: b.text.slice(0, at).split('\n').length };
      }
    }
    return null;
  };
  const lines = blg.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const warn = /^Warning--(.*?)(?: in (\S+))?$/.exec(line);
    if (warn) {
      const where = warn[2] ? findKey(warn[2]) : null;
      out.push({ file: where?.file ?? mainRel, line: where?.line ?? 0, severity: 'warning', message: warn[0].slice(9), source: 'BibTeX' });
      continue;
    }
    // "I was expecting a `,' or a `}'---line 9 of file refs.bib" (the message may also stand on the line before).
    const lineOf = /^(.*?)-{3,}line (\d+) of file (.+)$/.exec(line);
    if (lineOf) {
      const bib = bibs.find((b) => posix.basename(b.path) === posix.basename(lineOf[3].trim())) ?? null;
      const message = lineOf[1].trim() || (lines[i - 1] ?? '').trim() || 'BibTeX error';
      out.push({ file: bib?.path ?? mainRel, line: Number(lineOf[2]), severity: 'error', message, source: 'BibTeX' });
      continue;
    }
    if (/^I couldn't open|^I found no|^Illegal, another|^Sorry---you've exceeded/.test(line)) {
      out.push({ file: mainRel, line: 0, severity: 'error', message: line.trim(), source: 'BibTeX' });
    }
  }
  return out;
}
