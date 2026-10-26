// YAML front matter (pandoc's yaml_metadata_block at the top of the file): a line "---" on line 1, not followed
// by a blank line, closed by "---" or "...". The block's lines are blanked in the text handed to markdown-it, so
// every token keeps its real source line. Parsed with the `yaml` package (ISC); a YAML error becomes a
// diagnostic and the block is ignored, never a failed conversion.

import { isMap, isScalar, LineCounter, parseDocument } from 'yaml';

export interface FrontMatter {
  /** 1-based lines of the opening and closing delimiters. */
  startLine: number;
  endLine: number;
  data: Record<string, unknown>;
  /** 1-based source line of each top-level key. */
  keyLines: Record<string, number>;
  error?: string;
}

export interface SplitResult {
  frontMatter?: FrontMatter;
  /** The source with the front matter lines replaced by empty lines (same line count). */
  body: string;
}

export function splitFrontMatter(source: string): SplitResult {
  const lines = source.split('\n');
  if (lines.length < 2 || lines[0].replace(/\s+$/, '') !== '---' || lines[1].trim() === '') {
    return { body: source };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].replace(/\s+$/, '');
    if (t === '---' || t === '...') {
      end = i;
      break;
    }
  }
  if (end < 0) {
    return { body: source };
  }
  const yamlText = lines.slice(1, end).join('\n');
  const counter = new LineCounter();
  const doc = parseDocument(yamlText, { lineCounter: counter, prettyErrors: false, uniqueKeys: false });
  const keyLines: Record<string, number> = {};
  let data: Record<string, unknown> = {};
  let error: string | undefined;
  if (doc.errors.length > 0) {
    error = doc.errors[0].message.split('\n')[0];
  } else {
    const js: unknown = doc.toJS();
    if (js && typeof js === 'object' && !Array.isArray(js)) {
      data = js as Record<string, unknown>;
    } else if (js !== null && js !== undefined) {
      error = 'the front matter is not a set of "key: value" lines';
    }
    if (isMap(doc.contents)) {
      for (const pair of doc.contents.items) {
        if (isScalar(pair.key) && pair.key.range) {
          // LineCounter lines are 1-based within the YAML text, which starts on source line 2.
          keyLines[String(pair.key.value)] = counter.linePos(pair.key.range[0]).line + 1;
        }
      }
    }
  }
  const blanked = lines.map((line, i) => (i <= end ? '' : line));
  return {
    frontMatter: { startLine: 1, endLine: end + 1, data, keyLines, error },
    body: blanked.join('\n'),
  };
}
