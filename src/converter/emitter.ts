// The line emitter: every LaTeX line is pushed together with the 1-based Markdown line it comes from, so the
// line map is built as the text is (docs/DESIGN.md#converter: one LaTeX line per source line; pretty-printing is
// indentation only, and the map is recorded after it).

// A footnote's text is written where its reference stands, but comes from the footnote's definition, on another
// Markdown line. The writer marks it (markFromLine); the emitter puts it on a LaTeX line of its own, mapped to
// the definition, with its closing brace (TeX sets the note when it reads that brace, and SyncTeX gives it that
// line) and "%" at the breaks, so the typeset text is the same: "...\footnote{%", "text} %", "rest of the line".
// Click-to-source on footnote text then lands on the definition (docs/DESIGN.md#sync).
const FROM = String.fromCharCode(0xfdd1);
const AT = String.fromCharCode(0xfdd2);
const END = String.fromCharCode(0xfdd3);
const MARKED = new RegExp(`${FROM}(\\d+)${AT}([^${END}]*)${END}`);

/** Marks text that comes from another Markdown line (see above). */
export function markFromLine(line: number, text: string): string {
  return `${FROM}${line}${AT}${text}${END}`;
}

/** The text without the marks (for strings that do not go through an emitter: front matter values). */
export function stripLineMarks(text: string): string {
  return text.includes(FROM) ? text.replace(new RegExp(`${FROM}\\d+${AT}`, 'g'), '').split(END).join('') : text;
}

export class Emitter {
  readonly lines: string[] = [];
  readonly map: number[] = [];
  private depth = 0;
  private prefix = '';
  private prefixLine = 0;

  /** Indents the lines of an environment's body by two spaces per level. */
  indent(): void {
    this.depth++;
  }

  dedent(): void {
    this.depth = Math.max(0, this.depth - 1);
  }

  /**
   * Text that the next content line starts with ("\item "); flushed as a line of its own if no content follows.
   */
  setPrefix(text: string, sourceLine: number): void {
    this.flushPrefix();
    this.prefix = text;
    this.prefixLine = sourceLine;
  }

  flushPrefix(): void {
    if (this.prefix) {
      const text = this.prefix.trimEnd();
      this.prefix = '';
      this.push(text, this.prefixLine, false);
    }
  }

  private push(text: string, sourceLine: number, raw: boolean): void {
    let done = '';
    let rest = text;
    let m = MARKED.exec(rest);
    while (m) {
      const before = rest.slice(0, m.index);
      rest = rest.slice(m.index + m[0].length);
      if (Number(m[1]) === sourceLine) {
        done += before + m[2]; // defined on this very line (an inline note): it stays inline
      } else {
        this.pushOne(`${done}${before}%`, sourceLine, raw);
        // TeX sets a macro's argument when it reads the closing brace, and SyncTeX gives it that line: the
        // brace ends the note's own line. A space after it stays before the "%"; nothing after it, no "%".
        const close = /^\}([ \t]*)/.exec(rest);
        if (close) {
          rest = rest.slice(close[0].length);
          this.pushOne(`${m[2]}}${close[1]}${rest === '' ? '' : '%'}`, Number(m[1]), raw);
        } else {
          this.pushOne(`${m[2]}%`, Number(m[1]), raw);
        }
        done = '';
      }
      m = MARKED.exec(rest);
    }
    this.pushOne(done + rest, sourceLine, raw);
  }

  private pushOne(text: string, sourceLine: number, raw: boolean): void {
    const pad = raw || text === '' ? '' : '  '.repeat(this.depth);
    this.lines.push(pad + text);
    this.map.push(Math.max(1, sourceLine));
  }

  /** One line of LaTeX (no line breaks inside). */
  line(text: string, sourceLine: number): void {
    if (this.prefix) {
      text = this.prefix + text;
      this.prefix = '';
    }
    this.push(text, sourceLine, false);
  }

  /** A line kept exactly as written (verbatim and raw LaTeX): no indentation, no prefix. */
  rawLine(text: string, sourceLine: number): void {
    this.flushPrefix();
    this.push(text, sourceLine, true);
  }

  /**
   * Text with "\n" line breaks: line i maps to firstLine + i, but never past lastLine (a construct that produced
   * more lines than its source keeps the extra lines on its last source line).
   */
  multiline(text: string, firstLine: number, lastLine = Number.MAX_SAFE_INTEGER): void {
    text.split('\n').forEach((part, i) => this.line(part, Math.min(firstLine + i, Math.max(firstLine, lastLine))));
  }

  blank(sourceLine: number): void {
    this.flushPrefix();
    if (this.lines.length > 0 && this.lines[this.lines.length - 1] !== '') {
      this.push('', sourceLine, true);
    }
  }

  lastLine(): string | undefined {
    return this.lines[this.lines.length - 1];
  }
}
