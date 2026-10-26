// The starting documents of "New document from template" (docs/DESIGN.md#help-for-new-users, #presets): LaTeX
// documents for the classes the engine carries (article, report, beamer) and for journal classes that come with
// the Extra Packages add-on, and Markdown documents for the converter's templates, its class templates and the
// example preset. The starting documents (templates/) and the example preset (examples/presets/) are written
// for this project and dedicated to the public domain (CC0 1.0), because they are copied into the user's own
// folders; each file with a comment form says so in an SPDX line (templates/LICENSE.md,
// examples/presets/LICENSE.md; docs/DESIGN.md#store-and-packaging). Both ship inside the extension. Pure: no
// VS Code here.

export interface TemplateFile {
  /** Path inside the extension, with "/". */
  from: string;
  /** Path inside the new folder, with "/". */
  to: string;
}

export interface DocumentTemplate {
  id: string;
  label: string;
  detail: string;
  kind: 'tex' | 'markdown';
  /** The name of the new folder (a free variant of it: paper, paper-2, ...). */
  folder: string;
  files: TemplateFile[];
  /** The file opened when the folder is made. */
  main: string;
  /** The class comes with the Extra Packages add-on, not with the extension. */
  extra?: boolean;
  /** A folder config (.latexpreview.json) to write beside the files. */
  config?: Record<string, unknown>;
}

const BIB: TemplateFile = { from: 'templates/markdown/references.bib', to: 'references.bib' };

const tex = (id: string, label: string, detail: string, folder: string, extra = false): DocumentTemplate => ({
  id: `tex-${id}`,
  label,
  detail,
  kind: 'tex',
  folder,
  files: [{ from: `templates/tex/${id}/main.tex`, to: 'main.tex' }, ...(id === 'beamer' ? [] : [BIB])],
  main: 'main.tex',
  extra,
});

const md = (file: string, label: string, detail: string, folder: string, extra = false): DocumentTemplate => ({
  id: `md-${file}`,
  label,
  detail,
  kind: 'markdown',
  folder,
  files: [{ from: `templates/markdown/${file}.md`, to: `${folder}.md` }, ...(file === 'notes' ? [] : [BIB])],
  main: `${folder}.md`,
  extra,
});

const PRESET = 'examples/presets/two-column-paper';
const PRESET_FILES = [
  'preset.json',
  'paper-preamble.tex',
  'supplement-preamble.tex',
  'letter-preamble.tex',
  'letter-preamble-xetex.tex',
  'response-preamble.tex',
  'response-preamble-xetex.tex',
  'report-preamble.tex',
];

export const TEMPLATES: readonly DocumentTemplate[] = [
  tex('article', 'LaTeX article', 'One column, title, abstract, sections, an equation, a table and a bibliography', 'article'),
  tex('report', 'LaTeX report or thesis', 'Chapters and a table of contents', 'report'),
  tex('beamer', 'LaTeX slides (Beamer)', 'A title page and three slides', 'slides'),
  tex('revtex', 'LaTeX: Physical Review (REVTeX 4.2)', 'Needs the Extra Packages add-on', 'revtex-paper', true),
  tex('ieeetran', 'LaTeX: IEEE journal (IEEEtran)', 'Needs the Extra Packages add-on', 'ieee-paper', true),
  tex('elsarticle', 'LaTeX: Elsevier (elsarticle)', 'Needs the Extra Packages add-on', 'elsevier-paper', true),
  md('article', 'Markdown article', 'Typeset with the default article template; citations, cross-references, a table', 'article'),
  md('notes', 'Markdown notes', 'Typeset with XeTeX and DejaVu: Unicode, symbols and code print as written', 'notes'),
  md('report', 'Markdown report (report class)', 'Level-1 headings are chapters', 'report'),
  md('revtex', 'Markdown: Physical Review (REVTeX 4.2)', 'Needs the Extra Packages add-on', 'revtex-paper', true),
  md('ieeetran', 'Markdown: IEEE journal (IEEEtran)', 'Needs the Extra Packages add-on', 'ieee-paper', true),
  md('elsarticle', 'Markdown: Elsevier (elsarticle)', 'Needs the Extra Packages add-on', 'elsevier-paper', true),
  {
    id: 'md-preset-paper',
    label: 'Markdown paper with the example preset',
    detail: 'Two columns, a Methods appendix, bold "Table N." captions and drafting notes left out',
    kind: 'markdown',
    folder: 'paper',
    files: [
      { from: 'templates/preset/paper.md', to: 'paper.md' },
      { from: 'templates/preset/methods.md', to: 'methods.md' },
      BIB,
      ...PRESET_FILES.map((f) => ({ from: `${PRESET}/${f}`, to: `presets/two-column-paper/${f}` })),
    ],
    main: 'paper.md',
    config: { latexPreview: true, markdown: { preset: 'presets/two-column-paper/preset.json' } },
  },
];

/** A Markdown file with "latex-preview: true" in its front matter, so it is typeset as it is edited and saved. */
export function withPreviewOptIn(markdown: string): string {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  if (/^---\r?\n/.test(markdown)) {
    return markdown.replace(/^---\r?\n/, `---${eol}latex-preview: true${eol}`);
  }
  return `---${eol}latex-preview: true${eol}---${eol}${eol}${markdown}`;
}

/** `base`, or the first of base-2, base-3, ... that is not taken (names compared without case). */
export function freeName(base: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map((n) => n.toLowerCase()));
  if (!lower.has(base.toLowerCase())) {
    return base;
  }
  for (let k = 2; ; k++) {
    const name = `${base}-${k}`;
    if (!lower.has(name.toLowerCase())) {
      return name;
    }
  }
}

/** The files of the new folder, with the folder config and the Markdown opt-in applied; `read` reads a `from` path. */
export async function templateFiles(template: DocumentTemplate, read: (from: string) => PromiseLike<Uint8Array>): Promise<{ to: string; data: Uint8Array }[]> {
  const out: { to: string; data: Uint8Array }[] = [];
  for (const file of template.files) {
    let data = await read(file.from);
    // A Markdown file is typeset only when it opts in; the preset paper opts in through its folder config.
    if (template.kind === 'markdown' && !template.config && file.to === template.main) {
      data = new TextEncoder().encode(withPreviewOptIn(new TextDecoder().decode(data)));
    }
    out.push({ to: file.to, data });
  }
  if (template.config) {
    out.push({ to: '.latexpreview.json', data: new TextEncoder().encode(`${JSON.stringify(template.config, null, 2)}\n`) });
  }
  return out;
}
