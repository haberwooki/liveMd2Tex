# liveMd2Tex: design

This note is the design that the code follows and cites. The README says how to use the extension, and
`docs/DEVELOPING.md` how to build and test it; this note says what the extension promises and how its parts fit
together. Code comments cite its sections as `docs/DESIGN.md#<section>`.

## Rules

These rules hold for everyone who installs the extension.

1. **One download.** The only download is the extension package (and, if the user wants it, the optional
   Extra Packages add-on, from the same store). Nothing is downloaded after installation.
2. **No network.** The installed extension opens no network connection.
3. **No outside program.** The extension starts no program outside itself. Its only child process is its own
   engine host, started once with `child_process.fork` from one file (`dist/fork.js`), run by VS Code's own
   program in Node mode (`ELECTRON_RUN_AS_NODE=1`). The TeX engines are WebAssembly inside that process.
4. **What only a user can start.** VS Code, not the extension, does these after the user's action: a web or
   e-mail link clicked in the PDF (VS Code's link prompt), a web image in VS Code's own Markdown preview, the
   CTAN page of a missing package and "Report a missing package" (VS Code's link prompt), and "Install Extra
   Packages", which opens VS Code's Extensions view on the add-on.
5. **Checked, not promised.** ESLint bans network modules, process modules, code built from text and the VS
   Code APIs that start programs; test stubs block and record every spawn and socket in the extension host and
   the engine host; a scan reads every JavaScript file of each package; a private-marker scan runs before
   every commit and on CI. `docs/DEVELOPING.md` lists the exact rules.
6. **Development tools stay development tools.** Building and testing use Node, npm packages from a committed
   lockfile, and the installed VS Code. Heavier tools (a TeX Live reference, pandoc, other VS Code versions)
   run on CI only.

## Architecture

- **Extension host** (`src/extension/`): the compile loop, the preview panels, diagnostics, the Markdown
  features, SyncTeX, package help. No vscode-free logic depends on it: the scheduler, the project model, the
  pipeline, the converter and the log parser run in plain Node tests too.
- **Engine host** (`src/engine-host/`): one long-lived child process. It compiles the WebAssembly module once,
  reads the TeX image once into a `SharedArrayBuffer`, and runs each compile in a `worker_thread`. Cancel
  terminates the worker; the process, the module and the image stay. A standby worker prepares the next
  compile. The next job starts only after the previous worker has exited.
- **Compile backend** (`src/shared/backend.ts`): what the compile loop needs of an engine (capabilities, a
  check, a warm-up, compile with change sets, a cancel bound to its job, dispose). The engine service is the
  first implementation.
- **Viewer** (`src/webview/`): pdf.js in a webview with a strict content security policy; two slots swap so a
  new PDF appears at the old reading position.
- **Converter** (`src/converter/`): Markdown to LaTeX with a line map, pure functions.
- **Messages** between the processes are typed (`src/shared/engineProtocol.ts`, `engineJobs.ts`). Between the
  extension host and the engine host they are copied (Node's advanced serialization, a structured clone). Inside
  the engine host the workers read the image from the shared buffer without a copy, and a worker's result
  buffers are transferred, not copied.

### Where things are

| Folder | What it holds |
|---|---|
| `src/extension/compile` | The compile loop: targets and roots, events, the scheduler, one compile (runner), outputs, previews; `controller.ts` wires them |
| `src/extension/project` | The project model: collecting files, confinement, roots, the preamble scan, confined writes |
| `src/extension/engine` | The engine service (the forked engine host), data sets and their resolver |
| `src/extension/packages` | The user's package folder, CTAN ZIPs, the package commands |
| `src/extension/sync` | SyncTeX both ways, read in a worker |
| `src/extension/viewer`, `src/webview` | The preview panel and the pdf.js viewer inside it |
| `src/extension/markdown` | The Markdown features: conversion, the generated-LaTeX view, Export LaTeX, problems |
| `src/extension/coexist` | Living beside LaTeX Workshop |
| `src/extension/diagnostics` | The TeX log parser and the plain-words help for TeX errors |
| `src/extension/templates` | "New document from template" |
| `src/engine-host` | The engine host process and its workers |
| `src/converter` | Markdown to LaTeX |
| `src/synctex`, `src/git`, `src/shared` | The SyncTeX reader, a read-only Git reader, types and checks shared by the processes |
| `scripts` | Build, staging, scans, the fresh public history |
| `templates`, `walkthrough` | The starting documents and the walkthrough pages; both ship in the package |

### One compile, step by step

1. An event (a pause in typing, a save, a change on disk, a command) reaches the scheduler, which decides when
   the compile runs (`compile/events.ts`, `scheduler.ts`).
2. The runner collects the project's files and the editors' unsaved text, and the preamble scan lists what is
   missing (`compile/runner.ts`, `pipeline.ts`; for Markdown the converter runs first).
3. The engine service sends only the files that changed since the last compile (the change set) to the engine
   host (`engine/engineService.ts`).
4. The engine host gives the job to a worker, which mounts the TeX image and the data images the job lists, and
   runs LaTeX, bibtex8 and the passes the log asks for (`src/engine-host/engine/`).
5. The result comes back: the log's problems go to the Problems panel, the PDF to the preview, its SyncTeX data
   to the SyncTeX worker, and on a save the PDF next to the source (`compile/runner.ts`, `outputs.ts`).

## Engine and data

- **Engine.** TeXlyre's BusyTeX build (pdfTeX, XeTeX, bibtex8, xdvipdfmx, makeindex, kpathsea, and LuaHBTeX,
  run in ini mode only; TeX Live 2026), driven by our own code. It ships in the extension's own package
  (`dist/engine/`), since data extensions carry no code. The JavaScript glue is patched so that no route out
  remains: no shell, no network fetch for a missing file, no socket. Shell escape and font generation are off.
- **Pinned inputs.** Every engine and data file is named in `engine/pins.json` with its address, size and
  SHA-256, and checked before use. The patched glue is pinned too.
- **Data sets.** The core data ships with the extension. More packages come from data extensions, today the
  optional Extra Packages add-on. Every data set has `data/manifest.json` (format 1; `DataManifest` in
  `src/extension/engine/dataSets.ts` is the contract): the TeX Live year, the engine build it was made for (the
  SHA-256 of the engine WebAssembly), one image (a `.data` file and its index, in Emscripten's file_packager
  layout), and a package index (each file's package; each package's files and requires). A data set for
  another year or engine build is refused with one plain message. So is an add-on from another TeX Live snapshot
  than the core, once the core names its snapshot: the core's font maps name the add-on's fonts.
- **Building the data sets.** One builder (`scripts/build-bundle.mjs`), run on CI only, makes core-data and
  extra-data from a dated TeX Live snapshot: one pinned SHA-256 for the package database, which lists a SHA-512
  for every package archive. The pin is taken only after TeX Live's signature vouches for the database (gpg on
  the CI runner, with the key whose fingerprint the repository pins). It unpacks the archives with its own xz and tar readers, writes the generated files
  (ls-R, the language files, fmtutil.cnf, the font maps) as TeX Live's tools do, and starts no program but the
  extension's own engine host, which builds the formats and checks that every bundled package loads alone. A
  package whose licence is not free stays out, publisher classes included (decided by the maintainer, 2026-10-22).
  A "collection" package, and a publisher class labelled "other-free" or given no licence, comes in only once its
  files are read and their licences recorded. Each package's TeX files are complete and unchanged as TeX reads
  them. core-data stores its Type 1 fonts packed (t1c; font packing: decided by the maintainer, 2026-10-22): each
  .pfb with its eexec section and charstrings decrypted, so the image and the package compress it. The engine host
  encrypts a packed font again when TeX opens it, checks the original's SHA-256 that the image's index records,
  and serves exactly the original bytes; a font that fails the check does not open, and the compile names the
  damaged data set, for the user to reinstall. The index and the manifest must list the same packed files, or the
  engine host refuses the image. A compile keeps the fonts it opens in memory until it ends: at most the core's
  packed fonts, about 100 MB, which only a test that reads every font reaches. Which fonts are packed is
  decided font by font, by the terms the font's own header states: only the LPPL, the GUST Font License, the GPL
  and DejaVu's terms. A font under the SIL Open Font License (which counts a change of format as a modification),
  IBM's Courier terms, no clear terms, or a package's mixed terms is stored as it is. The package's licence file
  says how the fonts are stored, groups them by their terms, and quotes the licence terms on it.
  For each packed font under the GPL, a notice of the change (`LICENSES/CHANGES-GPL`) gives its path, its
  original's SHA-256, what was done and the date of the build (decided by the maintainer, 2026-10-26).
  Documentation,
  sources and programs stay out, also where TeX Live lists them as run files, and the build fails if a program
  file (a .jar, a Python wheel, a script, a binary) would ship. The data extensions list
  every package's licence and CTAN page, and ship the licence texts each package requires in `LICENSES/`, with
  an INDEX that names each package's files: the texts of its licences, pinned by their SHA-256, and its own
  licence files or the file that states its terms, from its archives. A package whose licence text is not found
  stops the build. The workflow runs in separate jobs (pin, fetch, build, a sharded
  closure test, the corpus, and a TeX Live reference in a job of its own), and each keeps its report on a failure.
- **Mounting.** The engine host mounts a data extension's image whole, when a compile needs one of its packages
  (or an earlier "not found" named one of its files), under a tree searched after the user's own packages and
  before the core. It keeps images by id, version and content, forgets images that were removed or updated,
  and a worker mounts exactly the images its job lists. A Type 1 font file that pdfTeX cannot open counts as
  "not found" too, and so does a font that XeTeX cannot find by name. XeTeX finds an add-on's OpenType and
  TrueType fonts by name, because fontconfig's file names the add-ons' font folders.
- **Package help.** Before each compile a preamble scan lists every file the document needs that no installed
  set has, in one message with the fix. It includes the dependencies of packages it knows, but not yet those of
  a package in a data set that is not installed, until that set's manifest lists them. The fix: install the add-on, add a package from a file
  (a `.sty`, `.cls`, `.dtx` with `.ins` built on the bundled engine, or a CTAN ZIP), or put a copy in the
  project. Font packages and packages that need an outside program get their own message.
- **Results.** A PDF that comes back cut short is no PDF: the compile fails, and the preview keeps the last
  good one.

## Converter

- A markdown-it parser and our own LaTeX writer, one LaTeX line per Markdown line (the line map), so errors
  and clicks map back to Markdown lines.
- The dialect follows pandoc's Markdown where most people write it: CommonMark and GFM tables, math passed
  through, pandoc citations, front matter, raw LaTeX, figures and tables with captions and labels,
  cross-references, footnotes, fenced divs, and common GitHub and Obsidian habits. Each unsupported construct
  gives one plain warning.
- The converter never fetches anything: a remote image becomes a placeholder.
- Templates: an article template on pdfTeX by default; a XeTeX notes template when the text needs characters
  outside Latin Modern.

## Presets

- A folder config (`.latexpreview.json`) can name a preset: a named config with preamble templates, figure
  and table layout, Unicode overrides and note patterns. The repository ships a generic example preset (CC0,
  see Store and packaging).
- Drafting notes have no built-in pattern: with no preset, no line is a note. A preset names its own inline
  marker (the example preset uses ` TODO:`), its block-quote prefixes and its note sections.
- Paths that a config or preset names are read only inside the project folder, never through a link.
- Preset patterns are untrusted text: they run on a restricted, linear-time matcher with caps on size and work,
  never as JavaScript regular expressions.

## Sync

- SyncTeX both ways: a click in the PDF opens the source line; "Show this line in the PDF" scrolls the
  preview there. For Markdown the line map adds the step back to the Markdown line.
- Each PDF and its SyncTeX data share a tag, so a click is answered from the data of the PDF on screen.
- SyncTeX data is read in a worker of the extension host, off the main thread.

## Multiple documents

- **Roots.** Each `.tex` file with `\documentclass` is its own document with its own preview. A file without one
  belongs to the document its `% !TEX root` comment names (inside the project), else to a document in its
  folder or the folder above that includes it (`src/extension/project/roots.ts`).
- **Following the editor.** Switching to a document brings its preview to the front of the preview's own group,
  never over the editor. A document without a preview yet is typeset when another preview is showing (setting
  `previewFollowsEditor`).
- **Shared files.** When several documents read the same file (a shared `.bib`, a shared section), a change to
  it compiles only the previewed document; the others catch up when their preview is shown again.

## Confinement and trust

- **The project folder** is the workspace folder that holds the document, or the document's own folder when
  none does. Only the document's folder and below are walked; files the documents name elsewhere in the
  project folder are read by name.
- **Nothing outside it is read.** An absolute path, or `..` that leaves the folder, is refused with a plain
  message on its line. A file is read only when its real path (every link resolved) lies inside; on a remote
  file system no part of the path may be a symbolic link.
- **Nothing outside it is written.** Every write into a project (the PDF on save, a package copied into the
  project, Export LaTeX, a folder config) refuses a link at the target or on its way, and goes through a
  temporary file and a rename.
- **Untrusted text is not repeated.** A folder config or preset that is not valid JSON is reported without
  quoting it, and preset patterns run only on the extension's own matcher (Presets).
- **Workspace Trust.** In Restricted Mode nothing compiles by itself; a compile command asks first; the
  workspace cannot switch on the Markdown HTML view.
- **Beside LaTeX Workshop.** One question, once per workspace, offers to turn off its automatic build; no key
  and no PDF editor of ours overlaps with it.
- **Private material** never enters the repository: private test documents live outside it and are found
  through a git-ignored file; private markers are kept outside it too, and the scan fails without them.

## Accessibility

- **Keyboard.** Every toolbar action of the preview is also a VS Code command, with a key while the preview has
  focus; F6 moves between VS Code's parts as usual. Only while the preview has focus do Ctrl+=, Ctrl+- and
  Ctrl+0 take the place of VS Code's own keys (window zoom, and Ctrl+0 for the Side Bar).
- **Screen readers.** The toolbar is a labelled toolbar; each page is a labelled region, and pdf.js's text layer
  keeps the words readable. A live region says "Preview updated", and how many errors a compile had.
- **Colours and motion.** Colours come from VS Code's theme. Under a High Contrast theme a toggle draws the pages
  in the theme's colours. Nothing animates when VS Code or the system asks for less motion.

## Store and packaging

- **The package.** One universal VSIX for every platform: JavaScript and WebAssembly only, no native code, no
  source maps, no `node_modules` (dependencies are bundled). Every file is scanned before release.
- **Data extensions** carry no code. The Extra Packages add-on is never a dependency: the user installs it from
  the same store through VS Code's Extensions view.
- **Licences.** The extension is GPL-3.0-or-later; TeXlyre's BusyTeX build (its JavaScript glue and the engine
  WebAssembly) keeps its AGPL-3.0 terms inside the combined work. Every bundled package's licence text ships in
  `dist/licenses/`, and so does the notice of every part linked into the engine (`dist/licenses/engine/`,
  pinned in `engine/engine-notices.json`). `THIRD_PARTY_NOTICES.md` lists the parts by others. Each release
  is tagged `v<version>`, README.md and the notices give that tag's tree as the source, and the release carries
  the engine's source archives and the data packages' GPL sources, attached to the draft release before it is
  published and before any package reaches a store (`.github/workflows/release-sources.yml`).
- **What is copied into users' folders is CC0.** The starting documents (`templates/`) and the example presets
  (`examples/presets/`) are dedicated to the public domain (CC0 1.0), so a paper, thesis or preset built from
  them carries no conditions. Each folder has a `LICENSE.md` notice, each file with a comment form an SPDX
  `CC0-1.0` line, and the CC0 legal text ships in `dist/licenses/`. "New document from template" writes the files
  as they are, with no header of the extension's. `package.json`'s expression stays
  `GPL-3.0-or-later AND AGPL-3.0-only`, the terms of the extension as a whole; the VSIX scan checks the notices,
  the legal text and the SPDX lines.
- **Releases** are built on CI from pinned inputs, so anyone can check them.
- **The public history** is made from scanned trees, never from the development history: one commit per sync
  (`scripts/public-sync.mjs`) with a message written for it, after the private-marker scan and the 8-word check,
  either of which stops it; the owner pushes.

## Live behaviour

- **When to compile.** A pause in typing (1 s by default) compiles the unsaved text in a quick pass (one TeX
  pass on the carried `.aux` and `.bbl`). A save, a manual compile, or a change on disk to a `.bib` file or a
  figure asks for a full pass (LaTeX, bibtex8 when needed, and the passes the log asks for). A save also writes
  the PDF next to the source, only from saved text.
- **One compile at a time.** A newer change of the same document cancels its running compile, except the
  document's first. Package builds run as tool jobs in the same slot: a build and a compile never cancel each
  other. A watchdog releases a compile that is stuck outside the engine. A compile command answers with the
  compile it asked for, not with an older one still running.
- **Change sets.** Only the files that changed since a project's last compile cross to the engine host; the
  engine host keeps each project's files, within a byte limit.
- **Files.** Reads go through a cache that the file watcher clears; a file open in an editor is always read from
  disk; full passes check each cached file's size and time.
- **The preview** opens on the first compile, follows the active document, keeps the last good PDF, and stays
  closed when the user closes it until a command opens it again. A preview the user puts in the editor's own
  group stays behind the editor; it is never brought over it.

## Help for new users

- **New document from template** (`src/extension/templates/`) makes a new folder with a starting document:
  LaTeX for the classes the core data carries (article, report, beamer) and for three journal classes that
  come with the Extra Packages add-on, Markdown for the converter's templates, and a Markdown paper with the
  example preset and its folder config. Nothing is overwritten, by construction: the folder gets a free name, a
  parent folder that cannot be listed or a folder that is already there is refused, and each file is created only
  when it does not exist; two runs at once take turns (`templates/place.ts`). A Markdown document asks to be typeset in its front matter. The
  starting documents are in `templates/` (CC0, as the example preset).
- **The walkthrough** (`walkthrough/`) has five steps: open a sample, see the preview, try Markdown, a missing
  package, and working beside LaTeX Workshop.
- **Help for TeX errors.** The 20 most common TeX errors, and two font errors (a Type 1 font file pdfTeX cannot
  open, a font XeTeX cannot find by name), get a sentence in plain words after TeX's message in
  the Problems panel, on a line of its own, with the error's id as the problem's code: what usually causes the
  error, and what to try, naming the command, file or environment (`src/extension/diagnostics/errorHelp.ts`).
  For an undefined command it names the one TeX did not know, also inside a macro or an argument (the log
  parser keeps TeX's first context line). On a Markdown line the help speaks of Markdown: the front matter, not
  the preamble or a `% !TEX` line. Each error has a fixture that makes it happen on the engine
  (`test/fixtures/tex-errors/`, with harder cases in `variants/`). epstopdf's note that shell escape is off,
  which every pdfLaTeX document with graphicx and hyperref gets, is left out unless the project has an .eps file;
  then it, and the failed conversion of the figure, say to put a PDF copy beside it.

## Testing

- **Unit tests** run in plain Node with the stubs loaded: the scheduler on a fake clock, the project model,
  the converter, the scans, the manifest checks.
- **Engine tests** run the real engine in the engine host with its stubs: a public corpus of sample documents
  (page counts and missing-package lists are compared with a recorded baseline), cancel races, change sets,
  data images, package builds.
- **VS Code tests** run in the installed VS Code (on CI, in downloaded versions) in a throwaway profile, with
  the stubs in the extension host and the engine host; a separate window runs Restricted Mode. Another window
  has LaTeX Workshop installed: there the stubs also allow its MathJax worker and its PDF viewer's server on the
  loopback address, which it needs to activate, so the tests meet it building on save beside ours.
- **Scans.** The VSIX scan, the private-marker scan (also of encoded forms), the licence check.
- **Coverage** is measured on CI as `docs/coverage-method.md` writes down: about 400 recent arXiv papers (CC BY
  and CC0, stratified), and thesis and Beamer templates, each compiled with core-data alone, with extra-data, and
  with a full TeX Live of the same snapshot (without network, with Ghostscript). Both sides are held to the same
  rules, every sampled document is reported ("not measured" with its reason included), and the shares carry 95 %
  Wilson intervals. A rehearsal on the public corpus and a few probes proves every step before any arXiv request.
- **Private tests** are not in the repository. A git-ignored `.private-fixtures.json` can point to private
  documents and to a private test folder. `scripts/private-tests.mjs` compiles that folder against the
  repository, and each test runner adds its tests when it is named. Otherwise they are skipped, and the runners
  say nothing.
- **CI** runs Linux x64 and arm64 and Windows x64 on every change to the main branch, and Windows arm64 and
  macOS on release candidates; a plain Node 24 job runs weekly. The search for the oldest VS Code version that
  passes runs by hand and on release candidates.
