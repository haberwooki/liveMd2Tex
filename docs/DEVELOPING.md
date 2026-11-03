# Developing liveMd2Tex

How to build and test the extension, the rules its checks enforce, and notes on each part as it was built. The
user's page is `README.md` (also the store page); the design, which the code cites, is `docs/DESIGN.md`.

## Names

Confirmed by the maintainer on 2026-10-16: publisher `haberwooki`; extension `haberwooki.livemd2tex`
(display name liveMd2Tex); data extensions `haberwooki.livemd2tex-core-data` and
`haberwooki.livemd2tex-extra-data`. Commands, settings and view IDs start with `livemd2tex.`. The repository
is https://github.com/haberwooki/liveMd2Tex. Its history is the fresh public history
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
in `../engine_assets/` (about 411.6 MB kept: our engine, 27.0 MB, the CTAN set, 13.0 MB, and the two data packages
the engine tests need, 131.7 MB and 239.9 MB; "The TeX engine") and small result files in `../s1_runs/`.

## The rules the checks enforce

- ESLint (`eslint.config.mjs`): `child_process` only in `src/extension/engineHostFork.ts` (the one fork
  file), never in `src/engine-host/`; no `http`, `https`, `net`, `tls`, `dgram`, `http2`, `ws`, `undici` or
  `dns` anywhere, and no `inspector` (it opens a port) or `cluster` (it starts processes); `vscode.git` banned
  (it runs `git.exe`); `node:wasi` only under `src/spikes/s1c/`; no `fetch`, `WebSocket`, `XMLHttpRequest` or
  `EventSource` anywhere in `src/`, the webview included; no `require()`, `process.binding` or
  `getBuiltinModule`; no `eval`, `Function` constructor or `Worker` from source text; and no VS Code API that
  starts a program for the extension: `workspace.findFiles` and `findTextInFiles` (they run ripgrep), tasks,
  `ShellExecution`, `ProcessExecution` and `window.createTerminal`; and no lazy or preloaded file in the engine
  (`createLazyFile`, `createPreloadedFile`, `preloadFile`), which would make Emscripten's glue read a URL, under
  Node from the real disk.
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
  `dist/licenses/`, and wherever the engine is, the notice of every part of it; in a test copy, core-data's
  `LICENSES/INDEX`) or one that is not the pinned bytes. A data image (the `.data` file a data manifest names) is
  read file by file through its index, not as compressed bytes, in which a marker can turn up by chance or be split
  by the compression (`scanImage`): every path; text files as text; binary files (fonts, formats after their gzip
  compression is undone, pictures, archives) for the path-like markers only. In TeX Live's own files, the files
  the data manifest's package index lists for the pinned snapshot's packages, the name-like markers (kind
  "word") are left out: TeX packages hold people's names by coincidence, and a list of the files where they
  occur would narrow the names down. Every other marker is searched there, and every marker in every file the
  index does not list, the files the data builder writes itself among them (`ls-R`, the font list, the formats).
  The engine is found by its content: every file that is WebAssembly must be the engine or one of pdf.js's three
  decoders, a script that is Emscripten's glue must be the engine's `engine.js`, and nothing of the engine's build
  ships, under `engine/build/` or by one of its file names anywhere (`engineByContent`). Wherever the engine is,
  the scan also checks it: `engine.wasm` and `engine.js` are the files `engine/pins.json` pins, and the wasm is
  the one `engine/engine-build.json` records
  (`pinnedEngine`); `engine/engine-notices.json` names the commits and the scripts' tree hash that record names
  (`noticesForEngine`), so the notices describe this engine; the engine holds none of the strings of libpaper,
  MakeIndex, LuaTeX, luaffi or remote fetching, and does hold dvipdfmx's own paper sizes (`engineStrings`, the
  build's own list); every import of the wasm, resolved through the glue, is on the build record's list and none is
  denied (a shell, a socket, the network, dynamic loading), the record shows Emscripten's raw-socket and host
  file system settings off, and the glue's watched names appear only in the comments
  `engine/build/glue-allow.json` reviews (`engineImports`); and the record's memory layout keeps the stack and
  the static data inside the 64 MiB the worker restores (`engineHeader`). Limits of the scan: it reads names as
  written, so a name built at run time (`globalThis['fe' + 'tch']`) or a `Worker` class reached through
  `require(...)` inside an expression is not seen. No shipped file uses either today (a text search finds none).
- Private-marker scan (`scripts/marker-scan.mjs`): run by the pre-commit and commit-msg hooks, on its own,
  and over the whole history before the repository is published. The markers are not in the repository in any
  form: they come from a git-ignored `.private-markers.json` (in the repository folder or the folder above it)
  and, on CI, from the secret `LIVEMD2TEX_PRIVATE_MARKERS`. Without markers the scan fails instead of passing.
  It also decodes what a file may hide a marker in, and searches the result: escapes, HTML entities, character
  codes, base64, base32, hex, percent encoding, UTF-16 and ROT13, plus a marker written backwards or split up.

## The TeX engine

The engine is our own build of TeX Live's programs: pdfTeX, XeTeX, xdvipdfmx and bibtex8 on kpathsea (TeX Live
2026), in one `engine.wasm` with its glue `engine.js`. This repository builds it (`engine/build/`, below), and our
own driver in `src/engine-host/engine/` runs it. Its files are not in the repository: `engine/pins.json` names each
one with its address in the engine release, its size and SHA-256 (`livemd2tex-engine`, release `engine-6a30018-4`),
beside a small CTAN set (corpus samples, the publisher classes, DejaVu). The release was published on 2026-11-02
(the pin's `published`) as an immutable release, so its files cannot change; `npm run engine:assets` downloads them
anonymously and checks each one. The CTAN set comes from a release of this repository too,
`test-inputs-20261015-1`, published on 2026-11-03 as an immutable release, and not from a CTAN mirror, which
serves only each package's newest files. On a first fetch or a CI cache miss, `npm run engine:assets` downloads
15 archives and CTAN's zip (33.4 MB downloaded) and checks each one. It keeps only the set's 36 files: 35 unpacked
from the archives, and the zip (13.0 MB kept).

That release, `test-inputs-<snapshot date>-<n>`, is made as a draft by `.github/workflows/test-inputs.yml` (by
hand, on `main`, with the candidate number `n`):
- **What it holds.** Whole works, unchanged, since the LPPL counts the distribution of part of a work as a
  modification (clause 2):
  - every archive the pinned TeX Live snapshot has for the nine packages the set's files come from (ieeetran,
    elsarticle, beamer, ucbthesis, acmart, llncs, pgf, dejavu and tensor: their run, doc and source archives);
  - CTAN's `revtex.tds.zip`, which the tests use as a CTAN ZIP (TeX Live has REVTeX's files, but not the zip);
  - the snapshot's `texlive.tlpdb.xz`, so anyone can check each archive's SHA-512;
  - `test-inputs.json`, the list of every file with its hashes and where it comes from.

  `scripts/lib/test-inputs.mjs` names each pinned file's archive and path.
- **The checks before the draft.** `scripts/test-inputs.mjs` writes the curl configs and curl fetches (as for the
  data releases). The tool then checks:
  - the tlpdb against `engine/bundle-pins.json`;
  - each archive against the tlpdb's size and SHA-512;
  - the zip against its pin;
  - each pinned file, unpacked, against its pin.

  So the release is known to give the pinned bytes. The tag must be free, and the draft must hold every file by
  name and size. The notes give each package's version and licence as its files state them, and where its licence
  texts are inside the archives. That includes llncs's credit (CC BY 4.0, and the LPPL of its `splncs04.bst`) and
  DejaVu's whole terms.
- **Making the release**, step by step:
  1. Run it: Actions, test-inputs, Run workflow, on `main`, with the candidate number (1 for the first).
  2. Read the run: every step passed; the check names 21 archives, the zip and the tlpdb, and 35 test files
     unpacked from the archives and checked; the draft holds its 24 files, which the job checked by name and size;
     the notes name the run's commit.
  3. When the job fails, its log says where. A failure before the draft step leaves no draft. If it fails after
     making the draft, or an upload fails partway (`gh release create` then leaves a partial draft), delete that
     draft on the Releases page. Then re-run the failed job, or start a new run with the next candidate number. A
     candidate number belongs to one run, as for the data releases.
  4. Publish the draft only after that check, with "Set as the latest release" unticked. Then check which release
     GitHub shows as "Latest", and set it back on the engine release if it moved, as for the data releases
     ("Running the data release", step 4).
  5. Pin it (the next item). Before the pins reach `main`, run, logged out, `node scripts/engine-assets.mjs --root
     <an empty folder> --source <id>` for each of the ten `ctan-*` sources. Each must say "all pinned files
     verified".
- **The pins, once the owner has published it.** `node scripts/pin-test-inputs.mjs --release DIR --published
  YYYY-MM-DD` (DIR: the release's files) checks the same things again. It then points each `ctan-*` source at the
  release: its `archives` (each with its address, size and SHA-512) and each file's `from` (an archive) and `path`
  (inside it). The sizes and SHA-256 never change there. A new file for the set gets its pin from its archive in
  the same way, after its entry in `scripts/lib/test-inputs.mjs`. Today all ten sources are pinned to
  `test-inputs-20261015-1`: 15 archives and CTAN's zip. From them come 36 files kept: 35 unpacked from the
  archives, and the zip. acmart's four `samples/*` files and llncs's `llncsdoc.tex`, which no test read, were
  dropped then, from the pins and from `scripts/lib/test-inputs.mjs` together.

  `scripts/engine-assets.mjs` then downloads each archive a missing file needs and checks it. It unpacks the file
  with our own xz and tar readers into the same folder as before, checks it, and deletes the archive. So the tests
  and the CI cache see the same files.
- **Tests:** `test/unit/testInputs.test.ts`, on archives made in the test, with no network. It covers:
  - every pinned file's archive and path;
  - the pins' shape: every `ctan-*` source on the one release, each file from one of its source's archives (CTAN's
    zip alone fetched by itself), every address under that release's downloads, and none on a CTAN mirror;
  - each package whole;
  - the tag;
  - the fetch of unpacked files: once per archive, nothing when present, and a failure for an archive of other
    bytes, a missing member, a member that is not its pin, `--verify` and an unpublished release;
  - the notes;
  - `pin-test-inputs.mjs`'s refusals.

  `test/unit/workflows.test.ts` checks the job.

```sh
npm run engine:assets   # fetch and check every pinned file into ../engine_assets/ (about 411.6 MB; never inside the repo)
npm run test:engine     # the engine tests: fixtures, the public corpus P1-P8, the engine-host design, any private tests
```

The engine tests also need TeX's files: a core-data package and the Extra Packages add-on built for the pinned
engine (their manifests' `abi` is its SHA-256). `engine/pins.json` pins both, each a `.vsix` in a data release of
its own: `livemd2tex-core-data` (release `core-data-ae9dbba-2`, 131.7 MB) and `livemd2tex-extra-data` (release
`extra-data-ae9dbba-2`, 239.9 MB), built by `bundle.yml` from the pinned snapshot ("The data releases" below).
`npm run engine:assets` downloads them with the engine. `stage-engine --data` then stages the pinned core data,
and the engine and integration tests mount the pinned add-on for the documents that need it, as for a user who
installed it. Each use checks a pinned package against its pin's size and SHA-256 (`checkedDataPackage` in
`scripts/lib/data-pins.mjs`): a file that differs fails on any machine. A missing file skips on a laptop, where
every engine test is then pending and `stage-engine` says it skipped. On CI (`CI=true`) a missing engine, core
data or add-on fails the engine tests and the VS Code integration tests, so a CI run never passes by skipping
(`test/support/missingData.ts`, `scripts/lib/data-pins.mjs`). Only a repository that pins neither data package
skips them on CI, with one notice.

To test a local build instead, such as one with changed rules, set `LIVEMD2TEX_CORE_DATA` to its core-data package
and `LIVEMD2TEX_EXTRA_DATA` to its add-on, and, for the bundle tests, `LIVEMD2TEX_BUNDLE_OUT` to the builder's
output folder. The variables come before the pins. The builder makes both packages on a laptop from a downloaded
copy of the pinned snapshot (`node scripts/build-bundle.mjs --local DIR`, "The data sets" below). Point the two
variables at its unpacked folders, `<out>/core-data` and `<out>/extra-data`: `stage-engine` then hard-links the
core data into `dist/data`, and the tests read the add-on where it is (a `.vsix`, such as the pinned one, is
unpacked on every run, about 0.5 GB). A `LIVEMD2TEX_EXTRA_DATA` that names nothing fails on any machine.

- Every route out of the engine is closed inside it. `system()` and `popen()` are our stubs
  (`engine/build/stubs.c`), which start nothing, so `\write18` and `\input|` run nothing. The engine imports no
  function for a socket, the network or dynamic loading (the build's import check and the VSIX scan). The glue is
  Emscripten's own; its few web-request lines are never reached under Node, and the scan lists each as reviewed.
  `engine/texmf-override.cnf` turns shell escape and all `mktex*` font generation off, and every call passes
  `-no-shell-escape`.
- The engine host sets the engine's environment. A tool or a test may set only three variables over it
  (`ENV_OVERRIDES` in `src/engine-host/engine/layout.ts`): `LIVEMD2TEX_FONT_LIST_CHECK`, which turns on the font
  list's collision report, and `SOURCE_DATE_EPOCH` and `FORCE_SOURCE_DATE`, the fixed dates a comparison of two
  runs needs. The engine host and each worker refuse any other variable (`checkEnvOverrides`), so shell escape,
  the search paths and the `mktex*` switches cannot be set this way. The extension sets none.
- The engine host compiles the WebAssembly module once, reads the core image (LZ4) with `fs` into a
  `SharedArrayBuffer`, and runs each compile in a `worker_thread` (one at a time); cancel terminates the worker.
  Each worker unpacks the image into its own buffers. The next compile starts only after the cancelled worker
  has exited. A cancel names its job, and the engine host ignores a cancel for any other job.
- The tools run one after another in one WebAssembly instance (BusyTeX's pattern). After each tool the worker
  restores the first 64 MiB of memory; the build keeps the stack and the static data inside them, and `prepare()`
  refuses an engine whose memory is not that size. The workers run with a 16 MiB stack, so TeX's own limit stops
  a runaway macro before V8 does.
- Only the files that changed since a project's last compile cross to the engine host. The engine host keeps
  each project's files (the last 8 projects, at most 256 MB together; a document with no preview and no editor
  tab is dropped). After a restart, or after its project was dropped, it asks for the whole project once.
- When the engine fails to start or load, its process is stopped and the error shows once. Later compiles fail
  quietly with the same message, until the engine files change or you run "Compile this document now" (or
  "Open LaTeX preview" for a Markdown file), which tries again and always answers with a pop-up.
- The main file may have spaces or accents in its name, or an upper-case `.TEX`. File names are case-sensitive
  in the preview on every system: `\input{Chapter1}` does not find `chapter1.tex`, even on Windows and macOS.
- XeTeX finds fonts by name through the font list, not fontconfig: the worker joins the lists of the images it
  mounts (`fonts/xetex-fonts.tsv` in each) into `/engine/fonts.list`, which the engine's stand-in reads
  (docs/DESIGN.md#engine-and-data). Nothing is scanned and no font cache is written.
- Engine tests can run under VS Code's own Node: set `ELECTRON_RUN_AS_NODE=1` and run
  `"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" node_modules/mocha/bin/mocha.js --config .mocharc.engine.cjs`.
- Results go to `../s1_runs/`, outside the repository. For a private document they hold numbers only. The
  tests fail when the engine host's peak memory reaches 1.5 GB, or a cancel takes a second or more.

### The TeX engine: our own build

`engine/build/` builds the engine: one `engine.wasm` and its glue `engine.js`, with pdfTeX, XeTeX, xdvipdfmx and
bibtex8 on kpathsea, from TeX Live's source at commit `6a300188` with Emscripten 6.0.13. `engine/engine-build-pins.json` pins every input by address, size and SHA-256. It runs under Linux, Ubuntu
26.04 (WSL2, or GitHub's `ubuntu-26.04` runner), never under Windows itself.

```sh
bash engine/build/build.sh --fetch --root ~/engine-build --out ~/engine-out   # the build (about 45 min, 3.7 GB)
node engine/build/tools/run.mjs ~/engine-out [--thai-font Loma.otf]          # the smoke test (31 cases)
node engine/build/tools/wasm-inspect.mjs ~/engine-out --check                # the safety checks (also run by the build)
node scripts/engine-compare.mjs CI_OUT WSL_OUT                               # two builds: prints "match" or what differs
node scripts/engine-shakedown.mjs --b ~/engine-out --a OTHER_ENGINE_DIR --images DATA_PACKAGES_DIR --work WORK_DIR \
  --corpus CORPUS_DIR --reference CORPUS_REFERENCE_JSON   # real LaTeX, A and B paired (--a busytex: the earlier
                                                          # engine, with --host of a checkout that still pins it)
```

- **Host tools** (Ubuntu package names; `engine-build-pins.json`, `hostTools`): `build-essential python3 xz-utils
  curl git gawk`; for the font check also `fontconfig libfreetype-dev libexpat1-dev pkg-config gperf`. `gawk` is
  required: kpathsea's `paths.h`, which is compiled in, is written by awk, Ubuntu's default awk is `mawk`, and
  `build.sh` passes `AWK=gawk` to both configure runs. It also passes `LEX=:` and `YACC=:`, so a flex or bison on
  the machine (GitHub's runner has both, WSL neither) changes nothing configure writes: TeX Live ships the scanners
  and parsers they would make. The manifest records each tool's version and Debian package (`toolchain.host`) and,
  on CI, the runner image. Emscripten and its Node come from the pinned archives, which `build.sh` installs into the
  build root; the build's own tools run on that Node (`EMSDK_NODE`), never on another node on `PATH`, and the build
  stops if its version is not the pinned one.
- **Where things go.** The build root must be outside the repository and, under WSL, in the Linux file system
  (`/home/<user>/...`). Use at most `--jobs 6` on a machine with 8 GB or less. `<out>` gets `engine.wasm`,
  `engine.js`, `engine-build.json` and `generated-sources/` (the generated C and headers: web2c's output, every
  `config.h`, `c-auto.h` and `paths.h`); the step logs stay in `<root>/logs/`. Nothing of it is committed.
- **Steps.** Each step logs to `<root>/logs/<step>.log` and is skipped when it is done; `--from STEP` redoes a step
  and every step after it. A speed variant sets `OPT` (default `-O3`), `EXTRA_CFLAGS` or `EXTRA_LDFLAGS` and builds
  into its own `--root` and `--out`, sharing the archives with `--downloads`: for example `OPT=-O2 bash
  engine/build/build.sh --root ~/engine-build-O2 --downloads ~/engine-build/downloads --out ~/engine-out-O2`. A
  change of `EXTRA_LDFLAGS` alone may reuse a root with `--from link`. The manifest records them.
- **`-g1` is required** (`--no-g1` is refused). It changes no byte of the wasm (the build checks it), and it keeps
  the glue's whitespace, comments and import names: without it Emscripten writes each library function into
  `wasmImports` in place, so the import check cannot name most of the imports, the scan's allow-list cannot tell its
  entries apart in a two-line file, and MiniLZ4's notice drops out of the glue. The glue's one `SOCKFS` (a comment)
  is a reviewed entry of `engine/build/glue-allow.json`, pinned to the glue's SHA-256 and line.
- **What the build checks, and fails on.** The rename and shared lists (a shared name must sit in `.bss`; strong
  names two libraries define are listed, and two loaded definers fail); the `-g1` link's wasm against the link
  without it; the link map, every input mapped to its part of the engine (`LINK_PARTS` in `link-report.mjs`) and
  nothing else; the linked libc files' own notices, each of which `LICENSES/engine/musl-file-notices.txt` must hold;
  the `system()` controls (with `-g1` the deny list must catch `__emscripten_system`; without it the unnamed-import
  rule must); and the safety checks on what ships (imports, exports, layout with the static end, libpaper's paper
  table and `PAPERSIZE` absent and dvipdfmx's `isob3` to `isob6` present, the strings of the dropped parts, the
  glue's watched names). **The configure check** (`tools/configure-check.mjs`, after the native step and after the
  build step) fails the build if any configure run took a lex or yacc other than `:`, if a `c-auto.h` or `config.h`
  defines `YYTEXT_POINTER`, if a library came from the machine (`--with-system-…`, or pkg-config found one), or if
  a step log shows make running a generator (`build-aux/missing` for autoconf, automake or makeinfo, `build-aux/ylwrap` for flex or bison,
  `help2man`). So a new runner image with other programs cannot change the generated sources without stopping the
  build.
- **No file of TeX Live's source is patched.** The build edits files TeX Live generated, each listed in the manifest
  (`generatedEdits`): dvipdfm-x's `config.h` and `Makefile` (no libpaper), `pdftexd.h` (the shared names),
  `libicudata.a` (ICU's data compiled whole) and the execute bit of the configure scripts it skips. No autoconf
  answer is given: three that an earlier draft gave were read by no configure script it runs, and were dropped.
- **Two builds must match.** The CI build (`.github/workflows/engine.yml`) and a WSL build from a fresh clone of the
  same public commit, never from a worktree, with nothing edited during the build, must give the same `engine.wasm`
  and `engine.js`; their manifests may differ only in the fields `scripts/engine-compare.mjs` lists as `IGNORABLE`:
  `toolchain.machine`, `toolchain.runnerImage`, `toolchain.host.*`, `toolchain.nativeCompiler` and `toolchain.python`
  (the scripts' commit counts: both sides build the same public commit). When they differ, the tool prints each wasm section's size, the
  data strings one side holds only (a path, a date), the glue lines, the manifest fields and the generated sources
  that differ; the CI run's `engine-generated-sources` artifact holds the same set as `<out>/generated-sources` under
  WSL. If GitHub ever serves a commit archive with other bytes, `build.sh` refuses the pinned SHA-256; build with
  `--downloads` pointing at the engine release's copy of the archive.
- **The release.** Published releases cannot change, so the draft holds everything, and it holds the bytes that
  were compared. The order: run `engine.yml` on `main` without "release"; download its `engine-build` artifact and
  its `engine-generated-sources` artifact into `<dir>/generated-sources/` beside it (the artifact is rooted at the
  folder itself); build under WSL from a fresh clone of the same commit; run `engine-compare.mjs`. Only on "match",
  run `engine.yml` again on `main` with "release" ticked and three inputs copied from the compared run: the commit
  (`expected_commit`) and the SHA-256 of `engine.wasm` and `engine.js`. The release job fails before the draft
  unless it runs on `main` at that commit and its new build has those hashes. It checks TeX Live's and Emscripten's
  archives against their commits' trees, the artifacts against the manifest, the pins and the checkout, and an
  archive of our build scripts at the commit (`engine/build/`, the pins and `LICENSE`, whose files must give the
  manifest's tree hash); it fails if the tag or a release of it exists; and it makes the draft
  `engine-<TeX Live short commit>-<n>`: the engine, its manifest and logs, the licence texts and notice files of
  `engine/engine-notices.json`, a generated `NOTICE`, the two source archives, our scripts' archive, and notes
  with the source directions (`scripts/engine-release.mjs`); then it counts the draft's files. The owner publishes
  it with "Set as the latest release" unticked (the extension's releases are the latest). While the engine release
  was the repository's only published release, GitHub showed it as "Latest" even with the box unticked. Since the
  data releases, it keeps the mark only because the owner set it back by hand ("Running the data release", step
  4); the first extension release, published as the latest, takes the mark. Then
  `engine/engine-build.json` is committed from the draft's own copy. Nothing is added later. `engine/pins.json`
  then pins the release (`livemd2tex-engine`: each file's address, size and SHA-256, the tag and the commit), and
  the data packages are built again for its `abi`. Once the owner has published the release, the next commit sets
  the pin's `published` to the date of publication and rewords its `note`; until then `scripts/engine-assets.mjs`
  refuses to download the release's files, and every CI job stops at its first step.
- **The font check** (`engine/build/tools/font-check.mjs`) compares the font list our fontconfig stand-in reads with
  a native `fc-scan` of fontconfig 2.13.96 (check 1), and every font name through the earlier engine (run with
  `--old-host`, a worktree of a commit that still pins it) and ours (check 2). It builds the list as the host will: each data set's list with its own `fontOrder` rules, joined core
  first; a name two sets share, a rule that does not hold and a rule that decides nothing fail it. `--evidence`
  leaves each rule out once and records the requests that then differ. `FcInit`'s collision report is printed only
  when `LIVEMD2TEX_FONT_LIST_CHECK` is set, which the builder and the font check do and the host never does.
- **The LaTeX shake-down** (`scripts/engine-shakedown.mjs`) runs real LaTeX through the extension's engine host
  (build `dist/` and `out/` first): it makes `pdflatex.fmt` and `xelatex.fmt` with each engine given as a folder,
  puts them into a copy of the core image, and compiles the corpus and its own cases (XeLaTeX with OpenType fonts by
  file name and bibtex8, X1; the speed benchmark's XeLaTeX document with fonts by family name, X4; `\write18` and
  `\input|` with shell escape forced) on A and B in turn. The dates are fixed: every format build and compile of an
  engine folder gets `SOURCE_DATE_EPOCH` (`--epoch`, default 1700000000) and `FORCE_SOURCE_DATE=1` through the
  host's override of the engine's environment, and a PDF that does not carry that date fails the run (a host
  without the override leaves the real date in). So A's and B's PDFs must be the same bytes, and a difference fails
  the run; every PDF is kept in `<work>/pdf/`. `--b-epoch N` gives B other dates, a control that must fail. Each
  job is prepared by the extension's own compile pipeline, so the add-on image is mounted only for a document whose
  preamble needs one of its packages, or after a "not found" names one of its files, as the extension mounts it
  (`--extra always` mounts it for every compile, to measure its cost; `--extra never` leaves it out; `--host DIR`
  runs another checkout's engine host). It reports pages, error lines, font warnings, embedded fonts, SyncTeX, times
  and memory. On B, `\write18` must reach `system()`, which runs nothing: the log says `runsystem(...)...executed`,
  the command's file does not appear, and the transcript says `system returned with code -1`. (The earlier
  engine, TeXlyre's build, answers the same, so the build's import checks, not this case, show that our stub is the
  one linked.) B may not warn where A does not. A document that gets the add-on after a "not found" is compiled
  twice, and its time covers both. A speed comparison of two builds measures with it. The engine host gives the
  engine the font list of the images it mounts, so the shake-down also covers fonts that LaTeX looks up by name.
- **Decisions, 2026-10-31.** Fonts by name go through our stand-in, with no fontconfig and no expat. The `-g1` glue
  ships. The collision report is on request only, and the builder checks collisions across the sets mounted together.
  CI runs on `ubuntu-26.04`.
- **The level, 2026-11-01.** The engine is built at `-O3` with `-sTEXTDECODER=2` (`build.sh`'s defaults). By the
  speed plan's pass rule, fixed before the timing, `-O3` failed: on its guard row, a short paper's first compile
  after each host start (which follows 10 idle minutes by default), it was slower in 30 of 30 pairs in three runs,
  by 21 to 29 ms. The maintainer took `-O3` anyway, as a recorded exception to that rule, for its gain per edit in
  a running session: about 0.25 s for a 31-slide deck, about 75 ms for a Markdown note, and 3 to 18 ms for a paper.
  The cost accepted: those 21 to 29 ms on a short paper's first compile after each host start, and an engine about
  1.6 MB larger. `-sTEXTDECODER=2` keeps `-Oz`'s text decoding (at `-O3` Emscripten's default decodes short strings in
  JavaScript, which gives other characters for invalid UTF-8). The engine releases `engine-6a30018-1` and `-2` were
  `-Oz` drafts, and `-3` an `-O3` draft with a false notice line; none was published. Another level may replace
  `-O3` at the yearly TeX Live rebuild, if it builds in its own root, passes the build's checks and the font
  check, measures with the shake-down paired against the shipped level with every PDF the same, passes the
  recursion case with the workers' stack, and passes its own gate.
- **Runtimes.** The smoke test runs under Node 22 and 24, and under VS Code's own runtime (`Code.exe` with
  `ELECTRON_RUN_AS_NODE=1`; on 2026-10-31 Electron 43.7.7 with Node 24.21.0 and V8 15.0). The engine's workers need a
  larger stack than Node's default: with `resourceLimits: { stackSizeMb: 16 }` TeX's own `expand_depth` stops a
  runaway macro. What a worker with Node's default 4 MB does first depends on the level (the `-Oz` pdfTeX met V8's
  `RangeError` first); the smoke test records it. At the shipped level, `-O3`, the engine tests' recursion fixture
  fails without the 16 MiB (pdfLaTeX's second run, XeLaTeX's first), so it guards the setting.
- **Decisions, 2026-10-30 and 2026-10-31** (the maintainer's, on the plan for this engine):
  - LuaTeX is left out (2026-10-31). Adding it back would take a new build with its parts, the LuaTeX data
    packages and their format, and their notices again.
  - No code comes from TeXlyre's build. BusyTeX's MIT code is a reference, and a line copied from it is marked
    "from BusyTeX" and carries its notice.
  - Indexes are out of scope: the engine holds no MakeIndex.
  - One file holds the four programs. The lists of renamed and shared names that this needs are computed by the
    build, not kept by hand.
  - ICU's data is compiled in whole.
  - `system()` and `popen()` can never start a shell: our stubs replace Emscripten's.
  - Emscripten 6.0.13, pinned with its emsdk archives and its Node; it moves on purpose, once or twice a year.
  - No patch to the generated glue. Its web-request lines are reviewed entries of the scan's allow-list.
  - The files are `engine.wasm`, `engine.js` and `/bin/engine`.
  - The engine lives in a release of this repository, and immutable releases are on (2026-10-31). A release holds
    everything from its first publication: the engine, its record and logs, the licence texts and notices,
    `NOTICE`, the source directions, and TeX Live's and Emscripten's source archives (Emscripten's attached,
    2026-10-31).
  - Two builds, the CI build and a WSL build of the same public commit, must give the same bytes before a release.
  - The engine reaches public `main` before the first extension release that ships it; nothing is released from
    `main` until then, and if that release's checks fail, `main` goes back to the earlier engine by a new sync.
  - Before that release, the new engine's compile times and memory are compared with the earlier engine's. A
    compile more than 25 % slower, or a document's peak memory more than 10 % higher, holds the release for a fix
    (2026-10-31). Speed work goes on separately.
  - The licence statement and `package.json`'s `GPL-3.0-or-later` (README.md, "Licence").
- **Each year.** TeX Live's new year comes each March: move `engine/engine-build-pins.json` to the new branch's
  commit, build under WSL, fix what moved (configure's answers, a library's flags; the renamed and shared names are
  computed again), build on CI, compare, release, pin the release, build the data packages again, and run the font
  check and the shake-down against the previous engine. Run the notice search on the new archives ("When the
  engine is rebuilt", under "Licences, notices and releases"). Emscripten moves once a year on purpose. The
  libraries that read users' files (libpng, FreeType, HarfBuzz, zlib, xpdf) can need a security fix: watch TeX
  Live's branch and their advisories, and rebuild from a newer commit of the branch when one matters.
- **Both data packages are pinned** (core-data and the Extra Packages add-on), so CI has the engine's TeX data.
  The engine tests and the VS Code integration tests that compile fail on CI without their inputs (the add-on's
  cases among them, and `scripts/run-integration.mjs` stops without the add-on), and the VSIX scans step scans the
  test copy as well as the plain package. A repository that pins neither data package skips them on CI with one
  notice that says so instead, and a unit test fails a commit that pins one without the other. A release must be
  published before the repository's `main` pins it, the engine's and each data package's alike:
  `scripts/engine-assets.mjs` cannot download a draft's files, and says so.

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
development machine, with a core-data package built for the pinned engine ("The TeX engine"):

```sh
node scripts/stage-engine.mjs --data --data-package PATH   # put the engine and the core data into dist/ (hard links), for F5 and the tests
node scripts/vsix-scan.mjs --test-copy --data-package PATH # build, stage, package and scan the test copy into out/vsix/
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

## Measuring speed

The speed tools are in `test/speed/`: the pass rule (`compare.ts`) and the shape of the result files it reads
(`samples.ts`), the reader of the benchmark's options and its start-load report (`benchArgs.ts`), shared helpers
(`common.ts`, which holds the measuring lock), the benchmark's six documents (`docs.ts`), CPU profiles
(`profile.ts`) and a data package unpacker (`unpackData.ts`). None of them knows the engine's file names. The
benchmark itself, which drives the extension's compile route and writes the result files, and the focused
experiments come with the engine's own build, which renames the engine's files they start; their commands are
added here then. `compare.ts` reads result files only.

- The probe (`src/engine-host/engine/speedProbe.ts`) is built in only by `--speed-probe`, which cannot be combined
  with `--production`. Every other build bundles `speedProbeOff.ts` in its place, in every bundle and for any import
  path that ends in `speedProbe`; the stand-in does nothing and reads no variable. `test/unit/speedProbe.test.ts`
  fails if any built script in `dist/` holds the probe, and checks the stand-in's values; the VSIX scan refuses a
  package whose scripts hold the text `LIVEMD2TEX_SPEED_`. By hand,
  `node scripts/build.mjs && grep -c LIVEMD2TEX_SPEED dist/engine-worker.js` prints 0. Run `node scripts/build.mjs`
  again before packaging or before the other tests.
- In the measuring build the probe still does nothing unless the engine host's environment sets
  `LIVEMD2TEX_SPEED_PROBE=1` (the benchmark sets it). Its switches (`LIVEMD2TEX_SPEED_RESTORE`, `_SYNCTEX`,
  `_STACKLIMIT`, `_LZ4SLOTS`, `_FILES`, and a job's `.speed.json` file) are read only then, and a value that is not
  on a switch's list is ignored. It also fixes the dates (`SOURCE_DATE_EPOCH`), so two runs give the same PDF bytes,
  and reports the worker's own phases and its thread's CPU time in each step's `probe` record.
- Compare in pairs: the same text compiled twice, A and B, one after the other, so a busy machine slows both alike.
  Calibrate first with an A/A run of the same rows and kind, on the same engine, image and host flags as the test's
  A side, and give that file to `compare.js --band`. A result file records each engine by the hash of its files and
  each image by the hash of its index file, and the load at the start: the CPU use over two seconds, the free
  memory, and what a calling script reports in `LIVEMD2TEX_SPEED_START_LOAD`, read at that moment (JSON: `wslLoad`,
  WSL's one-minute load average; `windowsCpuPct`; `power`). A field of the wrong type stops the benchmark. A calling
  script reports a WSL load of 0 when WSL is not running, since reading it would start WSL's virtual machine and take
  memory the run needs. The benchmark's own power watcher reads Windows' battery status at the start, about every
  30 s and at the end, and the result file keeps every reading with its time; on another system the file says that
  there is no watcher.
- With two engine hosts (B with other flags, another image, other variables or another engine), both restart every
  `--restart-every` pairs (4) within a row, the one started first alternating. Each host keeps its own speed for as
  long as it runs (within about 1 to 3 %), so the pairs between two restarts form one block, and the blocks, not the
  pairs, are a two-host row's independent units: 16 pairs make 4 blocks, 2 in each start order. In one host (A and B
  differ only in a worker switch) the row is one block.
- `compare.js --paired P.json --aim doc:mode,... --band CAL.json` judges a change aimed at a gain. An aimed row
  passes with at least `--min-pairs` pairs (default 8; 16 to 20 for a gain under 10 %), an even number, B faster in a
  clear majority (sign test, p at most 0.05, on the untied pairs: a tie counts as neither), and a median change below
  minus the band, 3 d/√n, where d comes from the calibration's row (10 % for a row it lacks, which the report names).
  With two hosts the band is the larger of that and 3 d_block/√blocks, where d_block is the median of the
  calibration row's absolute block medians and blocks is the number of blocks in the run's row; the report shows
  each block's median. Any other row fails when its wall median is past the band and either the sign test says B is
  slower or the CPU median is past its band too. Every pair,
  set-aside tries included, must give the same PDF, `.aux`, problems list and SyncTeX text (`--outputs-may-differ`
  lifts this for an engine or data change, but a pair still fails if either side has no PDF, the page counts differ,
  or B has more errors). A pair is noisy above 40 % machine CPU or below 1,000 MB of free memory, whatever the run
  was told. `compare.js` also fails a missing CPU time (unless `--no-cpu`), a row with more than half its pairs
  noisy, a run that started busy, with less than 3,000 MB free, or reported no WSL load (`--no-wsl` on a machine
  without WSL), a run whose power record has a reading that is not mains, fewer than a start and an end reading, a
  gap of more than 90 s (a watcher that stopped), or no readings (`--no-power` on a system without the watcher; it
  is refused for a run made on Windows, where the watcher always runs), a two-host row whose hosts started in one
  order only, and a calibration that is not A/A, pairs the other way, ran under another runtime, engine, image or
  host flags than the run's A side, restarted its two hosts at another interval, fails the same start and power
  checks, is noisy in more than half its pairs, has a row with fewer than 10 pairs (with two hosts, fewer than 4
  restart blocks outside fresh mode), or has a row that leans: its two-sided sign test on the untied pairs is clear
  after Holm's correction for the number of rows the run uses (0.10 for the family). The report gives each guard
  row's band as the slowdown that would pass unseen, and names every check that `--no-cpu`, `--outputs-may-differ`,
  `--no-wsl` or `--no-power` lifted. The worker's CPU time is reported but is no
  second witness: on a loaded laptop it grows with the load as wall time does. PASS is necessary, not sufficient. A
  change gets one full rerun at most, of every row, with a fresh A/A calibration made in the same quiet window and
  judged by the same rules; it passes only if the rerun passes every row; both runs are reported.
- A change that only removes work, one of those named in `compare.ts`'s `REMOVES_WORK_TIMERS` (today the restore
  between programs), is judged with `compare.js --paired P.json --removes-work restoreMs --band CAL.json`, with no
  aimed row. The timer's entry lists every document and mode the change acts on (for `restoreMs`: all six
  documents, quick and cold), and says whether the change moves work past the result. `--rows` may add rows, never
  leave one out. Every row is a guard row, and every other check above applies; each listed row needs at least 16
  pairs and a calibration row. The timer must be present on both sides (the benchmark writes a missing one as
  `null`), lower on B in a clear majority of pairs in each listed row, and higher in none; and in each listed row the
  wall median must show the timer's gain: at most minus that gain (as a share of A's wall time) plus the band, or the
  work may have moved out of the timed code. When the entry says work moves past the result, the default-pause run
  is given as `--paired` and a run made with `--pause 0` as `--pause0` (its calibration as `--pause0-band`), and both
  must pass. The gain claimed is the timer's.
- Unpaired mode (`compare.js A.json B.json [--a2 A2.json] [--allow 5] [--aim ...]`) is for a B that cannot run beside
  A. It checks the same outputs, that every row of A and every aimed row is in both files, that no row is slower than
  `--allow` %, and that each aimed row is faster by more than `--allow` and A's own drift. It has no sign test, no
  noisy check and no start-load check, so pairs are better whenever B can run beside A.
- One measurement at a time: the tools take `../speed_runs/.measuring.lock`. Do not measure while a WSL build runs:
  `compare.js` fails a run that started at a WSL load above 1, however its pairs went. Results go to
  `../speed_runs/` (outside the repository) or `--out`; the printed tables hold no absolute path. A table pasted into
  a commit message goes through the marker hook.

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
  Its jobs are pin, fetch, build, a sharded closure test, the corpus, the reference and, by input on `main`, the
  release of the two data packages ("The data sets", below); each keeps its report when it fails. The pin job checks TeX Live's signature with `gpg` on the runner, against the key whose
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
our own. acmart's fonts (Libertine, newtx, Inconsolata) are in core-data.

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

DejaVu is in core-data, so XeTeX finds it by name through the font list (docs/DESIGN.md#engine-and-data).

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
- **Package indexes.** Each data set has one: file name to package, and the files each package loads. The
  builder writes it into the set's `data/manifest.json`, and the core manifest also lists what the Extra Packages
  add-on holds (`elsewhere`). The core's own dependencies are left to B1's closure test, and a project's class or
  package is not followed (they load some packages only for some options).
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
  mounted, as in a TeX installation with the add-on. kpathsea looks the tree's files up in its `ls-R`, which the
  worker writes for every file it mounted there (`src/engine-host/engine/lsR.ts`): `engine/texmf-override.cnf`
  lists `/texmf-extra` in `TEXMFDBS`, and the worker's `TEXMFHOME` marks it `!!`, so no lookup searches its
  folders on disk (with the add-on's thousands of folders, that search made a compile up to a hundred times
  slower). The `!!` alone keeps kpathsea off the tree; the worker writes no `ls-R` before the first image, since
  an empty one makes kpathsea warn in every run. An image's own `ls-R`, `ls-r` and `aliases` at its top are not
  kept (an alias table would apply to every tree). A lookup in `ls-R` is exact, so file names must match in case,
  as in the core. The user's package folder, also in `TEXMFHOME`, has no `ls-R` and is searched on disk.
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

The Extra Packages add-on is released on GitHub (`extra-data-ae9dbba-2`), but not yet in the stores. The tests take
it from its pin (`livemd2tex-extra-data` in `engine/pins.json`); `LIVEMD2TEX_EXTRA_DATA` overrides the pin with a
local build ("The TeX engine"). The engine tests read it, and `scripts/run-integration.mjs` hands its `.vsix` to
the VS Code tests, which install it into the throwaway profile as a user would. The core data comes from its pin in
the same way (`LIVEMD2TEX_CORE_DATA` overrides it). Tests:
`test/unit/m6.test.ts`; `test/engine/m6.test.ts` (the scan finds nothing missing in the corpus with the add-on
installed; P7 without it: the scan names its package and TeX's "not found" its class, each with the add-on; with
the add-on, P7 reaches a PDF; P2 through the CTAN ZIP; tensor from its `.dtx` and `.ins`); `test/integration/m6.test.ts` (the same in
VS Code, with the add-on installed from its VSIX into the throwaway profile, and the compile command's answer:
its own compile, never an older one that was still running); `test/engine/gate2.test.ts` (a file
an image's package loads indirectly, the mount after "not found", a package build beside a live compile, the
user's files in the change sets).

## The data sets: core-data and extra-data (B1; released as core-data-ae9dbba-2 and extra-data-ae9dbba-2)

`scripts/build-bundle.mjs` builds the two data sets from TeX Live itself, on GitHub (`.github/workflows/bundle.yml`,
run by hand). On a development machine it runs on a downloaded copy of the pinned snapshot (`--local DIR`), to
try changed rules before a release (the engine tests take its output through the variables in "The TeX engine");
its unit tests use tiny made-up archives.

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
  - **What the add-on's own packages load.** A collection brings its packages, and TeX Live seldom records what a
    LaTeX package loads, so extra-data's `packages` also names 83 packages from other collections. The add-on's
    first closure test on GitHub (2026-11-02) found what its packages load, and each named package was tried on a
    local build:
    - small packages from plaingeneric, pictures, fontsextra, humanities, bibtexextra and the language
      collections, and tree-dvips;
    - the six cheapest of the larger ones: bidi, hfbright with cmbright, fourier, stix2-type1, arimo and
      fontawesome7;
    - lhcyr, whose T2A metrics (7, 9 and 10 pt) join lh's (6, 8, 10.95, 12 and 17.28 pt), with cm-super's outlines
      from core-data. Not every style has metrics in each of these sizes. In a 10 pt document (yes: the text is
      set; no: its metrics exist only as Metafont sources, and its text is left out; compiled 2026-11-02):

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

    Larger font packages (Fira, Roboto, Source Sans and others, 3 to 75 MB each) stay out, and the files that need
    them are expected failures (below).
  - **Packages that cannot work here.** extra-data's `exclude` also leaves out 71 packages whose every main file
    fails for a reason that will not change, each with that reason: Chinese classes and four general classes whose
    default font setup loads ctex (ctex, xeCJK and their fonts are not shipped), LuaLaTeX-only classes, packages
    that need shell escape or a program (pythontex, texosquery), ones that need fonts or files TeX Live does not
    ship (URW Arial, MathTime, AcroTeX), ones whose fonts exist only as Metafont sources (Concrete, the Tibetan
    ctib), and two that draw with PSTricks. PSTricks itself stays out: its
    figures draw through PostScript, and on our engines a PSTricks figure gives no drawing (tried on XeLaTeX and
    pdfLaTeX, 2026-11-02).
  - **Files left out of a package.** A set's `leaveOut` (package: each file and its reason) leaves named run files
    out of data/ for a package it keeps, and the data package's `LICENSE.txt` lists each with its reason. lhcyr
    keeps its TFMs and styles without `maketfms.sh`, a shell script that makes KOI-8 TFMs with mktextfm, which none
    of its files reads or runs; and without its three READMEs, whose name dehyph's README in core-data has (below).
    The READMEs state lhcyr's terms, so its licence reading (`engine/bundle-licences.json`, `readings`) ships them
    with its source archive's README in `LICENSES/packages/lhcyr/`. A listed file the package does not hold, or a
    package the set does not hold, stops the build.
  - **No file name in both sets.** The extension does not use an add-on whose package index holds a file name the
    core's holds: mounted, it is searched before the core and would change the core's file for every document
    (`filesBothHold`, `src/shared/packageIndex.ts`). The builder stops on such a name, with the same rule
    (`scripts/lib/package-index.mjs`'s `filesBothHold`; a unit test keeps the two equal). extra-data leaves out
    for this reason the LaTeX development release (`latex-base-dev` and its seven siblings, read only by the `-dev`
    formats, which the extension never builds) and `mmap` (its `t1.cmap` and `ot1.cmap` are cmap's names).
    The engine tests apply the same rule when they mount the add-on.
- **Our own tools, no other program.** The builder unpacks the `.tar.xz` archives with its own xz decoder and
  tar reader (`scripts/lib/xz.mjs`, `tar.mjs`), writes `ls-R`, `language.dat` and its siblings, `fmtutil.cnf`,
  `updmap.cfg`, `pdftex.map` and `kanjix.map` the way tlmgr and updmap do (`scripts/lib/texmf-config.mjs`), and
  packs each set into one LZ4 image (`scripts/lib/data-image.mjs`, `lz4.mjs`). From its first line it refuses to
  start python or perl.
- **What TeX reads, and nothing else.** `doc/`, `source/` and `scripts/` stay out of both sets, also where TeX Live
  lists them as run files (koma-script lists its whole tree), and the report lists the packages they came from. A
  program file among the rest (`.jar`, `.whl`, `.py`, `.pl`, `.exe`, `.dll`, `.so`, a shell script, or Lua outside
  `tex/`) stops the build. Such a package is left out with its reason (today `jupynotex` and `prettytok`, which
  hold Python scripts).
- **The engine checks the result.** In the extension's own engine host it builds `pdflatex.fmt` and
  `xelatex.fmt` in initex mode, and measures what the hyphenation patterns add to them. The closure test then
  loads, alone in a minimal document, every class and every `.sty` directly in a package's own `tex/latex`
  folder. A file under `tex/xelatex/` starts on XeTeX; any other starts on pdfTeX and moves to XeTeX when its log
  asks for a Unicode engine, in any of the ways packages say it ("requires XeTeX", "XeTeX is required", "Use
  Unicode-compliant TeX-engines", "Cannot be run with pdftex" and the like; `NEEDS_UNICODE_ENGINE` in
  `scripts/lib/bundle-engine.mjs`). A missing file or font fails it, and so does a package's main file that gives
  no PDF. Packages with nothing to load (fonts, BibTeX styles) are listed as not testable.
  `engine/bundle-closure.json` holds the test's rules:
  - `setup` gives a file the preamble it needs first (babelbib needs babel with a language; numerica-plus and
    numerica-tables need numerica).
  - `expected` lists the failures that are right, each with its reason. For core-data: documentation tools and
    helpers that need a package only extra-data holds, psnfss's font options whose fonts are in extra-data, old code
    a package loads only on a LaTeX older than ours (draftwatermark-2x), and the LuaTeX branches. For extra-data:
    files that need a package the add-on leaves out or does not hold (a larger font package, PSTricks, Chinese
    fonts), files not meant to load alone (documentation classes, files that ask on the terminal, a theme or helper
    that needs its class, a class that needs an option), and files that refer to files TeX Live no longer has.
  - `expectedPatterns` lists kinds of file by a regular expression on the path, each with its reason: the dated
    rollback copies (`chemmacros-2020-03-07.sty`), which only latexrelease loads.
  The report says which missing files extra-data holds. It also names a file listed by name that loads now, and,
  after a whole run of both sets (`--closure all`, one shard, no `--files`), a pattern that took no failure: a
  pattern names a kind of file in either set, so a run of one set cannot say it took none. Any other failure stops
  the build.
- **Stages.** `--stage pin`, `fetch`, `build` and `closure` run apart, each in its own job. Each stage writes
  `report-<stage>.json` and `.txt` after every step and once more on an error, so a failed run keeps what it
  found. The closure test takes `--closure core|extra|all` (core by default), `--shard i/n`, `--hosts N`,
  `--closure-rules FILE` (rules that are not committed yet) and `--files LIST`: only the targets a list file names,
  one per line, a target's path or `package:<name>`, to check a fix; a line that names no target of the scope stops
  it. A subset run writes `closure-<scope>-files.json`, so it never overwrites a full run's file.
  - **On a laptop.** The closure stage runs on a local build of the data sets (`--local` with the snapshot copy,
    then `--stage build`), from a checkout with `node scripts/build.mjs` and `npm run compile` done and the engine
    in `../engine_assets`:
    `node scripts/build-bundle.mjs --stage closure --closure extra --shard 0/1 --hosts 2 --out <build>`. It gives
    the same failures as CI, file for file. The whole add-on takes 21 to 24 minutes on 2 engine hosts; each host
    peaks at about 1.2 to 1.8 GB of memory.
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
    kastrup's, plweb's and fltpoint's files say "see the source file", so their `.dtx` (and plweb's `.ins`) ship in
    their LICENSES folders, fltpoint's with its README and the LPPL 1.2 text its `.dtx` names; menu, fancynum,
    colorprofiles, beamertheme-metropolis, tucv, apa6e, correctmathalign, docutils and dvips get the texts their
    READMEs name, and ifsym the LPPL 1.0 text its `.sty` names. doublestroke's and lhcyr's READMEs state their own
    terms and ship; lhcyr's three in its run files are kept out of data/ (`leaveOut`, above), and its reading can
    still ship them, since a file `leaveOut` names stays available to the licence step.
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
    with the original's MD5, and the corpus gives the same PDFs with and without packing. The release job makes no
    draft from any other run ("The data releases", below).
  Tests: `test/unit/t1c.test.ts`, `test/engine/t1c.test.ts` (also partial reads through `\pdffiledump`), and on
  CI `bundleCorpus.test.ts`.
- **Fonts in the add-on.** Some fonts live only in extra-data (bookman, charter, utopia and more). A Type 1 file
  that pdfTeX cannot open, and a font that XeTeX cannot find by name, each get plain help. When the add-on holds
  the file, the message names it, and an installed add-on is mounted for the next compile.
- **Font lists.** Each set's image holds `fonts/xetex-fonts.tsv`, the list of its OpenType and TrueType faces that
  the engine's stand-in for fontconfig reads (`scripts/lib/font-list.mjs` writes it as fontconfig 2.13.96 would
  describe each face). XeTeX keeps the first face it meets for a name, so where two of a set's files share a name,
  the set's `fontOrder` rule in `engine/bundle-sets.json` says which file comes first, and why. The builder stops
  on a shared name with no rule, on a name the two sets share, and on a rule that does not hold or decides nothing.
  It also stops on a font of a kind the font check has not compared with fontconfig: a variable font, a collection
  (`.ttc`, `.otc`) or a web font (`.woff`, `.woff2`); such a font must be left out of the set first. A file the
  list writer cannot read, or one with no outlines, is left out of the list as fontconfig leaves it out, and the
  build's report and log name each one. The worker joins the lists of the images it mounts, core first
  (docs/DESIGN.md#engine-and-data).
- **One build for both sets.** The core's font maps name the add-on's fonts. So the extension accepts an add-on
  only from the same TeX Live snapshot as its core, and says so in plain words otherwise.
- **The workflow.** `pin`, then `fetch` (the archive cache is saved even when the fetch fails), `build` (the
  packages' SHA-256 go into the job summary), `closure` (sharded over 4 or 8 runners, on the packages as they
  ship), `corpus` (the public corpus on the built packages) and `reference`; then, by input, `release` ("The data
  releases", below). The header gives the minutes, as measured on the first run.
- **Downloads.** texlive.info runs a bot check (Anubis). A browser gets a challenge page before the file, and so
  does Node's fetch, which cannot answer it; curl gets the file (checked 2026-10-26). So the workflow downloads the
  files with the runner's curl, and the builder reads that copy (`--local DIR`) and opens no connection itself. The builder lists for curl what the copy lacks (`--curl-config FILE`), then checks every
  file: the package database against the pin, each archive against the database's SHA-512.
- **The reference.** A separate job installs TeX Live from the same snapshot into the runner's temp folder,
  without root: TeX Live's installer, verified with the same key, with the collections the bundle draws from,
  then the build's packages. It compiles the public corpus again, and the page counts must match
  (`test/engine/bundleCorpus.test.ts`, `scripts/bundle-reference.mjs`). Why its Perl is allowed is under
  "CI and the public history on GitHub".
- **The data releases** (`bundle.yml`'s `release` job, input `release`, on `main` only; `scripts/data-release.mjs`).
  The job waits for the `build`, `closure`, `corpus` and `reference` jobs, and makes no draft unless each of them
  passed and the closure test covered both sets (input `closure` `all`); it runs within the packages' 3-day
  artifact window. Each package gets a draft release of its own:
  `core-data-<engine short hash>-<n>` and `extra-data-<engine short hash>-<n>`. The short hash is the first 7 hex
  digits of the SHA-256 of the `engine.wasm` both are built for (their `abi`), and `n` is the input `candidate`,
  the same for the two packages of one build. Two releases, because each package is its own store item with its own
  pin, licences and sources; the shared hash and number name the pair built together (the core lists the add-on's
  files, so the two are used together). The job checks that the build holds exactly one package of each set, both
  for the pinned engine and from one snapshot; then for each package `release-sources.mjs list` names the pinned
  snapshot's archives of its GPL, LGPL and AGPL packages and packed GPL fonts, curl downloads them, and
  `release-sources.mjs check` checks each against the pinned tlpdb's SHA-512 (as `release-sources.yml` does for
  an extension release). `data-release.mjs notes` then checks the list itself against the pinned tlpdb, so a short
  list stops the job: every package under the GPL, LGPL or AGPL, and every package `LICENSES/CHANGES-GPL` names,
  must list each archive the tlpdb gives it, and `LICENSES/INDEX` must be there. Each draft holds the package,
  `<tag>-sources.tar`, `sources.json`, the pinned `texlive.tlpdb.xz` and `<tag>-LICENSES.tar` (the package's
  `LICENSES/`, every file of it: the job counts them against the package), with notes that give the package's
  SHA-256, its engine and where the sources are; the job writes every file's SHA-256 into its summary, each line
  with its release's tag. Both tags must be free before either draft is made (a failed `git ls-remote` stops the
  job; it never counts as "free"), each draft must hold every file by name and size, and the job must make exactly
  two drafts. Only that job may write, and only to make the drafts; the owner publishes each one after its check,
  with "Set as the latest release" unticked ("Publishing", above).
- **Running the data release**, step by step:
  1. Before the run: `engine/pins.json` pins the published engine release the packages are built for; no other
     `bundle` run with "release" ticked is queued or running; the snapshot answers (an anonymous `curl -I` of the
     pinned `texlive.tlpdb.xz` gives 200); and both tags are free (anonymously, `git ls-remote --tags` lists
     neither; logged in, the Releases page shows no draft of either, since drafts cannot be seen anonymously).
  2. Start it: Actions, bundle, Run workflow, on `main`: job `build`, closure `all` with 8 shards, reference on,
     version empty (it gives the snapshot's date), "release" ticked, and the candidate number.
  3. Read the run: every job passed; the build summary's two `.vsix` SHA-256 equal the release summary's; each
     draft holds its five files, which the job checked by name and size; each `<tag>-LICENSES.tar` holds every
     file of its package's `LICENSES/` (the job's log gives the count), and each `<tag>-sources.tar` the archives
     its `sources.json` lists; the notes name the run's commit.
  4. Publish each draft only after that check, with "Set as the latest release" unticked, then pin both ("The
     pins", below). Then check which release GitHub shows as "Latest", and set it back on the engine release if it
     moved. Observed on 2026-11-03: publishing the two data drafts with the box unticked (`gh release edit
     --draft=false --latest=false`) still made `extra-data-ae9dbba-2` "Latest", and `gh release edit
     engine-6a30018-4 --latest` gave the mark back to the engine release.
  5. When the job fails, its summary and its `bundle-release` report say where. A failure before the drafts leaves
     none. If it fails after making a draft, or an upload fails partway (`gh release create` then leaves a partial
     draft), delete every draft of that run on the Releases page. Then re-run the failed job within the 3 days, or
     start a new run with the next candidate number.
  6. A candidate number belongs to one build run: a re-run of that run's release job uses it again once its drafts
     are deleted, and a new run takes the next number. The number of a deleted draft is never given to another
     build.
- **The pins.** `engine/pins.json` pins both packages, added in one commit: `livemd2tex-core-data` (release
  `core-data-ae9dbba-2`) and `livemd2tex-extra-data` (release `extra-data-ae9dbba-2`), both from candidate 2's run
  at the commit each pin's `commit` names. Each pin has every field: `id`, `folder` (its folder under
  `../engine_assets/`), `release`, `tag`, `published`, `commit`, `licence`, `note`, and `files`, the `.vsix` with
  its `name`, `url` (the published release's address, `releases/download/<tag>/<name>`), `size` and `sha256`. The
  size and SHA-256 are the draft's own (the release's asset digest, checked against a download of the draft), never
  a laptop build's: a laptop build of the same commit gives a package with other bytes. The
  pins are written while the drafts wait, with `published` null; `scripts/engine-assets.mjs` then cannot download
  the files and says so, and the drafts' files go into the pinned folders by hand for the checks. Once the owner
  publishes both releases, a second commit sets each `published` to the date, and only then does the pair reach
  `main`. CI then moves from "skip with one notice" to "fail without the data" at once (`scripts/lib/data-pins.mjs`
  keys on both, and a unit test, `dataRelease.test.ts`, fails a commit that pins one without the other).
- **mylatexformat in core-data** (`forOwnDocuments`, decided 2026-11-01): a planned format that holds a pdfLaTeX
  document's preamble, which the engine host would dump, needs it, so it is in core-data rather than the add-on.
  No code builds that format yet. Its licence, read in the pinned snapshot: the LaTeX Project Public License 1.3 or
  later (`mylatexformat.ltx` lines 13-17; Copyright 2010-2011 Florent Chervet, line 24, after David Carlisle's
  mylatex.ltx, line 29; the tlpdb gives `lppl1.3`). Checked on our engine with TeX Live 2026's kernel
  (2026-11-02): `pdflatex -ini -jobname=pre "&pdflatex" mylatexformat.ltx doc.tex` dumps the format, and a pass
  with `-fmt=pre` gives the same PDF as the ordinary format, byte for byte with fixed dates, and no error. One
  difference: in that pass `\begin` is an ordinary macro, while the kernel makes it `\protected` (`latex.ltx` line
  15563, TeX Live's `latex` package in the pinned snapshot): mylatexformat redefines `\begin` with `\gdef` to catch
  `\begin{document}`, and puts the old body back the same way, which drops the `\protected` (`mylatexformat.ltx`
  lines 184-196). Whoever uses the format must allow for that.
- **Still open.** Our own copy of the snapshot after the first build.

Tests: `test/unit/xz.test.ts`, `tar.test.ts`, `tlpdb.test.ts`, `bundle.test.ts` (the whole build without the engine,
on a made-up snapshot: the signed pin, the licence lists, the licence texts and their INDEX, the report on an error,
the closure targets and the program guard, `leaveOut`; the closure rules with their patterns, the engine a file
starts on, and `--files`), `dataImage.test.ts`, `fontLists.test.ts` (the font lists and their
rules), `workflows.test.ts` (the jobs and their order, the release job's steps), `dataRelease.test.ts` (the
data releases' tags, plan and notes, the sources' list against the tlpdb, the checked data pins and their rule,
both pins or neither, mylatexformat's place), `m6.test.ts` (an add-on from another snapshot);
`test/engine/bundleEngine.test.ts` (the formats, the patterns' cost and the closure test on the engine).

## How many documents compile (M5, prepared, not yet run)

The method is `docs/coverage-method.md`, written down before any document was fetched. It measures the frame
without arXiv: TeX Live's own example and template documents of the pinned snapshot, the public corpus and the
probes. Its parameters are in `engine/coverage-local-frame.json`. It runs on GitHub only, in
`.github/workflows/coverage.yml`, by hand. In the public repository the runners cost nothing.

The arXiv frame is kept and cannot run: it waits for arXiv's permission. `engine/coverage-frame.json` sets
`harvest.enabled` to false, so the `sample` and `fetch` stages refuse to start; the workflow's `pin` and `sources`
jobs have `if: false`, and no choice of the `job` input reaches them. Running it later needs arXiv's agreement
first, then a change to the method, to that file and to the workflow, and a gate.

1. **Build the data packages.** A run of the bundle workflow; its `bundle-packages` artifact is kept 3 days.
2. **Rehearse.** Run the workflow with job `rehearse` (the default) and that run's id as `bundle_run`. Each compile
   job builds its documents from the repository (`--stage rehearse`: the public corpus and the probes of
   `scripts/lib/coverage.mjs`), so no document is fetched. The report's first lines list its checks (Ghostscript
   and `repstopdf`, the DVI route, biber, no network, a missing file, the corpus on TeX Live, every
   corpus document and probe measured on both sides), and the job fails when one does not pass. Fix and rehearse
   again until all pass.
3. **Tag the method.** Tag the commit to be measured (say `coverage-method-1`), so the method is fixed before any
   result is seen. In the public repository, run from a branch of its own (say `coverage-run`) at that commit: pull
   requests into `main` cannot restore that branch's caches.
4. **Measure.** Run the workflow with job `measure-local` and that run's id as `bundle_run` (required). Steps 1
   and 4 must fall within the bundle artifact's 3 days. The jobs:
   - `local`: first `--stage mirror-check` asks the snapshot's host for the tlpdb's signed checksum and stops the
     job unless it comes back as the file with the pinned SHA-512 (texlive.info's bot check decides by the
     User-Agent; an HTML page here means it stops this client). After `npm ci` (the stage draws a corpus figure with
     pdf-lib), `--stage local` first removes the sample an earlier run left in the cache (`papers.json`,
     `frame.json`), so a stage that stops early uploads none. It takes the pinned tlpdb (in three rounds, checked
     against `engine/bundle-pins.json`) and draws the frame from it. It stops when the frame's counts or members are
     not the ones `engine/coverage-local-frame.json` writes down. Then it downloads each drawn package's
     documentation archive with curl and curl's own User-Agent, as the bundle workflow does, one request at a time,
     a second apart, a 429 or 503 waited out, and checks each reply: status 200, no HTML page, the tlpdb's size and
     SHA-512. A download that fails three rounds keeps its package in the sample as not measured; ten such packages
     in a row fail the stage with an error, the sample saved as incomplete with the reason, so no compile job runs
     and the report gives no share. A package's document is its first example file, in draw order, that is a LaTeX
     main file, with its folder. The corpus and the probes are added. The archives go into a cache of their own
     (`coverage-docarchives-*`), for this job only; the documents go into the sample's cache (`coverage-local-*`).
     Neither goes into an artifact. Both are saved for each attempt, also when the step fails or runs out of time; a
     new run takes the archives it already has from the newest entry.
   - `texlive`: the reference, scheme-full of the pinned snapshot, its installer verified with gpg, kept in the
     cache by the snapshot's pin. install-tl, TeX Live's Perl installer, runs in this job only.
   - `compile`, one job per shard: `scripts/coverage.mjs --stage prepare` unpacks the shard's documents (each on its
     own: one that cannot be unpacked is counted, and the next goes on); `out/test/engine/coverageRun.js` compiles
     each on the extension's own route, with core alone and, where the core lacks a file, with extra installed. It
     refuses to start without the stubs or without all four engine files, and records what the stubs blocked. It
     compiles two canaries (pdfLaTeX, XeLaTeX) before the shard's documents and after them. A compile the engine
     cannot start or load for is tried once more on a fresh service, then not measured; an engine host that dies on
     a document is retried once on a fresh service, and a second death, or a fresh service that cannot start after
     the death, is the document's failure. A XeLaTeX or LuaLaTeX request gets the engine setting XeLaTeX (the
     extension has no LuaLaTeX), and the extension's own rule then reads the document. The mark written before each
     document holds the engine that rule chooses, so TeX Live runs that engine for a document the process died on.
     When only a compile with the add-on is rejected, the core result stands. `--stage reference` runs the same two
     canaries on TeX Live and compiles each on TeX Live, started with `sudo unshare --net` and dropped back to the
     runner's user: no network, a small environment, restricted shell escape and `openout_any=p` (since TeX Live
     2026 nothing limits reading; `docs/coverage-method.md`, "The reference"), and the log line
     lengths of `engine/texmf-override.cnf` (`referenceEnvironment`). TeX Live's own Perl tools (`repstopdf`,
     `biber`) run there, inside that sandbox. Ghostscript comes from the runner's Ubuntu archive
     (the job's one other use of `sudo`). The checkout keeps no token, and the job saves no cache. Results are
     written after every document, and each side stops starting documents at its time budget. "Re-run failed jobs"
     works for a shard: it restores this run's newest sample entry.
   - `report`: after `npm ci` (a rehearsal's report job runs `--stage rehearse`, which uses pdf-lib), `--stage
     report` lists every sampled document with its outcome, "not measured" with its reason included. It gives the
     shares of each part (package examples, journal, conference and thesis templates, Beamer packages, the corpus)
     with their Wilson intervals, per stratum, each part's accounting, the stratified share of the package examples,
     and the missing packages (`coverage-report.md` in the job summary, and `coverage-report.json`), with each
     share's worst and best case for what was not measured, and how many documents ran on another engine than TeX
     Live (rule 4: no more TeX errors than TeX Live's log, which both sides record). Its first lines give the checks
     (the canaries on both sides, the bounds on "not measured", on what fails on TeX Live and on what is broken as
     submitted, each shard's left-out documents against the other shards', the corpus, the probes); the next says
     when a shard or part of the sample is missing. A failed check makes the job fail. It records the commit and the
     SHA-256 of the method's files.
5. **Keep the result.** Commit `coverage-report.json` (package names, file names, outcomes; no document text)
   beside the method, as `docs/coverage-report.json`: the run's artifacts expire after 7 days.
6. **The caches.** Until a measurement runs, the repository's caches hold only npm and VS Code downloads. A
   measurement without arXiv adds public files only: TeX Live's documentation archives from the pinned snapshot
   (`coverage-docarchives-*`); the sample, that is the pinned tlpdb, the documents taken from those archives and
   the repository's own corpus and probes (`coverage-local-*`); TeX Live itself (`coverage-texlive-full-*`); and
   the engine's pinned release files, which the compile jobs restore (`engine-assets-*`). To save cache space,
   delete the `coverage-local-*` entries after a run (Actions, Caches, or `gh cache delete <key>`; the prefix
   takes the samples only), and keep `coverage-docarchives-*` and `coverage-texlive-full-*` while another run is
   planned. The arXiv frame has never run, and makes no cache while it is disabled. If it ever runs, delete its
   `coverage-sources-*` and `coverage-templates-*` entries after every run: they hold the papers' sources.

The pure parts (the frame without arXiv and its strata, the example files and their order, the draw and the
shards, "compiles" for both sides, the interval, every document's outcome, the report, the rehearsal's probes and
checks, and the arXiv frame's reader, pacer and endpoints) are unit-tested in `test/unit/coverage.test.ts`. The
same file runs the `local` stage end to end on a made-up snapshot behind a made-up mirror. `test/unit/workflows.test.ts`
checks the workflow's rules (the arXiv jobs never run and no choice names them; no document in an artifact; no
token in a checkout; no cache saved by the compile job; `sudo` in two lines only, the reference's without network).
The minutes are estimated in the workflow's header.

When M5 passes, the README's "How many documents compile" gets the numbers the method's "What lands in the README"
names, from the report, as shares of TeX Live's own example and template documents, never of papers; "Not yet
measured" goes.

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
as they are and adds no header of the extension's. `package.json` keeps `GPL-3.0-or-later`, our own code's terms,
and the CC0 files carry their own notice, as the bundled MIT and Apache-2.0 parts do. The VSIX scan fails a package whose starting documents lack the notices, the legal text or an
SPDX line, or name the GPL (`cc0Headers` and `missingNotices` in `scripts/vsix-scan.mjs`). The test fixtures
marked CC0 (`test/fixtures/`, `test/corpus/`, `test/converter/`) are not shipped.

## Licences, notices and releases

The licence gates (2026-10-26) checked every part by others that a package ships, and the engine's notices were
written again for our own engine (2026-10-31). What they set up:

- **The engine's notices.** `engine/engine-notices.json` lists the parts of the engine, each with its version,
  licence, the link inputs that belong to it (`links`) and its notice files. `build` names TeX Live's and
  Emscripten's commits, the commit and tree hash of our build scripts, and the build record
  (`engine/engine-build.json`). The notice files are in `LICENSES/engine/`, each copied from that part's own source
  and pinned by SHA-256 in the manifest (`files`). The build copies them to `dist/licenses/engine/`, and the engine
  release ships the same files. THIRD_PARTY_NOTICES.md's "Inside the engine" table is the output of
  `node scripts/lib/engine-notices.mjs`, and the release's `NOTICE` the output of its `--release-notice`.
  - `test/unit/engineNotices.test.ts` checks that each part's `links` are the patterns the build's link check gives
    it (`LINK_PARTS` in `engine/build/tools/link-report.mjs`), that every part of the link map
    `engine/engine-build.json` records is a part of the manifest, and that the map passed. The build itself fails on
    a link input no part claims. The test also checks that every notice file is present at its pinned bytes, that
    `LICENSES/engine/` holds nothing else, that the table in THIRD_PARTY_NOTICES.md is the manifest's, that the
    manifest names the commits and the scripts' tree hash of `engine-build.json`, and that the VSIX scan requires
    every notice file wherever `dist/engine/engine.wasm` ships.
  - The VSIX scan fails a package whose engine notices or licence texts are missing, or are not the pinned bytes
    (`missingNotices`, `wrongNotices`).
- **Below the link line.** A linked library can hold code by other authors under terms of their own, which the
  link check cannot see. `node scripts/engine-notice-search.mjs --archives DIR` helps a person find it; it is
  an aid to reading, not a proof. It reads the source archives (by their names in the manifest's `sources`) and
  searches each linked library's compiled sources for licence clauses that match its patterns (`clauses`, each
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
    nobody. A line that holds two kinds of clause needs both covered.
  - An own licence marked `reference` (a pointer to a notice that ships) needs no holder of its own; one marked
    `anyHolder` (a licence that asks for no list of holders in a copy, such as FreeType's under its GPL option, or a
    public-domain dedication) covers any holder and says why. These two hold only when their words start on the
    clause's own line. Words may be a phrase (`text`) or a pattern (`pattern`); `unless` rules a licence out when it
    matches the clause's lines: the public-domain dedication's catches "not", "n't", "no longer", "never" and "no"
    up to 40 characters before "public domain" in the same sentence (it stops at "." and ";"). Own licences can be
    limited to some files (`files`).
  - Every other file needs a rule in the manifest's `search`: the notice that ships for it, why the shipped notices
    cover it, or why it is not compiled for the engine. A file with no rule, and a rule that names no file, fail the
    search. A part that is not searched says why (`notSearched`: Emscripten's libraries, whose notices are
    Emscripten's, musl's and LLVM's; our own code; BusyTeX's few lines in our dispatcher).
  - The run of 2026-11-01, on TeX Live's archive at the pinned commit, is recorded in
    `engine/engine-notice-search.report.json` (each folder's files with hits, by clause kind, and the rules used).
    It found no new hit since the run of 2026-10-27, and one problem, which a new rule settles: SyncTeX's LuaTeX
    header, which only LuaTeX's build compiles. The notices it found are those THIRD_PARTY_NOTICES.md lists in
    "Inside the engine", in the paragraph that starts "Below the link line".
- **When the engine is rebuilt** from new sources (a new TeX Live commit, a new Emscripten):
  - Update the manifest's `build`, `sources` (each archive's address and SHA-256), versions and notice files, and
    run the table again. The unit test fails until the manifest names the new build record's commits and tree hash.
  - Download the new source archives (the engine release holds them) and run
    `node scripts/engine-notice-search.mjs --archives DIR --since engine/engine-notice-search.report.json`. It lists
    the files whose hits are new or changed, by folder, file and clause kinds (not by archive, whose name changes
    with the commit). A person reads each of them and each problem, writes the rules and notices, and records the
    run with `--report engine/engine-notice-search.report.json`.
  - The build checks the linked musl files' notices itself (`link-report.mjs musl`); a new linked file with terms
    of its own stops it until `LICENSES/engine/musl-file-notices.txt` holds its header.
  - No release ships a rebuilt engine before this is done.
- **This version's source.** README.md (Licence) and THIRD_PARTY_NOTICES.md name the tag of the version as its
  source: "for this version, the tag `v<version>` of https://github.com/haberwooki/liveMd2Tex", with the version of
  `package.json`. They name the tag and do not link its tree, which opens only once the release has made the tag;
  each release's page links it. `test/unit/releaseSources.test.ts` fails when the version changes and they do not.
  The repository must be public before any package is published, so that this address works.
- **Releases, in this order.** The sources are attached before any package reaches a store.
  0. If the engine was rebuilt since the last release, the notice search's new hits have been read and ruled
     ("When the engine is rebuilt", above), and its report is recorded.
  1. Push the tag `v<version>` on the commit the packages are built from.
  2. Make a draft release on GitHub for that tag, with the packages (`.vsix`) as its files. Its notes give the
     source: the tag's tree, https://github.com/haberwooki/liveMd2Tex/tree/v<version>.
  3. Run `.github/workflows/release-sources.yml` by hand with the tag. It runs `scripts/release-sources.mjs`,
     which checks the tag against the extension's version and README, and lists the sources each package needs:
     for a package with the engine, the two archives of `engine/engine-notices.json`; for a data package, the
     snapshot archives its `licences.json` lists, each under the pinned snapshot's mirrors. For the engine it also
     checks that the packaged `engine.wasm` is the one `engine-build.json` records and `engine/pins.json` pins,
     built from the two archives' commits, and says where our build scripts' source is: the tag itself if its
     `engine/build/` and `engine/engine-build-pins.json` still give the build's tree hash, otherwise the engine
     release and its commit (`buildManifestDifferences`). curl downloads the archives, git lists the trees of the
     two commits GitHub's archives are made from (fetched with `--filter=blob:none`, so only the trees come down),
     and the script checks each archive: its SHA-256 or SHA-512, a data archive's SHA-512 against the pinned package
     database, and a commit archive's files against its commit. The workflow then attaches one tar file per group
     (`engine-sources-<tag>.tar`, `core-data-sources-<tag>.tar`, `extra-data-sources-<tag>.tar`) and the list,
     `sources.json`, to the draft. The data packages are released on their own, each with its sources, by
     `bundle.yml`'s `release` job ("The data sets", "The data releases"), so the two `-data-sources-<tag>.tar`
     names apply only when an extension release also holds a data package. On the first real run, confirm that
     `gh release download` and `gh release upload` find the draft by its tag: GitHub's look-up by tag does not
     return drafts, and gh's way around that has not been tried here.
  4. Only when that run has passed: publish the release.
  5. Only then: upload the packages to the VS Code Marketplace and Open VSX.

  GitHub makes the `archive/` files of TeX Live's and Emscripten's commits on request, and promises the same files
  for a commit, not the same bytes. An archive with other bytes but the commit's files is attached with its new
  SHA-256 and a note; one whose files differ stops the run. Never make an archive by hand with a new hash.
- **A fixed copy of the engine's sources.** The engine release holds TeX Live's and Emscripten's archives from its
  first publication, checked against their commits' trees. Once it is published, each source in
  `engine/engine-notices.json` can get a `mirror` (the release file's address); `scripts/release-sources.mjs` uses
  `mirror` before the upstream address, and still checks the same hashes.
- **pplib's licence (the maintainer's decision, 2026-10-30).** pplib states no licence of its own. It stays
  recorded under LuaTeX's terms, GPL-2.0-or-later, as Debian and Fedora record it, and no question goes upstream.
- **Open.**
  - A "Licences" command that shows the notices inside VS Code, before the first release (GPL-3 section 5(d)).
  - A first bundle run on the new repository, to check `LICENSES/INDEX`, `CHANGES-GPL` and the archives in
    `licences.json` against real packages.
