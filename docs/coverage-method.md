# How many documents compile: the method

This note fixes how the coverage of the data sets is measured (docs/DESIGN.md#engine-and-data, #testing), before
any document is fetched or compiled. The numbers it produces go into the README's "How many documents compile".

There are two frames:

- **The frame without arXiv** is the one measured now. Its documents are TeX Live's own example and template
  documents and the repository's public corpus. Its parameters are in `engine/coverage-local-frame.json`; the
  rules of "compiles" (300 seconds, one page) and the 1 GiB cap are shared with the arXiv frame and are in
  `engine/coverage-frame.json`.
- **The arXiv frame** is kept but disabled. It waits for arXiv's permission. No request goes to arXiv: the arXiv
  stages refuse to run, and the workflow offers no job that reaches them. It is described at the end of this note,
  and its parameters are in `engine/coverage-frame.json`.

The scripts read those files. A change to a frame file or to this note is a change to the method; make it in both,
before a run.

## What is measured

For each document, three compiles:

- **core**: the extension's own route (the preamble scan, the engine, the pipeline's passes) with core-data alone;
- **core + extra**: the same, with the Extra Packages add-on (extra-data) installed;
- **reference**: a full TeX Live (scheme-full) of the same snapshot as the data sets (`engine/bundle-pins.json`),
  installed on the CI runner, with Ghostscript beside it (see "The reference").

The result is the share of documents that compile with core alone, and with core and extra, each against the
reference, with its 95 % interval.

## What the frame without arXiv can and cannot claim

**These are TeX Live's own example and template documents, not papers.** The shares measure package coverage, not
how often a real paper compiles. Read every number with these biases in mind:

- **They are written to compile.** A package author writes an example to show the package working, on a TeX Live
  that has everything. A real paper is not written that way, and it fails in ways an example does not.
- **They exercise their own package.** An example shows one package fully, often with few other packages. A real
  paper loads many unrelated packages and uses each a little. So a missing package shows up once, in its own
  example, rather than in every paper that loads it.
- **Each package counts once.** One document per package, whatever the package's use in the world. A package
  that thousands of papers load weighs the same as one that few do. The shares are not weighted by popularity.
- **Only packages that ship such files are in the frame.** 848 of TeX Live's 7,167 packages ship a `.tex` file
  whose name says it is an example, sample, template or demo. The others are not represented.
- **TeX Live has everything.** The reference is scheme-full of the same snapshot, so it holds every package. An
  example that fails there needs something outside TeX (a program, LuaLaTeX features, a file the package does not
  ship). It is left out and listed, not counted against the extension.
- **An example that needs the DVI route without asking for it drops out.** An example written for `latex` and
  `dvips` (PSTricks, say) that has no `% !TEX program = latex` line gets pdfLaTeX on both sides. When it fails on
  TeX Live too, it is left out, although the extension would fail it for a user. Four PSTricks packages are among
  the first 400 of the draw order (pst-pdf, pst-flags, pst-graphicx and pst-jtree, all in the graphics stratum).
  The report counts the package examples that load PSTricks and how many of them were left out.

**What it can claim:** of TeX Live's own example and template documents, drawn as below, this share compiles with
core-data alone, and this share with extra-data, against TeX Live of the same snapshot. It also shows which
packages are missing, which feeds the choice of the data sets.

**What it cannot claim:** a share of papers, of arXiv, or of users' documents. The README never says "of papers".

## The frame without arXiv

### The snapshot and its checks

Everything comes from the pinned TeX Live snapshot (`engine/bundle-pins.json`): the package database
(`tlpkg/texlive.tlpdb.xz`, checked against the pinned SHA-256, whose signature TeX Live's key vouched for), and
each package's documentation archive (`archive/<name>.doc.tar.xz`), checked against the size and the SHA-512 the
tlpdb lists for it. A file whose checksum is wrong is never used.

- **How.** With curl and curl's own User-Agent, as the data sets' builder downloads from the snapshot: the host's
  bot check decides by the User-Agent, and answers other clients, and curl with a project User-Agent, with an HTML
  page. One request at a time, at least one second apart, following no redirect; a 429 or 503 is waited out (its
  Retry-After, else 30 seconds) before the next request. A reply that is an error, another status than 200, an
  HTML page or the wrong size is a failed download.
- **First.** Before any other work, the measurement asks the host for the tlpdb's signed checksum
  (`tlpkg/texlive.tlpdb.sha512`); it stops unless that comes back as the file and names the SHA-512 the pins hold.
  Then it removes any sample an earlier run left in the cache, so a stage that stops early leaves no sample that is
  not its own. The tlpdb itself is fetched in the same three rounds as an archive.
- **When the host stops answering.** Ten packages in a row whose downloads fail stop the measurement with an
  error: past that, the bound on "not measured" would fail the run anyway. They are not turned into "not measured"
  documents of a finished run. The sample is saved as incomplete, with the reason, no compile job runs, and the
  report's first line says the sample was not drawn in full, why, and that no share of the run stands.
- **Where.** The dated snapshot is on one host, texlive.info. Its second entry in the pins, `www.texlive.info`, is
  the same server, so there is no second mirror. A copy of the snapshot of the project's own is not set up.

### Example files

A package's **example files** are the `.tex` files of its documentation tree whose name contains `example`,
`sample`, `template`, `demo`, `skeleton` or `minimal` (case ignored), as the tlpdb lists its doc files. Only
packages of category `Package` count.

### The three parts

Every package with at least one example file falls in exactly one part:

- **(b) Journal, conference and thesis templates:** the packages of TeX Live's publisher collection
  (`collection-publishers`, "Publisher styles, theses, etc.") that ship an example file: **151** packages of its
  358 at the snapshot.
- **(b) Beamer packages and themes:** the other packages with the Catalogue topic `presentation` and `beamer` in
  their name: **32** packages. Besides themes, this takes helper packages whose name says Beamer (such as
  beamerappendixnote and beamerauxtheme).
- **(a) Package examples:** every other package with an example file: **665** packages.
- **(c) The public corpus:** each folder of `test/corpus` (CC0, written by the project), one document each.

Each part has its own shares. They are never pooled.

### The sample

- **(a) Package examples: 400 packages**, drawn from the 665 and allocated to the strata below in proportion to
  each stratum's packages (largest remainders; at least one for a stratum that has any).
- **(b) Templates: all of them**, 151 and 32, a census.
- **(c) The corpus: all of it.**
- **Seed and order.** Within each stratum, the packages are ordered by the SHA-256 of `20261026:<package>`
  (the seed is **20261026**), and taken in that order until the stratum's quota is met. The templates are taken in
  the same order. The order depends only on the seed and the package names, so anyone with the same snapshot
  draws the same sample.
- **One document per package.** A package's example files are tried in the order of the SHA-256 of
  `20261026:<package>/<path>`, where `<path>` is the file's path in the texmf tree (`doc/latex/pkg/pkg-example.tex`,
  not the tlpdb's `RELOC/doc/...`). The first one that is a LaTeX main file (`\documentclass` outside comments, and
  `\begin{document}`) is the package's document.
- **Skips.** Only what the snapshot decides skips a package; it is counted, and the next of its stratum is taken:
  its documentation archive is larger than 1 GiB (none in the frame is; the largest is 159 MB), none of its example
  files is a LaTeX main file, its archive passed its checks but cannot be read, or the document's folder comes to
  more than **1,073,741,824 bytes** (1 GiB) or cannot be one folder. A skip never tries the package's next example
  file.
- **A failed download is not replaced.** A download that fails for any reason (no answer, an HTTP error, an HTML
  page, the wrong size or the wrong SHA-512) is tried again after 30 seconds and after 60 more (three rounds). If
  it still fails, the package stays in the sample, counted in its stratum's quota, and is reported as
  **not measured**. So the drawn sample differs from that of a run where every download succeeds only by the
  packages reported as not measured (one of them might have been skipped), never by the day's network otherwise.
- **The frame is fixed by the snapshot.** At the pinned snapshot the frame holds these counts, also written in
  `engine/coverage-local-frame.json` ("expected"), with the SHA-256 of its members in draw order. A run whose
  frame differs in either stops before it fetches a document.

### The strata of (a)

By the package's Catalogue topics, as the tlpdb lists them (`catalogue-topics`). A package goes to the **first**
stratum in this table that one of its topics falls under; a pattern ending in `*` covers every topic that starts
with it. A package that falls under none goes to `other`.

| Stratum | Packages | Quota | Topics |
|---|---|---|---|
| fonts | 130 | 78 | `font*` |
| maths-science | 75 | 45 | `maths*`, physics, chemistry, numbers, calculation, arithmetic, engineering, scientific-docs, units, biology, astronomy, comp-sci, algorithms, logic, statistics, pseudocode, crystallography, electronic, optics, automata, uml |
| graphics | 93 | 56 | pgf-tikz, `graphics*`, `diagram*`, colour, decoration, logo, chart, tree, pstricks, qrcode, barcode, mp-use, image-supp, watermark, background, genchart |
| references | 65 | 39 | biblatex, `bibtex*`, biblio, `cite*`, glossary, `index*`, label-ref, hyper, acronym, endnote, footnote, toc-etc |
| tables-lists-boxes | 32 | 19 | `table*`, float, listing, boxing, `box-*`, `list*`, verbatim, caption, multicol, parallel, marginal |
| languages | 58 | 35 | `multilingual*`, linguistic, `chinese*`, `japanese*`, korean, arabic, persian, bidi, cyrillic, russian, greek, hebrew, indic, sanskrit, bengali, polish, `french*`, `german*`, croatian, kurdish, malagasy, cherokee, tibetan, `vietnamese*`, other-lang, african, hyphenation, phonetic, translation, unicode, inputenc |
| document-types | 114 | 69 | `class*`, report-like, article-like, `book-*`, letter, cv, exam, exercise, notes, teaching, doc-templ, `editorial*`, magazine, presentation, drama-script, legal, games, music, calendar, poster, journalpub, dissertation, confproc, essay, cooking, covers, chess, go, puzzle, chords, crit-ed, course-material, invoice, `card-*`, meeting-admin, theology, humanities, amusements, novelty, advert, publicity |
| engines-pdf | 51 | 31 | luatex, `use-lua*`, xetex, `pdf-*`, `tagged-pdf*`, accessible, std-conform, etex, callback, engine, context, latex3, multimedia, metadata |
| layout-programming | 38 | 23 | `layout*`, geometry, `page-*`, headings, `macro-*`, counter-mgmt, keyval, format, `data-*`, csv-support, `doc-*`, cond-comp, parser, debug-supp, package-devel, latex-devel, program-doc, misc-support, project-mgmt, version-control, security, archival, typesetting, `text-*`, typeset-grid, rule, quotation, date-time, word-count, dummy-gen, random, `tut-*`, tutorial, defer-stuff, env-query, sys-supp |
| other | 9 | 5 | none of the above |

### Preparing a document

- **The folder.** The document's folder is every file of the package's documentation archive under the example
  file's own directory, with the example file as the main file. A file the example needs from elsewhere is
  missing on both sides, so the document is left out as broken as submitted.
- **The engine.** A `% !TEX program` line, else the engine the documentation tree names (an example under
  `doc/lualatex/` or `doc/luatex/` asks for LuaLaTeX, one under `doc/xelatex/` for XeLaTeX), else the extension's
  own rule (fontspec, unicode-math or polyglossia mean XeLaTeX), else pdfLaTeX. The reference runs that engine.
  - Two packages keep their examples under `doc/platex/` (pxchfon and pxrubrica): they need pLaTeX, which neither
    side runs here. They get pdfLaTeX, and are left out when that fails on TeX Live.
  - `% !TEX program = latex` asks for the DVI route: the reference runs `latex`, then `dvips`, then Ghostscript's
    `ps2pdf`. The extension has no DVI route and runs pdfLaTeX, as it would for a user.
  - The extension has no LuaLaTeX, and runs a LuaLaTeX request on XeTeX (which reads the same fontspec
    preambles). The result is judged against the reference's LuaLaTeX compile, rule 4 included (no more TeX
    errors than the reference). Many such examples are in the engines-pdf stratum.
  - On the extension's side, the measurement sets the extension's engine setting to XeLaTeX for a document that
    asks for XeLaTeX or LuaLaTeX, and to the default, pdfLaTeX, otherwise; the extension's own rule then reads
    the document (a `% !TEX program` line, then fontspec, unicode-math or polyglossia). For a `% !TEX program =
    lualatex` line, XeTeX is the extension's own rule. For an example that asks for LuaLaTeX only by its
    documentation tree, it is the measurement's choice, not the extension's rule: the measurement plays a user
    who asks for LuaLaTeX and so sets XeLaTeX. With the default setting, such an example would run on pdfLaTeX
    unless its preamble loads one of those three packages.
- **The bibliography.** When the folder holds the main file's `.bbl`, no BibTeX runs. Otherwise the reference
  runs `bibtex` (or `biber`, when biblatex asks for it), and the extension runs bibtex8 as it always does.

### Storage

The documentation archives and the documents stay on the CI runners and in the repository's Actions cache: the
archives in a cache of their own, which only the job that draws the sample reads, and the documents in the
sample's cache, which the compile jobs restore. They are never committed, never uploaded as artifacts, and never
shipped. Only the report leaves the runners: package names, file names, page counts, outcomes and the kind of each
error.

## The reference

- TeX Live as installed from the snapshot, scheme-full, with its restricted shell escape (only TeX Live's own
  list of programs, `repstopdf` among them).
- TeX may not open a file by an absolute path, through `..`, or with a name that starts with a dot
  (`openin_any = p` and `openout_any = p`), so it reads and writes only in the document's folder and TeX Live's
  own trees. The extension, too, reads only the document's folder.
- It runs as the runner's user, without network, in a copy of the document's folder.
- TeX writes its log with the extension's line lengths (`max_print_line`, `error_line` and `half_error_line`,
  read from `engine/texmf-override.cnf`), not TeX Live's default of 79 columns, so both logs are written the
  same way and rule 4 counts the same errors on both sides: at 79 columns a long path can break an error's
  `file:line:` across lines.
- Ghostscript comes from the runner's Ubuntu release (24.04). The report records its version and TeX Live's.
- On the reference, pdfLaTeX turns `.eps` figures into PDF through the restricted shell escape (`repstopdf`, which
  calls Ghostscript). The extension runs no outside program and cannot, so such a document counts against the
  extension, as it would for a user.

## When a document compiles

A compile **compiles** when all of these hold:

1. **No missing file.** The preamble scan lists no missing file, and the log reports no "File ... not found".
2. **No fatal error.** A PDF with pages comes back, the log has no "Emergency stop" and no "Fatal error", the
   engine did not fail, and the compile finished within **300 seconds**.
3. **The same length.** Its page count is within **one page** of the reference's.
4. **On another engine, no more errors.** When the extension ran another engine than the reference (a LuaLaTeX
   request on XeTeX, or the DVI route on pdfLaTeX), its log has no more TeX errors than the reference's. A TeX
   error is a log line that starts with `!` or, as both sides run with `-file-line-error`, with `file:line:`.
   Both sides count the last pass's log, written with the same line lengths (see "The reference"). A package
   that does not work on the other engine often stops with an error TeX recovers from, and the PDF then lacks
   what the package does; this rule counts that as a failure. A document whose two counts are not both recorded
   is not measured, and counts in the bound on "not measured" like every other cause.

The reference is held to rules 1 and 2 as well (the preamble scan is the extension's own, so for the reference
rule 1 is its log). A document whose reference compile breaks one is left out of the shares and listed; it never
counts against the extension:

- with a file missing on TeX Live too, it is **broken as submitted** (a figure the source lacks, say);
- otherwise it **does not compile on TeX Live either**.

On the same engine as the reference, TeX errors that TeX recovers from do not count by themselves: the page-count
rule catches the ones that change the document. On another engine, rule 4 counts them. The report gives, for each
part, how many documents ran on another engine than the reference, how many of them count as compiling, and how
many fail only by rule 4.

With the add-on, a document that compiled with core alone, with no missing file and no "not found" in its log,
compiles the same way: the add-on is mounted only for a file the core lacks (docs/DESIGN.md#engine-and-data). Such
a document is not compiled twice; its core result stands for both.

## Every document is counted

- **The shards.** The compile jobs share the documents in draw order (the SHA-256 of `<seed>:<key>`), so the
  strata are interleaved. A job that runs out of time leaves a random tail, not a stratum.
- **The outcomes.** The report lists every sampled document, with one of these outcomes:
  - it compiles;
  - it does not compile, with the first rule it breaks;
  - it is left out, as broken as submitted or as not compiling on TeX Live either;
  - it is **not measured**, with the reason: its documentation archive could not be downloaded, the extension's
    engine rejected its compile, its shard returned no results, it could not be unpacked in its job (a full disk,
    say), or a side's time ran out before it.
- **A document in flight counts.** Each side writes a mark before it starts a document, and the mark stays when
  the side's process stops during that document. On the extension's side the document does not compile, as it
  would fail for a user. The extension's mark holds the engine the extension's own rule chooses for the document
  (read from its main file before the compile), so TeX Live runs that same engine for it: a fontspec document
  the process stops on is judged against XeLaTeX, not left out after a pdfLaTeX run that was bound to fail. On
  the reference's side the stop is the runner's, not TeX Live's, so the document is **not measured**, inside the
  bound below; it is never left out.
- **An engine that cannot start is tried once more, then not measured; one that dies on a document is retried.**
  When the extension's engine service cannot start or load its data, the compile says nothing about the document.
  The service is replaced and the document compiled once more on the fresh one, so a passing failure still gives a
  measurement; when that fails too, the document is reported as not measured, with the reason. When the engine
  host dies during a document's compile, the document is compiled once more on a fresh service. A second death is
  the document's failure ("the engine stopped on this document"), as it would be for a user. So is a fresh
  service that cannot start or load right after the death, with its own reason: that is most likely the death's
  aftermath (memory not yet given back, say), so it is not "not measured". The report counts these apart.
- **A rejected compile with the add-on never throws away the core result.** The compile with the add-on runs only
  for a document that already failed with core-data alone for want of a file. When only that compile is rejected,
  the core result stands and counts in the core share; only the add-on side is not measured, with its own count in
  the bound below.
- **A canary in every shard, on both sides.** Before a shard's documents and after them, the extension compiles two
  known-good documents with core-data alone, one on pdfLaTeX and one on XeLaTeX, and TeX Live compiles the same two.
  A check fails when either does not give a page with nothing missing, on either side, in any shard. So an engine
  that stops working in one shard fails the run, and so does a TeX Live that does not work in one shard, which
  would otherwise leave that shard's documents out quietly. The canaries load only `article` and `fontspec`, so a
  TeX Live that lacks part of its tree passes them; the bounds on what TeX Live leaves out, below, catch that.
- **No canary for a font fallback.** None exercises the converter's font fallback (DejaVu for a character Latin
  Modern lacks). That fallback belongs to the Markdown route, which this measurement does not use: for a `.tex`
  document neither side substitutes a font, and a character the font lacks is a "Missing character" warning in
  the log, which the rules do not count.
- **A bound on "not measured".** The report gives, for each part (package examples, templates, Beamer packages,
  the corpus), how many documents were not measured and their share, with core alone and with the add-on. When
  more than **5 %** of any part is not measured, a check fails and the run does not count.
- **What the bound allows.** Beside each part's share, the report gives the share again with every document not
  measured counted as failing (the worst case) and as compiling (the best case), so a reader sees the most the
  allowance could move it.
- **Bounds on what TeX Live leaves out.** A check fails when
  more than **20 %** of a part's measured documents do not compile on TeX Live either. Another fails when
  more than **20 %** are broken as submitted (a file missing on TeX Live too). These are TeX Live's own
  documents on all of TeX Live, so past either bound the reference, not the documents, is in doubt. Both limits
  are sanity bounds fixed before any run, not measured rates. When one fails, the run does not count, and the
  reference is examined before another run; a limit is not raised after the fact.
- **Each shard against the others.** The shards share the documents in hash order, so what TeX Live leaves out
  (both kinds) falls on them by chance alone. For each shard, the report takes the other shards' rate (counting
  one more document left out and one more kept, so the rate is never 0) and the chance, at that rate, of leaving
  out at least as many of the shard's measured documents as it did. A check fails for a shard when that chance
  is below **0.001**. With ten shards, a run with nothing wrong fails this check at most about once in a hundred
  runs.
- **What the shard check can and cannot catch.** It catches a TeX Live badly broken in one shard, not one missing
  package. With 60 documents in a shard and 15 % left out across the other shards, a shard fails at about 19 left
  out, where 9 are expected; at 5 %, at about 10, where 3 are expected. A package missing from one shard's TeX
  Live, which leaves one or two documents out, passes it. The canaries and the two bounds above do not catch that
  either; it would show as those documents left out, listed by name in the report.
- **Each part's accounting.** For each part, the report gives the documents in the frame, those drawn, those
  skipped while drawn (and why), those not measured (failed downloads, rejected compiles, and the rest, apart), those
  left out, and those counted in the share.
- **The first line.** If a shard returned nothing, or the sample was not drawn in full, the report's first line
  says so. "Not measured" is also given per stratum.

## Statistics

- **The shares.** For core, and for core with extra: the documents that compile, over those that are neither left
  out nor not measured. For each part on its own, and per stratum of (a).
- **The interval.** The 95 % Wilson score interval (z = 1.96), which stays inside 0 to 100 % and behaves at small
  counts (E. B. Wilson, "Probable inference, the law of succession, and statistical inference", J. Am. Stat.
  Assoc. 22 (1927) 209–212). The pooled share of (a) weights each stratum by its counted documents. Proportional allocation would make
  it self-weighted for the frame, but skips and left-out documents vary by stratum, so the weights drift; the
  report therefore also gives the share stratified by the frame's stratum sizes, as a point estimate beside the
  pooled one. The pooled interval treats the sample as a simple random one. The frame of (a) is finite (665
  packages, 400 drawn), and the interval leaves out the finite-population
  correction, so it is wider than it needs to be. The templates are a census, and their interval describes the
  process that made them, not a sampling error. The per-stratum intervals are wide where a stratum is small.
- **Missing packages.** For the documents that fail with core alone because of a missing file: each missing
  package, the number of documents it stopped, and where it is (extra-data, or neither set). These feed the
  extra-set choices.
- **The engines.** How many documents asked for each engine, and how many of them were left out; and, for each
  part, how many ran on another engine than the reference, how many of those count as compiling, and how many
  fail only by rule 4.

## The rehearsal and the checks

Before a measurement, the workflow's `rehearse` job runs the same steps (unpacking, the extension's compiles, the
reference, the report) on documents from the repository alone: each folder of the public corpus (`test/corpus`,
CC0) and five probes written for it (`rehearsalProbes` in `scripts/lib/coverage.mjs`). A measurement of the frame
without arXiv runs the same probes beside its documents. Each probe proves one part of the reference:

- an `.eps` figure is converted (`repstopdf`, then Ghostscript);
- `00README.json`'s `latex` runs the DVI route (`latex`, `dvips`, `ps2pdf`);
- biber runs without network and fills the bibliography;
- TeX cannot read a file outside the document's folder (`openin_any = p`);
- a file missing on TeX Live too makes the document "broken as submitted".

The report also checks:

- that every corpus document compiles on TeX Live and, with core-data alone, on the extension. The corpus is the
  extension's own test set, with one document on XeLaTeX (`test/corpus/xelatex`), so a missing data set shows
  here;
- that every shard's canaries compiled before and after its documents, on the extension and on TeX Live, so an
  engine or a TeX Live that stops working in any shard shows (see "Every document is counted");
- that every corpus document and probe was measured on both sides, that no part has more than 5 % not measured,
  that no part has more than 20 % failing on TeX Live or 20 % broken as submitted, and that no shard leaves out
  far more of its documents on TeX Live than the other shards;
- that the reference ran without network and with Ghostscript.

A check that fails makes the report fail, and its shares do not count until every check passes. The probes and
the canaries are never part of a share.

## Holding the method still

- The method's commit is tagged before the first run.
- The report records the commit it ran on, and the SHA-256 of this note and of the frame files.
- The report's JSON (package names, file names, outcomes; no document text) is committed after the run, because
  the run's artifacts expire after 7 days.

## What lands in the README

When M5 passes, "How many documents compile" gives, for core alone and for core with extra, the share **of TeX
Live's own example and template documents** that compile, never "of papers":

- each part's share on its own, never one pooled share: the package examples, with the 95 % interval and the
  sample size, the journal, conference and thesis templates, and the Beamer packages;
- beside each share, its worst and best case: the share with every document not measured counted as failing,
  and as compiling, so the reader sees how far the 5 % allowance could move it;
- the frame in one sentence (TeX Live's own example and template documents of the 2026-10-15 snapshot, one per
  package, stratified by Catalogue topic, the seed), with the biases stated in one sentence: written to compile,
  each exercising its own package, so it measures package coverage, not papers;
- for each part, how many documents were left out, and why: failing on TeX Live too, broken as submitted, or not
  measured.

It links this note. Until then it says "Not yet measured".

## Changes since the method was first written down

The method was first committed in 845b14b (2026-10-26). These changes were made after that commit and before any
run on CI:

- **2026-10-26: the documentation tree names the engine.** An example under `doc/lualatex/` or `doc/xelatex/`
  asks for that engine. It came after an offline trial of the stage on 32 real documents, where an example under
  `doc/lualatex/` would otherwise have run pdfLaTeX on both sides and been left out. It moves documents from "left
  out" to "does not compile on the extension", so it can only lower the shares.
- **2026-10-26: the corpus must also compile on the extension**, with core-data alone, so a broken engine or data
  set fails a check instead of showing as failing documents.
- **2026-10-26: the "measured" check covers the corpus and the probes**, where the first text said every document.
  In its place, each part is bounded: more than 5 % not measured fails a check.
- **2026-10-26: `% !TEX program = latex` runs the DVI route on the reference.** The first text already said "the
  reference runs that engine"; the code had ignored `latex`, which could only raise the shares.
- **2026-10-26: an archive that cannot be fetched is kept as "not measured"**, after three rounds, instead of being
  replaced by the next package, so the sample does not depend on the network.
- **2026-10-26: a document in flight counts.** A document during which a side's process stops counts as failing
  on that side, not as not measured.
- **2026-10-26: the folder rule.** The code now skips the package, as the first text said, when its document's
  folder cannot be used; it had tried the package's next example file. "Cannot be one folder" was added to the
  size rule, and the path in the file order was made explicit (texmf-relative).
- **2026-10-26: two more biases stated:** an example that needs the DVI route without asking for it, and the
  Beamer part's helper packages.
- **2026-10-26: the downloads are curl's, every failed download counts as one.** The snapshot's host answers Node's
  fetch with an HTML page. A wrong SHA-512 is now a failed download too (kept as not measured), where it had been a
  skip, so no reply of the host can change which packages are drawn. The pins' second mirror is the same server;
  the method says so.
- **2026-10-26: a compile the engine rejects is not measured, and every shard runs a canary.** A shard whose
  engine stopped working had counted its documents against the extension, with every check passing.
- **2026-10-26: `doc/luatex/` asks for LuaLaTeX** too (five packages keep their examples there), and the two
  `doc/platex/` packages are said to be left out when pdfLaTeX fails.
- **2026-10-26: the frame is held by the SHA-256 of its members** as well as its counts; the report gives each
  part's accounting and the share stratified by the frame's stratum sizes; the corpus gains a XeLaTeX document.
- **2026-10-26: what lands in the README** is each part's share on its own, and for each part how many documents
  were left out and why (failing on TeX Live too, broken as submitted, not measured), where the first text named
  the package examples' share and "how many documents were left out".
- **2026-10-26: curl's own User-Agent for the snapshot's host.** The host's bot check decides by the User-Agent and
  answered the project's with its HTML page. The measurement now checks the host first (the tlpdb's signed
  checksum) and waits out a 429 or 503. The project's User-Agent stays for the arXiv frame.
- **2026-10-26: ten failed downloads in a row stop the measurement.** A new rule, not in the first text: ten
  packages in a row whose downloads fail (after three rounds each) end the run with an error, an incomplete sample
  and a report that gives no share, instead of a finished run with those packages as "not measured". It can only
  stop a run, never change a share.
- **2026-10-26: a LuaLaTeX request runs as the extension runs it**, on XeTeX, judged against TeX Live's LuaLaTeX
  compile, where the first text counted it as failing without trying it. For a `% !TEX program` line this is the
  extension's own rule; for a request by the documentation tree it is the measurement's setting (2026-10-27).
- **2026-10-26: an engine host that dies on a document is retried once**, and a second death is the document's
  failure; only an engine that cannot start or load stays "not measured". A reference process that stops during a
  document makes it "not measured" (inside the bound) instead of left out. The skips name the 1 GiB limit on an
  archive, and "the sample depends on the snapshot and the seed only" is said exactly.
- **2026-10-26: a rejected compile with the add-on keeps the core result**; only the add-on side is not measured,
  with its own count in the bound. Before, the whole document became "not measured", which threw away a core
  failure.
- **2026-10-26: TeX Live runs the canaries too**, in every shard, and a check bounds what fails on TeX Live at 20 %
  of a part. Beside each share, the report gives the worst and the best case of what is not measured, and splits
  "not measured" by cause.
- **2026-10-26: text and files that move no number:** the note on where the compile rules live, "151 packages of
  its 358", the storage paragraph (the archives' own cache), and, in `engine/coverage-frame.json`, the arXiv
  frame's `harvest.enabled: false` with its `waitsFor`. The XeLaTeX corpus document lost its two Greek letters,
  which Latin Modern does not have, so its log has no "Missing character" warning.
- **2026-10-27: the in-flight mark holds the extension's engine.** It had held the engine the document asks for,
  else pdfLaTeX. So for a fontspec document the measuring process stopped on, TeX Live ran pdfLaTeX, failed, and
  the document was left out with the extension's crash. The mark now holds the extension's own choice, and such a
  document counts as the extension's failure. It can only lower the shares.
- **2026-10-27: a fresh engine that cannot start right after a death** makes the document fail, with its own
  reason, where it had been "not measured". It can only lower the shares.
- **2026-10-27: what TeX Live leaves out is bounded in full.** Broken as submitted gets its own 20 % bound, and
  each shard's left-out documents are checked against the other shards'. When a bound fails, the run does not
  count and the reference is examined first. These can only stop a run, never change a share.
- **2026-10-27: the README gives each share's worst and best case** beside it.
- **2026-10-27: text that moves no number.** For an example that asks for LuaLaTeX only by its documentation
  tree, the XeLaTeX setting is said to be the measurement's choice; the 2026-10-26 entry had called it the
  extension's own rule for every request. The canaries' note says that none exercises a font fallback, and why
  none is needed here.
- **2026-10-27: rule 4, on another engine no more TeX errors than the reference.** Decided before the first run.
  A LuaLaTeX request runs on XeTeX and the DVI route on pdfLaTeX, and rule 2 ignores errors TeX recovers from, so
  an example whose package does not work on the other engine could count as compiling with its function missing.
  Both sides now record TeX's error count, and the report gives how many documents ran on another engine and how
  many of them compile. It can only lower the shares, and a document without both counts is not measured.
- **2026-10-27: a failed start or load is tried once more** for the document, on a fresh service, before the
  document is "not measured". It can turn a "not measured" into a measurement, either way.
- **2026-10-27: the tlpdb in three rounds, and no stale sample.** The tlpdb is fetched in the same rounds as an
  archive, and an earlier run's sample is removed before the stage can stop. Neither moves a number.
- **2026-10-27: rule 4's loose ends.** A document rule 4 cannot judge (an error count missing on one side) now
  counts in the bound on "not measured", as every other cause does; it had been left out of the count. The
  reference writes its log with the extension's line lengths, so an error's `file:line:` is never broken across
  lines on one side only. The method says what the shard check can and cannot catch. None of these can raise a
  share.

## The arXiv frame (disabled: it waits for arXiv's permission)

This frame is kept in the code and in this note, unchanged, but nothing runs it. `engine/coverage-frame.json` sets
`harvest.enabled` to false, so its sample and fetch stages refuse to start, and the workflow has no job that
reaches them. It runs only after arXiv's administrators agree, and after this note and that file say so.

### The sampling frame

- **Source.** arXiv e-prints whose first version was submitted from **2026-07-01 to 2026-09-30** (UTC), as the
  `created` date of arXiv's OAI-PMH `arXiv` metadata format gives it. The window ends before the TeX Live snapshot
  of 2026-10-15, so every paper was first written for a TeX Live no newer than the reference.
- **Licence.** Only papers whose licence in that record is **CC BY 4.0**
  (`http://creativecommons.org/licenses/by/4.0/`) or **CC0 1.0** (`http://creativecommons.org/publicdomain/zero/1.0/`).
  This keeps any later use of the sources simple: the papers may be shown and shared, with credit for CC BY. It
  also skews the sample. Authors choose these licences more often in some fields than in others (where funders
  or publishers ask for open licences), so the sample stands for CC BY and CC0 papers, not for all of arXiv. The
  report gives, for each stratum, how many papers of the window carry these licences, so a reader can see the
  skew.
- **TeX sources only.** A paper whose source is not TeX (a PDF or HTML submission) cannot be compiled and is not
  in the frame. It is skipped and counted, and the next paper of its stratum is taken.
- **Strata.** By the first category listed in the record's `categories`:

  | Stratum | Categories |
  |---|---|
  | cs | `cs.*` |
  | math | `math.*` |
  | astro-ph | `astro-ph`, `astro-ph.*` |
  | cond-mat | `cond-mat`, `cond-mat.*` |
  | hep | `hep-ex`, `hep-lat`, `hep-ph`, `hep-th` |
  | quant-ph | `quant-ph` |
  | physics-other | `gr-qc`, `math-ph`, `nlin.*`, `nucl-ex`, `nucl-th`, `physics.*` |
  | stat | `stat.*` |
  | eess | `eess.*` |
  | other | `q-bio.*`, `q-fin.*`, `econ.*` |

### The sample

- **Size.** 400 papers with TeX sources, allocated to the strata in proportion to the number of eligible papers in
  each (largest remainders; at least one for a stratum that has any).
- **Seed and order.** Within each stratum the eligible papers are ordered by the SHA-256 of `20261022:<arXiv id>`
  (the seed is **20261022**), and taken in that order until the stratum's quota of TeX sources is met. The order
  depends only on the seed and the ids, so anyone with the same metadata draws the same sample.
- **The harvest.** The metadata comes from arXiv's OAI-PMH interface (`ListRecords`, `metadataPrefix=arXiv`,
  `from=2026-07-01`, no `until`, so a paper revised after the window is still seen). The sources come from
  arXiv's source address on its export site. Under arXiv's API terms:
  **no more than one request every three seconds, one connection at a time, across every machine**. One CI job
  does all of it, one request after another, and a concurrency group keeps two runs from fetching at once. A `503`
  with `Retry-After` is waited out.
  A harvest stopped by a time limit goes on from its last saved page in the next run; arXiv's resumption tokens
  expire daily, and an expired one starts the harvest again from its first page.
- **Where the requests go.** Only to the two endpoints arXiv sets aside for programmatic access, and nowhere else:
  - `https://oaipmh.arxiv.org/oai`, arXiv's OAI-PMH base URL since March 2025 (it replaced
    `export.arxiv.org/oai2`);
  - `https://export.arxiv.org/src/<id>`, the source address (`/src/<id>`) on export.arxiv.org, the site arXiv's
    bulk-data page names as "specifically set aside for programmatic access".

  Nothing is asked of arxiv.org itself, whose robots.txt disallows `/src`, `/e-print`, `/api` and `/oai2`. No
  redirect is followed: a redirect is recorded as the answer, so every request is one of the two kinds above.
  export.arxiv.org's own robots.txt disallows every path to every agent. That file asks crawlers to stay away,
  and the bulk-data page asks harvesters to come to that site. This is why the frame waits for arXiv's
  administrators to agree before any request.
- **The User-Agent.** Every request names the project, its version and its repository, with no personal e-mail
  address: `liveMd2Tex-coverage/<version> (+https://github.com/haberwooki/liveMd2Tex)`, where `<version>` is the
  extension's version in `package.json`.
- **The version.** The source is the latest version arXiv serves at the fetch, which may be newer than the
  snapshot. Its version (`<id>v<N>`, from the answer's file name) and its SHA-256 are recorded in `papers.json`,
  so a later run can tell when a source changed. arXiv offers no TeX source for a withdrawn version, so a paper
  withdrawn by then is skipped and counted like one without TeX source.
- **Storage.** The sources would go into the repository's GitHub Actions cache, which the compile jobs read. They
  are never committed, never uploaded as artifacts, and never shipped. arXiv's terms allow storing and using
  e-prints for research. The reports hold only arXiv ids, categories, versions, page counts, file and package
  names, and the kind of each error, never the papers' text. Pull requests can restore the caches of the branch
  they target, so in a public repository the measurement is run from a branch of its own, and its cache entries
  are deleted after the report (docs/DEVELOPING.md).

### Thesis and Beamer templates from CTAN

Measured the same way, separately from the papers: public thesis templates and Beamer templates from CTAN
(`engine/coverage-templates.json`), each pinned by its SHA-256 (a `pin` run records the hashes and the chosen main
files; an unpinned template is not measured). Each main file is one document. They are reported as two more
shares, with their intervals, not mixed into the papers' share.

### Preparing a paper

- **The archive.** A gzipped tar is unpacked; a single gzipped file is a lone `.tex` file. A source is
  **unreadable** when it cannot be unpacked, when a path in it would leave the folder, when a path in it is both a
  file and a folder, or when its files come to more than 1 GiB unpacked. An unreadable source is skipped and
  counted, and the next paper of its stratum is taken.
- **The main file.** The one `00README.json` names as `toplevel` (arXiv's own instruction file), else the single
  `.tex` file at the top level that has `\documentclass` (outside comments) and `\begin{document}`, else, of
  several, the one named `main`, `ms`, `paper`, `article` or `manuscript`, else the largest. The choice is recorded.
  A source with no such file (plain TeX, for one) is not LaTeX: it is skipped and counted, like a PDF submission.
- **The engine.** The one the paper asks for. First `00README.json`'s compiler, which arXiv builds with:
  `pdflatex` means pdfLaTeX, `xelatex` means XeLaTeX, and `latex` means the DVI route. Else a `% !TEX program`
  line. Else the extension's own rule (fontspec, unicode-math or polyglossia mean XeLaTeX). Else pdfLaTeX.
  - The reference runs that engine. For the DVI route it runs `latex`, then `dvips`, then Ghostscript's `ps2pdf`.
  - The extension runs that engine too, except for two. It has no DVI route, so a `latex` paper gets pdfLaTeX, as
    it would for a user; a paper that needs the DVI route (PSTricks, say) then counts against the extension. It
    has no LuaLaTeX, and runs a paper that asks for it on XeTeX, as it would for a user.
- **The bibliography.** As on arXiv, when the source ships the main file's `.bbl`, no BibTeX runs and the shipped
  `.bbl` is used, in all three compiles. Otherwise the reference runs `bibtex` (or `biber`, when biblatex asks for
  it), and the extension runs bibtex8 as it always does.

### Its statistics and README

The same as above, per stratum and for the CTAN templates, plus a sensitivity figure in the CI report only: each
stratum's share weighted by its number of papers in the window, all licences included. It assumes that within a
stratum, CC BY and CC0 papers compile as often as the others, which this sample cannot test. It has no interval
and does not go into the README. If this frame is ever run, the README gives the share of the sample that
compiles, its interval and size, and the frame in one sentence (arXiv, the window, CC BY and CC0, stratified, the
seed), with the skew stated.
