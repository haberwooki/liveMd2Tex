// The markdown-it parser for the converter's dialect (docs/DESIGN.md#converter): CommonMark with GFM tables, strikeout and
// autolinks, smart quotes, footnotes and definition lists (plugins), and our own rules for math, raw TeX,
// citations, attributes, fenced divs, line blocks, callouts, table captions and the Obsidian habits.

import MarkdownIt from 'markdown-it';
import deflist from 'markdown-it-deflist';
import footnote from 'markdown-it-footnote';
import { commentBlock, fencedDiv, latexBlock, lineBlock, mathBlock } from './rules/block';
import { callouts, headingAttributes, tableCaptions, tableMathPipes, wwwAutolinks } from './rules/core';
import {
  backticks,
  bracketedSpan,
  citationAuthorYear,
  citationBracketed,
  citationInText,
  markPostProcess,
  markTokenize,
  mathInline,
  obsidianComment,
  rawTexInline,
  subscript,
  superscript,
  trailingInlineAttributes,
  wikilink,
} from './rules/inline';

const ALL_CONTAINERS = ['paragraph', 'reference', 'blockquote', 'list'];

/** Adds the dialect's syntax rules to a markdown-it instance (also used, guarded, by the HTML view plugin). */
export function addDialectRules(md: MarkdownIt.MarkdownIt, options: { math: boolean; rawTex: boolean }): void {
  // Block rules.
  if (options.math) {
    md.block.ruler.before('fence', 'math_block', mathBlock, { alt: ALL_CONTAINERS });
  }
  if (options.rawTex) {
    md.block.ruler.before('html_block', 'latex_block', latexBlock, { alt: ['paragraph', 'reference', 'blockquote'] });
  }
  md.block.ruler.before('fence', 'fenced_div', fencedDiv, { alt: ALL_CONTAINERS });
  md.block.ruler.before('fence', 'comment_block', commentBlock, { alt: ALL_CONTAINERS });
  md.block.ruler.before('table', 'line_block', lineBlock, { alt: ['paragraph', 'reference'] });

  // Inline rules. Math and raw TeX must see a backslash before the escape rule does.
  if (options.math) {
    md.inline.ruler.before('escape', 'math_inline', mathInline);
  }
  if (options.rawTex) {
    md.inline.ruler.before('escape', 'raw_tex', rawTexInline);
  }
  md.inline.ruler.at('backticks', backticks);
  md.inline.ruler.after('text', 'pandoc_attributes', trailingInlineAttributes);
  md.inline.ruler.after('pandoc_attributes', 'citation_intext', citationInText);
  md.inline.ruler.after('citation_intext', 'obsidian_comment', obsidianComment);
  md.inline.ruler.before('link', 'wikilink', wikilink);
  md.inline.ruler.before('link', 'citation', citationBracketed);
  md.inline.ruler.before('link', 'bracketed_span', bracketedSpan);
  md.inline.ruler.before('emphasis', 'mark', markTokenize);
  md.inline.ruler2.before('emphasis', 'mark', markPostProcess);
  md.inline.ruler.before('strikethrough', 'subscript', subscript);
  md.inline.ruler.after('footnote_inline', 'superscript', superscript);

  // Core rules between block and inline parsing.
  md.core.ruler.before('inline', 'heading_attributes', headingAttributes);
  md.core.ruler.before('inline', 'callouts', callouts);
  md.core.ruler.before('inline', 'table_captions', tableCaptions);
  md.core.ruler.before('inline', 'table_math_pipes', tableMathPipes);
}

/** Parse-level choices a preset mode can make. */
export interface ParserOptions {
  /** $...$ and friends are math (or every $ is text). */
  math: boolean;
  /** pandoc's raw_tex rule (or every backslash is text). */
  rawTex: boolean;
  /** "[Surname 2020; Other 2019]" citations. */
  authorYear: boolean;
  singleQuotes: 'smart' | 'straight';
  doubleQuotes: 'tex' | 'straight';
  /** Bare addresses become links. */
  linkify: boolean;
}

export const DEFAULT_PARSER_OPTIONS: ParserOptions = { math: true, rawTex: true, authorYear: false, singleQuotes: 'smart', doubleQuotes: 'tex', linkify: true };

const parsers = new Map<string, MarkdownIt.MarkdownIt>();

/** The converter's parser for a set of options (instances are cached; markdown-it instances are reusable). */
export function converterParser(options: ParserOptions = DEFAULT_PARSER_OPTIONS): MarkdownIt.MarkdownIt {
  const key = JSON.stringify(options);
  let md = parsers.get(key);
  if (!md) {
    const smart = options.doubleQuotes === 'tex' || options.singleQuotes === 'smart';
    md = new MarkdownIt({ html: true, linkify: options.linkify, typographer: smart });
    md.disable(['replacements']); // keep smart quotes; leave (c), +-, ... and dashes to TeX
    if (smart) {
      // A straight kind stays straight: markdown-it's quotes option is [open double, close double, open single, close single].
      md.set({
        quotes: [
          options.doubleQuotes === 'tex' ? '“' : '"',
          options.doubleQuotes === 'tex' ? '”' : '"',
          options.singleQuotes === 'smart' ? '‘' : "'",
          options.singleQuotes === 'smart' ? '’' : "'",
        ],
      });
    }
    md.use(footnote);
    md.use(deflist);
    addDialectRules(md, { math: options.math, rawTex: options.rawTex });
    if (options.authorYear) {
      md.inline.ruler.before('citation', 'citation_author_year', citationAuthorYear);
    }
    if (options.linkify) {
      md.core.ruler.after('linkify', 'www_autolinks', wwwAutolinks);
    }
    parsers.set(key, md);
  }
  return md;
}
