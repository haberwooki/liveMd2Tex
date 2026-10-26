// The small HTML subset GitHub READMEs and notes use (docs/DESIGN.md#converter): <br>, <sup>, <sub> and <img>, plus
// the formatting and layout tags that have a plain LaTeX meaning. Everything else is dropped with one warning
// per tag name, and the text between tags is kept. A tokenizer, not a full HTML parser: enough for tags that
// markdown-it hands over one at a time (inline HTML) or as a block.

export interface HtmlTag {
  kind: 'open' | 'close' | 'selfclose';
  name: string;
  attrs: Record<string, string>;
}

export type HtmlPiece = { type: 'tag'; tag: HtmlTag; offset: number } | { type: 'text'; text: string; offset: number } | { type: 'comment'; offset: number };

const TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const VOID = new Set(['br', 'hr', 'img', 'input', 'link', 'meta', 'source', 'wbr', 'col', 'area', 'base', 'embed', 'track']);

export function parseTag(text: string, at = 0): { tag: HtmlTag; end: number } | undefined {
  TAG.lastIndex = at;
  const m = TAG.exec(text);
  if (!m) {
    return undefined;
  }
  const attrs: Record<string, string> = {};
  for (const a of m[3].matchAll(ATTR)) {
    attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[5] ?? '';
  }
  const name = m[2].toLowerCase();
  const kind = m[1] ? 'close' : m[4] || VOID.has(name) ? 'selfclose' : 'open';
  return { tag: { kind, name, attrs }, end: TAG.lastIndex };
}

/** Splits HTML into tags, comments and text runs, with their offsets in the input. */
export function tokenizeHtml(html: string): HtmlPiece[] {
  const pieces: HtmlPiece[] = [];
  let i = 0;
  let textStart = 0;
  const flush = (end: number) => {
    if (end > textStart) {
      pieces.push({ type: 'text', text: html.slice(textStart, end), offset: textStart });
    }
  };
  while (i < html.length) {
    if (html[i] !== '<') {
      i++;
      continue;
    }
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      flush(i);
      pieces.push({ type: 'comment', offset: i });
      i = end < 0 ? html.length : end + 3;
      textStart = i;
      continue;
    }
    if (/^<[!?]/.test(html.slice(i, i + 2))) {
      // <!DOCTYPE ...>, <?xml ...?>, <![CDATA[...]]>: drop.
      const end = html.indexOf('>', i);
      flush(i);
      pieces.push({ type: 'comment', offset: i });
      i = end < 0 ? html.length : end + 1;
      textStart = i;
      continue;
    }
    const parsed = parseTag(html, i);
    if (!parsed) {
      i++;
      continue;
    }
    flush(i);
    pieces.push({ type: 'tag', tag: parsed.tag, offset: i });
    i = parsed.end;
    textStart = i;
  }
  flush(html.length);
  return pieces;
}

/** Inline tags with a LaTeX equivalent: the opening text; the closing text is always "}". */
export const INLINE_TAGS: Record<string, string> = {
  b: '\\textbf{',
  strong: '\\textbf{',
  i: '\\emph{',
  em: '\\emph{',
  cite: '\\emph{',
  dfn: '\\emph{',
  var: '\\emph{',
  u: '\\uline{',
  ins: '\\uline{',
  s: '\\sout{',
  del: '\\sout{',
  strike: '\\sout{',
  mark: '\\hl{',
  sup: '\\textsuperscript{',
  sub: '\\textsubscript{',
  code: '\\texttt{',
  kbd: '\\texttt{',
  samp: '\\texttt{',
  tt: '\\texttt{',
  small: '{\\small ',
  big: '{\\large ',
  abbr: '{',
  span: '{',
  q: '``{',
  font: '{',
};

/** Closers that differ from "}". */
export const INLINE_CLOSERS: Record<string, string> = { q: "}''" };

/** Tags dropped silently (their content is kept): layout wrappers with no LaTeX meaning. */
export const TRANSPARENT_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'figure', 'figcaption', 'picture', 'source', 'details', 'tbody', 'thead', 'wbr', 'a', 'center', 'summary', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'br', 'img']);

/** Tags whose content is dropped with them (scripts, styles, embedded media). */
export const DROP_CONTENT_TAGS = new Set(['script', 'style', 'iframe', 'video', 'audio', 'object', 'svg', 'math', 'canvas', 'template', 'noscript', 'select', 'textarea', 'button', 'form']);
