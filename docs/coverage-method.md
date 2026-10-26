# How many documents compile: the method

This note fixes how the coverage of the data sets is measured (docs/DESIGN.md#engine-and-data, #testing), before
any paper is fetched or compiled. The numbers it produces go into the README's "How many documents compile". The
parameters below are also in `engine/coverage-frame.json`, which the scripts read; a change to either is a change
to the method and must be made in both, before a run.

## What is measured

For each document, three compiles:

- **core**: the extension's own route (the preamble scan, the engine, the pipeline's passes) with core-data alone;
- **core + extra**: the same, with the Extra Packages add-on (extra-data) installed;
- **reference**: a full TeX Live (scheme-full) of the same snapshot as the data sets (`engine/bundle-pins.json`),
  installed on the CI runner, with Ghostscript beside it (see "The reference").

The result is the share of documents that compile with core alone, and with core and extra, each against the
reference, with its 95 % interval.

## The sampling frame

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

## The sample

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
  and the bulk-data page asks harvesters to come to that site; this job follows a fixed list of ids at the API
  terms' rate, and arXiv's administrators are told of the run before it starts.
- **The User-Agent.** Every request names the project, its version and its repository, with no personal e-mail
  address: `liveMd2Tex-coverage/<version> (+https://github.com/haberwooki/liveMd2Tex)`, where `<version>` is the
  extension's version in `package.json`.
- **The version.** The source is the latest version arXiv serves at the fetch, which may be newer than the
  snapshot. Its version (`<id>v<N>`, from the answer's file name) and its SHA-256 are recorded in `papers.json`,
  so a later run can tell when a source changed. arXiv offers no TeX source for a withdrawn version, so a paper
  withdrawn by then is skipped and counted like one without TeX source.
- **Storage.** The sources go into the repository's GitHub Actions cache, which the compile jobs read. They are
  never committed, never uploaded as artifacts, and never shipped. arXiv's terms allow storing and using e-prints
  for research. The reports hold only arXiv ids, categories, versions, page counts, file and package names, and
  the kind of each error, never the papers' text. Pull requests can restore the caches of the branch they target,
  so in a public repository the measurement is run from a branch of its own, and its cache entries are deleted
  after the report (docs/DEVELOPING.md).

## Thesis and Beamer templates

Measured the same way, separately from the papers: public thesis templates and Beamer templates from CTAN
(`engine/coverage-templates.json`), each pinned by its SHA-256 (a `pin` run records the hashes and the chosen main
files; an unpinned template is not measured). Each main file is one document. They are reported as two more
shares, with their intervals, not mixed into the papers' share.

## Preparing a document

- **The archive.** A gzipped tar is unpacked; a single gzipped file is a lone `.tex` file. A source is
  **unreadable** when it cannot be unpacked, when a path in it would leave the folder, when a path in it is both a
  file and a folder, or when its files come to more than **1,073,741,824 bytes** (1 GiB) unpacked. An unreadable
  source is skipped and counted, and the next paper of its stratum is taken.
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
    has no LuaLaTeX, so a paper that asks for LuaLaTeX counts as not compiling there.
  - On the reference, pdfLaTeX turns `.eps` figures into PDF through TeX Live's restricted shell escape
    (`repstopdf`, which calls Ghostscript). The extension runs no outside program and cannot, so such a paper
    counts against the extension, as it would for a user.
- **The bibliography.** As on arXiv, when the source ships the main file's `.bbl`, no BibTeX runs and the shipped
  `.bbl` is used, in all three compiles. Otherwise the reference runs `bibtex` (or `biber`, when biblatex asks for
  it), and the extension runs bibtex8 as it always does.

## The reference

- TeX Live as installed from the snapshot, scheme-full, with its restricted shell escape (only TeX Live's own
  list of programs, `repstopdf` among them).
- TeX may not open a file by an absolute path, through `..`, or with a name that starts with a dot
  (`openin_any = p` and `openout_any = p`), so it reads and writes only in the document's folder and TeX Live's
  own trees. The extension, too, reads only the document's folder.
- It runs as the runner's user, without network, in a copy of the document's folder.
- Ghostscript comes from the runner's Ubuntu release (24.04). The report records its version and TeX Live's.

## When a document compiles

A compile **compiles** when all of these hold:

1. **No missing file.** The preamble scan lists no missing file, and the log reports no "File ... not found".
2. **No fatal error.** A PDF with pages comes back, the log has no "Emergency stop" and no "Fatal error", the
   engine did not fail, and the compile finished within **300 seconds**.
3. **The same length.** Its page count is within **one page** of the reference's.

The reference is held to rules 1 and 2 as well (the preamble scan is the extension's own, so for the reference
rule 1 is its log). A document whose reference compile breaks one is left out of the shares and listed; it never
counts against the extension:

- with a file missing on TeX Live too, it is **broken as submitted** (a figure the source lacks, say);
- otherwise it **does not compile on TeX Live either**.

TeX errors that TeX recovers from do not count by themselves: the page-count rule catches the ones that change the
document.

With the add-on, a document that compiled with core alone, with no missing file and no "not found" in its log,
compiles the same way: the add-on is mounted only for a file the core lacks (docs/DESIGN.md#engine-and-data). Such
a document is not compiled twice; its core result stands for both.

## Every document is counted

- **The shards.** The compile jobs share the documents in draw order (the SHA-256 of `20261022:<key>`, where the
  key is the arXiv id, or `<template>:<main file>`), so the strata are interleaved. A job that runs out of time
  leaves a random tail, not a stratum.
- **The outcomes.** The report lists every sampled document (`papers.json` and the pinned templates), with one of
  these outcomes:
  - it compiles;
  - it does not compile, with the first rule it breaks;
  - it is left out, as broken as submitted or as not compiling on TeX Live either;
  - it is **not measured**, with the reason: its shard returned no results, it could not be unpacked in its job
    (a full disk, say), or a side's time ran out before it.
- **The first line.** If a shard returned nothing, or the fetch stopped before every quota was met, the report's
  first line says so. "Not measured" is also given per stratum.

## Statistics

- **The shares.** For core, and for core with extra: the documents that compile, over those that are neither left
  out nor not measured. Overall and per stratum, and for the thesis and Beamer templates.
- **The interval.** The 95 % Wilson score interval (z = 1.96), which stays inside 0 to 100 % and behaves at small
  counts. Proportional allocation makes the overall share a self-weighted estimate for the frame; the pooled
  interval treats the sample as a simple random one, which proportional allocation makes close to the stratified
  interval. The per-stratum intervals are wide where a stratum is small.
- **A sensitivity figure, in the CI report only.** Each stratum's share weighted by its number of papers in the
  window, all licences included. It assumes that within a stratum, CC BY and CC0 papers compile as often as the
  others, which this sample cannot test. It has no interval and does not go into the README.
- **Missing packages.** For the documents that fail with core alone because of a missing file: each missing
  package, the number of documents it stopped, and where it is (extra-data, or neither set). These feed the
  extra-set choices.
- **The engines.** How many papers asked for each engine, the DVI route included, and how many of them were left
  out.

## The rehearsal

Before any request to arXiv, the workflow's `rehearse` job runs the same steps (unpacking, the extension's
compiles, the reference, the report) on documents from the repository: each folder of the public corpus
(`test/corpus`, CC0) and five probes written for it (`rehearsalProbes` in `scripts/lib/coverage.mjs`). Each probe
proves one part of the reference:

- an `.eps` figure is converted (`repstopdf`, then Ghostscript);
- `00README.json`'s `latex` runs the DVI route (`latex`, `dvips`, `ps2pdf`);
- biber runs without network and fills the bibliography;
- TeX cannot read a file outside the document's folder (`openin_any = p`);
- a file missing on TeX Live too makes the document "broken as submitted".

The report also checks that every corpus document compiles on TeX Live, that every document was measured on both
sides, and that the reference ran without network and with Ghostscript. A check that fails makes the rehearsal
fail, and the measurement waits until every check passes. The rehearsal's shares are not a measurement.

## Holding the method still

- The method's commit is tagged before the first run.
- The report records the commit it ran on, and the SHA-256 of this note, of `engine/coverage-frame.json` and of
  `engine/coverage-templates.json`.
- The report's JSON (ids, versions, outcomes, file and package names; no paper text) is committed after the run,
  because the run's artifacts expire after 7 days.

## What lands in the README

When M5 passes, "How many documents compile" gives, for core alone and for core with extra: the share of the
sample that compiles, its 95 % interval and the sample size; the frame in one sentence (arXiv, the window, CC BY
and CC0, stratified, the seed), with the skew stated; how many papers were left out, and why; and the thesis and
Beamer shares. It links this note. Until then it says "Not yet measured".
