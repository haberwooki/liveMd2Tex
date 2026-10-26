# Third-party notices

This file lists every part of other people's work that ships inside the liveMd2Tex extension package
(`haberwooki.livemd2tex`), with its licence: first what the plain package holds, then what the laptop's test
copy adds (the engine, TeXlyre's interim TeX image and the DejaVu fonts). The package's shape is in
docs/DESIGN.md#store-and-packaging.

The licence texts ship with the package: `LICENSE` (GPL-3.0), and `dist/licenses/`, which the build fills with
the licence file of every npm package bundled into a shipped file (found through esbuild's metafile; an index is
in `dist/licenses/INDEX.txt`) and the full GPL-3.0, AGPL-3.0, LGPL-3.0, Apache-2.0 and LPPL-1.3c texts from
`LICENSES/` (taken from the SPDX licence list, v3.27.0), ICU's licence (`ICU.txt`, ICU's own LICENSE file from
release 78) and MakeIndex's notice (`MakeIndex.txt`, from TeX Live's sources) for the two built into the engine,
with the CC0 1.0 Universal legal code (`CC0-1.0.txt`: Creative Commons' own plain text,
https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt, byte for byte, which is also SPDX's). The test copy adds
`dist/data/fonts/LICENSE` (DejaVu) and `dist/data/licenses/` (TeX Live's and CTAN's licence notes and the LPPL,
copied out of the image). A "Licences" command that shows them comes before the first release.

The extension as a whole is released under GPL-3.0-or-later (see `LICENSE`). Its `package.json` declares
`GPL-3.0-or-later AND AGPL-3.0-only` because the TeX engine's JavaScript wrapper (TeXlyre's busytex, added in
S1) keeps its AGPL-3.0 terms inside the combined work.

Two folders of the extension's own files are dedicated to the public domain under CC0 1.0 instead, because they
are copied into users' own folders: the starting documents of "New document from template" (`templates/`) and the
example presets (`examples/presets/`). Each folder has a `LICENSE.md` notice, and each file with a comment form an
SPDX `CC0-1.0` line. They are the liveMd2Tex authors' own work, not a third party's; README.md (Licence) says why.

## In the plain package

| Part | Version | Licence | Where in the package | Source |
|---|---|---|---|---|
| PDF.js (`pdfjs-dist`): `pdf.mjs`, `pdf.worker.mjs`, `pdf_viewer.mjs`, `pdf_viewer.css` and its images, cMaps | 6.4.299 | Apache-2.0 (`dist/viewer/pdfjs/LICENSE`) | `dist/viewer/pdfjs/` | https://github.com/mozilla/pdf.js |
| PDF.js standard fonts: Foxit fonts; Liberation Sans | 6.4.299 | Foxit: PDFium's BSD-3-Clause-style licence (`LICENSE_FOXIT`); Liberation 1.x: GPL-2.0 with Red Hat's font-embedding exception (`LICENSE_LIBERATION`) | `dist/viewer/pdfjs/standard_fonts/` | as above |
| OpenJPEG decoder (WebAssembly build by PDF.js) | 6.4.299 | BSD-2-Clause (`wasm/LICENSE_OPENJPEG`); PDF.js's build: BSD-2-Clause (`wasm/LICENSE_PDFJS_OPENJPEG`) | `dist/viewer/pdfjs/wasm/openjpeg.wasm` | as above |
| JBIG2 decoder (WebAssembly build by PDF.js) | 6.4.299 | PDFium's BSD-3-Clause-style licence (`wasm/LICENSE_JBIG2`); PDF.js's build: Apache-2.0 (`wasm/LICENSE_PDFJS_JBIG2`) | `dist/viewer/pdfjs/wasm/jbig2.wasm` | as above |
| qcms colour management (WebAssembly build by PDF.js) | 6.4.299 | MIT (`wasm/LICENSE_QCMS`, `wasm/LICENSE_PDFJS_QCMS`) | `dist/viewer/pdfjs/wasm/qcms_bg.wasm` | as above |
| CGATS001Compat-v2-micro ICC profile | 6.4.299 | CC0 1.0 (`iccs/LICENSE`) | `dist/viewer/pdfjs/iccs/` | as above |

Bundled by esbuild into `dist/extension.js` (and, for the converter, `dist/web/extension.js`) since C0a. Each
row's licence is the `license` field of the package's `package.json` and its `LICENSE` file (read 2026-10-15).

| Part | Version | Licence | Used for | Source |
|---|---|---|---|---|
| markdown-it | 15.0.2 | MIT | Markdown parser of the converter and the HTML view plugin | https://github.com/markdown-it/markdown-it |
| markdown-it-footnote | 4.0.0 | MIT | footnotes | https://github.com/markdown-it/markdown-it-footnote |
| markdown-it-deflist | 4.0.0 | MIT | definition lists | https://github.com/markdown-it/markdown-it-deflist |
| linkify-it 6.1.0, mdurl 2.1.0, uc.micro 3.0.0, punycode.js 2.3.1 | | MIT | markdown-it's link and Unicode helpers | https://github.com/markdown-it |
| entities | 8.1.0 | BSD-2-Clause | markdown-it's HTML entity tables | https://github.com/fb55/entities |
| yaml | 2.9.1 | ISC | YAML front matter | https://github.com/eemeli/yaml |
| isomorphic-git (only the read commands: resolveRef, readBlob, readCommit, currentBranch; the network commands are left out of the bundle) | 1.42.5 | MIT | the Git reader | https://github.com/isomorphic-git/isomorphic-git |
| isomorphic-git's `path.join` code, copied by isomorphic-git from @zenfs/core (Copyright (c) James Prevett and other ZenFS contributors) | 1.42.5 | LGPL-3.0-or-later (`dist/licenses/LGPL-3.0.txt`) | the Git reader's path joining, inside `dist/extension.js` | https://github.com/zen-fs/core |
| pako | 1.0.11 | MIT AND Zlib | isomorphic-git: zlib inflate of Git objects | https://github.com/nodeca/pako |
| sha.js | 2.4.12 | MIT AND BSD-3-Clause | isomorphic-git: SHA-1 | https://github.com/browserify/sha.js |
| crc-32 1.2.2, clean-git-ref 2.0.1 | | Apache-2.0 | isomorphic-git: pack checksums, ref names | https://github.com/SheetJS/js-crc32, https://github.com/wmhilton/clean-git-ref |
| async-lock 1.4.1, pify 4.0.1, diff3 0.0.3, ignore 5.3.2, safe-buffer 5.2.1, to-buffer 1.2.2, inherits 2.0.4 (ISC) | | MIT, ISC | isomorphic-git's helpers | npm |
| get-intrinsic, call-bind, call-bound, call-bind-apply-helpers, define-data-property, set-function-length, has-property-descriptors, es-define-property, es-errors, es-object-atoms, gopd, hasown, has-symbols, has-tostringtag, get-proto, dunder-proto, math-intrinsics, for-each, is-callable, is-typed-array, which-typed-array, typed-array-buffer, available-typed-arrays, possible-typed-array-names, isarray | (lockfile) | MIT | small helpers pulled in by sha.js and to-buffer (function-bind is replaced by a one-line file of ours, `scripts/shims/function-bind.cjs`, because its fallback builds code from text) | npm |

The licence of each row is the one stated in the file named beside it (read 2026-10-15); B1's licence scan
rechecks every row before a release. Open point for that review: the Liberation fonts are GPL-2.0 (not "or
later"); they ship as separate font files that pdf.js reads, which is aggregation, not combination, under
GPL-3 section 5.

## In the test copy (since V0 and M1; the store packages get them from the data packages after B1)

`node scripts/vsix-scan.mjs --test-copy` builds the laptop's test copy, which adds these to the plain package.

| Part | Version | Licence | Where in the test copy | Source |
|---|---|---|---|---|
| pdfTeX, XeTeX, dvipdfmx, xdvipdfmx, bibtex8, kpathsea and the rest of web2c, as TeXlyre's WebAssembly build | TeX Live 2026, TeXlyre build 46ebb62 | pdfTeX, dvipdfmx, xdvipdfmx: GPL-2.0-or-later; bibtex8: GPL-1.0-or-later; XeTeX: MIT/X11; kpathsea: LGPL-2.1-or-later (texts: `dist/licenses/GPL-3.0.txt`, `LGPL-3.0.txt`, each "or later") | `dist/engine/busytex.wasm` | https://github.com/TeXlyre/texlyre-busytex-build (sources: https://tug.org/texlive/) |
| TeXlyre's busytex JavaScript wrapper (patched, `engine/patches/`) | build 46ebb62 | AGPL-3.0 (`dist/licenses/AGPL-3.0.txt`) | `dist/engine/busytex.js` | as above |
| LZ4 decoder inside that wrapper (Emscripten's MiniLZ4, Copyright (c) 2012 Pierre Curto) | | MIT (its notice is kept in `dist/engine/busytex.js`) | `dist/engine/busytex.js` | https://github.com/pierrec/node-lz4 |
| ICU (International Components for Unicode), built into the engine for XeTeX, and its data file | 78 (`icudt78l.dat`) | Unicode License V3, with ICU's third-party notices (`dist/licenses/ICU.txt`; in core-data, `LICENSES/texts/ICU.txt`) | `dist/engine/busytex.wasm`; `texlive/icudt78l.dat` in `dist/data/texlive-extra.data` and in core-data | ICU 78.2 as `libs/icu` in TeX Live's source tree at tag texlive-2026.0, which TeXlyre build 46ebb62 compiles: https://github.com/TeX-Live/texlive-source/tree/tags/texlive-2026.0/libs/icu; ICU's own: https://github.com/unicode-org/icu (release-78.2) |
| MakeIndex, built into the engine | TeX Live 2026 | MakeIndex Distribution Notice (`dist/licenses/MakeIndex.txt`, and in full below) | `dist/engine/busytex.wasm` | `texk/makeindexk` in TeX Live's source tree at tag texlive-2026.0: https://github.com/TeX-Live/texlive-source/tree/tags/texlive-2026.0/texk/makeindexk |

### MakeIndex's notice

The engine contains MakeIndex in executable form. Its notice asks that such a copy carry the notice and say how to
get the source. The engine is TeXlyre's build 46ebb62, which compiles TeX Live's source tree at tag texlive-2026.0
(its Makefile's `URL_texlive`). MakeIndex's source is in that tree, in `texk/makeindexk`:
https://github.com/TeX-Live/texlive-source/tree/tags/texlive-2026.0/texk/makeindexk (a copy of TeX Live's
Subversion repository, https://tug.org/texlive/svn/). The notice, as `texk/makeindexk/COPYING` gives it (also
`dist/licenses/MakeIndex.txt`):

```
			MakeIndex Distribution Notice

				11/11/1989

	Copyright (C) 1989 by Chen & Harrison International Systems, Inc.  
	Copyright (C) 1988 by Olivetti Research Center
	Copyright (C) 1987 by Regents of the University of California

	Author:	
	  	Pehong Chen
		Chen & Harrison International Systems, Inc.
		Palo Alto, California
	  	USA

Permission is hereby granted to make and distribute original copies of
this program provided that the copyright notice and this permission
notice are preserved and provided that the recipient is not asked to
waive or limit his right to redistribute copies as allowed by this
permission notice and provided that anyone who receives an executable
form of this program is granted access to a machine-readable form of
the source code for this program at a cost not greater than reasonable
reproduction, shipping, and handling costs.  Executable forms of this
program distributed without the source code must be accompanied by a
conspicuous copy of this permission notice and a statement that tells
the recipient how to obtain the source code.
                                                                       
Permission is granted to distribute modified versions of all or part
of this program under the conditions above with the additional
requirement that the entire modified work must be covered by a
permission notice identical to this permission notice.  Anything
distributed with and usable only in conjunction with something derived
from this program, whose useful purpose is to extend or adapt or add
capabilities to this program, is to be considered a modified version
of this program under the requirement above.  Ports of this program to
other systems not supported in the distribution are also considered
modified versions.  All modified versions should be reported back to
the author.

This program is distributed with no warranty of any sort.  No
contributor accepts responsibility for the consequences of using this
program or for whether it serves any particular purpose.
```
| TeX Live macro packages, classes and fonts in TeXlyre's `texlive-extra` image, unchanged | TeX Live 2026 | LPPL 1.3c and others, package by package (`dist/data/licenses/`: TeX Live's `LICENSE.TL`, `LICENSE.CTAN` and `lppl.tex`; `dist/licenses/LPPL-1.3c.txt`); B1's licence scan lists each package | `dist/data/texlive-extra.data` | https://ctan.org, https://tug.org/texlive/ |
| DejaVu fonts (Sans, Serif, Sans Mono; 12 TrueType files) | 2.34 | Bitstream Vera licence with DejaVu's changes; public domain for the changes (`dist/data/fonts/LICENSE`) | `dist/data/fonts/` | https://dejavu-fonts.github.io, https://ctan.org/pkg/dejavu |

## Added later (planned; not in the package yet)

| Part | Milestone | Licence (docs/DESIGN.md#store-and-packaging) |
|---|---|---|
| KaTeX, jsdiff | M1 and later | MIT, BSD-3-Clause |
| zeroperl, latexdiff (v1.1) | v1.1 | MIT, Apache-2.0, GPL-3.0-or-later |
| TeX Live's packages, classes and fonts in the data packages (core-data, extra-data), unchanged as TeX reads them. core-data stores most of its Type 1 fonts with their encryption removed, and the engine host restores each one to the original bytes, checked against its SHA-256, before TeX reads it; the package's `LICENSE.txt` says so and quotes the LPPL's clause 9. Which fonts are stored so is decided font by font, by each font's own header: fonts under the SIL OFL, IBM's Courier fonts and fonts with no clear terms are stored as they are, and so are all fonts of amsfonts, inconsolata, rsfs and newtx (`engine/bundle-sets.json`, `t1cSkip`). courier's `LICENSES` folder holds IBM's notice, as its fonts state it, and IBM's terms as X.Org ships them | B1 | Each package's own, as `data/licences.json` lists it from the TeX Catalogue. B1's licence scan of the 2026-10-15 snapshot finds: LPPL (1.3c and earlier), GPL, LGPL, AGPL, GNU FDL, SIL OFL, GUST Font License, Apache-2.0, BSD, 0BSD, MIT, ISC, X11, Artistic, CC0, CC BY, CC BY-SA, public domain, Knuth's terms, the Catalogue's "other-free", and TeX Live's own files. "collection" packages and the publisher classes labelled "other-free" as read in their files (`engine/bundle-sets.json`, `licenceReviews`). Each data package ships the licence texts its packages require in `LICENSES/`, and `LICENSES/INDEX` names each package's files: the licence texts (in this repository under `engine/licence-texts/` and `LICENSES/`, pinned in `engine/bundle-licences.json`: the LaTeX Project's LPPL texts, SPDX licence list v3.27.0, the GUST Font License from lm, CTAN's statement of Knuth's terms, MakeIndex's notice from TeX Live's sources; TeX Live's own `LICENSE.TL` and `LICENSE.CTAN` from texlive.infra) and each package's own licence files, GUST font manifests and statements of terms from its archives. core-data also ships ICU's licence for the ICU data file it takes from the engine build, and `LICENSES/CHANGES-GPL`: for each packed font under the GPL, its path, its original's SHA-256, what was done and the date, as the GPL asks of a changed file |

## Test copies only (not in the store package)

The laptop's test copy (`node scripts/vsix-scan.mjs --test-copy`) also carries TeXlyre's interim TeX image,
unchanged, with the engine rows above, and two files derived from that image's own file list and package files:
`dist/data/texlive-extra.index.json` and `dist/data/packages.json` (which package each file name belongs to, and
which files each package loads; docs/DESIGN.md#architecture, #engine-and-data). Two CTAN packages are used only by tests and by the
stand-in for the Extra Packages add-on, `out/vsix/livemd2tex-extra-data-0.0.1-standin.vsix`, which is never
published:

| Part | Version | Licence | Used for | Source |
|---|---|---|---|---|
| REVTeX (class, `.rtx` options, helper `.sty` files, `.bst` styles), unchanged from `revtex.tds.zip` | 4.2f | LPPL 1.3c | the stand-in add-on; the corpus document P2 | https://ctan.org/pkg/revtex |
| tensor (`tensor.dtx`, `tensor.ins`), built by docstrip in a test | 2.2 (2023/07/18) | LPPL 1.3c or later | the `.dtx` and `.ins` test of "Add a package from a file" | https://ctan.org/pkg/tensor |

Packages a user adds with "Add a package from a file" stay on the user's computer, under VS Code's global storage
for this extension (or in the project folder); the extension never distributes them.

## Development tools (never shipped)

The tools used to build and test the extension (esbuild-wasm, TypeScript, ESLint, Mocha, `@vscode/vsce`,
`@vscode/test-cli`, `@vscode/test-electron`, acorn, pdf-lib and their dependencies) are not in the package;
`package-lock.json` pins them.

The coverage measurement (`docs/coverage-method.md`) runs on GitHub's runners only, never on a user's computer and
never in the package. There it installs a full TeX Live (scheme-full of the pinned snapshot; each package under its
own licence, https://tug.org/texlive/) and Ubuntu's Ghostscript package (AGPL-3.0-or-later,
https://www.ghostscript.com), and downloads arXiv papers under CC BY 4.0 or CC0 1.0 and CTAN templates. None of
them is committed, uploaded as an artifact or shipped.

## Test data from other projects (never shipped)

| Part | Version | Licence | Used for | Source |
|---|---|---|---|---|
| LaTeX Workshop (James-Yu.latex-workshop): its keybindings, PDF custom editor and auto-build setting, copied as data from its `package.json` into `test/unit/fixtures/latex-workshop-10.19.0.json`; no code | 10.19.0 | MIT | the coexistence tests (M2-B) | https://github.com/James-Yu/LaTeX-Workshop |

`scripts/run-integration.mjs --with-latex-workshop` installs LaTeX Workshop's VSIX (pinned by SHA-256, a
development-only download kept outside the repository) into a throwaway test profile, and nowhere else.
