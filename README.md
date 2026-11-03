# liveMd2Tex

A VS Code extension that shows a real LaTeX PDF of a `.tex` or `.md` file beside the editor and updates it as you
type. The TeX engines run inside the extension, so you need no TeX installation. Licence: `GPL-3.0-or-later`
for our own code; the TeX engine's parts keep their own terms (see Licence below, `LICENSE` and
`THIRD_PARTY_NOTICES.md`).

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

The plan for the first release is three store items. The two data packages are built and released on GitHub
(`core-data-ae9dbba-2` and `extra-data-ae9dbba-2`, each a `.vsix` with its sources), but the extension is not yet
built, so for now the core data reaches VS Code only in the development test copy.

| Item | What it holds | Size |
|---|---|---|
| liveMd2Tex (`haberwooki.livemd2tex`) | The extension: the compile loop, the TeX engines, the viewer, the Markdown converter, the notices | not yet built |
| liveMd2Tex core data (`haberwooki.livemd2tex-core-data`) | The packages and fonts most documents use, the prebuilt formats | 131.7 MB |
| Extra Packages (`haberwooki.livemd2tex-extra-data`) | Optional: many more packages and fonts, publishers' classes among them | 239.9 MB |

The TeX engines are part of the extension itself. The two data items hold TeX's files only, and no code.
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

Not yet measured. Before the first release, the share of TeX Live's own example and template documents that
compile is measured, with and without the add-on. It is given here for each part on its own (package examples,
journal, conference and thesis templates, and Beamer packages), each with its 95 % interval, with its worst and
best case (every document that could not be measured counted as failing, and as compiling), and with how many of
its documents were left out and why. These documents are written to compile and to show their own package, so the
shares measure package coverage, not papers. The method is written down in `docs/coverage-method.md`.

## What does not work

- `.eps` figures without a PDF copy beside them: turning `.eps` into PDF needs Ghostscript, an outside program.
- Chinese, Japanese and Korean text: their fonts are not included.
- Packages that need an outside program (listed above), and anything else that needs shell escape.
- LuaLaTeX: the engines are pdfLaTeX and XeLaTeX. biblatex runs with its bibtex8 backend, since Biber is not
  included.
- The LaTeX development release (`latex-dev`) and the `mmap` package are left out of the Extra Packages add-on,
  because their files have the same names as files of the core data. The `cmap` package, which the core data
  holds, makes the PDF's text searchable and copyable.
- Also left out of the add-on, because they cannot work here: Chinese thesis and document classes, and four
  general classes whose default font setup loads ctex (they need ctex and its Chinese fonts), LuaLaTeX-only
  classes, packages that need shell escape or a program, packages that need files TeX Live does not ship (the URW
  Arial and MathTime fonts, AcroTeX's form packages), packages whose fonts exist only as Metafont sources (the
  Concrete fonts), and PSTricks, whose figures draw through PostScript and come out empty here.
  `engine/bundle-sets.json` gives each package's reason.
- Some larger font packages are not in the add-on (Fira, Roboto, Source Sans and Source Code Pro, Alegreya,
  Merriweather, New PX, KP Fonts, XCharter and others). The classes and themes that load them are in the add-on,
  but stop with a missing file; `engine/bundle-closure.json` names each.
- Cyrillic in the T2A encoding (`\usepackage[T2A]{fontenc}`, with the Extra Packages add-on) works only in the
  sizes and styles whose font metrics TeX Live ships ready-made. The others need Metafont, which the engine does
  not have, and their text is left out. In a 10 pt document (yes: the text is set; no: it is left out):

  | Size | roman | bold | italic | slanted | bold italic | sans | bold sans | typewriter |
  |---|---|---|---|---|---|---|---|---|
  | `\tiny` (5 pt) | no | no | no | no | no | no | no | yes |
  | `\scriptsize` (7 pt) | yes | yes | no | no | no | no | no | yes |
  | `\footnotesize` (8 pt) | yes | no | no | no | no | no | no | yes |
  | `\small` (9 pt) | yes | yes | yes | yes | no | no | no | yes |
  | `\normalsize` (10 pt) | yes | yes | yes | yes | no | yes | yes | yes |
  | `\large` (12 pt) | yes | yes | yes | no | no | no | no | no |
  | `\Large` (14.4 pt) | no | no | no | no | no | no | no | no |
  | `\LARGE` (17.28 pt) | yes | yes | no | no | no | no | no | no |
  | `\huge` (20.74 pt) | no | no | no | no | no | no | no | no |
  | `\Huge` (24.88 pt) | no | no | no | no | no | no | no | no |

  So `\section` headings, which are bold `\Large`, are left out.
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

liveMd2Tex is free software. Our own code is GPL-3.0-or-later (`LICENSE`), and `package.json` declares
`GPL-3.0-or-later`. The TeX engine as a whole can be passed on under GPL-3.0, because one of its parts, xpdf,
allows GPL-2.0 or GPL-3.0 and no later version. Each part of the engine keeps its own terms. No program code under
the AGPL ships, but some TeX packages in the Extra Packages add-on stay under the AGPL. Copyright (C) 2026 the
liveMd2Tex authors; `AUTHORS.md` in the repository says who they are. The parts by others and their licences are
in `THIRD_PARTY_NOTICES.md`. The licence texts and the notices of the engine's parts ship in `dist/licenses/`.

The source code of each release is the tag of its version in this repository: for this version, the tag `v0.0.1`
of https://github.com/haberwooki/liveMd2Tex. The tag is `v` and the version, its tree holds the whole source, and
each release's page links it.

The engine is built by this repository from TeX Live's source at commit `6a300188` with Emscripten 6.0.13.
`engine/build/` holds the build, and `THIRD_PARTY_NOTICES.md` ("The engine's source") gives each source archive's
address and SHA-256. Each release that ships the engine carries a copy of these archives, attached before the
release is published, so they stay available. In the same way, each data package's release (`core-data-ae9dbba-2`,
`extra-data-ae9dbba-2`) carries the TeX Live archives of its packages under the GPL, LGPL or AGPL
(`<tag>-sources.tar`, listed in `sources.json`), the package database they were checked against, and the package's
licence texts (`<tag>-LICENSES.tar`). The core data stores most of its Type 1 fonts in a packed form that
compresses better, while the add-on ships its fonts unchanged. So only the core data's release also carries the
archives of the GPL fonts it packs.

liveMd2Tex's engine and data packages are built from TeX Live 2026 with changes of our own. The engine's programs
are linked with our own stubs for `system()` and `popen()` and our own stand-in for fontconfig, and without
libpaper. The data packages hold a selection of TeX Live's packages, without their documentation, sources and
scripts, with configuration files and formats that we write, and with most Type 1 fonts of the core data stored
packed. `docs/DEVELOPING.md` describes each change. Please report problems with them to us, not to TeX Live.

Thanks. liveMd2Tex is built on the work of many people:

- Donald E. Knuth, who wrote TeX, and the authors of the engine's programs: pdfTeX (Hàn Thế Thành), XeTeX
  (Jonathan Kew and SIL International), e-TeX's extensions in both (Peter Breitenlohner and the NTS team),
  dvipdfmx (Jin-Hwan Cho, Matthias Franz and Shunsaku Hirata, after Mark A. Wicks's dvipdfm) and bibtex8 (Niel
  Kempson and Alejandro Aguilar-Sierra, after Oren Patashnik's BibTeX).
- TeX Live, developed as a joint effort by all TeX user groups (https://tug.org/texlive/). The engine's programs
  come from its source. Please consider joining a TeX user group: https://tug.org/usergroups.html.
- The authors of the packages on CTAN (https://ctan.org), whose classes, packages and fonts fill the data
  packages.
- BusyTeX, by Vadim Kantorov. Our engine follows its design, TeX's tools in one WebAssembly program, and holds
  a few of its lines. Earlier development versions of liveMd2Tex ran TeXlyre's build of BusyTeX, by Fares
  Abawi.
- Emscripten, which compiles the engine. Its runtime is the engine's glue, `engine.js`, and its C library and
  memory allocator run inside `engine.wasm`.
- fontconfig (Keith Packard and others). The font list that lets XeTeX find fonts by name describes each font as
  fontconfig does, and follows fontconfig's tables of weights, widths and slants.
- PDF.js, Mozilla's PDF library, which shows the PDF.
- markdown-it and its footnote and definition-list plugins, which read Markdown; isomorphic-git, which reads Git
  repositories; and yaml, which reads front matter.
- The libraries inside the engine: kpathsea (Karl Berry and others), HarfBuzz, Graphite2, TECkit, FreeType,
  ICU, libpng, zlib, pplib, xpdf, SyncTeX and libmd5 (L. Peter Deutsch), with musl, dlmalloc (Doug Lea) and
  LLVM's libraries from Emscripten. `THIRD_PARTY_NOTICES.md` lists each one with its version and licence, and
  `dist/licenses/` holds their licence texts and notices.

Portions of this software are copyright © 2025 The FreeType Project (https://freetype.org). All rights reserved.

The files the extension copies into your folders come with no conditions at all: the starting documents of "New
document from template" (`templates/`) and the example presets (`examples/presets/`) are dedicated to the public
domain (CC0 1.0), so that a paper, thesis or preset you write from them carries no conditions. Each folder has a
`LICENSE.md` notice, and each file with a comment form the line `SPDX-License-Identifier: CC0-1.0`.

## Developing

How the extension is built and tested, the rules its checks enforce, and notes on each part are in
`docs/DEVELOPING.md`. The design is `docs/DESIGN.md`.
