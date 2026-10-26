# liveMd2Tex

A VS Code extension that shows a real LaTeX PDF of a `.tex` or `.md` file beside the editor and updates it as you
type. The TeX engines run inside the extension, so you need no TeX installation. Licence:
`GPL-3.0-or-later AND AGPL-3.0-only` (see Licence below, `LICENSE` and `THIRD_PARTY_NOTICES.md`).

Status: a development version, not published yet. `.tex` files compile as you type and on save, Markdown files
are converted and typeset when asked, and a click in the PDF goes to the source line. This page is for users, and
is the store page; building and testing the extension is in `docs/DEVELOPING.md`.

## What it does

- Typesets a LaTeX document after a short pause in typing, and on save. A save also writes `name.pdf` next to
  the source.
- Typesets Markdown too. Its own converter writes the LaTeX: pandoc's Markdown with citations,
  cross-references, maths, tables, figures and front matter (see Markdown, below).
- Goes from a click in the PDF to the source line, and from a source line to its place in the PDF.
- Lists TeX's errors in the Problems panel on their lines. The 20 most common errors also get a sentence in
  plain words: what usually causes the error, and what to try.
- Names the packages a document needs and does not have, before it compiles, and says how to get each one.
- Gets you started: "New document from template" and a walkthrough.

## What it never does

- **No download after installation.** Everything it needs comes from the store when you install it. The
  optional Extra Packages add-on is a second extension, which you install yourself from the same store.
- **No network.** It opens no network connection: no update check of its own, no package or font download.
- **No outside program.** It starts no program on your computer. Its only child process is its own engine
  host, which VS Code's own program runs in Node mode. The TeX engines are WebAssembly inside that process, and
  TeX's shell escape (`\write18`) is off.
- **No telemetry.** It sends nothing, ever, and contains no telemetry library.
- **No administrator rights.** It installs into your VS Code profile like any other extension. It writes your
  PDFs next to their sources, the files you ask for, and its own folder in VS Code's storage.

A few things only you can start, and VS Code (not the extension) then does them: opening a web or e-mail link
you click in the PDF, the CTAN page of a missing package, and "Report a missing package" (each after VS Code's
own link prompt); showing a web image in VS Code's own Markdown preview, when you open that preview; and
"Install Extra Packages", which opens VS Code's Extensions view on the add-on.

These rules are checked, not only promised: lint rules, test stubs that block and record every program start
and every connection, and a scan of every file in the package (`docs/DEVELOPING.md` lists them).

## Getting started

Open the walkthrough: in the Command Palette (Ctrl+Shift+P) run "Welcome: Open Walkthrough..." and choose "Get
started with liveMd2Tex". In a few minutes it shows how to open a sample, see the preview, try Markdown, deal
with a missing package, and use the extension beside LaTeX Workshop.

"New document from template" (Command Palette, or File > New File) makes a new folder with a starting
document: a LaTeX article, report or slides; a Physical Review, IEEE or Elsevier paper; or a Markdown article,
notes, report, journal paper, or two-column paper with the example preset. The new folder never replaces one
that exists. The starting documents and the example preset are dedicated to the public domain (CC0 1.0), so you
can use them for anything.

## What you install

The plan for the first release is three store items. Until the data packages are built (before that release), the
core data is inside the extension itself.

| Item | What it holds | Size |
|---|---|---|
| liveMd2Tex (`haberwooki.livemd2tex`) | The extension: the compile loop, the viewer, the Markdown converter, the notices | not yet built |
| liveMd2Tex core data (`haberwooki.livemd2tex-core-data`) | The TeX engines, the packages and fonts most documents use, the prebuilt formats | not yet built |
| Extra Packages (`haberwooki.livemd2tex-extra-data`) | Optional: many more packages and fonts, publishers' classes among them | not yet built |

Installing liveMd2Tex from the store will install the core data with it. If you install from a `.vsix` file
instead, install the core data's `.vsix` file first: VS Code fetches a dependency only from the store.

## Markdown

A Markdown file gets a PDF when you run "Open LaTeX preview", or when its front matter has `latex-preview: true`,
or its folder's `.latexpreview.json` has `"latexPreview": true`. Other Markdown files are left alone. The
extension's own converter writes the LaTeX; there is no pandoc and no other program. The dialect is pandoc's
Markdown, so existing documents work, plus the GitHub and Obsidian habits people use:

- tables with column alignment, footnotes, definition lists, task lists, strikeout and smart quotes;
- maths between `$...$` and `$$...$$` (also `\(...\)`, `\[...\]` and GitHub's forms); `$$...$$ {#eq:id}` is a
  numbered equation;
- LaTeX written in the text, such as `\ref{a}` or `\SI{3}{\metre}`, passes through as written;
- citations `[@key]`, `[@a; @b]`, `[see @a, p. 3]` and `@a`, with natbib, or biblatex with `biblatex: true`;
  cross-references `[@fig:a]`, `[@tbl:b]`, `[@eq:c]`, `[@sec:d]`;
- figures from an image with a caption, tables with `Table: caption {#tbl:id}`, and pandoc's front matter
  (`title`, `author`, `abstract`, `bibliography`, `documentclass`, `header-includes` and the others);
- GitHub alerts and Obsidian callouts (`> [!NOTE]`), `==highlight==`, `[[wikilinks]]` and a few HTML elements.

A document is typeset with pdfLaTeX unless it has characters pdfLaTeX cannot print; then it uses XeTeX, with
DejaVu fonts when Latin Modern lacks a character. `engine: xelatex` and `template: notes` in the front matter
choose directly. "Show generated LaTeX" shows the LaTeX beside the Markdown and follows the cursor, and "Export
LaTeX" saves it as a `.tex` file. A folder's `.latexpreview.json` can set defaults for its Markdown files and name
a preset: a set of rules for a group's house style, such as the example in `examples/presets/two-column-paper/`.

What the converter does not support gives one plain warning each (see What does not work, below).

## The preview

- The PDF updates after a short pause in typing (1 second; the setting `livemd2tex.pauseMilliseconds`). The
  status bar switches between **Live** and **On save**.
- A double-click or a Ctrl+click (Cmd+click on macOS) in the PDF opens the source line, with the word selected;
  for Markdown, the Markdown line. Shift+Alt+J in the editor shows the cursor's line in the PDF.
- Several documents in one folder each get their own preview, and the preview follows the editor you work in.
- By keyboard, while the preview has focus: Alt+PageDown and Alt+PageUp turn the pages, Ctrl+= and Ctrl+- zoom,
  Ctrl+0 fits the width, and Shift+Alt+J opens the source of the view's centre. These keys replace VS Code's own
  (window zoom, and Ctrl+0 for the Side Bar) only while the preview has focus. F6 moves between VS Code's parts.
- The toolbar and pages have labels for screen readers, and a live region says when the preview is updated and
  how many errors a compile had. Under a High Contrast theme, a toggle draws the pages in the theme's colours.

## Beside LaTeX Workshop

Keep LaTeX Workshop if you use it: it gives completion and the outline, which need no TeX installation, and this
extension builds and previews. The first time you open a `.tex` file in a workspace, this extension offers once
to turn off LaTeX Workshop's automatic build for that workspace, so that a change does not build twice. Nothing is
changed without your yes. The two share no keys, and PDF files still open in LaTeX Workshop's viewer.

## Restricted Mode

In a folder you have not trusted, nothing compiles by itself; a compile you start from a command asks first. The
folder's settings cannot switch on the HTML view for VS Code's own Markdown preview.

## When a package is missing

Before each compile the extension reads the preamble. Each file that no installed package set has is listed in
the Problems panel and in one notification, with what to do:

- **Install Extra Packages**, when the add-on has it. The button opens VS Code's Extensions view on the add-on,
  and you install it there.
- **Add a package from a file**: a `.sty` or `.cls` file, a `.dtx` file with its `.ins` file (built with the
  extension's own TeX), or a ZIP file from CTAN. The package is kept for all your documents, or put in the
  document's folder.
- Or copy the package's files into the document's folder.

Packages that need a program outside TeX (minted, svg, gnuplottex, pythontex, sagetex, epstopdf, biblatex with
Biber) get their own message, with what to use instead.

## How many documents compile

Not yet measured. Before the first release, the share of recent arXiv papers that compile is measured with and
without the add-on, and given here with its 95 % interval. The method is written down in
`docs/coverage-method.md`.

## What does not work

- `.eps` figures without a PDF copy beside them: turning `.eps` into PDF needs Ghostscript, an outside program.
- Chinese, Japanese and Korean text: their fonts are not included.
- Packages that need an outside program (listed above), and anything else that needs shell escape.
- LuaLaTeX: the engines are pdfLaTeX and XeLaTeX. biblatex runs with its bibtex8 backend, since Biber is not
  included.
- In Markdown: CSL styles and citeproc (natbib or biblatex is used instead), grid, simple and multiline tables,
  example lists, letter and Roman list markers, and Markdown to Beamer slides. Each gives one plain warning.

## Remote windows

By default the extension and its engine run on your own computer, and the project's files are read over the
remote link. To run the engine on the remote machine instead, set `remote.extensionKind` for the three items to
`["workspace"]`. In a browser Codespace, VS Code runs it on the remote side. Remote windows (Remote-SSH, WSL,
Dev Containers, Codespaces) have not been tested yet, and the download per container and the memory per window
are not yet measured.

## VS Code version

VS Code 1.105 or later, for now. The oldest version that works will be measured before the first release. If it
ends above 1.105, this section will name the editors built on older VS Code versions that cannot install it.

## Maintenance and issues

Preview, as time allows: issues are answered as time allows, and the TeX package set is rebuilt once a year
with TeX Live. Report problems and missing packages at https://github.com/haberwooki/liveMd2Tex/issues
("Report a missing package" in the Command Palette opens it).

## Licence

liveMd2Tex is free software under GPL-3.0-or-later (`LICENSE`). The TeX engine's JavaScript wrapper (TeXlyre's
busytex) keeps its AGPL-3.0 terms inside the combined work, so `package.json` declares
`GPL-3.0-or-later AND AGPL-3.0-only`. Copyright (C) 2026 the liveMd2Tex authors. The parts by others and their
licences are in `THIRD_PARTY_NOTICES.md`; the licence texts ship in `dist/licenses/`.

The files the extension copies into your folders come with no conditions at all: the starting documents of "New
document from template" (`templates/`) and the example presets (`examples/presets/`) are dedicated to the public
domain (CC0 1.0), so that a paper, thesis or preset you write from them carries no conditions. Each folder has a
`LICENSE.md` notice, and each file with a comment form the line `SPDX-License-Identifier: CC0-1.0`.

## Developing

How the extension is built and tested, the rules its checks enforce, and notes on each part are in
`docs/DEVELOPING.md`. The design is `docs/DESIGN.md`.
