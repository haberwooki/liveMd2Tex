// The HTML view plugin for VS Code's Markdown preview: inert by default, and when on, it
// shows the dialect's syntax, keeps source maps for data-line, and leaves math alone.

import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import MarkdownIt from 'markdown-it';
import { htmlViewPlugin } from '../../src/converter/htmlView';
import { testDir } from './support';

/** A markdown-it like VS Code's (html, linkify, typographer) with a stand-in math rule, as KaTeX would add. */
function vscodeLikeMd(): MarkdownIt.MarkdownIt {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: true });
  md.inline.ruler.before('escape', 'stand_in_math', (state, silent) => {
    if (state.src[state.pos] !== '$') {
      return false;
    }
    const end = state.src.indexOf('$', state.pos + 1);
    if (end < 0) {
      return false;
    }
    if (!silent) {
      state.push('math_inline_vscode', 'math', 0).content = state.src.slice(state.pos + 1, end);
    }
    state.pos = end + 1;
    return true;
  });
  md.renderer.rules.math_inline_vscode = (tokens, idx) => `<eq>${tokens[idx].content}</eq>`;
  return md;
}

const corpusDir = path.join(testDir, 'corpus');
const corpus = readdirSync(corpusDir).filter((f) => f.endsWith('.md'));

describe('HTML view plugin (markdown.markdownItPlugins)', () => {
  it('is inert when not switched on: every corpus document renders byte for byte as without it', () => {
    for (const file of corpus) {
      const text = readFileSync(path.join(corpusDir, file), 'utf8');
      const plain = vscodeLikeMd().render(text, {});
      const withPlugin = htmlViewPlugin(vscodeLikeMd(), { isEnabled: () => false }).render(text, {});
      assert.equal(withPlugin, plain, file);
    }
  });

  it('treats an error in the gate as "off"', () => {
    const md = htmlViewPlugin(vscodeLikeMd(), {
      isEnabled: () => {
        throw new Error('no config');
      },
    });
    assert.equal(md.render('==x== [@k]', {}), vscodeLikeMd().render('==x== [@k]', {}));
  });

  it('asks the gate once per parse with the env and the exact text, as VS Code parses (currentDocument undefined)', () => {
    const seen: unknown[] = [];
    const md = htmlViewPlugin(vscodeLikeMd(), {
      isEnabled: (env, text) => {
        seen.push([env.currentDocument, text]);
        return false;
      },
    });
    md.parse('a\r\nb', { currentDocument: undefined, containingImages: new Set() });
    assert.deepEqual(seen, [[undefined, 'a\r\nb']]);
  });

  describe('when switched on', () => {
    const md = htmlViewPlugin(vscodeLikeMd(), { isEnabled: () => true });
    const render = (text: string) => md.render(text, {});

    it('shows citations, highlights, sub- and superscripts, wikilinks and hides %%comments%%', () => {
      const html = render('See [@doe99, p. 3] and @smith. ==Key== H~2~O x^2^ [[Note|alias]] %%hidden%%');
      assert.match(html, /<span class="livemd2tex-citation" title="doe99">\[@doe99, p\. 3\]<\/span>/);
      assert.match(html, /<span class="livemd2tex-citation" title="smith">@smith<\/span>/);
      assert.match(html, /<mark>Key<\/mark>/);
      assert.match(html, /H<sub>2<\/sub>O x<sup>2<\/sup>/);
      assert.match(html, /<span class="livemd2tex-wikilink">alias<\/span>/);
      assert.doesNotMatch(html, /hidden/);
    });

    it('renders callouts with their title and keeps the source map for data-line', () => {
      const tokens = md.parse('Intro\n\n> [!WARNING] Mind *this*\n> Body', {});
      const quote = tokens.find((t) => t.type === 'blockquote_open');
      assert.deepEqual(quote?.map, [2, 4]);
      const html = render('Intro\n\n> [!WARNING] Mind *this*\n> Body');
      assert.match(html, /<blockquote class="livemd2tex-callout livemd2tex-callout-warning" style="[^"]+">\n<p class="livemd2tex-callout-title"[^>]*>Mind <em>this<\/em><\/p>/);
      assert.match(html, /<p>Body<\/p>/);
    });

    it('turns fenced divs into divs (with their map), line blocks into lines, and Table: into a caption', () => {
      const tokens = md.parse('::: {.note #n}\nInside.\n:::\n', {});
      assert.deepEqual(tokens[0].map, [0, 3]);
      assert.match(render('::: {.note #n}\nInside.\n:::'), /<div id="n" class="livemd2tex-div note">\n<p>Inside\.<\/p>\n<\/div>/);
      assert.match(render('| one\n| two'), /<p class="livemd2tex-line-block">one<br>\ntwo<\/p>/);
      assert.match(render('| a |\n|---|\n| 1 |\n\nTable: Cap.'), /<table>\n?<caption>Cap\.<\/caption>/);
    });

    it('consumes attributes so {#fig:id width=50%} does not show as text', () => {
      const html = render('![A](a.png){#fig:a width=50%}\n\n# Head {#sec:h}');
      assert.doesNotMatch(html, /\{#fig/);
      assert.match(html, /<img src="a.png" alt="A" id="fig:a" style="width: 50%;">/);
      assert.match(html, /<h1 id="sec:h">Head<\/h1>/);
    });

    it('hides {=latex} blocks and keeps {=html} ones', () => {
      assert.equal(render('```{=latex}\n\\newpage\n```'), '');
      assert.equal(render('```{=html}\n<b>x</b>\n```'), '<b>x</b>\n');
    });

    it('keeps \\| inside math in table cells, so KaTeX shows a norm', () => {
      assert.match(render('| n |\n|---|\n| $\\|A\\|$ |'), /<td><eq>\\\|A\\\|<\/eq><\/td>/);
      assert.match(vscodeLikeMd().render('| n |\n|---|\n| $\\|A\\|$ |', {}), /<td><eq>\|A\|<\/eq><\/td>/);
    });

    it('leaves math to the preview\'s own math plugin', () => {
      assert.match(render('$a_{1} ==b== $ and ==c=='), /<eq>a_\{1\} ==b== <\/eq> and <mark>c<\/mark>/);
    });
  });
});
