// Diagnostics from a conversion. "unsupported" is the plain warning the dialect promises (docs/DESIGN.md#converter) for each
// construct the dialect does not support (named with pandoc's name for it; the text passes through).
// "notice" is everything else worth telling the user (characters pdfTeX cannot print, an SVG image without a
// PDF copy, a class template that arrives later). One diagnostic per kind of construct, listing every line.

/** 'warning': a problem outside the Markdown itself (a folder config path that was refused, say). */
export type DiagnosticKind = 'unsupported' | 'notice' | 'warning';

export interface Diagnostic {
  kind: DiagnosticKind;
  /** Stable identifier of the construct, e.g. "grid-table", "html:script". */
  code: string;
  message: string;
  /** 1-based Markdown lines where it occurs (first one first). */
  lines: number[];
}

export class Diagnostics {
  private readonly byCode = new Map<string, Diagnostic>();

  add(kind: DiagnosticKind, code: string, message: string, line: number): void {
    const existing = this.byCode.get(code);
    if (existing) {
      if (!existing.lines.includes(line)) {
        existing.lines.push(line);
      }
      return;
    }
    this.byCode.set(code, { kind, code, message, lines: [line] });
  }

  unsupported(code: string, message: string, line: number): void {
    this.add('unsupported', code, message, line);
  }

  notice(code: string, message: string, line: number): void {
    this.add('notice', code, message, line);
  }

  list(): Diagnostic[] {
    return [...this.byCode.values()].map((d) => ({ ...d, lines: [...d.lines].sort((a, b) => a - b) }));
  }
}
