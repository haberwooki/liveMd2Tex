// One test or more per rule of the dialect (docs/DESIGN.md#converter), each taken from pandoc's documented
// behaviour (pandoc MANUAL, "Pandoc's Markdown") or from the GitHub and Obsidian syntax the plan lists.

import * as assert from 'node:assert/strict';
import { convertMarkdown, latexToMarkdownLine, markdownToLatexLine } from '../../src/converter/markdownToLatex';
import { parseAttributeList, splitTrailingAttributes } from '../../src/converter/attributes';
import { escapeText } from '../../src/converter/escape';
import { parseCitationGroup } from '../../src/converter/rules/inline';
import { lineMapProblems } from './support';

/** The converted body (between the preamble and \end{document}), trailing blank lines removed. */
function body(md: string, options = {}): string {
  const r = convertMarkdown(md, options);
  const lines = r.latex.split('\n').slice(r.bodyStartLine - 1);
  return lines.slice(0, lines.lastIndexOf('\\end{document}')).join('\n').trim();
}

function unsupported(md: string): string[] {
  return convertMarkdown(md)
    .diagnostics.filter((d) => d.kind === 'unsupported')
    .map((d) => d.code);
}

describe('dialect: CommonMark and GFM basics', () => {
  it('maps headings to sections with pandoc identifiers, explicit ones winning', () => {
    assert.equal(body('# Intro\n\n## Two words {#sec:two}\n\n### Unnumbered {-}'), [
      '\\section{Intro}\\label{intro}',
      '',
      '\\subsection{Two words}\\label{sec:two}',
      '',
      '\\subsubsection*{Unnumbered}\\label{unnumbered}',
    ].join('\n'));
  });

  it('makes duplicate identifiers unique and drops leading digits and punctuation (auto_identifiers)', () => {
    const b = body('# 1. Results\n\n# Results\n\n# Results!');
    assert.match(b, /\\label\{results\}/);
    assert.match(b, /\\label\{results-1\}/);
    assert.match(b, /\\label\{results-2\}/);
  });

  it('keeps one LaTeX line per paragraph line and a blank line between paragraphs', () => {
    const md = 'First line\nsecond line\n\nNew paragraph.';
    const r = convertMarkdown(md);
    const b = body(md);
    assert.equal(b, 'First line\nsecond line\n\nNew paragraph.');
    const first = r.latex.split('\n').indexOf('First line') + 1;
    assert.equal(latexToMarkdownLine(r, first), 1);
    assert.equal(latexToMarkdownLine(r, first + 1), 2);
    assert.equal(latexToMarkdownLine(r, first + 3), 4);
    assert.equal(markdownToLatexLine(r, 4), first + 3);
  });

  it('converts emphasis, strong, strikeout, code and hard breaks', () => {
    assert.equal(body('*a* **b** ~~c~~ `d_e` f  \ng\\\nh'), '\\emph{a} \\textbf{b} \\sout{c} \\texttt{d\\_e} f\\\\\ng\\\\\nh');
  });

  it('renders task lists as lists with box marks, and ordered lists with their start', () => {
    assert.equal(body('- [ ] open\n- [x] done'), '\\begin{itemize}\n  \\item[$\\square$] open\n  \\item[$\\boxtimes$] done\n\\end{itemize}');
    assert.match(body('3. c\n4. d'), /\\begin\{enumerate\}\\setcounter\{enumi\}\{2\}/);
  });

  it('turns smart quotes and dashes into TeX, and escapes specials', () => {
    assert.equal(body('"Quoted" and \'single\' -- dash'), "``Quoted'' and `single' -- dash");
    assert.equal(escapeText('a_b{c}#$%&~^\\<>|[]'), 'a\\_b\\{c\\}\\#\\$\\%\\&\\textasciitilde{}\\^{}\\textbackslash{}\\textless{}\\textgreater{}\\textbar{}{[}{]}');
  });

  it('maps Unicode symbols pdfTeX cannot print, and stays on pdfLaTeX when the table covers them all', () => {
    const r = convertMarkdown('α → β ≤ ✓, m⁻¹, H₂O and Dvořák');
    assert.match(r.latex, /\\\(\\alpha\\\) \\textrightarrow\{\} \\\(\\beta\\\) \\\(\\leq\\\) \\checkmark\{\}, m\\textsuperscript\{-1\}, H\\textsubscript\{2\}O and Dvořák/);
    assert.deepEqual(r.unprintable, []);
    assert.equal(r.engine, 'pdflatex');
    assert.deepEqual(r.fontFiles, []);
  });

  it('takes XeTeX for characters pdfLaTeX cannot print: Latin Modern for accented names, DejaVu for the rest', () => {
    // ė is a letter T1 composes (two parts in the PDF's text): XeTeX, in the same Latin Modern fonts.
    const names = convertMarkdown('Thanks to Jonas Kazlauskas and Dovilė Žemaitė.');
    assert.equal(names.engine, 'xelatex');
    assert.equal(names.fontSet, 'latin-modern');
    assert.deepEqual(names.fontFiles, []);
    assert.match(names.latex, /\\usepackage\{fontspec\}\n\\usepackage\{unicode-math\}\n\\setmathfont\{latinmodern-math\.otf\}/);
    assert.doesNotMatch(names.latex, /fontenc|lmodern|amssymb|setmainfont/);
    assert.match(names.latex, /Dovilė Žemaitė/);
    const notice = names.diagnostics.find((d) => d.code === 'engine');
    assert.ok(notice && /ė/.test(notice.message) && /Latin Modern/.test(notice.message));

    // Box drawing, Greek in math, script letters, an emoji: the DejaVu notes template with the fallback rule.
    const notes = convertMarkdown('Done ✓ 😀 and $α → 𝒩$.\n\n```\n┌─┐ 𝒯\n```\n');
    assert.equal(notes.engine, 'xelatex');
    assert.equal(notes.fontSet, 'dejavu');
    assert.ok(notes.fontFiles.includes('DejaVuSerif.ttf') && notes.fontFiles.length === 12);
    assert.match(notes.latex, /\\setmainfont\{DejaVuSerif\}/);
    assert.match(notes.latex, /\\XeTeXcharclass"2713=/);
    assert.match(notes.latex, /\\XeTeXcharclass"1F600=/);
    assert.match(notes.latex, /\\XeTeXcharclass"1D4AF=/); // in code: from DejaVu Math TeX Gyre
    assert.match(notes.latex, /\\XeTeXcharclass"2500=/); // the code font has it upright only
    assert.match(notes.latex, /Done ✓ 😀 and \$α → 𝒩\$\./);
  });

  it('writes a character no shipped font has as [U+XXXX], with a notice on its line, on either engine', () => {
    const r = convertMarkdown('Launch 🚀 today.\n\n```\ncode 🚀\n```\n\nAgain 🚀 and $🚀$.');
    assert.equal(r.engine, 'pdflatex');
    assert.match(r.latex, /Launch \\mdmissingchar\{1F680\} today\./);
    assert.match(r.latex, /code \[U\+1F680\]/);
    assert.match(r.latex, /\$\\mbox\{\[U\+1F680\]\}\$/);
    assert.match(r.latex, /\\newcommand\*\\mdmissingchar\[1\]/);
    const d = r.diagnostics.find((x) => x.code === 'missing-font:1F680');
    assert.deepEqual(d?.lines, [1, 4, 7]);
    // Variation selectors print nothing and need no font.
    assert.match(convertMarkdown('Warning ⚠️ sign').latex, /Warning ⚠ sign/);
  });

  it('front matter and folder config choose the engine and the template', () => {
    assert.equal(convertMarkdown('---\nengine: xelatex\n---\nplain').fontSet, 'latin-modern');
    assert.equal(convertMarkdown('---\ntemplate: notes\n---\nplain').fontSet, 'dejavu');
    const forced = convertMarkdown('---\nengine: pdflatex\n---\nDovilė');
    assert.equal(forced.engine, 'pdflatex');
    assert.ok(forced.diagnostics.some((x) => x.code === 'unicode'));
    assert.equal(convertMarkdown('plain', { defaults: { template: 'notes' } }).engine, 'xelatex');
  });

  it('links: inline, reference, autolink, internal and www.', () => {
    const b = body('[a](https://x.org/p?q=1#f) [b][r] <https://y.org> [c](#intro) www.z.org\n\n[r]: https://r.org');
    assert.equal(b, '\\href{https://x.org/p?q=1\\#f}{a} \\href{https://r.org}{b} \\url{https://y.org} \\hyperref[intro]{c} \\href{http://www.z.org}{\\nolinkurl{www.z.org}}');
  });

  it('pipe tables with alignment, booktabs, and long text columns as tabularx', () => {
    assert.equal(
      body('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |'),
      ['\\begin{center}', '  \\begin{tabular}{@{}lcr@{}}', '  \\toprule', '  a & b & c \\\\', '  \\midrule', '  1 & 2 & 3 \\\\', '  \\bottomrule', '  \\end{tabular}', '\\end{center}'].join('\n'),
    );
    const long = 'x'.repeat(60);
    const r = convertMarkdown(`| k | text |\n|---|---|\n| 1 | ${long} ${long} |`);
    assert.match(r.latex, /\\begin\{tabularx\}\{\\linewidth\}\{@\{\}lL@\{\}\}/);
    assert.match(r.latex, /\\usepackage\{tabularx\}/);
  });

  it('keeps \\| inside math in a table cell (a norm), and unescapes it elsewhere as GFM does', () => {
    const b = body('| x | y |\n|---|---|\n| $\\|A\\|_2$ | a \\| b `c\\|d` |\n| $5 | $6 \\| x |');
    assert.match(b, /\$\\\|A\\\|_2\$ & a \\textbar\{\} b \\texttt\{c\\textbar\{\}d\} \\\\/);
    // Currency dollars pair up wrongly in the math-aware split; the cell count differs, so GFM's split stands.
    assert.match(b, /\\\$5 & \\\$6 \\textbar\{\} x \\\\/);
  });

  it('fenced and indented code as verbatim, line for line', () => {
    const md = 'Text\n\n```js\nlet a = "{x}";\n\tindented\n```\n\n    four spaces';
    const r = convertMarkdown(md);
    assert.equal(body(md), 'Text\n\n\\begin{verbatim}\nlet a = "{x}";\n    indented\n\\end{verbatim}\n\n\\begin{verbatim}\nfour spaces\n\\end{verbatim}');
    const lines = r.latex.split('\n');
    const at = lines.indexOf('let a = "{x}";');
    assert.deepEqual(r.lineMap.slice(at - 1, at + 3), [3, 4, 5, 6]);
  });

  it('block quotes, horizontal rules and definition lists', () => {
    assert.equal(body('> quoted\n> text'), '\\begin{quote}\n  quoted\n  text\n\\end{quote}');
    assert.match(body('a\n\n---\n\nb'), /\\rule\{0\.5\\linewidth\}\{0\.5pt\}/);
    assert.equal(body('Term\n: Definition'), '\\begin{description}\n  \\item[{Term}]\n  Definition\n\\end{description}');
  });

  it('footnotes, labelled and inline, become \\footnote at the reference', () => {
    // A note defined on another line gets a LaTeX line of its own, mapped to the definition (click-to-source);
    // "%" keeps the typeset text the same. An inline note stays where it is.
    assert.equal(
      body('A[^n] and B^[inline *note*].\n\n[^n]: The note.\n\n    Second paragraph.'),
      'A\\footnote{%\nThe note. \\par Second paragraph.} %\nand B\\footnote{inline \\emph{note}}.',
    );
    const r = convertMarkdown('Text[^n].\n\n[^n]: The note.');
    const lines = r.latex.split('\n');
    assert.equal(r.lineMap[lines.indexOf('The note.}%')], 3);
    assert.equal(r.lineMap[lines.indexOf('Text\\footnote{%')], 1);
  });
});

describe('dialect: math', () => {
  it('inline $...$ follows pandoc: no space inside the delimiters, no digit after the closer', () => {
    assert.equal(body('$a+b$ and $20,000 and $30,000 and $ x$'), '$a+b$ and \\$20,000 and \\$30,000 and \\$ x\\$');
  });

  it('\\(...\\), \\[...\\], $$...$$ and ```math pass through untouched', () => {
    assert.equal(body('\\(x_1\\) and \\[y^2\\]'), '\\(x_1\\) and \\[y^2\\]');
    assert.equal(body('$$\na_{1} = b\n$$'), '\\[\na_{1} = b\n\\]');
    assert.equal(body('```math\nE = mc^2\n```'), '\\[\nE = mc^2\n\\]');
  });

  it('labels display math with {#eq:id} and numbers it', () => {
    assert.equal(body('$$ x = 1 $$ {#eq:one}'), '\\begin{equation} x = 1 \\label{eq:one}\\end{equation}');
    assert.equal(body('$$\nx\n$$ {#eq:two}'), '\\begin{equation}\nx\n\\label{eq:two}\\end{equation}');
  });

  it('keeps math that holds lines markdown-it would read as lists or headings', () => {
    assert.equal(body('$$\n- a\n# b\n$$'), '\\[\n- a\n# b\n\\]');
  });

  it('does not wrap an environment in \\[ \\], and wraps a bare \\\\ in gathered or aligned', () => {
    assert.equal(body('$$\\begin{align}a&=b\\end{align}$$'), '\\begin{align}a&=b\\end{align}');
    assert.equal(body('$$a \\\\ b$$'), '\\[\\begin{gathered}a \\\\ b\\end{gathered}\\]');
    assert.equal(body('$$a &= b \\\\ c &= d$$'), '\\[\\begin{aligned}a &= b \\\\ c &= d\\end{aligned}\\]');
  });

  it('keeps display math inside its paragraph when no blank line separates them', () => {
    assert.equal(body('Text\n$$\nx\n$$\nmore'), 'Text\n\\[\nx\n\\]\nmore');
  });

  it("supports GitHub's $`...`$ inline form", () => {
    assert.equal(body('Value $`\\sqrt{2}`$.'), 'Value $\\sqrt{2}$.');
  });
});

describe('dialect: citations and cross-references', () => {
  it('parses pandoc citation groups', () => {
    assert.deepEqual(parseCitationGroup('see @doe99, pp. 33-35; also @smith04, chap. 1'), [
      { key: 'doe99', prefix: 'see', suffix: 'pp. 33-35', suppressAuthor: false },
      { key: 'smith04', prefix: 'also', suffix: 'chap. 1', suppressAuthor: false },
    ]);
    assert.deepEqual(parseCitationGroup('-@doe99')?.[0].suppressAuthor, true);
    assert.equal(parseCitationGroup('mail me at a@b.org'), undefined);
    assert.deepEqual(parseCitationGroup('@{https://x.org/a}')?.[0].key, 'https://x.org/a');
  });

  it('writes natbib commands by default', () => {
    assert.equal(
      body('[@a] [@a; @b] [@a, p. 3] [see @a] [see @a, p. 3] [-@a] @a @a [p. 4] [see @a; @b, ch. 2]'),
      '\\citep{a} \\citep{a,b} \\citep[p.~3]{a} \\citep[see][]{a} \\citep[see][p.~3]{a} \\citeyearpar{a} \\citet{a} \\citet[p.~4]{a} \\citetext{see \\citealp{a}; \\citealp[ch. 2]{b}}',
    );
  });

  it('writes biblatex commands when the front matter asks', () => {
    const md = '---\nbiblatex: true\nbibliography: refs.bib\n---\n[@a] [@a; @b] [@a, p. 3] [-@a] @a [see @a; @b, p. 2]';
    const r = convertMarkdown(md);
    assert.match(r.latex, /\\autocite\{a\} \\autocite\{a,b\} \\autocite\[p\.~3\]\{a\} \\autocite\*\{a\} \\textcite\{a\} \\autocites\[see\]\[\]\{a\}\[p\.~2\]\{b\}/);
    assert.match(r.latex, /\\usepackage\[backend=bibtex8\]\{biblatex\}\n[\s\S]*\\addbibresource\{refs\.bib\}/);
    assert.match(r.latex, /\\printbibliography/);
  });

  it('does not take e-mail addresses or links for citations', () => {
    assert.equal(body('me@example.org [text @a](https://x.org)'), '\\href{mailto:me@example.org}{\\nolinkurl{me@example.org}} \\href{https://x.org}{text \\citet{a}}');
  });

  it('turns fig:, tbl:, eq: and sec: keys into references (pandoc-crossref), with \\cref on request', () => {
    assert.equal(body('[@fig:a] [@Fig:a] [-@tbl:b] [@eq:c; @eq:d] @sec:e'), 'fig.~\\ref{fig:a} Fig.~\\ref{fig:a} \\ref{tbl:b} eqns.~\\ref{eq:c}, \\ref{eq:d} sec.~\\ref{sec:e}');
    const r = convertMarkdown('---\ncref: true\n---\n[@fig:a] [@Fig:a; @fig:b]');
    assert.match(r.latex, /\\cref\{fig:a\} \\Cref\{fig:a,fig:b\}/);
    assert.match(r.latex, /\\usepackage\{cleveref\}/);
    assert.deepEqual(r.citationKeys, []);
  });

  it('places the bibliography at {#refs} or at the end, and warns when there is no file', () => {
    const r = convertMarkdown('---\nbibliography: [a.bib, b.bib]\n---\n# R\n\n::: {#refs}\n:::\n\n# After');
    assert.match(r.latex, /\\bibliographystyle\{plainnat\} \\bibliography\{a,b\}\n\n\\section\{After\}/);
    const none = convertMarkdown('Cited [@k].');
    assert.ok(none.diagnostics.some((d) => d.code === 'no-bibliography'));
  });
});

describe('dialect: attributes, figures, tables, divs', () => {
  it('parses pandoc attribute lists', () => {
    assert.deepEqual(parseAttributeList('#fig:a .wide width=80% title="A b"'), { id: 'fig:a', classes: ['wide'], values: { width: '80%', title: 'A b' } });
    assert.deepEqual(parseAttributeList('=latex'), { classes: [], values: {}, rawFormat: 'latex' });
    assert.equal(parseAttributeList('not valid'), undefined);
    assert.deepEqual(splitTrailingAttributes('Title {#sec:a}'), { text: 'Title', attrs: { id: 'sec:a', classes: [], values: {} } });
    assert.deepEqual(splitTrailingAttributes('see \\SI{3}{m}'), { text: 'see \\SI{3}{m}' });
  });

  it('makes an image alone in its paragraph a figure when it has a caption or an id (implicit_figures)', () => {
    assert.equal(
      body('![Cap *x*](a.png){#fig:a width=50%}'),
      ['\\begin{figure}[htbp]', '  \\centering', '  \\includegraphics[width=0.5\\linewidth,keepaspectratio]{a.png}', '  \\caption{Cap \\emph{x}}\\label{fig:a}', '\\end{figure}'].join('\n'),
    );
    assert.equal(body('![](a.png)'), '\\mdincludegraphics{a.png}');
    assert.equal(body('Inline ![x](a.png) image.'), 'Inline \\mdincludegraphics{a.png} image.');
  });

  it('uses the .pdf the caller finds beside a .png, and placeholders for web and SVG images', () => {
    const r = convertMarkdown('![A](fig/a.png)\n\n![B](https://x.org/b.png)\n\n![C](c.svg)', { resolveImage: (p) => (p === 'fig/a.png' ? 'fig/a.pdf' : undefined) });
    assert.match(r.latex, /\\mdincludegraphics\{fig\/a\.pdf\}/);
    assert.match(r.latex, /\\mdremoteimage\{https:\/\/x\.org\/b\.png\}/);
    assert.match(r.latex, /\\mdmissingimage\{c\.svg\}/);
    assert.deepEqual(r.images, ['fig/a.png', 'c.svg']);
    assert.ok(r.diagnostics.some((d) => d.code === 'image-format:svg' && d.kind === 'notice'));
  });

  it('attaches "Table:" captions written before or after a table', () => {
    const after = body('| a |\n|---|\n| 1 |\n\nTable: After. {#tbl:x}');
    assert.match(after, /\\begin\{table\}\[htbp\]\n {2}\\centering\n {2}\\caption\{After\.\}\\label\{tbl:x\}/);
    const before = body(': Before.\n\n| a |\n|---|\n| 1 |');
    assert.match(before, /\\caption\{Before\.\}\n {2}\\begin\{tabular\}/);
  });

  it('turns theorem-like divs into amsthm environments and callout divs into boxes', () => {
    const r = convertMarkdown('::: {.lemma #lem:a title="Key"}\nText.\n:::\n\n::: warning\nCareful.\n:::');
    assert.match(r.latex, /\\begin\{lemma\}\[Key\]\\label\{lem:a\}\n {2}Text\.\n\\end\{lemma\}/);
    assert.match(r.latex, /\\newtheorem\{lemma\}\{Lemma\}/);
    assert.match(r.latex, /\\begin\{mdcallout\}\{warning\}\{Warning\}/);
  });

  it('keeps the content of an unknown div class as plain text, with one warning', () => {
    const r = convertMarkdown('::: {.sidebar}\nAside.\n:::\n\n::: {.sidebar}\nAgain.\n:::');
    const warnings = r.diagnostics.filter((d) => d.kind === 'unsupported');
    assert.deepEqual(warnings.map((d) => [d.code, d.lines]), [['div-class:sidebar', [1, 5]]]);
    assert.match(r.latex, /\nAside\.\n/);
  });

  it('line blocks keep their lines and indentation', () => {
    // "|" and one space mark the line; the spaces after them are its indentation (here two).
    assert.equal(body('| one\n|   two\n| three'), '\\noindent one\\\\\n\\hspace*{1em}two\\\\\nthree');
  });

  it('bracketed spans: small caps and underline mean something, other classes nothing', () => {
    assert.equal(body('[Ab]{.smallcaps} [u]{.underline} [x]{.foo}'), '\\textsc{Ab} \\uline{u} {x}');
  });
});

describe('dialect: GitHub and Obsidian habits', () => {
  it('GitHub alerts and Obsidian callouts become tcolorbox boxes', () => {
    const r = convertMarkdown('> [!NOTE]\n> Body.\n\n> [!faq]- Why *this*?\n> Because.');
    assert.match(r.latex, /\\begin\{mdcallout\}\{note\}\{Note\}\n {2}Body\.\n\\end\{mdcallout\}/);
    assert.match(r.latex, /\\begin\{mdcallout\}\{important\}\{Why \\emph\{this\}\?\}/);
    assert.match(r.latex, /\\usepackage\{tcolorbox\}/);
  });

  it('==highlight== uses soul, ^sup^ and ~sub~ follow the tilde rule', () => {
    assert.equal(body('==hi== x^2^ H~2~O ~~del~~ a ~b c~'), '\\hl{hi} x\\textsuperscript{2} H\\textsubscript{2}O \\sout{del} a \\textasciitilde{}b c\\textasciitilde{}');
  });

  it('maps the common inline HTML and drops the rest with one warning per element', () => {
    const r = convertMarkdown('a<br>b <sup>1</sup> <sub>2</sub> <kbd>K</kbd> <b>B</b> <span style="x">s</span> <marquee>m</marquee> <script>evil()</script>');
    assert.match(r.latex, /a\\leavevmode\\\\b \\textsuperscript\{1\} \\textsubscript\{2\} \\texttt\{K\} \\textbf\{B\} \{s\} m /);
    assert.doesNotMatch(r.latex, /evil/);
    assert.deepEqual(r.diagnostics.filter((d) => d.kind === 'unsupported').map((d) => d.code).sort(), ['html:marquee', 'html:script']);
  });

  it('HTML blocks: centred paragraphs, images, details and summary, comments', () => {
    const b = body('<p align="center">\n  <img src="logo.png" width="100">\n</p>\n\n<!-- a comment -->\n\n<details>\n<summary>More</summary>\n\nHidden text.\n\n</details>');
    assert.equal(b, '\\begin{center}\n\\includegraphics[width=100px,keepaspectratio]{logo.png}\n\\end{center}\n\n\\noindent\\textbf{More}\\par\n\nHidden text.');
  });

  it('wikilinks become text, embeds become images, %%comments%% disappear, [TOC] is a table of contents', () => {
    assert.equal(body('[[A]] [[B|b]] [[C#D]] %%gone%% ![[e.png|200]]'), 'A b C \\textgreater{} D  \\includegraphics[width=200px,keepaspectratio]{e.png}');
    assert.equal(body('%%\nblock\n%%\n\nAfter'), 'After');
    assert.equal(body('[TOC]'), '\\tableofcontents');
  });

  it('warns once for an embedded note', () => {
    assert.deepEqual(unsupported('![[Other note]]'), ['note-embed']);
  });
});

describe('dialect: front matter and the template', () => {
  it('reads pandoc metadata into the preamble and title block', () => {
    const md = [
      '---',
      'title: The *title*',
      'author: [A One, B Two]',
      'date: 2026',
      'abstract: Short.',
      'documentclass: report',
      'classoption: twocolumn',
      'fontsize: 11pt',
      'geometry: margin=2cm',
      'lang: de',
      'toc: true',
      'numbersections: false',
      'header-includes: \\usepackage{xspace}',
      '---',
      'Body.',
    ].join('\n');
    const r = convertMarkdown(md);
    for (const line of [
      '\\documentclass[11pt,twocolumn]{report}',
      '\\usepackage[margin=2cm]{geometry}',
      '\\usepackage[ngerman]{babel}',
      '\\usepackage{xspace}',
      '\\setcounter{secnumdepth}{-1}',
      '\\title{The \\emph{title}}',
      '\\author{A One \\and B Two}',
      '\\date{2026}',
      '\\maketitle\\relax',
      '\\begin{abstract}',
      'Short.',
      '\\tableofcontents',
    ]) {
      assert.ok(r.latex.split('\n').includes(line), line);
    }
    const lines = r.latex.split('\n');
    assert.equal(r.lineMap[lines.indexOf('\\title{The \\emph{title}}')], 2);
    assert.equal(r.lineMap[lines.indexOf('\\usepackage[ngerman]{babel}')], 10);
    assert.equal(r.lineMap[lines.indexOf('Body.')], 15);
    assert.deepEqual(r.diagnostics, []);
  });

  it('leaves a package to header-includes when the user loads it there, so options never clash', () => {
    const md = '---\nheader-includes: |\n  \\usepackage[dvipsnames]{xcolor}\n  \\usepackage[numbers]{natbib}\n  \\usepackage{hyperref}\n---\n==x== and [@k]\n\n> [!NOTE]\n> y';
    const lines = convertMarkdown(md).latex.split('\n');
    const index = (l: string) => lines.indexOf(l);
    assert.equal(index('\\usepackage{xcolor}'), -1);
    assert.equal(index('\\usepackage{natbib}'), -1);
    assert.ok(index('\\usepackage{soul}') >= 0 && index('\\usepackage{tcolorbox}') >= 0);
    // Definitions come after the user's packages, so the colours exist whoever loaded xcolor.
    assert.ok(index('\\usepackage[dvipsnames]{xcolor}') < lines.findIndex((l) => l.startsWith('\\definecolor')));
    assert.ok(index('\\usepackage[numbers]{natbib}') < index('\\usepackage{hyperref}'));
    assert.ok(lines.some((l) => l.startsWith('\\hypersetup{hidelinks')));
  });

  it('warns for csl: and documentclass: beamer, and survives broken YAML', () => {
    assert.deepEqual(convertMarkdown('---\ncsl: apa.csl\n---\nx').diagnostics.map((d) => d.code), ['csl']);
    assert.deepEqual(unsupported('---\ndocumentclass: beamer\n---\nx'), ['beamer']);
    const broken = convertMarkdown('---\ntitle: [unclosed\n---\nText');
    assert.ok(broken.diagnostics.some((d) => d.code === 'front-matter'));
    assert.match(broken.latex, /\nText\n/);
  });

  it('uses folder-config defaults when the front matter is silent', () => {
    const r = convertMarkdown('[@a]', { defaults: { citationPackage: 'biblatex' } });
    assert.match(r.latex, /\\autocite\{a\}/);
  });
});

describe('dialect: unsupported constructs get one plain warning and pass through', () => {
  it('grid tables, simple tables, example lists, fancy lists', () => {
    assert.deepEqual(unsupported('+---+---+\n| a | b |\n+---+---+'), ['grid-table']);
    assert.deepEqual(unsupported('Text\n\n  Right     Left\n-------     ------\n     12     12\n'), ['simple-table']);
    assert.deepEqual(unsupported('Text\n\n---\n\nMore'), []);
    assert.deepEqual(unsupported('(@) First\n(@) Second'), ['example-list']);
    assert.deepEqual(unsupported('a. one\nb. two'), ['fancy-list']);
    assert.deepEqual(unsupported('e.g. this is fine\nand so is i.e. this'), []);
  });

  it('keeps the text of an unsupported construct', () => {
    assert.match(convertMarkdown('+---+\n| a |\n+---+').latex, /\+---\+\n\\textbar\{\} a \\textbar\{\}\n\+---\+/);
  });
});

describe('the line map', () => {
  it('maps every LaTeX line to a real Markdown line, for a document with every construct', () => {
    const md = [
      '---',
      'title: T',
      'bibliography: r.bib',
      '---',
      '# H',
      '',
      'Para [@k] with $m$.[^1]',
      '',
      '[^1]: Note',
      '  over two lines.',
      '',
      '- a',
      '  - b',
      '',
      '| x | y |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'Table: Cap.',
      '',
      '![F](f.png)',
      '',
      '> [!TIP]',
      '> Tip.',
      '',
      '```',
      'code',
      '```',
      '',
      '$$',
      'x',
      '$$',
    ].join('\n');
    const r = convertMarkdown(md);
    assert.deepEqual(lineMapProblems(r.latex, r.lineMap, md), []);
    const lines = r.latex.split('\n');
    const expectLine = (latex: string, mdLine: number) => assert.equal(r.lineMap[lines.findIndex((l) => l.includes(latex))], mdLine, latex);
    expectLine('\\section{H}', 5);
    expectLine('Para \\citep{k}', 7);
    expectLine('\\item a', 12);
    expectLine('\\item b', 13);
    expectLine('1 & 2', 17);
    expectLine('\\caption{Cap.}', 19);
    expectLine('\\caption{F}', 21);
    expectLine('Tip.', 24);
    expectLine('code', 27);
    expectLine('\\end{verbatim}', 28);
    expectLine('\\[', 30);
  });

  it('finds the LaTeX line for a Markdown line, and the nearest one for a line that makes none', () => {
    const r = convertMarkdown('A\n\n[^1]: unused footnote\n\nB');
    const lines = r.latex.split('\n');
    assert.equal(markdownToLatexLine(r, 5), lines.indexOf('B') + 1);
    // Line 3 (a footnote definition) makes no LaTeX; the nearest earlier mapped line is the blank after A.
    assert.equal(markdownToLatexLine(r, 3), lines.indexOf('A') + 2);
    assert.equal(lines[markdownToLatexLine(r, 3) - 1], '');
  });

  it('handles CRLF, a BOM and an empty document', () => {
    const r = convertMarkdown('\uFEFF# A\r\n\r\nText\r\n');
    assert.match(r.latex, /\\section\{A\}\\label\{a\}\n\nText\n/);
    assert.deepEqual(lineMapProblems(r.latex, r.lineMap, '# A\n\nText\n'), []);
    const empty = convertMarkdown('');
    assert.deepEqual(lineMapProblems(empty.latex, empty.lineMap, ''), []);
  });
});
