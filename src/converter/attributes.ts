// pandoc attribute blocks: {#id .class key=value key2="quoted value"}, {-} for .unnumbered, and the raw
// format form {=latex}. Used after headings, images, links, code spans, bracketed spans, display math, fenced
// code, fenced divs and table captions (pandoc's header_attributes, link_attributes, inline_code_attributes,
// bracketed_spans, fenced_divs, raw_attribute). Pure functions, no I/O.

export interface Attributes {
  id?: string;
  classes: string[];
  values: Record<string, string>;
  /** The raw format of {=latex}, {=tex} or {=html}; set only for that form. */
  rawFormat?: string;
}

export function emptyAttributes(): Attributes {
  return { classes: [], values: {} };
}

const NAME = /^[A-Za-z_:][\w:.-]*$/;
const ID = /^[^\s{}#.="']+$/;

/**
 * Parses the inside of one attribute block (without the braces). Returns undefined when the text is not a valid
 * pandoc attribute list, so the caller can keep it as text.
 */
export function parseAttributeList(inner: string): Attributes | undefined {
  const text = inner.trim();
  if (text === '') {
    return undefined;
  }
  const raw = /^=([A-Za-z][\w-]*)$/.exec(text);
  if (raw) {
    return { classes: [], values: {}, rawFormat: raw[1].toLowerCase() };
  }
  const attrs = emptyAttributes();
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) {
      i++;
    }
    if (i >= text.length) {
      break;
    }
    const ch = text[i];
    if (ch === '#' || ch === '.') {
      let j = i + 1;
      while (j < text.length && !/[\s{}]/.test(text[j])) {
        j++;
      }
      const word = text.slice(i + 1, j);
      if (!ID.test(word)) {
        return undefined;
      }
      if (ch === '#') {
        attrs.id = word;
      } else {
        attrs.classes.push(word);
      }
      i = j;
      continue;
    }
    if (ch === '-' && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      attrs.classes.push('unnumbered');
      i++;
      continue;
    }
    // key=value, key="value", key='value'
    let j = i;
    while (j < text.length && !/[\s=]/.test(text[j])) {
      j++;
    }
    const key = text.slice(i, j);
    if (!NAME.test(key) || text[j] !== '=') {
      return undefined;
    }
    j++;
    let value: string;
    const quote = text[j];
    if (quote === '"' || quote === "'") {
      const end = text.indexOf(quote, j + 1);
      if (end < 0) {
        return undefined;
      }
      value = text.slice(j + 1, end);
      j = end + 1;
    } else {
      const start = j;
      while (j < text.length && !/\s/.test(text[j])) {
        j++;
      }
      value = text.slice(start, j);
      if (value === '') {
        return undefined;
      }
    }
    attrs.values[key] = value;
    i = j;
  }
  return attrs;
}

/**
 * Reads an attribute block that starts at src[pos] === '{'. Quoted values may contain '}'. Returns the attributes
 * and the index just after the closing brace, or undefined.
 */
export function scanAttributeBlock(src: string, pos: number, max = src.length): { attrs: Attributes; end: number } | undefined {
  if (src[pos] !== '{') {
    return undefined;
  }
  let quote = '';
  for (let i = pos + 1; i < max; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      // A quote only opens inside a key="value" pair.
      if (src[i - 1] === '=') {
        quote = ch;
      }
      continue;
    }
    if (ch === '{') {
      return undefined;
    }
    if (ch === '}') {
      const attrs = parseAttributeList(src.slice(pos + 1, i));
      return attrs ? { attrs, end: i + 1 } : undefined;
    }
  }
  return undefined;
}

/**
 * Splits trailing attributes off a line of text, as pandoc does for headings and captions: "Title {#sec:a}".
 * Whitespace before the brace is optional (Manubot writes "Heading{.center}").
 */
export function splitTrailingAttributes(text: string): { text: string; attrs?: Attributes } {
  const trimmed = text.replace(/\s+$/, '');
  if (!trimmed.endsWith('}')) {
    return { text };
  }
  // Try each '{' from the right whose block runs to the end of the text.
  for (let open = trimmed.lastIndexOf('{'); open >= 0; open = trimmed.lastIndexOf('{', open - 1)) {
    if (open > 0 && trimmed[open - 1] === '\\') {
      continue;
    }
    const scanned = scanAttributeBlock(trimmed, open);
    if (scanned && scanned.end === trimmed.length) {
      // Raw TeX such as \SI{3}{\metre} must not lose its last argument: the brace has to follow a space or
      // start the text, or follow a closing bracket or backtick that cannot belong to a TeX command.
      const before = trimmed.slice(0, open);
      if (/\\[A-Za-z@]+\*?(\[[^\]]*\]|\{[^{}]*\})*$/.test(before)) {
        return { text };
      }
      return { text: before.replace(/\s+$/, ''), attrs: scanned.attrs };
    }
  }
  return { text };
}

/** Converts a pandoc width or height value ("80%", "5cm", "300px", "3in") to a LaTeX length. */
export function latexLength(value: string | undefined, axis: 'width' | 'height'): string | undefined {
  if (!value) {
    return undefined;
  }
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(%|cm|mm|in|pt|px|em|ex|bp|pc)?\s*$/.exec(value);
  if (!m) {
    return undefined;
  }
  const num = m[1];
  const unit = m[2] ?? 'px';
  if (unit === '%') {
    const fraction = Number(num) / 100;
    const base = axis === 'width' ? '\\linewidth' : '\\textheight';
    return `${Number(fraction.toFixed(4))}${base}`;
  }
  return `${num}${unit}`;
}
