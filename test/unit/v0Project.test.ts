// Version 0's project model and log reading, without the engine: engine choice, the root document's text,
// which files go into a compile, and the TeX and BibTeX logs to Problems-panel entries.

import * as assert from 'node:assert/strict';
import { generatedMainFor, prepareCompile } from '../../src/extension/compile/pipeline';
import { parseBlg, parseTexLog, projectPath } from '../../src/extension/diagnostics/logParser';
import { folderConfigAsksForTypesetting, frontMatterAsksForTypesetting } from '../../src/extension/project/markdownOptIn';
import { collectProject, collectReferenced, fingerprint, type ProjectFs } from '../../src/extension/project/collect';
import { insideProject, scanGraphicsPaths, scanReferences } from '../../src/extension/project/confine';
import { chooseEngine, hasDocumentClass, includesFile, magicComment, preamble, stripComments } from '../../src/extension/project/texText';

const enc = (s: string) => new TextEncoder().encode(s);

/** A project in memory: paths with "/" mapped to text. */
function memoryFs(files: Record<string, string>): ProjectFs & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async readDirectory(rel) {
      const prefix = rel ? `${rel}/` : '';
      const seen = new Map<string, 'file' | 'dir'>();
      for (const p of Object.keys(files)) {
        if (p.startsWith(prefix)) {
          const rest = p.slice(prefix.length);
          const slash = rest.indexOf('/');
          seen.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? 'file' : 'dir');
        }
      }
      return [...seen];
    },
    async readFile(rel) {
      reads.push(rel);
      if (!(rel in files)) {
        throw new Error(`no such file: ${rel}`);
      }
      return enc(files[rel]);
    },
  };
}

describe('texText: reading a .tex file', () => {
  it('strips comments but keeps \\%', () => {
    assert.equal(stripComments('a % comment\n50\\% off % gone'), 'a \n50\\% off ');
  });

  it('finds the preamble and the document class', () => {
    const text = '% \\documentclass{fake}\n\\documentclass[11pt]{article}\n\\usepackage{x}\n\\begin{document}\nbody';
    assert.equal(hasDocumentClass(text), true);
    assert.equal(hasDocumentClass('% \\documentclass{article}\nText.'), false);
    assert.match(preamble(text), /usepackage\{x\}/);
    assert.doesNotMatch(preamble(text), /body/);
  });

  it('reads magic comments in the first lines only', () => {
    assert.equal(magicComment('% !TEX root = ../main.tex\n', 'root'), '../main.tex');
    assert.equal(magicComment('%!TEX TS-program = xelatex\n', 'program'), 'xelatex');
    assert.equal(magicComment(`${'\n'.repeat(40)}% !TEX root = late.tex`, 'root'), null);
  });

  it('chooses the engine: magic comment, then the preamble, then the setting', () => {
    assert.equal(chooseEngine('% !TEX program = xelatex\n\\documentclass{article}', 'pdflatex').engine, 'xelatex');
    assert.equal(chooseEngine('% !TEX program = pdflatex\n\\usepackage{fontspec}', 'xelatex').engine, 'pdflatex');
    const lua = chooseEngine('% !TEX program = lualatex\n', 'pdflatex');
    assert.equal(lua.engine, 'xelatex');
    assert.match(lua.reason, /LuaLaTeX is not offered/);
    assert.equal(chooseEngine('\\usepackage[no-math]{fontspec}\n\\begin{document}', 'pdflatex').engine, 'xelatex');
    assert.equal(chooseEngine('\\usepackage{amsmath,unicode-math}\n', 'pdflatex').engine, 'xelatex');
    // A package named in a comment, or after \begin{document}, does not count.
    assert.equal(chooseEngine('% \\usepackage{fontspec}\n\\begin{document}\n\\usepackage{fontspec}', 'pdflatex').engine, 'pdflatex');
    assert.equal(chooseEngine('\\documentclass{article}', 'xelatex').engine, 'xelatex');
  });

  it('tells whether a file includes another', () => {
    const main = '\\input{sections/intro}\n\\include{chap2.tex}\n% \\input{old}\n\\subimport{parts/}{methods}';
    assert.equal(includesFile(main, 'intro.tex'), true);
    assert.equal(includesFile(main, 'chap2'), true);
    assert.equal(includesFile(main, 'old.tex'), false);
    assert.equal(includesFile(main, 'methods.tex'), true);
    assert.equal(includesFile(main, 'tro.tex'), false);
  });
});

describe('Markdown route: when a Markdown file is typeset, and under which name', () => {
  it('reads "latex-preview: true" in the front matter only', () => {
    assert.equal(frontMatterAsksForTypesetting('---\ntitle: A\nlatex-preview: true\n---\n\nText'), true);
    assert.equal(frontMatterAsksForTypesetting('---\r\nlatex-preview: yes\r\n---\r\n'), true);
    assert.equal(frontMatterAsksForTypesetting('---\nlatex-preview: false\n---\n'), false);
    assert.equal(frontMatterAsksForTypesetting('# Title\n\nlatex-preview: true\n'), false);
    assert.equal(frontMatterAsksForTypesetting('---\ntitle: [unclosed\nlatex-preview: true\n---\n'), false);
  });

  it('reads "latexPreview": true at the top of the folder config only', () => {
    assert.equal(folderConfigAsksForTypesetting('{ "latexPreview": true, "markdown": { "cref": true } }'), true);
    assert.equal(folderConfigAsksForTypesetting('{ "markdown": { "latexPreview": true } }'), false);
    assert.equal(folderConfigAsksForTypesetting('{ "latexPreview": "yes" }'), false);
    assert.equal(folderConfigAsksForTypesetting('not json'), false);
  });

  it('names the generated root document after the Markdown file', () => {
    assert.equal(generatedMainFor('notes.md'), 'notes.tex');
    assert.equal(generatedMainFor('paper.draft.markdown'), 'paper.draft.tex');
  });
});

describe('confinement: what the project model refuses to read', () => {
  it('refuses absolute paths and ".." that leaves the project folder, with a plain message and its line', () => {
    const text = ['\\documentclass{article}', '\\begin{document}', '\\input{../../.ssh/id_rsa}', '\\input{/etc/passwd}', '\\includegraphics{C:/Windows/win.ini}', '\\end{document}'].join('\n');
    const scan = scanReferences(text, 'paper/main.tex', 'paper/main.tex');
    assert.deepEqual(
      scan.refused.map((d) => [d.file, d.line, d.severity]),
      [['paper/main.tex', 3, 'error'], ['paper/main.tex', 4, 'error'], ['paper/main.tex', 5, 'error']],
    );
    assert.match(scan.refused[0].message, /Not read: "\.\.\/\.\.\/\.ssh\/id_rsa" is outside the project folder/);
    assert.match(scan.refused[1].message, /absolute path/);
    assert.equal(scan.references.length, 0);
  });

  it('collects references that stay inside the project folder, with the extensions TeX tries', () => {
    const text = '\\input{../shared/macros}\n\\includegraphics{figs/plot}\n\\bibliography{refs,../bib/more}\n% \\input{../../secret}\n\\subimport{parts/}{intro}';
    const scan = scanReferences(text, 'paper/sections/a.tex', 'paper/main.tex');
    assert.deepEqual(scan.refused, []);
    assert.deepEqual(
      scan.references.map((r) => r.candidates),
      [
        ['shared/macros', 'shared/macros.tex'],
        ['paper/figs/plot', 'paper/figs/plot.pdf', 'paper/figs/plot.png', 'paper/figs/plot.jpg', 'paper/figs/plot.jpeg', 'paper/figs/plot.eps'],
        ['paper/refs.bib'],
        ['bib/more.bib'],
        ['paper/sections/parts/intro', 'paper/sections/parts/intro.tex'],
      ],
    );
  });

  it('follows \\graphicspath, paths in \\usepackage, \\documentclass and \\bibliographystyle, and \\VerbatimInput (G1S-11)', () => {
    const text = [
      '\\documentclass{../templates/lab}',
      '\\usepackage{amsmath,../sty/notation}',
      '\\graphicspath{{../figs/}{local/}{/abs/}{../../out/}}',
      '\\bibliographystyle{../bst/plainurl}',
      '\\begin{document}',
      '\\includegraphics{plot}',
      '\\VerbatimInput{../code/run.py}',
      '\\end{document}',
    ].join('\n');
    const paths = scanGraphicsPaths(text, 'paper/main.tex', 'paper/main.tex');
    assert.deepEqual(paths.dirs, ['figs/', 'paper/local/']);
    assert.deepEqual(paths.refused.map((d) => [d.line, /graphics folder "(.*)"/.exec(d.message)?.[1]]), [[3, '/abs/'], [3, '../../out/']]);
    const scan = scanReferences(text, 'paper/main.tex', 'paper/main.tex', paths.dirs);
    assert.deepEqual(scan.refused, []);
    assert.deepEqual(
      scan.references.map((r) => r.candidates.filter((c) => /\.(cls|sty|bst|png|py)$/.test(c))),
      [['templates/lab.cls'], ['sty/notation.sty'], ['bst/plainurl.bst'], ['paper/plot.png', 'figs/plot.png', 'paper/local/plot.png'], ['code/run.py']],
    );
  });

  it('a figure found through \\graphicspath outside the document\'s folder goes into the compile', async () => {
    const fs = memoryFs({
      'paper/main.tex': '\\documentclass{article}\n\\usepackage{graphicx}\n\\graphicspath{{../figs/}}\n\\begin{document}\n\\includegraphics{plot}\n\\end{document}\n',
      'figs/plot.png': 'png',
      'figs/other.png': 'png',
    });
    const prepared = await prepareCompile({ fs, mainRel: 'paper/main.tex', engineSetting: 'pdflatex' });
    assert.deepEqual(prepared.job.files.map((f) => f.path).sort(), ['figs/plot.png', 'paper/main.tex']);
  });

  it('insideProject accepts only plain relative paths', () => {
    for (const ok of ['a.tex', 'x/y/z.png', 'a/../b.tex']) {
      assert.equal(insideProject(ok), true, ok);
    }
    for (const bad of ['', '../a.tex', 'a/../../b', '/etc/passwd', 'C:/x', 'c:x', '~/x', '..']) {
      assert.equal(insideProject(bad), false, bad);
    }
  });

  it('the walk covers the main file\'s folder only; referenced files elsewhere in the project come in by name', async () => {
    const fs = memoryFs({
      'paper/main.tex': 'main',
      'paper/fig.png': 'png',
      'shared/macros.tex': 'macros',
      'shared/unused.tex': 'unused',
      'other/big.pdf': 'pdf',
    });
    const project = await collectProject(fs, 'paper/main.tex');
    assert.deepEqual(project.files.map((f) => f.path).sort(), ['paper/fig.png', 'paper/main.tex']);
    const added = await collectReferenced(fs, project, [['shared/macros', 'shared/macros.tex'], ['../escape.tex'], ['missing.tex']]);
    assert.deepEqual(added.map((f) => f.path), ['shared/macros.tex']);
    assert.ok(!fs.reads.includes('../escape.tex'));
  });
});

describe('collect: the files that go into a compile', () => {
  it('takes inputs, leaves out leftovers, the main PDF, dot folders and other files, and applies unsaved text', async () => {
    const fs = memoryFs({
      'main.tex': 'saved',
      'main.pdf': 'old output',
      'main.aux': 'aux',
      'main.synctex.gz': 'x',
      'refs.bib': '@misc{a,}',
      'aps.rtx': 'revtex option',
      'figs/plot.pdf': '%PDF',
      'figs/data.csv': '1,2',
      'notes.docx': 'binary',
      '.git/config': 'secret',
      'node_modules/x/y.tex': 'no',
    });
    const project = await collectProject(fs, 'main.tex', new Map([['main.tex', enc('unsaved')]]));
    const paths = project.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ['aps.rtx', 'figs/data.csv', 'figs/plot.pdf', 'main.tex', 'refs.bib']);
    assert.equal(new TextDecoder().decode(project.files.find((f) => f.path === 'main.tex')?.data), 'unsaved');
    assert.ok(!fs.reads.includes('main.tex'), 'read the saved file although an unsaved editor holds it');
    assert.equal(project.truncated, false);
  });

  it('stops at the limits and says so', async () => {
    const files: Record<string, string> = { 'main.tex': 'x' };
    for (let i = 0; i < 20; i++) {
      files[`part${i}.tex`] = 'y'.repeat(100);
    }
    const project = await collectProject(memoryFs(files), 'main.tex', new Map(), { maxFiles: 5, maxBytes: 1e6, maxDepth: 6 });
    assert.equal(project.files.length, 5);
    assert.equal(project.truncated, true);
  });

  it('fingerprints differ when the content does', () => {
    assert.equal(fingerprint(enc('abc')), fingerprint(enc('abc')));
    assert.notEqual(fingerprint(enc('abc')), fingerprint(enc('acb')));
  });
});

describe('logParser: TeX and BibTeX logs to Problems entries', () => {
  it('maps engine paths to the project', () => {
    assert.equal(projectPath('./sections/a.tex', ''), 'sections/a.tex');
    assert.equal(projectPath('./a.tex', 'paper'), 'paper/a.tex');
    assert.equal(projectPath('/project/paper/b.tex', 'paper'), 'paper/b.tex');
    assert.equal(projectPath('/texlive/texmf-dist/tex/latex/base/article.cls', ''), null);
    assert.equal(projectPath('../outside.tex', ''), null);
  });

  const log = [
    'This is pdfTeX, Version 3.141592653-2.6-1.40.28 (TeX Live 2026) (preloaded format=pdflatex)',
    '(./main.tex',
    'LaTeX2e <2025-11-01>',
    '(/texlive/texmf-dist/tex/latex/base/article.cls',
    'Document Class: article 2024/06/29 v1.4n Standard LaTeX document class',
    ')',
    '(./sections/part.tex',
    './sections/part.tex:3: Undefined control sequence.',
    'l.3 An \\undefinedmacro',
    '                       here.',
    ')',
    '',
    'LaTeX Warning: Reference `nowhere\' on page 1 undefined on input line 5.',
    '',
    'Package natbib Warning: Citation `x\' on page 1 undefined on input line 7.',
    '',
    'Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
    '(hyperref)                removing `math shift\' on input line 9.',
    '',
    'LaTeX Font Warning: Font shape `OT1/cmr/bx/sc\' undefined',
    '(Font)              using `OT1/cmr/bx/n\' instead on input line 11.',
    '',
    'Overfull \\hbox (12.3pt too wide) in paragraph at lines 13--14',
    '[]\\OT1/cmr/m/n/10 text',
    '/texlive/texmf-dist/tex/latex/graphics/graphics.sty:99: Package graphics Error: oops.',
    '[1] )',
  ].join('\n');

  it('reads errors with their file and line, warnings, font messages and overfull boxes', () => {
    const d = parseTexLog(log, 'main.tex');
    const error = d.find((x) => x.severity === 'error' && /Undefined control/.test(x.message));
    assert.deepEqual([error?.file, error?.line], ['sections/part.tex', 3]);
    assert.match(error?.message ?? '', /at: An \\undefinedmacro/);
    const ref = d.find((x) => /nowhere/.test(x.message));
    assert.deepEqual([ref?.file, ref?.line, ref?.severity], ['main.tex', 5, 'warning']);
    const natbib = d.find((x) => /Citation/.test(x.message));
    assert.match(natbib?.message ?? '', /^natbib: /);
    const hyperref = d.find((x) => /hyperref/.test(x.message));
    assert.match(hyperref?.message ?? '', /removing `math shift' on input line 9/);
    assert.equal(hyperref?.line, 9);
    const font = d.find((x) => /Font shape/.test(x.message));
    assert.equal(font?.severity, 'info');
    const box = d.find((x) => /Overfull/.test(x.message));
    assert.deepEqual([box?.line, box?.severity], [13, 'info']);
    // An error inside a bundle file goes on the main file, naming the bundle file.
    const outside = d.find((x) => /Package graphics Error/.test(x.message));
    assert.deepEqual([outside?.file, outside?.line], ['main.tex', 0]);
    assert.match(outside?.message ?? '', /\[in graphics\.sty\]/);
  });

  it('reads "!" errors without a file on the current file', () => {
    const d = parseTexLog(['(./main.tex', '(./ch1.tex', '! Missing $ inserted.', '<inserted text>', 'l.4 a_', ''].join('\n'), 'main.tex');
    assert.deepEqual(
      d.map((x) => [x.file, x.line, x.severity]),
      [['ch1.tex', 4, 'error']],
    );
  });

  it('places BibTeX warnings on the .bib entry and errors on their line', () => {
    const bib = { path: 'refs.bib', text: '@article{first,\n  title={A}}\n\n@book{second,\n  title={B}}\n' };
    const blg = [
      'Database file #1: refs.bib',
      'Warning--empty year in second',
      'I was expecting a `,\' or a `}\'---line 9 of file refs.bib',
      ' :  title = {broken',
      'I couldn\'t open style file nostyle.bst',
    ].join('\n');
    const d = parseBlg(blg, [bib], 'main.tex');
    assert.deepEqual([d[0].file, d[0].line, d[0].severity], ['refs.bib', 4, 'warning']);
    assert.deepEqual([d[1].file, d[1].line, d[1].severity, d[1].message], ['refs.bib', 9, 'error', "I was expecting a `,' or a `}'"]);
    assert.ok(d.some((x) => x.severity === 'error' && x.message.startsWith("I couldn't open style file")));
  });
});
