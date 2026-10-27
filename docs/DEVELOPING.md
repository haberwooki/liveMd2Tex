# Developing liveMd2Tex

How to build and test the extension, the rules its checks enforce, and notes on each part as it was built. The
user's page is `README.md` (also the store page); the design, which the code cites, is `docs/DESIGN.md`.

## Names

Confirmed by the maintainer on 2026-10-16: publisher `haberwooki`; extension `haberwooki.livemd2tex`
(display name liveMd2Tex); data extensions `haberwooki.livemd2tex-core-data` and
`haberwooki.livemd2tex-extra-data`. Commands, settings and view IDs start with `livemd2tex.`. The repository
is https://github.com/haberwooki/liveMd2Tex (private for now). Its history is the fresh public history
(`fresh-history.mjs`, then `public-sync.mjs`, below), never this repository's own. `src/shared/identity.ts`
holds these names for the code, and `test/unit/identity.test.ts` checks that it agrees with `package.json`.

`docs/DESIGN.md` is the design: the rules, the parts and how they fit, the path of one compile, the engine and
data contract, the converter, confinement and trust, the store shape, live behaviour, accessibility, help for new
users and testing. Code comments cite its sections.

## What you need

- Node 22 and its npm.
- VS Code installed (the integration tests run the installed VS Code; they never download one).
- git.

Nothing else: no Python, Perl, pandoc, WSL, Docker, browser or second VS Code.

The same holds for B1's bundle builder (`scripts/build-bundle.mjs`), which runs on GitHub only: it starts no
Python or Perl and refuses both from its first line. One CI job is the exception, and it is outside the builder.
The bundle workflow's reference job runs TeX Live's own installer and `tlmgr`, which are Perl, on the GitHub
runner only (see "CI and the public history on GitHub" below).

## Install, build, check

```sh
npm ci --omit=optional     # from the committed lockfile; .npmrc also sets ignore-scripts=true
node scripts/install-hooks.mjs   # once per clone: the private-marker scan before every commit
node scripts/build.mjs     # dist/: extension, fork file, engine host, viewer, browser bundle
npm run lint               # ESLint, including the process and network rules below
npm run typecheck          # TypeScript, extension host and webview
npm run compile            # tsc to out/ (emptied first), used by the tests
npm run test:unit          # Mocha under plain Node, with the stubs loaded
npm run test:integration   # @vscode/test-cli against the installed VS Code (opens a test window)
npm run scan:vsix          # package with vsce and scan every file in the VSIX
npm run scan:markers       # private-marker scan of the working tree
npm run check:stores       # are the three extension IDs and the publisher still free on the Marketplace and Open VSX?
```

## What lands on your computer

`npm ci --omit=optional` installs about 215 MB of npm packages into `node_modules` (204 MB before C0a added
markdown-it, its two plugins, yaml and isomorphic-git, all pure JavaScript) and adds about 200 MB to npm's
shared cache. There is no native program among them: the bundler is `esbuild-wasm` (esbuild compiled
to WebAssembly), the optional native packages of `@vscode/vsce` (signing, keyring) and of `pdfjs-dist`
(canvas) are left out, and no package install script runs. The integration tests use the installed VS Code
with a throwaway profile under the system temp folder (`--user-data-dir`, `--extensions-dir`), deleted after
the run; `.vscode-test.mjs` refuses to download a VS Code build. The engine work adds the pinned engine files
in `../engine_assets/` (about 380 MB: the TeXlyre engine and image, 366 MB, and the CTAN set, 13.6 MB) until
the data packages are built on CI (docs/DESIGN.md#rules), and small result files in `../s1_runs/`.

## The rules the checks enforce

- ESLint (`eslint.config.mjs`): `child_process` only in `src/extension/engineHostFork.ts` (the one fork
  file), never in `src/engine-host/`; no `http`, `https`, `net`, `tls`, `dgram`, `http2`, `ws`, `undici` or
  `dns` anywhere, and no `inspector` (it opens a port) or `cluster` (it starts processes); `vscode.git` banned
  (it runs `git.exe`); `node:wasi` only under `src/spikes/s1c/`; no `fetch`, `WebSocket`, `XMLHttpRequest` or
  `EventSource` anywhere in `src/`, the webview included; no `require()`, `process.binding` or
  `getBuiltinModule`; no `eval`, `Function` constructor or `Worker` from source text; and no VS Code API that
  starts a program for the extension: `workspace.findFiles` and `findTextInFiles` (they run ripgrep), tasks,
  `ShellExecution`, `ProcessExecution` and `window.createTerminal`.
- Stubs (`test/stubs/`): the process stub makes `spawn`, `spawnSync`, `exec`, `execSync`, `execFile`,
  `execFileSync` and any fork except the engine host throw; the network stub makes every socket, server, DNS
  lookup, HTTP(S) request, `fetch` and `WebSocket` throw. Both record each attempt. Unit tests run with them
  loaded; the integration tests load them into VS Code's extension host, and both load them into the
  engine-host child with `execArgv: ['--require', ...]`. One window is different: the coexistence window
  (below) also allows LaTeX Workshop's own MathJax worker and its PDF viewer's server on 127.0.0.1, which it
  needs to activate (`test/stubs/coexist.cjs`).
- VSIX scan (`scripts/vsix-scan.mjs`): every JavaScript file in the package is parsed and searched for the
  modules `child_process`, `ws`, `net`, `tls`, `http`, `https`, `dgram`, `http2`, `undici`, `dns`,
  `inspector`, `cluster`, the names `fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource`,
  `RTCPeerConnection`, `WebTransport`, `sendBeacon`, and code built from text (`eval`, `Function`, a `Worker`
  with `eval`, `process.binding`). `child_process` is allowed only in `dist/fork.js`; any other hit must be on
  `security/vsix-scan-allowlist.json` with its file, line and reason. The scan also fails on native files,
  source maps, `node_modules` and private markers in the package, and on a missing licence text (the notices,
  `dist/licenses/`, ICU's licence and MakeIndex's notice wherever the engine is, and in a test copy the TeX Live
  and DejaVu licences). The test copy's patched engine glue
  must match the SHA-256 pinned in `engine/pins.json`. Limits of the scan: it reads names as written, so a
  name built at run time (`globalThis['fe' + 'tch']`) or a `Worker` class reached through `require(...)` inside
  an expression is not seen. No shipped file uses either today (a text search finds none).
- Private-marker scan (`scripts/marker-scan.mjs`): run by the pre-commit and commit-msg hooks, on its own,
  and over the whole history before the repository is published. The markers are not in the repository in any
  form: they come from a git-ignored `.private-markers.json` (in the repository folder or the folder above it)
  and, on CI, from the secret `LIVEMD2TEX_PRIVATE_MARKERS`. Without markers the scan fails instead of passing.
  It also decodes what a file may hide a marker in, and searches the result: escapes, HTML entities, character
  codes, base64, base32, hex, percent encoding, UTF-16 and ROT13, plus a marker written backwards or split up.

## The TeX engine (S1)

The engine is TeXlyre's BusyTeX build (pdfTeX, XeTeX, LuaHBTeX in ini mode, bibtex8, xdvipdfmx, makeindex,
kpathsea; TeX Live 2026) run by our own driver in `src/engine-host/engine/`. Its files are not in this
repository: `engine/pins.json` names each one with its URL, size and SHA-256 (the TeXlyre release, and a small
CTAN set: corpus samples, the publisher classes, DejaVu).

```sh
npm run engine:assets   # fetch and check every pinned file into ../engine_assets/ (about 380 MB; never inside the repo)
npm run engine:patch    # apply engine/patches/busytex-glue.mjs to the glue, into ../engine_assets/derived/<hash>/
npm run test:engine     # the S1 gate: fixtures, public corpus P1-P8, the engine-host design, any private tests
```

On a fresh clone, run the first two commands before the tests. Without the engine files every engine test is
pending, and `stage-engine` says it skipped. CI fetches the files before its tests.

- The glue patches (reviewable diff: `engine/patches/busytex.js.diff`) close every route out of the engine:
  `\write18` and `os.execute` get "no shell", kpathsea never fetches a missing file from the network, and
  every socket fails with "permission denied". `engine/texmf-override.cnf` turns shell escape and all `mktex*`
  font generation off; every LuaTeX call passes `--nosocket`.
- The engine host compiles the WebAssembly module once, reads the image (342 MB, LZ4) with `fs` into a
  `SharedArrayBuffer`, and runs each compile in a `worker_thread` (one at a time); cancel terminates the worker.
  Each worker unpacks the image into its own buffers. The next compile starts only after the cancelled worker
  has exited. A cancel names its job, and the engine host ignores a cancel for any other job.
- Only the files that changed since a project's last compile cross to the engine host. The engine host keeps
  each project's files (the last 8 projects, at most 256 MB together; a document with no preview and no editor
  tab is dropped). After a restart, or after its project was dropped, it asks for the whole project once.
- When the engine fails to start or load, its process is stopped and the error shows once. Later compiles fail
  quietly with the same message, until the engine files change or you run "Compile this document now" (or
  "Open LaTeX preview" for a Markdown file), which tries again and always answers with a pop-up.
- The main file may have spaces or accents in its name, or an upper-case `.TEX`. File names are case-sensitive
  in the preview on every system: `\input{Chapter1}` does not find `chapter1.tex`, even on Windows and macOS.
- `engine/fonts.conf` gives XeTeX the bundle's OpenType and TrueType folders only; the first XeTeX run writes a
  fontconfig cache that later compiles reuse.
- Engine tests can run under VS Code's own Node: set `ELECTRON_RUN_AS_NODE=1` and run
  `"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" node_modules/mocha/bin/mocha.js --config .mocharc.engine.cjs`.
- Results go to `../s1_runs/`, outside the repository. For a private document they hold numbers only. The
  tests fail when the engine host's peak memory reaches 1.5 GB, or a cancel takes a second or more.

## Version 0: compile on save (V0)

- Saving a `.tex` file compiles its root document: the file named by `% !TEX root`, the file itself when it
  has `\documentclass`, or a file beside or above it that includes it. The engine is chosen per document: a
  `% !TEX program` comment, then the preamble (`fontspec`, `unicode-math` or `polyglossia` mean XeLaTeX), then
  the `livemd2tex.engine` setting. A first compile runs LaTeX, bibtex8 (when the document has a
  bibliography), LaTeX, LaTeX; later saves reuse the `.aux` and `.bbl` and run one pass, with bibtex8 again
  only when the citations or a `.bib` file change.
- Every compile runs in nonstopmode, so a PDF comes back even with errors. The log (`-file-line-error`) and the
  BibTeX `.blg` go to the Problems panel in the extension's own diagnostics collection, with file and line.
- The PDF shows beside the editor and is updated in place; `name.pdf` is written next to the source (a
  temporary file, then a rename). It is written only from saved text: when a file of the compile is open with
  unsaved changes, the PDF is not written, and the log says why. A PDF cut short (xdvipdfmx failed, or a
  program stopped in the middle of the file) counts as no PDF: the compile fails with a plain message in the
  Problems panel, the preview keeps the last good PDF, and nothing is written next to the source. A status bar item shows the state; the log
  (the liveMd2Tex output channel) has one line per compile with its latency.
- When you close the preview, it stays closed while you type. The compile command or "Show the PDF preview"
  opens it again. When you also close the document, the next compile after you open it again shows the
  preview as before.
- A Markdown file is typeset only on the "Open LaTeX preview" command, or when its front matter has
  `latex-preview: true` or its folder's `.latexpreview.json` has `"latexPreview": true` at the top level. The
  converter's LaTeX is compiled as an in-memory `name.tex` (a real `name.tex` beside it is not read, and its
  `name.pdf` is not overwritten); TeX problems are shown on Markdown lines through the converter's line map,
  next to the converter's own warnings (M1, below).
- In Restricted Mode nothing compiles by itself; a compile command asks first (a yes holds for the session). When LaTeX Workshop is
  installed and builds on save, the extension offers once per workspace to turn its auto-build off.
- The engine host starts on the first compile and stops after `livemd2tex.engineIdleMinutes`.

The engine and data are not in the normal package yet (the data packages come with B1 and G0). For a
development machine:

```sh
node scripts/stage-engine.mjs --data       # put the engine, TeXlyre's image and the DejaVu fonts into dist/ (hard links), for F5 and the tests
node scripts/vsix-scan.mjs --test-copy     # build, stage, package and scan the test copy (about 270 MB) into out/vsix/
```

The test copy goes into a throwaway VS Code profile only (`code --user-data-dir DIR --extensions-dir DIR
--install-extension FILE`, then `Code.exe` with the same two folders), never into a normal profile.
`npm run test:engine` includes the V0 route at Node level (`test/engine/v0.test.ts`: every corpus document
through the save pipeline, a second save, a bibliography change, errors on their lines, the Markdown corpus),
and `npm run test:integration` lays the corpus out as the test window's workspace and saves each document in
the editor (`test/integration/v0.test.ts`).

## Live preview: when to compile (M2-A)

- `src/extension/compile/scheduler.ts` decides when to compile, with no VS Code in it. An edit starts a quick
  pass (one TeX pass on the unsaved text, reusing the `.aux` and `.bbl`) after a pause in typing
  (`livemd2tex.pauseMilliseconds`, 1 s). A save, a manual compile, or a change on disk to a `.bib` file or a
  figure asks for a full pass; a save also writes the PDF next to the source. Quick-pass PDFs stay in memory.
- Every event raises the document's generation number. One compile runs at a time. A newer change to the same
  document terminates its running compile (`worker.terminate()` in the engine host; the process, the compiled
  module and the image stay), except the document's first compile, which always finishes. A cancelled
  compile's pass kind and save carry over to the one that replaces it.
- A quick pass whose log asks for another pass, or whose citations changed, is followed by a full pass.
- The engine host keeps one worker on standby that has already instantiated the engine and mounted the image,
  so a compile pays only for its own files and the TeX run.
- TeX runs with `-recorder`; the files each compile read (and its `.bib` files) are watched, and a change on
  disk to one that is not open in an editor recompiles.
- The status bar switch (`$(zap) Live` / `$(save) On save`, setting `livemd2tex.compileOn`) turns live
  compiles off; saves still compile. The engine host stops after `livemd2tex.engineIdleMinutes`.
- Confinement (`src/extension/project/confine.ts`): the project folder is the workspace folder that holds the
  document (the document's folder when none does). Only the document's folder and below are read, plus files
  the documents name elsewhere in the project folder. An absolute path, or a `..` that leaves the project
  folder, is not read, and the Problems panel says so on its line (`\input{../../.ssh/id_rsa}` is the
  fixture). A file reached through a link (a symbolic link or a Windows junction) that leads outside the
  project folder is not read either, and the Problems panel says so too. A file in no workspace folder reads
  only the files beside it, plus the files it names.
- The named files come from `\input`, `\include`, the graphics and listings commands, `\VerbatimInput`, the
  bibliography commands, the `import` package, the folders of `\graphicspath`, and `\usepackage`,
  `\documentclass` and `\bibliographystyle` when the name holds a path. `\openin` and names built by macros are
  not followed.
- Files are read through a cache that the file watcher clears, so a compile reads again only what changed. A
  file open in an editor is always read from disk, so a save compiles the text just saved even when the
  watcher's news comes late. Saves and other full passes also check each kept file's size and time, because
  watchers miss changes on some drives (network drives, WSL's view of Windows drives). "Compile this document
  now" reads the whole folder again. When another program changes a file that is open and saved, the watcher's
  event compiles it, in "On save" mode too.
- Unsaved text is sent in the document's own encoding: a Latin-1 file stays Latin-1.
- The engine allows one compile 10 minutes. A compile that has not finished after 12 minutes (stuck in a file
  read or in the viewer) is cancelled and released, so one stuck compile never stops the others; the status
  bar says so. The last 200 compile records are kept, and a document with no preview and no editor tab is
  forgotten.
- Each compile's log line has its latency: last keystroke to preview, event to PDF, event to preview.

`npm run test:engine` runs `test/engine/m2a.test.ts` (confinement, watched files, quick passes, cold start) and
`test/engine/liveSession.test.ts`, a scripted typing session through the scheduler and the engine
(`M2A_SESSION_SECONDS=600` for the ten-minute session; 45 s by default). The short run only checks that the
loop gives fresh PDFs, and its test title says so. The latency limit is the single pass plus 1 s: S1's figure
for T1, and a fixed figure measured the same way for P1.

## The PDF viewer (S3)

`src/webview/viewer.ts` shows PDFs with pdf.js 6.4 in a webview under the CSP `default-src 'none'`, scripts
from the webview's `cspSource` with `'wasm-unsafe-eval'`, `worker-src blob:`. Two slots swap so a new PDF
appears at the old reading position. pdf.js's worker is built from its source text, which the extension sends,
because a `blob:` worker cannot load files by URL in a VS Code webview (VS Code's resource service worker cannot
tell which webview such a request belongs to; it answers 408 after 30 s). For the same reason pdf.js runs with
`useWorkerFetch: false`: the page loads cMaps, standard fonts and pdf.js's WASM decoders from inside the
extension and hands them to the worker. pdf.js then skips ICC colour management (CMYK uses its built-in
conversion). Bytes sent to the webview are always plain `Uint8Array` views: a Node `Buffer` would arrive as
`{type: 'Buffer', data: [...]}`.

## Private test files

Private documents and the tests that use them never enter this repository. A git-ignored
`.private-fixtures.json` (format: `.private-fixtures.example.json`) points to copies kept outside it. Tests that
need them skip when the file is absent, and nothing derived from them is written inside the tree.

The same file can name a private test folder outside the repository (`"privateTests"`). It is laid out like
`test/`, with `engine/`, `unit/`, `integration/` and `converter/`. Write each test there as if it lay one folder
below the repository root, so it imports `../../src/...` and `../../test/support/...`.

- `scripts/private-tests.mjs` type-checks the folder against the repository and compiles it into the git-ignored
  `out/private/`. `npm run test:unit`, `npm run test:engine` and `npm run test:integration` run it after `tsc`.
- Each test runner adds `out/private/<suite>/**/*.test.js` (`.mocharc.cjs` takes `unit` and `converter`,
  `.mocharc.engine.cjs` takes `engine`, `.vscode-test.mjs` takes `integration`).
- Without the file or the folder, nothing is added and nothing is said (`scripts/lib/private-tests.cjs`).
  `test/unit/privateTests.test.ts` checks this hook on a throwaway folder.

## Integration tests and an open VS Code window

`npm run test:integration` starts a second VS Code window with its own throwaway profile. Keep runs few; the
window closes when the tests finish (about 110 s with the V0 workspace: 58 tests on 2026-10-16, VS Code 1.142).
The throwaway profile's extensions folder starts empty, so the window runs without `--disable-extensions`; the
built-in extensions that start language servers or git are switched off one by one.

Day-1 check (M0, 2026-10-15, VS Code 1.141 on Windows): `@vscode/test-cli` runs while your own VS Code window
is open; the test window uses its own profile and does not touch yours. One exception: while VS Code is
installing an update in the background, it refuses to start any new window from the same installation until
you restart VS Code. The launcher detects that state and says so. If the command line ever cannot run the
tests, run them by hand with F5 (an Extension Development Host); from G0 they also run on CI.

## CI and the public history on GitHub

CI runs on GitHub since G0: on the first commit of the fresh history, and on each later sync once it is pushed.


- `.github/workflows/ci.yml`: the private-marker scan over the tree and the whole history; then, on every push,
  Linux x64, Linux arm64 and Windows x64 (`test-runner.yml`: install from the lockfile, the pinned engine inputs
  cached by `engine/pins.json`, lint, typecheck, unit, engine and VS Code tests, with `xvfb` on Linux; both VSIX
  scans on Linux x64). Windows arm64 and Apple Silicon run on release candidates (tags `v*-rc*`, or by hand). A
  plain-Node-24 job runs the unit and engine tests weekly and on release candidates. The file states the
  minutes estimate for the private phase.
- `.github/workflows/floor.yml`: the integration tests under VS Code 1.105 and older versions, to find the oldest
  that passes. `.github/workflows/references.yml`: pandoc's references for the Markdown corpus, and the
  zeroperl check for v1.1. Both run on GitHub only; pandoc and old VS Code versions never reach a development machine.
- `.github/workflows/release-sources.yml` runs by hand on a draft release, before it is published: it attaches the
  sources of what the release's packages ship ("Licences, notices and releases", below). It is the one workflow
  with write access to the repository's contents, for the release's files; it pushes nothing, and its actions are
  pinned by commit.
- `.github/workflows/bundle.yml` (B1, run by hand) builds the two data packages from the pinned TeX Live snapshot.
  Its jobs are pin, fetch, build, a sharded closure test, the corpus, and the reference; each keeps its report
  when it fails. The pin job checks TeX Live's signature with `gpg` on the runner, against the key whose
  fingerprint `engine/bundle-pins.json` pins.
  - The builder follows the plan's rule: no Python and no Perl.
  - The reference job is the exception, and why it is allowed. It installs the TeX Live that the public corpus is
    compared with, and TeX Live's only installer and package manager (`install-tl`, `tlmgr`) are Perl. The job
    runs on the GitHub runner only. It starts after the build job has put the packages' SHA-256 in the job
    summary, and it downloads only the corpus and the package list, so the Perl never touches a data package.
    It checks the installer against TeX Live's signing key, and installs without root into the runner's temp
    folder. Nothing of it reaches a development machine.
- On CI only, `@vscode/test-cli` downloads the VS Code version the workflow names. Both `CI=true` and
  `LIVEMD2TEX_ALLOW_VSCODE_DOWNLOAD=1` must be set (`scripts/lib/test-vscode.mjs`); elsewhere the tests use
  the installed VS Code, and the launcher fails if a download happened anyway.
- `test/engine/corpusBaseline.test.ts` is G0's acceptance check: the public corpus gives the same page counts and
  missing-package lists on every runner as on a development machine (`test/baselines/corpus.json`, written
  there with `LIVEMD2TEX_WRITE_CORPUS_BASELINE=1` for the image with the same SHA-256).
- `node scripts/fresh-history.mjs` makes the fresh history. It puts the files of `main` in one commit, in a new
  repository outside this one (default `../public_candidate`), with no remote. The commit's author is
  `haberwooki <189794217+haberwooki@users.noreply.github.com>` (`--author` changes it), and its times are in UTC.
  A report goes beside the folder (`../public_candidate.report.txt`). It has the private-marker scan of the tree
  and of the history, any watched words (`--watch`), and every run of 8 words that a public file shares with a
  private fixture or a text file of the private test folder. The repository's owner reads the report before
  anything is pushed.
- `node scripts/public-sync.mjs --message "..." [--ref main]` brings the public repository up to a later commit of
  this one. It adds one commit on top of the public clone's `origin/main`, made from the files of that commit,
  never from this repository's history. The commit has the same author and UTC times. The message is required and
  written by hand (`--message` or `--message-file`); it is never made from this repository's commits. Before
  anything is written, any of these stops the sync:
  - a private file by name (`.private-fixtures.json`, `.private-markers.json`, any `.private-*` path);
  - a private marker in a file, a file name or the message (plain, encoded or decoded);
  - a branch name of this repository, something that looks like a commit hash, or the words "private",
    "overlay", "laptop" or "worklog" in the message;
  - a run of 8 words that a changed file shares with the private texts, unless the reviewed allow-list
    (`../public-sync-allow.json`, outside the repository; `--allow` names another) or the public history
    already holds it;
  - private texts that cannot be read (no `.private-fixtures.json`, a missing folder, a pair that cannot be
    read). `--no-private-check` waives the comparison only on a computer without the private markers file.

  After the commit it scans the clone's whole history again.
  - `../public_candidate.sync-report.txt` holds the report: the changed files, the scans, and the runs that
    stopped it. It is private; keep it out of any upload or issue.
  - `../public_candidate.sync.json` records which commit here each public commit came from. It stays beside the
    clone, never in it.
  - A second run with the same commit changes nothing. The script never fetches, adds a remote or pushes.

## Markdown to LaTeX (C0a)

The extension converts Markdown to LaTeX itself (`src/converter/`), with no pandoc and no outside program. The
dialect aims at pandoc's Markdown, so existing documents work, plus the GitHub and Obsidian habits people use:

- CommonMark, GFM pipe tables (column alignment; long text columns become `tabularx`), strikeout, task lists,
  autolinks including `www.` addresses; smart quotes; footnotes (also `^[inline]`); definition lists; line blocks.
- Math: `$...$`, `$$...$$`, `\(...\)`, `\[...\]`, GitHub's `` $`...`$ `` and ```` ```math ````, passed through
  untouched; `$$...$$ {#eq:id}` becomes a numbered `equation` with a label.
- Raw LaTeX (pandoc's `raw_tex`): `\ref{a}`, `\cite{k}`, `\SI{3}{\metre}` and any `\begin{...}...\end{...}` pass
  through wherever they stand; only lone special characters are escaped. A `~` right before a command is a tie.
  ```` ```{=latex} ```` blocks and `` `...`{=latex} `` spans are copied verbatim.
- Citations `[@key]`, `[@a; @b]`, `[see @a, p. 3]`, `[-@a]`, `@a`, `@a [p. 3]` become natbib (`\citep`, `\citet`,
  ...) or, with `biblatex: true`, biblatex commands. `[@fig:a]`, `[@tbl:b]`, `[@eq:c]`, `[@sec:d]` are cross-references
  (pandoc-crossref style; `\cref` with `cref: true`).
- Images: an image alone in its paragraph with a caption or `{#fig:id width=80%}` is a figure; a `.pdf` beside a
  `.png` is used; a web image becomes a placeholder box (the converter never fetches). `Table: caption {#tbl:id}`
  before or after a table gives a captioned `table` float.
- YAML front matter with pandoc's names (`title`, `author`, `date`, `abstract`, `keywords`, `bibliography`,
  `documentclass`, `classoption`, `fontsize`, `geometry`, `header-includes`, `lang`, `toc`, `numbersections`,
  `biblio-style`, `natbib`, `biblatex`); fenced divs (`::: {.theorem}`, `::: warning`); bracketed spans
  (`[text]{.smallcaps}`); heading attributes (`{#sec:id}`, `{-}`).
- GitHub alerts and Obsidian callouts (`> [!NOTE]`) become framed boxes; `==highlight==`, `^sup^`, `~sub~`;
  `<br>`, `<sup>`, `<sub>`, `<img>`, `<kbd>`, `<details>` and a few more HTML elements are mapped; `[[wikilinks]]`
  become text, `![[image.png]]` an image, `%%comments%%` disappear, `[TOC]` is a table of contents.

Not supported (one plain warning each, and the text passes through): grid tables (`grid_tables`), simple and
multiline tables (`simple_tables`, `multiline_tables`), example lists (`example_lists`), letter and Roman list
markers (`fancy_lists`), CSL styles and citeproc (`csl:`; natbib or biblatex is used), Markdown to Beamer
(`documentclass: beamer`, planned for v1.1), embedded Obsidian notes, icon fonts and other HTML elements.

Every LaTeX line maps to a Markdown line (the line map): "Show generated LaTeX" opens the converted file beside
the Markdown and follows the cursor; "Go to Markdown source" jumps back; "Export LaTeX" writes the `.tex` next to
the `.md` and asks first when Git shows uncommitted changes to it; "Compare generated LaTeX with the committed
.tex" shows a diff against the file at HEAD. The Git reader is isomorphic-git on `workspace.fs` (no `git.exe`),
with linked worktrees and the rule that CRLF-only differences count as unchanged. A folder can set defaults in
`.latexpreview.json` (`markdown.citations`, `cref`, `numbersections`, `documentclass`, `classoption`, `geometry`,
`exportName`, `htmlView`).

The HTML view plugin for VS Code's own Markdown preview does nothing unless the setting
`livemd2tex.markdown.htmlViewPlugin` or a folder's `"htmlView": true` switches it on.

Tests: `test/converter/` (unit, under plain Node with the stubs), with the public corpus P9, P10, P16, P17 and
Manubot's rootstock sample in `test/converter/corpus/` and their hand-written expected structures.

## Presets and class templates (C0b)

A preset is a JSON file of options for the converter, one set per mode. It is off unless a folder config names
it. The same converter, line map and views are used; the preset only changes how text is escaped and how front
matter, captions, figures, tables, citations, notes and the title are written. Turn one on in `.latexpreview.json`:

```json
{ "markdown": { "preset": "presets/two-column-paper/preset.json", "mode": "paper",
                "presetOverrides": { "figures": { "wide": ["fig_overview"] } } } }
```

Without `mode`, the mode whose `entry` pattern matches the Markdown file's name is used. Each mode can name a
preamble template file beside the preset (`{{title}}`, `{{author}}`, `{{date}}` are filled in) and an appendix
file read from beside the Markdown. Options are listed in `src/converter/preset/types.ts`.

A repository can ship its own `.latexpreview.json` and preset, so both are read as untrusted:

- **Paths stay in the workspace folder.** The preset file, its preamble files and the appendix file are read only
  from inside the workspace folder that holds the Markdown file (its own folder when no folder is open). An
  absolute path, a drive letter, a UNC path, `~`, a URI or a `..` that leaves the folder is refused, and so is a
  path that leads out through a symbolic link or a Windows junction. A refused path is a warning on the Markdown
  file in the Problems panel, and nothing is read from it (`src/extension/markdown/confinePaths.ts`).
- **Patterns are a safe subset of regular expressions.** `figures.label`, `tables.label` and
  `appendix.dropLines` accept literals, `.`, character classes, `\d \w \s \b` and their negations, `^` and `$`,
  groups, `|`, and `* + ? {m,n}` (up to 100), in at most 300 characters and 200 automaton states. Look-arounds,
  back-references and named groups are refused with a problem in the log, and that pattern is not used. The
  extension matches the patterns with its own linear-time matcher (`src/converter/preset/safePattern.ts`), and
  caps the work: at most 20 `dropLines`, no line or caption longer than 4,000 characters is tested, and one
  conversion spends at most a million steps on patterns (a character read or an automaton state visited is a step;
  about 10 ms); past a cap a warning says what
  was not applied. Mode `entry` names (`paper*.md`) are matched as `*` and `?` globs by a plain loop
  (`glob.ts`), at most 100 of them, each at most 200 characters.
- **Files are capped too.** A folder config, and each file it or its preset names, is read only up to 4 MB, and
  a folder config that is a link leading out of the project folder is not read. A file that is not valid JSON
  is reported without quoting it.

`examples/presets/two-column-paper/` is a worked example with neutral settings and five modes (CC0, like the
starting documents: `examples/presets/LICENSE.md`):

- paper: two columns, a title banner and a Methods appendix;
- supplement, letter and response;
- report, on XeTeX.

It shows:

- bold "Figure N." captions;
- `[Surname 2020; Surname 2021]` citations as `\cite`;
- wide and side-caption figures chosen by file name;
- a Unicode table;
- skipped drafting-note block quotes, and inline notes cut from a marker (` TODO:`) to the end of the line.

Figure sizes and table fitting are options with plain defaults:

- `figures.graphics`: the `\includegraphics` options of each layout, `single`, `wide`, `side` and `report`. For
  example, `"width=\\linewidth,height=0.8\\textheight,keepaspectratio"` caps a figure's height.
- `figures.sideCaptionWidths`: the two minipages of the side-caption layout, as fractions of the text width.
- `tables.wrap`: LaTeX put before and after an in-place table, such as a `\resizebox` that fits it to the line.

Class templates: a `documentclass` of `revtex4-2`, `IEEEtran`, `elsarticle`, `acmart`, `llncs` or `report`
writes the title, authors, affiliations, abstract and keywords the way that class expects, leaves out packages
the class loads or forbids, and picks its bibliography style (`src/converter/classes.ts`). Starting documents
for each are in `templates/markdown/` (CC0); "New document from template" offers those for REVTeX, IEEEtran,
elsarticle and report (M4, below). CTAN's llncs has no sample paper that compiles, so its starting document is
our own. acmart's fonts (Libertine, newtx, Inconsolata) are not yet in the engine image, so acmart falls back to
Computer Modern until the data packages carry them.

Tests:

- `test/converter/preset.test.ts`: every mode on CC0 stand-ins.
- `test/converter/safePattern.test.ts` and `test/converter/g1bPatterns.test.ts`: the pattern rules, including the
  worst case at every cap. The work is bounded by the matcher's own step count (deterministic); the clock is
  checked only by sanity limits that a busy machine cannot fail. Such a check passes under its fixed limit (2 s),
  or within a multiple of a reference: similar work measured in the same test, under the same load
  (`test/support/clock.ts`, which the other timed tests use too). A pattern that backtracks fails both.
- `test/unit/configPaths.test.ts`: the path rules, with a real junction or symbolic link.
- `test/integration/configConfine.test.ts`: both rules again, in VS Code.

More tests: `test/engine/templates.test.ts` and `test/engine/presetModes.test.ts` (each template and each mode
typesets on the bundled engine). Private tests, such as a preset's output compared with a committed `.tex` under a
whitespace- and comment-blind diff, live outside the repository in a test overlay named by `.private-fixtures.json`,
and are skipped when it is absent.

## Markdown to PDF (M1)

A Markdown file is typeset with pdfLaTeX and the default template unless it has characters pdfLaTeX cannot
print as single characters. Those are Greek or arrows in code or math, box-drawing lines, script letters, most
emoji, and accented letters that pdfLaTeX builds from two parts (ė, ā, ș; the PDF's text would then hold the
two parts, so a search or a copy of the name fails). Such a document is typeset with XeTeX:

- in Latin Modern, the same fonts as the pdfLaTeX template, when Latin Modern has every character;
- otherwise with the notes template: DejaVu Serif, Sans and Sans Mono for text and code, Latin Modern Math for
  math (fontspec and unicode-math).

A notice in the Problems panel says which characters made the choice. `engine: xelatex` or `engine: pdflatex`
and `template: notes` in the front matter, or `"engine"` and `"template"` in `.latexpreview.json`, choose
directly. A preset mode names its engine; `"engine": "auto"` with a `"xetexPreambleFile"` does the same switch
with the preset's own preamble (the example preset's letter and response modes do).

No one font has every character, so the notes template has a fallback rule. A character the main font lacks is
printed, upright, from the first shipped font that has it: DejaVu Sans, Sans Mono, Serif, DejaVu Math TeX
Gyre, then Latin Modern Math. The rule runs inside XeTeX (an interchar class per character, chosen for the
serif text and for the code), so it also works in headings, tables and verbatim blocks. Math characters Latin
Modern Math lacks come from DejaVu Math TeX Gyre. The table of which font has which character
(`src/converter/fonts/coverage.ts`) is measured from the font files by XeTeX itself
(`test/engine/fontCoverage.test.ts`; `UPDATE_FONT_COVERAGE=1` rewrites it). A character that no shipped font
has is shown as `[U+XXXX]`, with a notice on each line where it stands.

Until the data packages carry DejaVu (B1), its files come from the pinned CTAN set. `stage-engine.mjs` puts them
in `dist/data/fonts/`, and the compile hands them to XeTeX as project files
(`src/extension/engine/interimFonts.ts`).

Citations: natbib by default; with `biblatex: true`, biblatex with `backend=bibtex8`, since Biber is not in the
engine. Each unsupported construct gives one plain warning on its first line in the Problems panel, whether the
file was converted for a view or typeset.

Inputs that TeX would stop on are changed, each with a notice: control characters are removed; lists nested
deeper than LaTeX's four levels join the list around them; an HTML block such as `<div align="center">` opened
inside a list item, a quote or a callout ends where that container ends. A Windows path such as
`C:\Users\name` outside a code span is read as LaTeX commands, as pandoc reads it, and gets a notice that
suggests backticks.

The converter runs on the extension host's thread, so it runs as few times as it can: the compile and the
generated-LaTeX view share one conversion per document version, and the log gives each conversion's time (about
150 ms for a 4,400-line note).

Tests: `test/converter/m1.test.ts` (unit), `test/engine/m1.test.ts` (P9, P10, P16, P17 and the CC0 stand-ins in
`test/converter/m1/` through the extension's compile route, with zero "Missing character" lines, the names and
symbols checked in the PDF's text as pdf.js reads it). Private documents are typeset the same way by the private
test overlay, when `.private-fixtures.json` names one.

## Click-to-source and source-to-PDF (M2-A, SyncTeX)

- **PDF to source:** in the preview, a double-click or a Ctrl+click (Cmd+click on macOS) opens the source line,
  with the clicked word selected. For Markdown, the line goes through the converter's line map to the Markdown
  line (or to a preset's appendix file).
- **Source to PDF:** "Show This Line in the PDF Preview" (Shift+Alt+J in a `.tex` or Markdown editor) scrolls
  the preview to the cursor's line and highlights it briefly. A paragraph written on one long line can run over a
  page break; the preview then shows the part that holds the word at the cursor. The setting
  `syncFollowCursor` (off by default) does this on every cursor move.
- **Keyboard:** pdf.js has no caret inside a page, so in the preview, Shift+Alt+J ("Go to the Source of the PDF
  Preview's Centre") opens the source of the view's centre. Every jump is announced in the viewer's
  `aria-live` status.

The `.synctex.gz` the engine writes is read by the extension's own SyncTeX reader (`src/synctex/parser.ts`,
written for this project) in a worker thread (`dist/synctex-worker.js`), so a large file never blocks the
extension host. The reader honours the preamble's `Unit`, `X Offset` and `Y Offset`. pdfTeX writes offsets of 0
and positions that include TeX's one-inch origin; XeTeX puts the inch in the offsets.

TeX gives text the source line where it finished reading it. For a title block that is the line after
`\maketitle`; for a verbatim block or a boxed environment, the block's last line. So a click also sends the word
under it and the typeset line around it, from pdf.js's text layer. When SyncTeX's line does not hold the word,
the source line that shares most words with the typeset line wins (a line of a code block, an author's
affiliation, a click on a symbol), else the nearest line that holds the word (`src/synctex/compose.ts`).

A click on the contents list goes to the heading it lists, on a list of figures or tables to the caption, and on
a bibliography entry to its entry in the `.bib` file (`src/synctex/generated.ts`). SyncTeX names the list TeX made
(`name.toc`, `name.bbl`), and the auxiliary files the compile read say where each line came from. Those come from
the compile before, so on a document's very first compile such a click finds nothing.

Each PDF and its SyncTeX data share a tag, and the viewer sends the tag of the PDF a click was on. A compile that
gives no PDF the viewer can show leaves the old PDF and its data in place, so a click is never answered from the
layout of a PDF that is not on screen.

A click on a link in the PDF opens web and e-mail addresses through VS Code, which asks before it opens a site
(`env.openExternal`); other links (files, programs) are not opened. Links inside the document move the view.

The converter keeps its line map exact for SyncTeX in three places:

- a footnote's text gets a LaTeX line of its own, mapped to the footnote's definition;
- a citation that wraps across a line break keeps the break (`\cite{key%`, then `}`);
- the class templates write `\maketitle\relax`, so `\maketitle` does not read the next line before it sets the
  title.

Tests:

- `test/unit/synctex.test.ts` and `test/unit/syncLists.test.ts` (the contents and bibliography lookup).
- `test/engine/synctex.test.ts` is a harness on P1, P10, and P9 on XeTeX. It picks unambiguous words from the PDF's
  text with pdf.js and clicks them through SyncTeX: ten of ten land within one line. It checks forward search from
  their lines.
- The same harness clicks 100 random characters of the text: common words, maths, numbers, tables, captions,
  footnotes, titles, the contents list and the bibliography.
  - It reports them beside SyncTeX alone, with a floor of 90 % of the points it can judge.
  - Clicks in the lists must reach their heading or `.bib` entry. All 88 did, over the five documents.
- The private test overlay does the same on private documents, when `.private-fixtures.json` names one.
- `test/integration/sync.test.ts` runs both ways through the real viewer.
- `test/integration/syncTags.test.ts` covers a click on the PDF on screen, links, and the lists.

## Several documents, LaTeX Workshop, trust and the keyboard (M2-B)

**Several root documents in one folder.** Each `.tex` file with `\documentclass` is its own document with its
own preview. A file without one belongs to the document named by its `% !TEX root` comment, else to a document
in its folder or the folder above that includes it (`src/extension/project/roots.ts`). The preview follows the
active editor: switching to a document brings its preview to the front, and a second document without a preview
yet is typeset when a preview is showing (setting `previewFollowsEditor`, on by default). A preview you put in
the editor's own group, as a tab, stays behind the editor: neither typing nor clicking the editor's tab brings it
to the front. When several
documents read the same file (a shared `.bib`, a shared section), a change to it recompiles only the document
being previewed. The others' previews add "(out of date)" to their titles, and those documents compile when their
preview is shown again.

**Beside LaTeX Workshop.** The two work together: LaTeX Workshop gives completion and the outline (these
need no TeX installation), and this extension builds and previews.
- When LaTeX Workshop is installed, a `.tex` file opened in a folder brings one question, once per workspace:
  turn off LaTeX Workshop's automatic build for this workspace, so a change does not build twice. Nothing is
  changed without a yes, and only the workspace setting (`latex-workshop.latex.autoBuild.run`).
- None of our keys is one of LaTeX Workshop's; ours start with Shift+Alt or act only inside the preview.
- Our commands, settings and Problems entries carry our own prefix.
- We register no editor for `.pdf` files: a PDF opens in LaTeX Workshop's viewer or VS Code's, never ours.

The rules are unit tests against LaTeX Workshop 10.19.0's own keybindings and PDF editor
(`test/unit/coexistence.test.ts`). `node scripts/run-integration.mjs --with-latex-workshop` also runs the
integration tests beside LaTeX Workshop, installed into a throwaway test profile only. There the stubs allow
LaTeX Workshop two things, so that it activates: the MathJax worker process it forks, and its PDF viewer's
server on the loopback address 127.0.0.1. Its builds stay blocked and recorded. So the tests see both
extensions build on save, and only ours once the offer's setting is written. The walkthrough step about the
pairing is `walkthrough/latex-workshop.md`.

**Workspace Trust.** In Restricted Mode:

- nothing compiles by itself, on typing or on save, for `.tex` and for Markdown that asks for typesetting;
- a compile from a command asks first; a yes holds for the session, and closing the question asks again next time;
- the workspace cannot switch on the Markdown HTML view: its folder configs are ignored, and so is its value of
  `livemd2tex.markdown.htmlViewPlugin`, a restricted configuration in the manifest.

The manifest declares limited support. A setting that names a file path will be listed there as restricted
(none does yet, and a unit test fails if one is added without being listed). `test/restricted/restricted.test.ts`
checks all of this in a real Restricted Mode window: `scripts/run-integration.mjs` starts it with Workspace Trust
on and a workspace nobody trusted, because `@vscode/test-cli` always turns Workspace Trust off.

**Markdown stays opt-in.** The HTML view plugin for VS Code's Markdown preview does nothing unless switched on,
and a Markdown file is typeset only after "Open LaTeX preview", or when its front matter or folder config asks.

**The viewer by keyboard and screen reader.**
- The toolbar (previous and next page, zoom, fit width, go to source) has labels for screen readers.
- Each page is a labelled region, and pdf.js's text layer keeps the words readable.
- Every toolbar command is also a VS Code command:

  | Command | Key, while the preview has focus |
  |---|---|
  | Next and previous page | Alt+PageDown and Alt+PageUp (PageDown and PageUp scroll) |
  | Zoom in, zoom out | Ctrl+= and Ctrl+- |
  | Fit the page width | Ctrl+0 |
  | Go to the source of the view's centre | Shift+Alt+J |
  | Focus the preview, page colours | Command Palette |

- While the preview has focus, Ctrl+= and Ctrl+- zoom the page instead of VS Code's window, and Ctrl+0 fits the
  width instead of moving to the Side Bar. Elsewhere these keys do what VS Code does by default.
- F6 moves between VS Code's parts as usual.
- Under a High Contrast theme, a "Theme colours" toggle draws the pages in the theme's background and
  foreground (pdf.js's `pageColors`; off by default, since some figures need their true colours).
- Colours come from VS Code's theme variables only.
- Nothing animates when VS Code or the system asks for less motion.
- The viewer's live region says "Preview updated", and how many errors a compile had.

Tests:

- `test/unit/roots.test.ts`, `coexistence.test.ts` and `pageColors.test.ts`.
- `test/unit/coexistStubs.test.ts`: what the coexistence window allows LaTeX Workshop is narrow. In a worker
  thread, only its viewer's server file may listen, only on 127.0.0.1 (the test opens and closes one such
  listener); other files, other addresses and other forks stay blocked. The forks are allowed as exact
  (target, caller) pairs (`allowForkPairs` in `test/stubs/stub-state.cjs`), and the crossed pairs are refused.
- `test/engine/multiroot.test.ts`, on the multi-root fixture `test/corpus/multiroot/` (CC0).
- `test/integration/multiroot.test.ts` and `coexistence.test.ts`; the latter runs with LaTeX Workshop installed in
  a throwaway profile (`--with-latex-workshop`). LaTeX Workshop stays inactive there, because the test stubs block
  the worker process it starts. So these tests check the setting it reads, its keys and its PDF editor, not two
  builds on save side by side.
- `test/integration/keyboard.test.ts`: every viewer command with no mouse event. It also reads the first page's
  canvas as drawn: white with dark ink, then black with white ink under VS Code's High Contrast theme.
- `test/restricted/restricted.test.ts`, in a Restricted Mode window.

## When a package is missing (M6)

- **The preamble scan** (`src/extension/project/packageScan.ts`) runs before every compile. It reads
  `\documentclass`, `\usepackage` and `\RequirePackage` (options and lists), `\usetikzlibrary`,
  `\usepgfplotslibrary`, Beamer's `\usetheme`, `\usecolortheme` and the font, inner and outer themes,
  `\bibliographystyle`, and bare `\input` and `\include` names. It resolves each file through the data sets'
  package indexes and lists every file that no installed set has, in one go, in the Problems panel and in one
  notification: the file, its package, and what to do. The compile still runs; TeX's own "not found" error then
  also names the package and the data set that has it. The CTAN address is in the text; for a single missing
  package the notification also has a button for its CTAN page, which VS Code opens only after its own link
  prompt.
- **Package indexes.** Each data set has one: file name to package, and the files each package loads. Until B1
  builds the real `manifest.json`, `scripts/stage-engine.mjs` builds `dist/data/packages.json` from TeXlyre's
  interim image (its own `.sty` and `.cls` files, read with `scripts/lib/image-files.mjs`), and the core manifest
  lists what the Extra Packages add-on holds. The core's own dependencies are left to B1's closure test, and a
  project's class or package is not followed (they load some packages only for some options).
- **"Install Extra Packages"** opens VS Code's Extensions view on `haberwooki.livemd2tex-extra-data`; the user
  installs it there and the extension downloads nothing. The resolver (`src/extension/engine/dataResolver.ts`)
  finds the add-on with `extensions.getExtension` (it is never a dependency) and accepts it only when its TeX
  Live year and engine ABI (the SHA-256 of the engine WebAssembly) match, both present; otherwise one plain
  message.
- **A data extension is an image.** Its `data/` folder holds `manifest.json` and one image: a `.data` file and
  its index, in the layout of the core image (Emscripten's file_packager format; `scripts/lib/data-image.mjs`
  builds it). The manifest's format is the contract B1 builds to (`DataManifest` in
  `src/extension/engine/dataSets.ts`): `format` 1, `texLive`, `abi`, `image` (`file`, `index`, `bytes`,
  `sha256`), the package `index`, and in the core `elsewhere`. When the scan needs one of its packages, the
  engine host reads the image once and every compile worker mounts it whole under `/texmf-extra`, searched after
  the user's package folder and before the core, so files a package loads indirectly (`.fd`, `.def`, `.cfg`,
  `.ldf`) are found too. Nothing of it is copied into a compile. If a compile reports "not found" for a file that
  an installed image has, the next compile mounts that image. Once the engine host has read an image, it stays
  mounted, as in a TeX installation with the add-on.
- **"Add a package from a file"** takes a `.sty`, `.cls` (with their small files), a `.dtx` with its `.ins`, or a
  CTAN `.zip`. A `.ins` runs on the bundled engine (docstrip, in memory), as a job of the compile scheduler, so a
  live compile and the build never cancel each other. The result goes into the user's package folder under VS
  Code's global storage (read by every compile; its files go into each compile's own texmf tree, `TEXMFHOME`,
  and cross to the engine host in the change sets), or into the document's folder. Files are written there only
  inside the project folder, never through a link (as for every write into a project: the PDF on save, Export
  LaTeX, "Create folder config").
- **Plain messages** for font packages (a `.sty` copy is not enough) and for packages that need an outside
  program (minted, svg, gnuplottex, epstopdf, pythontex, sagetex, biblatex's default Biber backend,
  glossaries-extra's `record`, `\makeglossaries`), each with what to do instead. "Report a missing package"
  opens the issue tracker through VS Code's link prompt.

The Extra Packages add-on does not exist yet; `node scripts/build-extra-standin.mjs` builds a test stand-in that
holds REVTeX 4.2 as one data image (`out/vsix/livemd2tex-extra-data-0.0.1-standin.vsix`). Tests: `test/unit/m6.test.ts`;
`test/engine/m6.test.ts` (the scan finds nothing missing in the corpus; P2 without REVTeX through the stand-in
add-on and through the CTAN ZIP; tensor from its `.dtx` and `.ins`); `test/integration/m6.test.ts` (the same in
VS Code, with the stand-in installed from its VSIX into the throwaway profile, and the compile command's answer:
its own compile, never an older one that was still running); `test/engine/gate2.test.ts` (a file
an image's package loads indirectly, the mount after "not found", a package build beside a live compile, the
user's files in the change sets).

## The data sets: core-data and extra-data (B1, prepared, not yet run)

`scripts/build-bundle.mjs` builds the two data sets from TeX Live itself, on GitHub only (`.github/workflows/bundle.yml`,
run by hand). Nothing of it runs on a development machine except its tests, on tiny made-up archives.

- **One pin, checked against TeX Live's signature.** `engine/bundle-pins.json` names a dated snapshot of TeX
  Live's package repository and the SHA-256 of its package database, `texlive.tlpdb`. Every package archive is
  checked against the SHA-512 that this database lists. TeX Live signs the database's SHA-512 with its key. The
  pins file holds that key's fingerprint. The workflow's `pin` job verifies the signature with `gpg` on the
  runner, and the builder checks that the signed SHA-512 is the database's. Only then does it print the entry to
  pin: the SHA-256, the signed SHA-512, and a note that the signature was checked. The builder refuses to build
  without that note.
- **The selection.** `engine/bundle-sets.json` names collections and packages for core-data and extra-data, as
  planned (core-data: TeX Live's basic and LaTeX collections, the hyphenation patterns and babel languages, and
  the common packages of papers, slides and theses; extra-data: the rest of the recommended and extra LaTeX
  collections, mathematics and science, the recommended fonts, publisher classes and biblatex styles). A
  package whose Catalogue licence is not free stays out and is listed.
  - **Publisher classes** follow the same free rule (decided by the maintainer, 2026-10-22; until then they had to
    be LPPL, GPL or CC BY). Non-commercial, no-derivatives and missing licences stay out, and so does an
    unreviewed "collection". A class the Catalogue labels "other-free", or one with no Catalogue licence, comes
    in only once its files are read and recorded in `licenceReviews` (the group's `readFirst`). Two classes are
    left out on purpose, with the reason: `bmstu` (its logo is used under fair use, not under a licence) and
    `kluwer` (none of its files states a licence).
  - A group's own rules cover the group's own members only. The fonts and helpers a class depends on, and
    packages the set already selects, keep the set's rule.
  The free licences include the GUST Font License (Latin Modern, TeX Gyre) and the Greek Font Society's. The
  `pin` job runs the selection once and lists every package that is not plainly free, and every package with no
  Catalogue licence (TeX Live's own files). Read both lists before the build. The Catalogue calls a few packages
  a "collection": their files carry several licences. Such a package counts as not free until a person has read
  its files and recorded their licences in `licenceReviews`, with what was read. Today that is `preprint`, which
  holds authblk, `was`, which holds upgreek, and `frankenstein`, and the publisher classes `fbithesis` and
  `tugboat-plain` (below). A set's `exclude` leaves a package out on purpose, with its reason (today `ltxmisc`:
  one of its files forbids selling it). The report lists both.
- **Our own tools, no other program.** The builder unpacks the `.tar.xz` archives with its own xz decoder and
  tar reader (`scripts/lib/xz.mjs`, `tar.mjs`), writes `ls-R`, `language.dat` and its siblings, `fmtutil.cnf`,
  `updmap.cfg`, `pdftex.map` and `kanjix.map` the way tlmgr and updmap do (`scripts/lib/texmf-config.mjs`), and
  packs each set into one LZ4 image (`scripts/lib/data-image.mjs`, `lz4.mjs`). From its first line it refuses to
  start python or perl.
- **What TeX reads, and nothing else.** `doc/`, `source/` and `scripts/` stay out of both sets, also where TeX Live
  lists them as run files (koma-script lists its whole tree), and the report lists the packages they came from. A
  program file among the rest (`.jar`, `.whl`, `.py`, `.pl`, `.exe`, `.dll`, `.so`, a shell script, or Lua outside
  `tex/`) stops the build. Such a package is left out with its reason (today `jupynotex` and `prettytok`, which
  hold Python scripts). The engine build's own support files come from its pinned image and are not scanned.
- **The engine checks the result.** In the extension's own engine host it builds `pdflatex.fmt` and
  `xelatex.fmt` in initex mode, and measures what the hyphenation patterns add to them. The closure test then
  loads, alone in a minimal document, every class and every `.sty` directly in a package's own `tex/latex`
  folder (on XeTeX when the package asks for it). A missing file or font fails it, and so does a package's main
  file that gives no PDF. Packages with nothing to load (fonts, BibTeX styles) are listed as not testable.
  `engine/bundle-closure.json` holds the test's rules. `setup` gives a file the preamble it needs first
  (babelbib needs babel with a language). `expected` lists the failures that are right for core-data, each with
  its reason: documentation tools and helpers that need a package only extra-data holds, psnfss's font options
  whose fonts are in extra-data, and the LuaTeX branches. The report says which missing files extra-data holds.
  It also names a listed file that loads now. Any other failure stops the build.
- **Stages.** `--stage pin`, `fetch`, `build` and `closure` run apart, each in its own job. Each stage writes
  `report-<stage>.json` and `.txt` after every step and once more on an error, so a failed run keeps what it
  found. The closure test takes `--closure core|extra|all` (core by default) and `--shard i/n`.
- **What it writes.** For each set: `data/manifest.json` (the DataManifest contract; core-data's also gives its
  mount root, its formats with their SHA-256, and extra-data's files and requires; both name the snapshot), the
  image, `licences.json` (each package's licence and CTAN page; for a package under the GPL, LGPL or AGPL, or
  with a packed font under the GPL, also its archives in the pinned snapshot with their SHA-512), `LICENSES/`
  (below), and a data-only VSIX under our own cap of 262,144,000 bytes (250 MiB). The cap is ours, not a store's
  published limit. Also `closure-targets.json` and `selection.json` (each set's packages). The report gives the
  sizes by package, the patterns' cost, the closure test and the engine host's peak memory.
- **Licence texts.** Each data package ships the licence texts its packages require, in `LICENSES/` beside
  `data/`, and `LICENSES/INDEX` lists each package with its files. `engine/bundle-licences.json` holds the rules
  (`scripts/lib/licence-texts.mjs` applies them):
  - Each Catalogue licence names the texts it needs: the LPPL in the version the Catalogue gives, GPL-2 and GPL-3,
    the LGPL, the GUST Font License, the OFL, MIT, BSD, Apache, CC and others. The texts are in this repository
    with their pinned SHA-256: the LaTeX Project's own LPPL texts, SPDX's licence list (v3.27.0), the GUST Font
    License from lm's doc archive, CTAN's statement of Knuth's terms, and MakeIndex's notice from TeX Live's
    sources. TeX Live's own `LICENSE.TL` and `LICENSE.CTAN` come from texlive.infra's archive, for the packages
    with no Catalogue licence.
  - A package's own licence files go with it where its licence asks for them: an OFL font's copyright notice and
    Reserved Font Names, an MIT or BSD notice, an Apache-2.0 package's `NOTICE` (Apache-2.0 section 4(d); ktbox
    has one), the GUST fonts' `MANIFEST` files, DejaVu's Bitstream Vera and Arev terms. They come from the package's run archive and, when the tlpdb lists some in its doc files, from its doc
    archive. The fetch stage downloads those doc archives too, each checked against the tlpdb's SHA-512.
  - "other-free" and an unnamed BSD licence have no common text. Their terms must be found: in a licence file, a
    README, a shipped file whose own text states them, or another file of the doc or source archive (a `.ins`
    file first). The report lists the terms found by reading text, for a person to check; `readings` records a
    package whose terms a person read, with the shipped or archive files that state them and the texts they name.
    kastrup's and plweb's files say "see the source file", so their `.dtx` (and plweb's `.ins`) ship in their
    LICENSES folders; menu, fancynum, colorprofiles, beamertheme-metropolis, tucv, apa6e, correctmathalign,
    docutils and dvips get the texts their READMEs name.
  - core-data's files from the engine build's image need texts too (`engineFiles`): ICU's licence for
    `icudt78l.dat`, ICU's data, and TeX Live's for its own files. A file no rule matches stops the build.
  - **GPL change notices: decided by the maintainer, 2026-10-26.** The GPL fonts stay packed, with a notice per
    file. `LICENSES/CHANGES-GPL` in core-data lists every packed font under the GPL, by its own terms (above): its
    path, its package, its original's SHA-256, the snapshot archive that holds the original unmodified (its URL),
    what was done to it, and the date of the build. README.md and LICENSE.txt point to it, and a packed GPL font it
    does not list stops the build.
  - **Where the sources are (the licence gate, M6).** CTAN keeps only a package's newest version, so a pointer to
    CTAN alone stops finding the source of the shipped files at the next update. LICENSE.txt therefore names the
    pinned snapshot (its date and URL), which keeps each package's run, source and doc archives as shipped. For each
    package under the GPL, LGPL or AGPL, or with a packed font under the GPL, `licences.json` lists those archives
    (`archives`: kind, URL, the tlpdb's SHA-512), and the release attaches a copy of each (Releases, below).
  - A licence with no rule, a text that is not the pinned one, and a package whose text or terms are not found
    stop the build. cv4tw is left out of extra-data for this: none of its files states its terms.
- **Core size: fonts kept in core, one add-on; decided by the maintainer, 2026-10-22.** core-data keeps its fonts
  whole (cm-super, Latin Modern, TeX Gyre, DejaVu, and acmart with libertine, newtx and inconsolata), with no
  subset and no package split between the sets. A core of about 150 to 180 MB is accepted. What leaves core:
  - the LuaTeX-only packages (luaotfload, lualibs, lua-uni-algos, luamml, lualatex-math), out of both sets;
  - updmap's two copies of `pdftex.map`, which nothing here reads;
  - xunicode and tipa, which go to extra-data (core-data's `toExtra`).
  The closure test found thirteen packages that core's classes and packages load, and core-data now holds them:
  totpages, everyshi, cmap, comment, draftwatermark, ncctools (manyfoot), pbalance and zref (acmart), upquote
  (inconsolata), ifoddpage and relsize (algorithm2e), aliascnt (llncs) and catchfile (ifplatform).
- **Font packing: decided by the maintainer, 2026-10-22.** core-data stores its Type 1 fonts with t1c
  (`scripts/lib/t1c.mjs`): each `.pfb` with its eexec section and charstrings decrypted, so the LZ4 image and the
  package's zip compress it. Decrypting and encrypting again gives every byte back, and the builder packs a file
  only when it does. It then runs the engine host's own unpacking (`out/src/engine-host/engine/t1c.js`, so
  `npm run compile` comes first) on every packed file, and stops if one does not give its original back. The
  image's index and the manifest list the packed files with each original's SHA-256. The engine host encrypts a
  packed font again when TeX opens it (`src/engine-host/engine/t1c.ts`), checks the SHA-256, and keeps the
  original in the worker for the rest of the compile. A font that fails the check does not open, and the compile
  makes no PDF; its message names the data set to reinstall (the Core Packages, or the add-on), with no "cannot
  open" help for that font. The engine host also refuses an image whose index and manifest list different packed
  files, and the extension refuses a data set packed in a way it does not know. extra-data is not packed.
  - **Licences, font by font.** Each font's terms come from its own header (`fontTerms` in
    `engine/bundle-licences.json`; `classifyFonts`). A font is packed only when its header states the LPPL, the
    GUST Font License, the GPL or DejaVu's Bitstream Vera and Arev terms, or points to its package's licence or
    states nothing in a package under the LPPL 1.3 or later, the GUST Font License or the GPL. A font that states
    the OFL (or a font under it, as STIX or EB Garamond), IBM's Courier terms, "All rights reserved", the public
    domain, or only what it derives from, is stored as it is, and so is a font that states nothing in a package
    whose fonts state different terms. A font's own terms also add their texts to its package's in `LICENSES/`
    (courier: IBM's notice, from its fonts' headers, and IBM's terms as X.Org ships them). `t1cSkip` keeps all of
    amsfonts and inconsolata (the SIL Open Font License calls a derivative made "by changing formats" a Modified
    Version, and amsfonts reserves its font names), rsfs (its terms were not read for this) and newtx (its fonts
    carry several licences that its Catalogue licence does not give) as they are. The package's README and
    LICENSE.txt say how the fonts are stored; LICENSE.txt groups the packed fonts by their own terms, lists the
    fonts stored as they are with the reason, and quotes the LPPL's clause 9 on alternative formats.
  - **Cost.** Unpacking costs about 15 ms per MB of fonts read. On T1, P1 and P5 (two runs of one cold and three
    warm compiles each) the compile times stayed within run-to-run noise, about ±15 %, and the engine host's peak
    memory was about 600 MB packed and 617 MB unpacked (a Windows 11 development machine, Node 22). A compile
    keeps the fonts it opens until it ends: at most the core's packed fonts, about 100 MB.
  - **Publishing.** Publish a core-data VSIX only from a `bundle.yml` run whose `corpus` job passed for that same
    package. That job checks every packed font on the engine: each unpacks to its original, pdfTeX reads each one
    with the original's MD5, and the corpus gives the same PDFs with and without packing.
  Tests: `test/unit/t1c.test.ts`, `test/engine/t1c.test.ts` (also partial reads through `\pdffiledump`), and on
  CI `bundleCorpus.test.ts`.
- **Fonts in the add-on.** Some fonts live only in extra-data (bookman, charter, utopia and more). A Type 1 file
  that pdfTeX cannot open, and a font that XeTeX cannot find by name, each get plain help. When the add-on holds
  the file, the message names it, and an installed add-on is mounted for the next compile. `engine/fonts.conf`
  names the add-ons' OpenType and TrueType folders, so XeTeX finds an add-on's font by name.
- **One build for both sets.** The core's font maps name the add-on's fonts. So the extension accepts an add-on
  only from the same TeX Live snapshot as its core, and says so in plain words otherwise.
- **The workflow.** `pin`, then `fetch` (the archive cache is saved even when the fetch fails), `build` (the
  packages' SHA-256 go into the job summary), `closure` (sharded over 4 or 8 runners, on the packages as they
  ship), `corpus` (the public corpus on the built packages) and `reference`. The header gives the minutes.
- **Downloads.** texlive.info runs a bot check (Anubis). A browser gets a challenge page before the file, and so
  does Node's fetch, which cannot answer it; curl gets the file (checked 2026-10-26). So the workflow downloads the
  files with the runner's curl, and the builder reads that copy (`--local DIR`) and opens no connection itself. The builder lists for curl what the copy lacks (`--curl-config FILE`), then checks every
  file: the package database against the pin, each archive against the database's SHA-512.
- **The reference.** A separate job installs TeX Live from the same snapshot into the runner's temp folder,
  without root: TeX Live's installer, verified with the same key, with the collections the bundle draws from,
  then the build's packages. It compiles the public corpus again, and the page counts must match
  (`test/engine/bundleCorpus.test.ts`, `scripts/bundle-reference.mjs`). Why its Perl is allowed is under
  "CI and the public history on GitHub".
- **Afterwards.** Once `dist/data` holds core-data, `node scripts/clean-interim-data.mjs --yes` deletes the interim
  image and the pinned CTAN files from a development machine (without `--yes` it only lists them). Every
  core-data build still needs the engine build's image, for its own support files; the workflow fetches it again.
- **Still open.** Our own copy of the snapshot after the first build, and the measured minutes.

Tests: `test/unit/xz.test.ts`, `tar.test.ts`, `tlpdb.test.ts`, `bundle.test.ts` (the whole build without the engine,
on a made-up snapshot: the signed pin, the licence lists, the licence texts and their INDEX, the report on an error,
the closure targets and the program guard), `dataImage.test.ts`, `cleanup.test.ts`, `workflows.test.ts` (the jobs and their order), `m6.test.ts`
(an add-on from another snapshot); `test/engine/bundleEngine.test.ts` (the formats, the patterns' cost and the
closure test on the engine, with the interim image standing in for the new tree).

## How many documents compile (M5, prepared, not yet run)

The method is `docs/coverage-method.md`, written down before any paper was fetched; its parameters are in
`engine/coverage-frame.json`. It runs on GitHub only, in `.github/workflows/coverage.yml`, by hand. In the public
repository the runners cost nothing; arXiv's limits stay as they are (one request every three seconds, one at a
time, across every machine).

1. **Pin the templates.** Run the workflow with job `pin`. It downloads the CTAN thesis and Beamer templates of
   `engine/coverage-templates.json` and prints each zip's SHA-256 and its main files in the job summary. Commit the
   entries (keep the main files that are templates); an entry without a SHA-256 is not measured.
2. **Build the data packages.** A run of the bundle workflow; its `bundle-packages` artifact is kept 3 days.
   **Rehearse.** Run the workflow with job `rehearse` (the default) and that run's id as `bundle_run`. It asks
   arXiv nothing: the `sources` job does not run, and each compile job builds its documents from the repository
   (`--stage rehearse`: the public corpus and the probes of `scripts/lib/coverage.mjs`). The report's first lines
   list its checks (Ghostscript and `repstopdf`, the DVI route, biber, no network, `openin_any=p`, a missing file,
   the corpus on TeX Live, every document measured on both sides), and the job fails when one does not pass. Fix
   and rehearse again until all pass.
3. **Tag the method.** Tag the commit to be measured (say `coverage-method-1`), so the method is fixed before any
   result is seen. In the public repository, run from a branch of its own (say `coverage-run`) at that commit: pull
   requests into `main` cannot restore that branch's caches, so the sources stay out of their reach.
   Before the run, tell arXiv's administrators what it will fetch and at what rate. arXiv's robots page asks for
   contact in advance only when an application needs its guidelines relaxed; telling them is still good practice.
   export.arxiv.org's robots.txt disallows every path to crawlers, although arXiv's bulk-data page sets that site
   aside for programmatic access. The requests go only to `oaipmh.arxiv.org/oai` and
   `export.arxiv.org/src/<id>`, follow no redirect, and carry the User-Agent
   `liveMd2Tex-coverage/<version> (+https://github.com/haberwooki/liveMd2Tex)`.
4. **Measure.** Run the workflow with job `measure` and that run's id as `bundle_run`. The jobs:
   - `sources`: the harvest from arXiv's OAI-PMH interface, the draw (`candidates.json`, only ids), and the sources,
     stratum by stratum until each quota of LaTeX sources is met (`papers.json`, with each source's version and
     SHA-256). One request every three seconds, one at a time (`Pacer` in `scripts/lib/coverage.mjs`), in a
     concurrency group. The harvest prints its page count and time every 20 pages and saves its progress
     (`harvest.json`). The sources go into the Actions cache, never into an artifact, saved under a key of their
     own for each attempt, also when a step fails or runs out of time. A new run goes on from the newest entry of
     the same frame: the harvest from its last saved page, the fetch with the sources it lacks. The templates have
     a cache of their own, keyed by their file, so re-pinning one keeps the arXiv sources.
   - `texlive`: the reference, scheme-full of the pinned snapshot, its installer verified with gpg, kept in the
     cache by the snapshot's pin. install-tl, TeX Live's Perl installer, runs in this job only.
   - `compile`, one job per shard: `scripts/coverage.mjs --stage prepare` unpacks the shard's documents (each on
     its own: one that cannot be unpacked is counted, and the next goes on); `out/test/engine/coverageRun.js`
     compiles each on the extension's own route, with core alone and, where the core lacks a file, with extra
     installed. It refuses to start without the stubs and records what they blocked. `--stage reference` compiles
     each on TeX Live, started with `sudo unshare --net` and dropped back to the runner's user: no network, a small
     environment, restricted shell escape and `openin_any=p`. TeX Live's own Perl tools (`repstopdf`, `biber`) run
     there, inside that sandbox. Ghostscript comes from the runner's Ubuntu archive (the job's one other use of
     `sudo`). The checkout keeps no token, and the job saves no cache. Results are written after every document,
     and each side stops starting documents at its time budget. "Re-run failed jobs" works for a shard: it
     restores this run's newest sources entry.
   - `report`: `--stage report` lists every sampled document (`papers.json` and the pinned templates) with its
     outcome, "not measured" with its reason included, and gives the shares with their Wilson intervals, per
     stratum, and the missing packages (`coverage-report.md` in the job summary, and `coverage-report.json`). Its
     first line says when a shard or part of the sample is missing. It records the commit and the SHA-256 of the
     method's files. The reweighted figure is there as a sensitivity figure only.
5. **Keep the result.** Commit `coverage-report.json` (ids, versions, outcomes, file and package names; no paper
   text) beside the method, as `docs/coverage-report.json`: the run's artifacts expire after 7 days.
6. **Delete the caches.** Delete the `coverage-sources-*` and `coverage-templates-*` entries (Actions, Caches, or
   `gh cache delete <key>`): after every run, and all of them before the repository is made public. Keep
   `coverage-texlive-full-*` if another run is planned.

The pure parts (the OAI-PMH reader, the strata, the draw and the shards, the pacer, the version, the main file,
"compiles" for both sides, the interval, every document's outcome, the report, the rehearsal's probes and checks)
are unit-tested in `test/unit/coverage.test.ts`; `test/unit/workflows.test.ts` checks the workflow's rules (one
job asks arXiv, and only for `measure`; no source in an artifact; no token in a checkout; no cache saved by the
compile job; `sudo` in two lines only, the reference's without network). The minutes are estimated in the
workflow's header.

When M5 passes, the README's "How many documents compile" gets the numbers the method's last section names, from
the report, and "Not yet measured" goes.

## New documents, the walkthrough and help for TeX errors (M4)

- **New document from template** (`src/extension/templates/`), in the Command Palette and in File > New File.
  `catalog.ts` lists the starting documents, with no VS Code in it; `newDocument.ts` is the command. It makes a
  new folder with a free name (`article`, `article-2`, ...). Nothing is overwritten, by construction (`place.ts`,
  with no VS Code in it): only a parent that does not exist counts as empty, and any other failure to list it
  refuses with a plain message and nothing written; a folder that is there although the listing did not show it is
  refused; each file is created with a workspace edit that may not overwrite; two runs at once (API calls) take
  turns (`oneAtATime`), so they never share a folder. Files go through VS Code's file system only. A Markdown document gets
  `latex-preview: true` in its front matter. The preset paper gets a `.latexpreview.json` that names the example
  preset, copied beside it. The command takes a template id and a folder as arguments, as the walkthrough's
  buttons do; otherwise it asks. The starting documents are in `templates/` (CC0); `.vscodeignore` ships them
  and the example preset.
- **The walkthrough** "Get started with liveMd2Tex" (`contributes.walkthroughs` in `package.json`, pages in
  `walkthrough/`): open a sample, see the preview, try Markdown, a missing package, and LaTeX Workshop. Its
  buttons run "New document from template" with a template id, so the user only picks a folder.
- **Help for TeX errors** (`src/extension/diagnostics/errorHelp.ts`). The table matches the message as the log
  parser gives it, and adds a sentence that names the command, file or environment. The 20 errors: undefined
  control sequence; file not found (a package or class, an image, another file); missing `$`; extra `}` or
  forgotten `$`; missing `}`; too many `}`; runaway argument (a paragraph ended); file ended while scanning;
  environment undefined; `\begin` ended by another `\end`; misplaced `&`; extra alignment tab; missing number;
  illegal unit; missing `\begin{document}`; preamble-only command; no line to end; lonely `\item`; double
  superscript or subscript; and a Unicode character pdfLaTeX cannot print. The runner adds the help to each TeX
  error that has one (`withErrorHelp`); the Problems panel shows it on its own line after TeX's message, with the
  error's id (such as `undefined-command`) as the problem's code (`compile/outputs.ts`). An error shown on a
  Markdown line gets the Markdown wording where it differs (the front matter's `engine:` and `header-includes`,
  not `% !TEX` lines or the preamble). For an undefined command inside a macro or an argument, the log parser
  keeps TeX's first context line as `(in: ...)`, and the help names its last command: the one TeX did not know.
  epstopdf's "Shell escape feature is not enabled" note (graphicx with hyperref) is left out unless the compile's
  files include an .eps file; then it has help, and so does the missing `*-eps-converted-to.pdf` (put a PDF copy
  beside the figure). Fixtures: `test/fixtures/shell-escape/`; test: `test/engine/shellEscapeNote.test.ts`.

Tests:

- `test/unit/templates.test.ts`: the catalog, the opt-in, free names, and that every starting document ships in
  the VSIX (vsce's own file list).
- `test/engine/newDocuments.test.ts`: each starting document, written as the command writes it, typesets on the
  bundled engine with no TeX error and no undefined reference. A journal class is first named by the preamble
  scan, then typesets with its files from the pinned CTAN set.
- `test/unit/errorHelp.test.ts` and `test/engine/errorHelp.test.ts`: each of the 20 errors happens on the engine
  from its fixture in `test/fixtures/tex-errors/` (CC0) and gets its help; in `variants/`, an undefined command
  inside a macro and inside an argument gets help that names it; the Markdown wording on Markdown lines.
- `test/unit/newDocumentPlace.test.ts`: nothing is replaced when the parent cannot be listed, when the folder is
  there but not listed, or when a file appears before it is created. `test/integration/m4.test.ts` checks VS
  Code's create-only write on a real file.
- `test/unit/storeReadme.test.ts`: README.md, the store page, has no developer sections or build commands.
- `test/unit/walkthrough.test.ts`: the five steps in order, every page in the VSIX, every button a contributed
  command with a template the catalog has, and each page's "Click ..." the label of its button.
- `test/integration/m4.test.ts`, in VS Code: the command makes a LaTeX article (twice: `article`, then
  `article-2`), a Markdown article and the preset paper, each with its PDF; each of the 20 fixtures shows its
  help in the Problems panel; the walkthrough opens.
- By hand, waiting for its testers: `test/manual/walkthrough-timed.md`, the timed check that a newcomer reaches a
  PDF from the walkthrough alone in under 10 minutes.

## The CC0 files

The starting documents (`templates/`) and the example presets (`examples/presets/`) are dedicated to the public
domain under CC0 1.0 (`CC0-1.0`), because "New document from template" and the preset instructions copy them into
users' own folders, so that a paper or thesis written from them carries no conditions. Each folder has a
`LICENSE.md` notice, each file with a comment form carries the line `SPDX-License-Identifier: CC0-1.0`, and the
legal text is `LICENSES/CC0-1.0.txt` (in the package, `dist/licenses/CC0-1.0.txt`). The command writes these files
as they are and adds no header of the extension's. `package.json` keeps `GPL-3.0-or-later AND AGPL-3.0-only`: it
names the terms of the extension as a whole, and the CC0 files carry their own notice, as the bundled MIT and
Apache-2.0 parts do. The VSIX scan fails a package whose starting documents lack the notices, the legal text or an
SPDX line, or name the GPL (`cc0Headers` and `missingNotices` in `scripts/vsix-scan.mjs`). The test fixtures
marked CC0 (`test/fixtures/`, `test/corpus/`, `test/converter/`) are not shipped.

## Licences, notices and releases

The licence gates (2026-10-26) checked every part by others that a package ships. What they set up:

- **The engine's notices.** `engine/engine-notices.json` lists the parts of the engine, each with its version,
  licence, the files TeXlyre's Makefile links for it, and its notice files. It also holds a copy of the Makefile's
  link line (line 376) and of the object lists it names (lines 77 to 86). The notice files are in
  `LICENSES/engine/`, each copied from that part's own source and pinned by SHA-256 in the manifest. The build
  copies them to `dist/licenses/engine/`. THIRD_PARTY_NOTICES.md's "Inside the engine" table is the output of
  `node scripts/lib/engine-notices.mjs`.
  - `test/unit/engineNotices.test.ts` checks that every file on the manifest's copy of the link lines belongs to a
    part, and the reverse; that every notice file is present at its pinned bytes; that the table in
    THIRD_PARTY_NOTICES.md is the manifest's; and that the VSIX scan requires every notice file wherever
    `dist/engine/busytex.wasm` ships. It reads the manifest's copy of the Makefile lines, not the Makefile: it
    also checks that the manifest names the TeXlyre commit and release that `engine/pins.json` pins, so a new pin
    fails the test until the manifest is updated. The release check compares the copy with the Makefile inside
    TeXlyre's archive at that commit (its SHA-256, and line by line).
  - The VSIX scan fails a package whose engine notices or licence texts are missing, or are not the pinned bytes
    (`missingNotices`, `wrongNotices`). It also fails an engine whose WebAssembly holds libpaper's strings
    (`PAPERCONF`, `/etc/papersize`). libpaper is GPL-2.0-only and may not ship with the AGPL-3.0 parts; it is on the
    link line, but none of its code is in the pinned build.
- **Below the link line.** A linked library can hold code by other authors under terms of their own, which the
  link-line test cannot see. `node scripts/engine-notice-search.mjs --archives DIR` helps a person find it; it is
  an aid to reading, not a proof. It reads the four source archives (by their names in the manifest's `sources`)
  and searches each linked library's compiled sources for licence clauses that match its patterns (`clauses`, each
  with an id): written out, stated by reference ("Released under", "licensed under", "See Copyright Notice in",
  SPDX lines) and public-domain dedications. The patterns are generous; the rules do the sorting.
  - What it guarantees: every clause that matches a pattern, on one line or across two adjacent lines, is either
    covered by one of the library's own licences (`own`) that may cover that kind of clause, or its file is named by
    a rule a person wrote.
  - What it does not see, which the person's reading is for: words that no pattern knows; a clause split over three
    lines or more; a holder more than 25 lines above its clause (`window`); a denial of a dedication in other words
    than the guard's; and a second author's grant of the same kind with no copyright line of its own, which is
    checked against the first author's holder above it.
  - Each own licence lists the clause kinds it may cover (`clauses`). A clause is covered when a licence of its kind
    has its words on the clause's own line (or, for a named licence, in the clause's paragraph) and the notices name
    every holder on the copyright lines up to 25 lines above the clause; a holder written only as "the authors" names
    nobody. A line that holds two kinds
    of clause needs both covered.
  - An own licence marked `reference` (a pointer to a notice that ships) needs no holder of its own; one marked
    `anyHolder` (a licence that asks for no list of holders in a copy, such as FreeType's under its GPL option, or a
    public-domain dedication) covers any holder and says why. These two hold only when their words start on the
    clause's own line. Words may be a phrase (`text`) or a pattern (`pattern`); `unless` rules a licence out when it
    matches the clause's lines: the public-domain dedication's catches "not", "no longer", "isn't", "never" and "no"
    up to 40 characters before "public domain". Own licences can be limited to some files (`files`), as luaffi's and
    DynASM's are.
  - Every other file needs a rule in the manifest's `search`: the notice that ships for it, why the shipped notices
    cover it, or why it is not compiled for the engine. A file with no rule, and a rule that names no file, fail the
    search.
  - The run of 2026-10-27 is recorded in `engine/engine-notice-search.report.json` (each folder's files with hits,
    by clause kind, and the rules used). It found the notices that THIRD_PARTY_NOTICES.md lists under "Below the link
    line". DynASM's notice was added from a review, not by the search: DynASM's headers state their licence by
    reference, which the first version of the search did not read. It reads them now.
- **When the engine pin changes.** Read the new Makefile's link line; update the manifest's `build`, `makefile`
  (its URL, SHA-256 and lines), `sources`, versions and notice files; run the table again. The unit test fails until
  the manifest names the new pin. Then download the new source archives and run
  `node scripts/engine-notice-search.mjs --archives DIR --since engine/engine-notice-search.report.json`: it lists
  the files whose hits are new or changed, by folder, file and clause kinds (not by archive, whose name changes with
  the pin). A person reads each of them and each problem, writes the rules and
  notices, and records the run with `--report engine/engine-notice-search.report.json`. No release ships a new
  engine pin before this is done.
- **The notice in the patched glue.** `engine/patches/busytex-glue.mjs` holds `notice`: the original (TeXlyre's
  release, copyright and licence), the date of the last change to the patches, who changed it, where the patches
  are, and the SHA-256 of the patches (`patchesSha256`). `scripts/engine-patch.mjs` writes the notice at the head of
  the patched glue and of `engine/patches/busytex.js.diff` (AGPL-3.0 section 5(a) and (b)); `patchesSha256` is not
  written into the glue, so it changes neither the glue nor its pin. It is there for the unit test, which fails when
  the patches change until `date` and `patchesSha256` follow. Only then does the glue change: run
  `scripts/engine-patch.mjs` and pin the new glue's SHA-256 in `engine/pins.json`.
- **The derived glue is keyed by its hash.** `engine-patch` writes the glue into
  `../engine_assets/derived/<first 16 digits of its SHA-256>/` (`scripts/lib/derived-glue.mjs`). `stage-engine`,
  the engine tests and the bundle builder read only the folder of the hash `engine/pins.json` pins. So worktrees
  with different patches share the one assets folder without overwriting each other's glue.
- **This version's source.** README.md (Licence) and THIRD_PARTY_NOTICES.md say "The source code of this version is
  at https://github.com/haberwooki/liveMd2Tex/tree/v<version>", with the version of `package.json`;
  `test/unit/releaseSources.test.ts` fails when the version changes and they do not. The repository must be public
  before any package is published, so that this address works.
- **Releases, in this order.** The sources are attached before any package reaches a store.
  0. If the engine pin changed since the last release, the notice search's new hits have been read and ruled
     ("When the engine pin changes", above), and its report is recorded.
  1. Push the tag `v<version>` on the commit the packages are built from.
  2. Make a draft release on GitHub for that tag, with the packages (`.vsix`) as its files.
  3. Run `.github/workflows/release-sources.yml` by hand with the tag. It runs `scripts/release-sources.mjs`,
     which checks the tag against the extension's version and README, and lists the sources each package needs:
     for a package with the engine, the four archives of `engine/engine-notices.json`; for a data package, the
     snapshot archives its `licences.json` lists, each under the pinned snapshot's mirrors. curl downloads them,
     git lists the trees of the two commits GitHub's archives are made from (fetched with `--filter=blob:none`, so
     only the trees come down), and the script checks each archive:
     its SHA-256 or SHA-512, a data archive's SHA-512 against the pinned package database, a commit archive's files
     against its commit, and TeXlyre's Makefile against the manifest. The workflow then attaches one tar file per
     group (`engine-sources-<tag>.tar`, `core-data-sources-<tag>.tar`, `extra-data-sources-<tag>.tar`) and the list,
     `sources.json`, to the draft.
     On the first real run, confirm that `gh release download` and `gh release upload` find the draft by its tag:
     GitHub's look-up by tag does not return drafts, and gh's way around that has not been tried here.
  4. Only when that run has passed: publish the release.
  5. Only then: upload the packages to the VS Code Marketplace and Open VSX.

  GitHub makes the `archive/` files of TeXlyre's and TeX Live's commits on request, and promises the same files
  for a commit, not the same bytes. An archive with other bytes but the commit's files is attached with its new
  SHA-256 and a note; one whose files differ stops the run. Never make an archive by hand with a new hash.
- **A fixed copy of the engine's sources (the maintainer's decision).** The reviewers suggest attaching the four
  archives once, now, to a permanent release of this repository (for example `engine-sources-46ebb62`), so later
  releases need not ask GitHub to make them again. That release is permanent, so whether to make it is the
  maintainer's decision; none is made yet. If it is made: run the workflow's steps for the four archives into it,
  then give each source in `engine/engine-notices.json` a `mirror` (the release file's address).
  `scripts/release-sources.mjs` uses `mirror` before the upstream address, and still checks the same hashes.
- **Open.**
  - A "Licences" command that shows the notices inside VS Code, before the first release (GPL-3 and AGPL-3
    section 5(d)).
  - MakeIndex's notice asks that a modified work carry an identical notice; TeXlyre links MakeIndex into one binary
    with GPL and AGPL code. Ask TeXlyre or TUG for a reading before the first release.
  - pplib states no licence of its own and is recorded under LuaTeX's terms; ask LuaTeX's team.
  - luaffi is Facebook's luaffifb, with Facebook's "Additional Grant of Patent Rights Version 2" (`PATENTS`). The
    FSF's licence list has no entry for it; whether it raises a question for the GPL-3 and AGPL-3 parts is the
    maintainer's to decide (THIRD_PARTY_NOTICES.md, the notes under "Inside the engine").
  - A first bundle run on the new repository, to check `LICENSES/INDEX`, `CHANGES-GPL` and the archives in
    `licences.json` against real packages.
