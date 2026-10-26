// The HTML view plugin for VS Code's own Markdown preview (docs/DESIGN.md#converter), contributed
// through markdown.markdownItPlugins. It is inert by default: a gate rule asks
// isEnabled(env, text) once per parse, and every rule below does nothing unless the answer was yes, so the preview of
// a user who has not switched it on is byte-for-byte what VS Code renders without this extension. When on, it
// shows the dialect's own syntax (citations, callouts, ==highlights==, ^sup^, ~sub~, wikilinks, fenced divs,
// line blocks, %%comments%%, attributes, Table: captions) instead of leaving it as raw text. It adds no math
// rule and touches no math token, so VS Code's KaTeX (markdown.math.enabled) or another math plugin is left
// alone; it fetches nothing; every block it makes keeps its source map, so data-line and scroll sync work.

import type MarkdownIt from 'markdown-it';
import type { Attributes } from './attributes';
import { commentBlock, fencedDiv, lineBlock } from './rules/block';
import { callouts, headingAttributes, tableCaptions, tableMathPipes, type CalloutMeta, type TableCaption } from './rules/core';
import {
  bracketedSpan,
  citationBracketed,
  citationInText,
  markPostProcess,
  markTokenize,
  obsidianComment,
  subscript,
  superscript,
  trailingInlineAttributes,
  wikilink,
  type CitationMeta,
  type WikiMeta,
} from './rules/inline';

type Md = MarkdownIt.MarkdownIt;
type StateBlock = MarkdownIt.StateBlock;
type StateInline = MarkdownIt.StateInline;
type StateCore = MarkdownIt.StateCore;
type Token = MarkdownIt.Token;

export interface HtmlViewOptions {
  /**
   * Decides per parse whether the plugin acts. VS Code parses with env.currentDocument undefined (only rendering
   * gets the document) and caches the tokens, so the text being parsed is passed too, for the caller to find the
   * document by. Errors count as "no".
   */
  isEnabled(env: Record<string | symbol, unknown>, text: string): boolean;
}

const ENABLED = Symbol.for('livemd2tex.htmlView.enabled');
const on = (env: Record<string | symbol, unknown>) => env[ENABLED] === true;

const CALLOUT_COLOURS: Record<string, string> = {
  note: '#0969da',
  tip: '#1a7f37',
  important: '#8250df',
  warning: '#9a6700',
  caution: '#cf222e',
};
const CALLOUT_KIND: Record<string, string> = {
  info: 'note', todo: 'note', abstract: 'note', summary: 'note', tldr: 'note', quote: 'note', cite: 'note', example: 'note',
  hint: 'tip', success: 'tip', check: 'tip', done: 'tip', question: 'important', help: 'important', faq: 'important',
  attention: 'warning', failure: 'caution', fail: 'caution', missing: 'caution', danger: 'caution', error: 'caution', bug: 'caution',
};
const IMAGE = /\.(png|jpe?g|gif|svg|webp|bmp)$/i;

export function htmlViewPlugin(md: Md, options: HtmlViewOptions): Md {
  const escape = md.utils.escapeHtml;
  const gateBlock =
    (fn: (s: StateBlock, a: number, b: number, silent: boolean) => boolean) =>
    (s: StateBlock, a: number, b: number, silent: boolean) =>
      on(s.env) && fn(s, a, b, silent);
  const gateInline = (fn: (s: StateInline, silent: boolean) => boolean) => (s: StateInline, silent: boolean) => on(s.env) && fn(s, silent);
  const gateCore = (fn: (s: StateCore) => void) => (s: StateCore) => {
    if (on(s.env)) {
      fn(s);
    }
  };

  md.core.ruler.before('normalize', 'livemd2tex_gate', (state) => {
    let enabled: boolean;
    try {
      enabled = options.isEnabled(state.env, state.src) === true;
    } catch {
      enabled = false;
    }
    state.env[ENABLED] = enabled;
  });

  md.block.ruler.before('fence', 'livemd2tex_fenced_div', gateBlock(fencedDiv), { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.block.ruler.before('fence', 'livemd2tex_comment_block', gateBlock(commentBlock), { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.block.ruler.before('table', 'livemd2tex_line_block', gateBlock(lineBlock), { alt: ['paragraph', 'reference'] });

  md.inline.ruler.after('text', 'livemd2tex_attributes', gateInline(trailingInlineAttributes));
  md.inline.ruler.after('livemd2tex_attributes', 'livemd2tex_citation_intext', gateInline(citationInText));
  md.inline.ruler.after('livemd2tex_citation_intext', 'livemd2tex_comment', gateInline(obsidianComment));
  md.inline.ruler.before('link', 'livemd2tex_wikilink', gateInline(wikilink));
  md.inline.ruler.before('link', 'livemd2tex_citation', gateInline(citationBracketed));
  md.inline.ruler.before('link', 'livemd2tex_span', gateInline(bracketedSpan));
  md.inline.ruler.before('emphasis', 'livemd2tex_mark', gateInline(markTokenize));
  md.inline.ruler2.before('emphasis', 'livemd2tex_mark', (state) => {
    if (on(state.env)) {
      markPostProcess(state);
    }
  });
  md.inline.ruler.before('strikethrough', 'livemd2tex_sub', gateInline(subscript));
  md.inline.ruler.before('link', 'livemd2tex_sup', gateInline(superscript));

  md.core.ruler.before('inline', 'livemd2tex_heading_attributes', gateCore(headingAttributes));
  md.core.ruler.before('inline', 'livemd2tex_callouts', gateCore(callouts));
  md.core.ruler.before('inline', 'livemd2tex_table_captions', gateCore(tableCaptions));
  md.core.ruler.before('inline', 'livemd2tex_table_math_pipes', gateCore(tableMathPipes));
  md.core.ruler.push('livemd2tex_html_shapes', gateCore(toHtmlShapes));

  // Renderers for our token types. The tokens exist only when the plugin is on.
  const rules = md.renderer.rules;
  rules.citation = (tokens, idx) => {
    const meta = tokens[idx].meta as unknown as CitationMeta;
    return `<span class="livemd2tex-citation" title="${escape(meta.items.map((i) => i.key).join(', '))}">${escape(meta.source)}</span>`;
  };
  rules.wikilink = (tokens, idx) => {
    const w = tokens[idx].meta as unknown as WikiMeta;
    const shown = w.alias ?? (w.target && w.anchor ? `${w.target} > ${w.anchor}` : w.target || w.anchor || '');
    return `<span class="livemd2tex-wikilink">${escape(shown)}</span>`;
  };
  rules.wikiembed = (tokens, idx) => `<span class="livemd2tex-wikilink">${escape((tokens[idx].meta as unknown as WikiMeta).target)}</span>`;
  rules.comment = () => '';
  rules.comment_block = () => '';
  rules.mark_open = () => '<mark>';
  rules.mark_close = () => '</mark>';
  rules.sup = (tokens, idx) => `<sup>${escape(tokens[idx].content)}</sup>`;
  rules.sub = (tokens, idx) => `<sub>${escape(tokens[idx].content)}</sub>`;
  rules.span_open = (tokens, idx) => {
    const attrs = (tokens[idx].meta as { attrs?: Attributes } | null)?.attrs;
    const classes = attrs?.classes.map(escape).join(' ') ?? '';
    return `<span${attrs?.id ? ` id="${escape(attrs.id)}"` : ''}${classes ? ` class="${classes}"` : ''}>`;
  };
  rules.span_close = () => '</span>';
  rules.div_open = (tokens, idx, _options, _env, self) => {
    const t = tokens[idx];
    const attrs = (t.meta as { attrs?: Attributes } | null)?.attrs;
    if (attrs?.id) {
      t.attrSet('id', attrs.id);
    }
    t.attrJoin('class', ['livemd2tex-div', ...(attrs?.classes ?? [])].join(' '));
    return `<div${self.renderAttrs(t)}>\n`;
  };
  rules.div_close = () => '</div>\n';
  rules.raw_inline = (tokens, idx) => (tokens[idx].info === 'html' ? tokens[idx].content : '');

  const defaultFence = rules.fence;
  rules.fence = (tokens, idx, opts, env, self) => {
    const raw = /^\{?=([A-Za-z]+)\}?$/.exec(tokens[idx].info.trim());
    if (on(env as Record<string | symbol, unknown>) && raw) {
      return raw[1].toLowerCase() === 'html' ? tokens[idx].content : '';
    }
    return defaultFence ? defaultFence(tokens, idx, opts, env, self) : self.renderToken(tokens, idx, opts);
  };

  const defaultQuote = rules.blockquote_open;
  rules.blockquote_open = (tokens, idx, opts, env, self) => {
    const callout = (tokens[idx].meta as { callout?: CalloutMeta } | null)?.callout;
    if (!callout) {
      return defaultQuote ? defaultQuote(tokens, idx, opts, env, self) : self.renderToken(tokens, idx, opts);
    }
    const kind = CALLOUT_COLOURS[callout.type] ? callout.type : (CALLOUT_KIND[callout.type] ?? 'note');
    const t = tokens[idx];
    t.attrJoin('class', `livemd2tex-callout livemd2tex-callout-${kind}`);
    t.attrSet('style', `border-left: 0.25em solid ${CALLOUT_COLOURS[kind]}; padding: 0 1em;`);
    const title = callout.title ? md.renderInline(callout.title, env as MarkdownIt.Env) : escape(callout.type.charAt(0).toUpperCase() + callout.type.slice(1));
    return `<blockquote${self.renderAttrs(t)}>\n<p class="livemd2tex-callout-title" style="color: ${CALLOUT_COLOURS[kind]}; font-weight: 600;">${title}</p>\n`;
  };

  const defaultTable = rules.table_open;
  rules.table_open = (tokens, idx, opts, env, self) => {
    const caption = (tokens[idx].meta as { caption?: TableCaption } | null)?.caption;
    const open = defaultTable ? defaultTable(tokens, idx, opts, env, self) : self.renderToken(tokens, idx, opts);
    return caption ? `${open}<caption>${md.renderInline(caption.text, env as MarkdownIt.Env)}</caption>\n` : open;
  };
  return md;
}

/** After inline parsing: line blocks become paragraphs with line breaks; image embeds and attributes become plain HTML image settings. */
function toHtmlShapes(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'line_block_open') {
      t.type = 'paragraph_open';
      t.tag = 'p';
      t.attrJoin('class', 'livemd2tex-line-block');
      let j = i + 1;
      const inlines: Token[] = [];
      while (j < tokens.length && tokens[j].type !== 'line_block_close') {
        inlines.push(tokens[j]);
        j++;
      }
      const merged = new state.Token('inline', '', 0);
      merged.map = t.map;
      merged.children = [];
      inlines.forEach((inline, k) => {
        merged.children?.push(...(inline.children ?? []));
        if (k < inlines.length - 1) {
          merged.children?.push(new state.Token('hardbreak', 'br', 0));
        }
      });
      tokens.splice(i + 1, inlines.length, merged);
      const close = tokens[i + 2];
      close.type = 'paragraph_close';
      close.tag = 'p';
      continue;
    }
    if (t.type === 'heading_open') {
      const id = (t.meta as { attrs?: Attributes } | null)?.attrs?.id;
      if (id) {
        t.attrSet('id', id);
      }
      continue;
    }
    if (t.type !== 'inline' || !t.children) {
      continue;
    }
    for (let k = 0; k < t.children.length; k++) {
      const c = t.children[k];
      const attrs = (c.meta as { attrs?: Attributes } | null)?.attrs;
      if (c.type === 'image' && attrs) {
        if (attrs.id) {
          c.attrSet('id', attrs.id);
        }
        const width = attrs.values.width;
        if (width) {
          c.attrSet('style', `width: ${/^\d+$/.test(width) ? `${width}px` : width};`);
        }
      }
      if (c.type === 'wikiembed') {
        const w = c.meta as unknown as WikiMeta;
        if (IMAGE.test(w.target)) {
          const img = new state.Token('image', 'img', 0);
          img.attrs = [
            ['src', state.md.normalizeLink(w.target)],
            ['alt', ''],
          ];
          const size = /^(\d+)/.exec(w.alias ?? '');
          if (size) {
            img.attrSet('width', size[1]);
          }
          img.children = [];
          img.content = '';
          t.children[k] = img;
        }
      }
    }
  }
}
