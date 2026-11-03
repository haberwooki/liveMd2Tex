# Third-party notices

This file lists every part of other people's work that ships inside the liveMd2Tex extension package
(`haberwooki.livemd2tex`), with its licence. The package holds the extension, PDF.js and the TeX engine
(`dist/engine/`). The data packages hold TeX's files and no code; their own `LICENSE.txt` and `LICENSES/` give
those files' terms (see "The data packages" below). The package's shape is in docs/DESIGN.md#store-and-packaging.

## This version and its source

Our own code is GPL-3.0-or-later (see `LICENSE`), and `package.json` declares `GPL-3.0-or-later`. The TeX engine
as a whole can be passed on under GPL-3.0, because one of its parts, xpdf, allows GPL-2.0 or GPL-3.0 and no later
version. Each part of the engine keeps its own terms ("Inside the engine"). No program code under the AGPL ships.
Some TeX packages in the Extra Packages add-on stay under the AGPL; they are files TeX reads, and the add-on ships
their licence text ("The data packages"). Copyright (C) 2026 the liveMd2Tex authors (`AUTHORS.md` in the
repository says who they are).

The source code of each release is the tag of its version in this repository: for this version, the tag `v0.0.1`
of https://github.com/haberwooki/liveMd2Tex. Each release is tagged `v<version>`, with the version in
`package.json`, on the commit its packages are built from, and its page links the tag's tree. That tree holds the
whole source, with the engine's build in `engine/build/`. The release workflow
(`.github/workflows/release-sources.yml`) checks the tag against the package's version and its README, and
attaches the sources of the engine and of the data packages' GPL files to the release ("The engine's source",
"The data packages").

Two folders of the extension's own files are dedicated to the public domain under CC0 1.0 instead, because they
are copied into users' own folders: the starting documents of "New document from template" (`templates/`) and the
example presets (`examples/presets/`). Each folder has a `LICENSE.md` notice, and each file with a comment form an
SPDX `CC0-1.0` line. They are the liveMd2Tex authors' own work, not a third party's; README.md (Licence) says why.

## The licence texts

`LICENSE` is the GPL-3.0 text as the Free Software Foundation publishes it (https://www.gnu.org/licenses/gpl-3.0.txt).
The build fills `dist/licenses/` with:

- the licence file of every npm package bundled into a shipped file, found through esbuild's metafile
  (`dist/licenses/INDEX.txt` lists them);
- the full texts of the licences, from `LICENSES/`: the GPL-3.0 (a copy of `LICENSE`); the GPL-2.0, LGPL-2.1,
  LGPL-3.0, Apache-2.0 and MIT texts from the SPDX licence list, v3.27.0; and the LPPL 1.3c as the LaTeX
  Project publishes it (https://www.latex-project.org/lppl/lppl-1-3c.txt), since the LPPL allows only verbatim
  copies of itself and SPDX's copy has the version 1.3 appendix;
- ICU's licence (`ICU.txt`, ICU's own LICENSE file from release 78.2), for the ICU built into the engine;
- the CC0 1.0 Universal legal code (`CC0-1.0.txt`: Creative Commons' own plain text,
  https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt, byte for byte, which is also SPDX's);
- `dist/licenses/engine/`: the notice of every part of the engine that asks for one, each taken from that part's
  own source at the version the engine builds ("Inside the engine" below).

`LICENSES/` also holds the AGPL-3.0 text and MakeIndex's notice (from TeX Live's sources), which only the data
packages ship, for some of their TeX packages; nothing in the extension is under them. The test copy adds
`dist/data/LICENSES/`: core-data's licence texts and its `INDEX`, which names each package's files ("In the test
copy"). A "Licences" command that shows them comes before the first release.

## PDF.js

| Part | Version | Licence | Where in the package | Source |
|---|---|---|---|---|
| PDF.js (`pdfjs-dist`): `pdf.mjs`, `pdf.worker.mjs`, `pdf_viewer.mjs`, `pdf_viewer.css` and its images | 6.4.299 | Apache-2.0 (`dist/viewer/pdfjs/LICENSE`) | `dist/viewer/pdfjs/` | https://github.com/mozilla/pdf.js |
| Four of those images: `altText_spinner.svg`, `annotation-paperclip.svg`, `annotation-pushpin.svg`, `toolbarButton-editorStamp.svg` | 6.4.299 | MPL-2.0 (each keeps its MPL header, which gives the licence's address) | `dist/viewer/pdfjs/web/images/` | as above |
| PDF.js's CMaps (168 `.bcmap` files) | 6.4.299 | Adobe's BSD-3-Clause (`cmaps/LICENSE`) | `dist/viewer/pdfjs/cmaps/` | as above |
| PDF.js standard fonts: Foxit fonts; Liberation Sans | 6.4.299 | Foxit: PDFium's BSD-3-Clause-style licence (`LICENSE_FOXIT`); Liberation 1.x: GPL-2.0 with Red Hat's font-embedding exception (`LICENSE_LIBERATION`) | `dist/viewer/pdfjs/standard_fonts/` | as above; Liberation: see below |
| OpenJPEG decoder (WebAssembly build by PDF.js) | 6.4.299 | BSD-2-Clause (`wasm/LICENSE_OPENJPEG`); PDF.js's build: BSD-2-Clause (`wasm/LICENSE_PDFJS_OPENJPEG`) | `dist/viewer/pdfjs/wasm/openjpeg.wasm` | as above |
| JBIG2 decoder (WebAssembly build by PDF.js) | 6.4.299 | PDFium's BSD-3-Clause-style licence (`wasm/LICENSE_JBIG2`); PDF.js's build: Apache-2.0 (`wasm/LICENSE_PDFJS_JBIG2`) | `dist/viewer/pdfjs/wasm/jbig2.wasm` | as above |
| qcms colour management (WebAssembly build by PDF.js) | 6.4.299 | MIT (`wasm/LICENSE_QCMS`, `wasm/LICENSE_PDFJS_QCMS`) | `dist/viewer/pdfjs/wasm/qcms_bg.wasm` | as above |
| CGATS001Compat-v2-micro ICC profile | 6.4.299 | CC0 1.0 (`iccs/LICENSE`) | `dist/viewer/pdfjs/iccs/` | as above |

The Liberation fonts are GPL-2.0 (not "or later"). They ship as separate font files that PDF.js reads, which is
aggregation, not combination, under GPL-3 section 5. Their source: the same files in PDF.js's repository at its
tag, https://github.com/mozilla/pdf.js/tree/v6.4.299/external/standard_fonts, and Liberation 1.x's own
repository, https://github.com/liberationfonts/liberation-1.7-fonts (the fonts here are Liberation Sans 1.07.4,
as their name table gives).

## Bundled npm packages

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
| isomorphic-git (only the read commands: resolveRef, readBlob, readCommit, currentBranch, expandOid; the network commands are left out of the bundle) | 1.42.5 | MIT | the Git reader | https://github.com/isomorphic-git/isomorphic-git |
| isomorphic-git's `path.join` code, copied by isomorphic-git from @zenfs/core (Copyright (c) James Prevett and other ZenFS contributors) | 1.42.5 | LGPL-3.0-or-later (`dist/licenses/LGPL-3.0.txt`) | the Git reader's path joining, inside `dist/extension.js` | https://github.com/zen-fs/core |
| pako | 1.0.11 | MIT AND Zlib (`dist/licenses/pako.txt`: pako's MIT licence, then the zlib notice of Jean-loup Gailly and Mark Adler, as pako's `lib/zlib/` files state it) | isomorphic-git: zlib inflate of Git objects | https://github.com/nodeca/pako |
| sha.js | 2.4.12 | MIT AND BSD-3-Clause | isomorphic-git: SHA-1 | https://github.com/browserify/sha.js |
| crc-32 1.2.2, clean-git-ref 2.0.1 | | Apache-2.0 | isomorphic-git: pack checksums, ref names | https://github.com/SheetJS/js-crc32, https://github.com/TheSavior/clean-git-ref |
| async-lock 1.4.1, pify 4.0.1, diff3 0.0.3, ignore 5.3.2, safe-buffer 5.2.1, to-buffer 1.2.2, inherits 2.0.4 (ISC) | | MIT, ISC | isomorphic-git's helpers | npm |
| get-intrinsic, call-bind, call-bound, call-bind-apply-helpers, define-data-property, set-function-length, has-property-descriptors, es-define-property, es-errors, es-object-atoms, gopd, hasown, has-symbols, has-tostringtag, get-proto, dunder-proto, math-intrinsics, for-each, is-callable, is-typed-array, which-typed-array, typed-array-buffer, available-typed-arrays, possible-typed-array-names, isarray | (lockfile) | MIT | small helpers pulled in by sha.js and to-buffer (function-bind is replaced by a one-line file of ours, `scripts/shims/function-bind.cjs`, because its fallback builds code from text) | npm |

The licence of each row is the one stated in the file named beside it (read 2026-10-15); B1's licence scan
rechecks every row before a release.

## The TeX engine (`dist/engine/`)

The engine ships in the extension's own package, in `dist/engine/`: `engine.wasm` (the engine WebAssembly) and
`engine.js` (its JavaScript glue), with our engine configuration (`texmf-override.cnf`; GPL-3.0-or-later). It
holds pdfTeX, XeTeX, xdvipdfmx and bibtex8 with kpathsea and the libraries they need, and nothing else. This
repository builds it (`engine/build/`) from TeX Live's source with Emscripten. `engine/pins.json` pins its release,
`engine-6a30018-4` of this repository, by each file's address, size and SHA-256. That release also holds the
build's record (`engine-build.json`), every notice below, a `NOTICE` that lists the parts, and the source ("The
engine's source"). The data packages carry no code, so the engine is never in them. `node scripts/vsix-scan.mjs
--with-engine` builds the package with the engine; the plain package of the other scans leaves it out.

The glue is Emscripten's own output, unchanged: Emscripten's runtime, written by `emcc` with the flags that
`engine-build.json` records. Its source is Emscripten's `src/` at the pinned commit ("The engine's source"). It holds
one `fetch` and four `XMLHttpRequest` lines that the engine never reaches: the `fetch` runs only outside Node, and
the others serve lazily loaded files, which the engine never makes. The VSIX scan lists each of these lines as
reviewed (`security/vsix-scan-allowlist.json`, pinned to the glue's SHA-256).

### Inside the engine

Every input of the engine's link belongs to one row below. The build maps each input to its part
(`engine/build/tools/link-report.mjs`, `LINK_PARTS`) and fails on an input that no part claims or that belongs to a
dropped part. `engine/engine-build.json` records the map by part (`linkMap`). `test/unit/engineNotices.test.ts`
checks that each row's links are its part's, and that every part of the recorded map is a row. The versions are
from TeX Live's `libs/*/version.ac` at the pinned commit and from Emscripten's release. Each notice file is the
part's own, copied from its source at that version (`engine/engine-notices.json` pins each one).
`scripts/vsix-scan.mjs` fails a package with the engine that lacks one, or holds one with other bytes. The same
files ship in the engine release, and its `NOTICE` is written from the same manifest
(`node scripts/lib/engine-notices.mjs --release-notice`).

Below the link line. A linked library can hold code by other authors under terms of their own.
`scripts/engine-notice-search.mjs` helps a person find it; it is an aid to reading, not a proof. It searches the
compiled sources of every linked library, in TeX Live's source archive below, for licence clauses that match its
patterns: written out ("Permission is hereby granted", "Redistribution and use in source and binary forms"),
stated by reference ("Released under", "licensed under", "See Copyright Notice in", SPDX lines), and public-domain
dedications. What it guarantees is this: every clause that matches one of its patterns, on one line or across two
adjacent lines, is either covered by one of the library's own licences that may cover that kind of clause, or its
file is named by a rule a person wrote. A clause is covered when the licence's words are on the clause's own line
(or, for a licence written out, in its paragraph) and the notices name every holder on the copyright lines up to
25 lines above the clause; a holder written only as "the authors" names nobody. A licence that is only pointed to,
or that asks for no list of holders, covers a clause only in its own words on the clause's own line. A public-domain
line is not taken as a dedication when "not", "n't", "no longer", "never" or "no" comes up to 40 characters
before "public domain" in the same sentence (the guard stops at "." and ";"). The rules are in
`engine/engine-notices.json` ("search"): for each file, the notice that ships, or why the shipped notices cover it,
or why it is not compiled for the engine. What the search does not see is for a person to find: words that none
of its patterns knows, a clause split over three lines or more, a holder more than 25 lines above its clause, a
denial of a dedication in other words, and a second author's grant of the same kind with no copyright line of its
own, which is checked against the first author's holder above it. So whenever the engine is built from new
sources, a person reads the search's new hits and its rules before a release (docs/DEVELOPING.md). The search
found these, and their notices ship (its run of 2026-11-01 on the pinned commit found no new hit):
- pplib's SHA-2 code (`util/utilsha.c`, Aaron D. Gifford, BSD-3-Clause) and MD5 code (`util/utilmd5.c`, L. Peter
  Deutsch, Zlib-style);
- the Mersenne Twister in xdvipdfmx (`mt19937ar.c`, Makoto Matsumoto and Takuji Nishimura, BSD-3-Clause);
- FreeType's BDF and PCF drivers and its hash code (Francesco Zappa Nardelli; Computing Research Labs, New Mexico
  State University; MIT), and the PCF driver's `pcfutil.c` (The Open Group, X11 terms);
- in HarfBuzz, `hb-ucd.cc` (Grigori Goronzy, ISC), the fasthash function in `hb-algs.hh` (Zilong Tan, MIT) and
  Elie Roux's copyright line in the BASE table, which HarfBuzz's COPYING does not list;
- one more copyright line in XeTeX (`XeTeX_web.h`, Peter Breitenlohner).

Two more notices come from other checks. XeTeX's image readers are under the GPL, not XeTeX's MIT terms
(`XeTeX-image-notice.txt`; see the notes below). And some files of musl, the C library inside Emscripten, carry
terms of their own; `musl-file-notices.txt` holds the header of each such file that the engine links. The build
lists the linked members of `libc.a` from the link map and fails when one of them has a notice that the file does
not hold (`link-report.mjs musl`).

| Part | Version | Licence | Notices in the package |
|---|---|---|---|
| pdfTeX | TeX Live 2026 | GPL-2.0-or-later | `dist/licenses/GPL-2.0.txt`, `dist/licenses/GPL-3.0.txt` |
| XeTeX (and XeTeX_web.h's further copyright line, Peter Breitenlohner) | TeX Live 2026 | MIT/X11; its image readers (xetexdir/image/*.c, built by texk/web2c/xetexdir/am/xetex.am) are GPL-2.0-or-later, Copyright SIL International (Jonathan Kew), derived from dvipdfmx (Jin-Hwan Cho, Shunsaku Hirata, Mark A. Wicks) | `dist/licenses/engine/XeTeX-COPYING.txt`, `dist/licenses/engine/XeTeX-web-notice.txt`, `dist/licenses/GPL-2.0.txt`, `dist/licenses/engine/XeTeX-image-notice.txt` |
| web2c's library and TeX's own code (TeX, e-TeX) | TeX Live 2026 | Knuth's terms and web2c's (permissive) | none needed |
| libmd5 (L. Peter Deutsch, Aladdin Enterprises) | TeX Live 2026 | Zlib-style | `dist/licenses/engine/libmd5-notice.txt` |
| SyncTeX (Jérôme Laurens) | TeX Live 2026 | MIT | `dist/licenses/engine/SyncTeX-notice.txt` |
| bibtex8 | TeX Live 2026 | GPL-1.0-or-later | `dist/licenses/GPL-2.0.txt`, `dist/licenses/GPL-3.0.txt` |
| xdvipdfmx (dvipdfmx), with the Mersenne Twister (Makoto Matsumoto and Takuji Nishimura) | TeX Live 2026 | GPL-2.0-or-later; mt19937ar.c: BSD-3-Clause; the MD5, SHA-256, SHA-384/512 and ARC4 code in dpxcrypt.c comes from libgcrypt (LGPL-2.1-or-later, Free Software Foundation): LGPL code inside a GPL program | `dist/licenses/GPL-2.0.txt`, `dist/licenses/GPL-3.0.txt`, `dist/licenses/engine/xdvipdfmx-mt19937ar-notice.txt`, `dist/licenses/LGPL-2.1.txt` |
| kpathsea (the library only) | TeX Live 2026 | LGPL-2.1-or-later | `dist/licenses/LGPL-2.1.txt` |
| HarfBuzz (with hb-subset), with Grigori Goronzy's hb-ucd.cc, Zilong Tan's fasthash, and Elie Roux's line in its BASE table | 12.3.2 | Old MIT; hb-ucd.cc: ISC; fasthash (in hb-algs.hh): MIT; its Unicode data tables: the Unicode License V3, in ICU.txt | `dist/licenses/engine/HarfBuzz-COPYING.txt`, `dist/licenses/engine/HarfBuzz-ucd-notice.txt`, `dist/licenses/engine/HarfBuzz-fasthash-notice.txt`, `dist/licenses/engine/HarfBuzz-base-notice.txt`, `dist/licenses/ICU.txt` |
| Graphite2 | 1.3.14 | LGPL-2.1-or-later (or MPL-2.0 or GPL-2.0-or-later); the LGPL taken | `dist/licenses/engine/graphite2-COPYING.txt`, `dist/licenses/LGPL-2.1.txt` |
| TECkit | 2.5.13 | LGPL-2.1-or-later (or CPL-0.5); the LGPL taken | `dist/licenses/engine/TECkit-LICENSING.txt`, `dist/licenses/LGPL-2.1.txt` |
| FreeType, with its BDF and PCF drivers and its hash code (Francesco Zappa Nardelli; Computing Research Labs, New Mexico State University; The Open Group) | 2.14.1 | GPL-2.0-or-later: the GPL option of FreeType's dual licence (FTL or GPL-2.0-or-later), since the engine also holds GPL code; the BDF and PCF drivers and fthash: MIT, and pcfutil.c: The Open Group's X11 terms | `dist/licenses/engine/FreeType-LICENSE.txt`, `dist/licenses/engine/FreeType-FTL.txt`, `dist/licenses/GPL-2.0.txt`, `dist/licenses/engine/FreeType-bdf-notice.txt`, `dist/licenses/engine/FreeType-fthash-notice.txt`, `dist/licenses/engine/FreeType-pcf-notice.txt`, `dist/licenses/engine/FreeType-pcfutil-notice.txt` |
| libpng | 1.6.55 | libpng-2.0 | `dist/licenses/engine/libpng-LICENSE.txt` |
| zlib | 1.3.2 | Zlib | `dist/licenses/engine/zlib-LICENSE.txt` |
| pplib (Paweł Jackowski), used by LuaTeX and XeTeX | 2.05.0 | pplib's own files state no licence: recorded as shipped as part of LuaTeX, under LuaTeX's terms (GPL-2.0-or-later). Two of its files state their authors' terms: util/utilsha.c (SHA-2, Aaron D. Gifford): BSD-3-Clause; util/utilmd5.c (MD5, L. Peter Deutsch, Aladdin Enterprises): Zlib-style | `dist/licenses/GPL-2.0.txt`, `dist/licenses/engine/pplib-utilsha-notice.txt`, `dist/licenses/engine/pplib-utilmd5-notice.txt` |
| xpdf (its PDF reading code, used by pdfTeX) | 4.06 | GPL-2.0 or GPL-3.0 | `dist/licenses/engine/xpdf-README.txt`, `dist/licenses/GPL-2.0.txt`, `dist/licenses/GPL-3.0.txt` |
| ICU (and its data file, icudt78l.dat) | 78.2 | Unicode-3.0 | `dist/licenses/ICU.txt` |
| Emscripten's runtime (in engine.js) and system libraries (in engine.wasm) | 6.0.13 | MIT or NCSA | `dist/licenses/engine/Emscripten-LICENSE.txt` |
| musl libc, inside Emscripten (libc.a also holds Emscripten's own C library code, under the Emscripten component's terms) | Emscripten 6.0.13 | MIT | `dist/licenses/engine/musl-COPYRIGHT.txt`, `dist/licenses/engine/musl-file-notices.txt` |
| libc++, libc++abi and compiler-rt, inside Emscripten | Emscripten 6.0.13 | Apache-2.0 WITH LLVM-exception (no notice needed for compiled forms) | `dist/licenses/engine/LLVM-libcxx-LICENSE.txt`, `dist/licenses/Apache-2.0.txt` |
| MiniLZ4, Emscripten's LZ4 decoder in engine.js (Pierre Curto) | Emscripten 6.0.13 | MIT | `dist/licenses/engine/MiniLZ4-notice.txt` |
| BusyTeX (credit: the one-instance pattern, the multi-call idea, and a few lines copied into engine/build/dispatcher.c, each marked "from BusyTeX"); by Vadim Kantorov, who made 2,046 of its 2,069 contributions on GitHub (read 2026-10-26); its README states the MIT licence, and BusyTeX has no LICENSE file | main eb36aae (the commit its README was read at) | MIT | `dist/licenses/engine/BusyTeX-README-License.txt`, `dist/licenses/MIT.txt` |
| liveMd2Tex's own engine code: engine/build/dispatcher.c, stubs.c, the fontconfig stand-in (fontlist/), the build script and tools | the commit that built the engine (engine-build.json, build.scripts) | GPL-3.0-or-later | `dist/licenses/GPL-3.0.txt` |

Notes on the table:

- **XeTeX** is under the MIT/X11 terms of its `COPYING`. Its image readers (`xetexdir/image/`: `bmpimage.c`,
  `jpegimage.c`, `mfileio.c`, `numbers.c`, `pngimage.c`, which `texk/web2c/xetexdir/am/xetex.am:164-173` compiles
  into XeTeX) are GPL-2.0-or-later, Copyright SIL International (Jonathan Kew), and derive from dvipdfmx (Jin-Hwan Cho,
  Shunsaku Hirata, Mark A. Wicks). Both notices ship whole in `XeTeX-image-notice.txt`, from `jpegimage.c`.
- **FreeType** is dual-licensed: the FreeType License (FTL) or GPL-2.0-or-later. The engine holds GPL code, and
  the FTL does not combine with the GPL, so FreeType is taken here under its GPL option. Its credit, as the FTL
  words it (`docs/FTL.TXT`, with the year of FreeType 2.14.1's own copyright lines, 1996-2025), is kept anyway:
  Portions of this software are copyright © 2025 The FreeType Project (https://freetype.org). All rights
  reserved. Its BDF and PCF drivers and its hash code are under their own MIT and X11 terms (above).
- **pplib** (Paweł Jackowski) is the PDF reader that XeTeX uses for PDF images (`xetexdir/pdfimage.cpp:40-44`).
  Its own files state no licence. TeX Live ships it as part of LuaTeX, so it is recorded under LuaTeX's terms,
  GPL-2.0-or-later, as Debian records pplib (GPL-2+) and as Fedora covers it inside its LuaTeX packages
  (the maintainer's decision, 2026-10-30). The engine holds no LuaTeX. Two of pplib's files state their authors'
  terms, and their notices ship: `util/utilsha.c` (BSD-3-Clause) and `util/utilmd5.c` (Zlib-style).
- **libpaper** is GPL-2.0-only (`libs/libpaper/libpaper-src/lib/paper.c:3-6` at the pinned commit: "Use under the
  GPL version 2"), which does not combine with the extension's GPL-3.0-or-later code, so the engine leaves it out.
  dvipdfmx is built without it: the build edits dvipdfmx's generated `config.h` and `Makefile`, as
  `engine-build.json` records (`generatedEdits`). The build and the VSIX scan fail an engine that holds libpaper's
  paper table (`halfexecutive`, `csheet` and the rest) or its variable `PAPERSIZE`, or that lacks the four sizes
  dvipdfmx compiles in only without libpaper (`isob3` to `isob6`).
- **MiniLZ4**, Emscripten's LZ4 decoder inside `engine.js`, is based on Pierre Curto's node-lz4
  (`third_party/mini-lz4.js:2-7` at Emscripten's pinned commit; Copyright (c) 2012 Pierre Curto, MIT). The glue
  keeps its notice, and the notice ships as `dist/licenses/engine/MiniLZ4-notice.txt` as well.
- **dlmalloc**, Doug Lea's memory allocator, is one of Emscripten's system libraries in `engine.wasm`
  (`libdlmalloc.a`). Doug Lea released it to the public domain (CC0; `system/lib/dlmalloc.c:52-54` at Emscripten's
  pinned commit), so no notice is needed; it is named here for credit.
- **Parts left out.** The engine holds no LuaTeX (and so none of its Lua libraries, MetaPost, FontForge's code,
  luaffi or zziplib), no MakeIndex, no fontconfig or Expat (XeTeX finds fonts by name through our own stand-in,
  `engine/build/fontlist/`), and no libpaper. The build fails on a link input from any of their folders
  (`link-report.mjs`, `DROPPED`), and the build and the VSIX scan fail an engine that holds the strings of LuaTeX,
  luaffi, MakeIndex or libpaper (`engine/build/tools/wasm-inspect.mjs`).

### The engine's source

The engine's corresponding source has three parts. The engine release `engine-6a30018-4` holds all three, and
each release of liveMd2Tex that ships the engine carries them again:

| What | Archive | SHA-256 |
|---|---|---|
| TeX Live's source tree at commit 6a300188053b8f2ded89dbd52293732a706b9c0e, the head of `refs/heads/tags/texlive-2026.1` | https://github.com/TeX-Live/texlive-source/archive/6a300188053b8f2ded89dbd52293732a706b9c0e.tar.gz | `ab72044ed1abd9866d3e3899941cf5e66b0f22f889c749ce606d8c4cf571872b` |
| Emscripten 6.0.13's source at commit e13ee988ce3d87a738dd8f3661d02223308c412a: the runtime in `engine.js` and the system libraries compiled into `engine.wasm` | https://github.com/emscripten-core/emscripten/archive/e13ee988ce3d87a738dd8f3661d02223308c412a.tar.gz | `0eb45cf55702db363e5dacd06fec69b63345ce6ffe61156c0e7fcbf3ae842d4e` |
| Our build scripts, stubs, dispatcher and font stand-in: `engine/build/` and `engine/engine-build-pins.json` at commit 2594ca2e05764e77580ce19c7403d75fac1907ae of this repository | the engine release's `engine-build-scripts-2594ca2.tar.gz` | tree hash `00ccf30aca5c03a83edf9cb320ea769697d5c6356a5c6e556fd1ed5318e6eeb9` (SHA-256 over the files' SHA-256 and paths, as `engine-build.json` records it) |

- TeX Live's branch `tags/texlive-2026.1` can move, so the archive is taken by its commit. Its tree:
  https://github.com/TeX-Live/texlive-source/tree/6a300188053b8f2ded89dbd52293732a706b9c0e, a copy of TeX Live's
  Subversion repository (https://tug.org/texlive/svn/).
- The glue is Emscripten's output, whose source is Emscripten's `src/` at the commit above. The exact flags, the
  lists of renamed and shared names, the toolchain and the output hashes are in `engine/engine-build.json` at the
  release's tag (and in the engine release). Emscripten's compiler is installed from the emsdk archives that
  `engine/engine-build-pins.json` pins.
- The licence statement: our own code is GPL-3.0-or-later; the engine as a whole can be passed on under GPL-3.0,
  and its parts keep their own terms ("This version and its source").

Each release of liveMd2Tex that ships the engine carries a copy of the two archives, attached before the release
is published (`.github/workflows/release-sources.yml`, run on the draft release). The workflow downloads them,
checks each one's bytes against the SHA-256 above and its files against its commit's tree, and checks that the
packaged `engine.wasm` is the one that `engine-build.json` records and `engine/pins.json` pins, built from those
two commits. If the tag's `engine/build/` and `engine/engine-build-pins.json` still give the build's tree hash,
the tag itself holds the scripts' source; if not, the release names the engine release and the commit that built
the engine. It then attaches the archives as `engine-sources-v<version>.tar`, with their list in `sources.json`.
So the source stays available from liveMd2Tex's own releases, as GPL-3 section 6(d) asks; every GPL part of the
engine is under "version 2 or later", or GPL-2 or GPL-3 (xpdf), so section 6(d) of version 3 applies. GitHub makes
the two `archive/` files on request, and it promises the same files for a commit, not the same bytes. If one comes
back with other bytes but the commit's files, the workflow attaches it with its new SHA-256 and says so; if its
files differ, the workflow stops.

## In the test copy

`node scripts/vsix-scan.mjs --test-copy --data-package PATH` builds the development machine's test copy: the
package with the engine, plus a core-data package's data in `dist/data/` and its licence texts in
`dist/data/LICENSES/`, for a throwaway VS Code profile only. The store packages get these files from the data
packages instead.

| Part | Version | Licence | Where in the test copy | Source |
|---|---|---|---|---|
| TeX Live's packages, classes and fonts of core-data, as that data package holds them ("The data packages") | TeX Live 2026 | each package's own; `dist/data/LICENSES/INDEX` names each package's licence files | `dist/data/` | https://ctan.org, https://tug.org/texlive/ |

## The data packages (core-data, extra-data; B1, released as core-data-ae9dbba-2 and extra-data-ae9dbba-2)

TeX Live's packages, classes and fonts in the data packages are unchanged as TeX reads them. core-data stores
most of its Type 1 fonts with their encryption removed, and the engine host restores each one to the original
bytes, checked against its SHA-256, before TeX reads it; the package's `LICENSE.txt` says so and quotes the LPPL's
clause 9. Which fonts are stored so is decided font by font, by each font's own header: fonts under the SIL OFL,
IBM's Courier fonts and fonts with no clear terms are stored as they are, and so are all fonts of amsfonts,
inconsolata, rsfs and newtx (`engine/bundle-sets.json`, `t1cSkip`). courier's `LICENSES` folder holds IBM's
notice, as its fonts state it, and IBM's terms as X.Org ships them. From lhcyr, the Extra Packages add-on leaves
out of its data one shell script (`maketfms.sh`, which none of its files runs) and three READMEs whose name a
core-data file has (`engine/bundle-sets.json`, `leaveOut`). The READMEs state lhcyr's terms, so they ship, with
its source archive's README, in lhcyr's `LICENSES` folder, and the add-on's `LICENSE.txt` lists the four files
with their reasons.

Each package is under its own licence, as `data/licences.json` lists it from the TeX Catalogue. B1's licence scan
of the 2026-10-15 snapshot finds: LPPL (1.3c and earlier), GPL, LGPL, AGPL, GNU FDL, SIL OFL, GUST Font License,
Apache-2.0, BSD, 0BSD, MIT, ISC, X11, Artistic, CC0, CC BY, CC BY-SA, public domain, Knuth's terms, the
Catalogue's "other-free", and TeX Live's own files. "collection" packages and the publisher classes labelled
"other-free" are as read in their files (`engine/bundle-sets.json`, `licenceReviews`).

- **Licence texts.** Each data package ships the licence texts its packages require in `LICENSES/`, and
  `LICENSES/INDEX` names each package's files: the licence texts (in this repository under `engine/licence-texts/`
  and `LICENSES/`, pinned in `engine/bundle-licences.json`: the LaTeX Project's LPPL texts, SPDX licence list
  v3.27.0, the GUST Font License from lm, CTAN's statement of Knuth's terms, MakeIndex's notice from TeX Live's
  sources; TeX Live's own `LICENSE.TL` and `LICENSE.CTAN` from texlive.infra) and each package's own licence files,
  GUST font manifests, Apache-2.0 `NOTICE` files and statements of terms from its archives.
- **Changes to GPL fonts.** core-data's `LICENSES/CHANGES-GPL` lists each packed font under the GPL: its path,
  its original's SHA-256, the snapshot archive that holds the original unmodified, what was done and the date, as
  the GPL asks of a changed file.
- **Where the sources are.** CTAN keeps only each package's newest version. So each data package's `LICENSE.txt`
  names the pinned TeX Live snapshot (https://texlive.info/tlnet-archive/2026/10/15/tlnet/), which keeps every
  package as shipped: `archive/<package>.tar.xz`, and its `.source.tar.xz` and `.doc.tar.xz` where it has them.
  For each package under the GPL, LGPL or AGPL, and each package with a packed GPL font, `data/licences.json`
  lists those archives with their URLs and the SHA-512 of TeX Live's package database. Each data package's own
  release (`core-data-<engine short hash>-<n>`, `extra-data-<engine short hash>-<n>`, made by
  `.github/workflows/bundle.yml`'s `release` job) carries a copy of each as `<tag>-sources.tar`, with
  `sources.json`, the pinned package database and the package's `LICENSES/`. The first two are
  `core-data-ae9dbba-2` and `extra-data-ae9dbba-2`, which `engine/pins.json` pins.

## Added later (planned; not in the package yet)

| Part | Milestone | Licence (docs/DESIGN.md#store-and-packaging) |
|---|---|---|
| KaTeX, jsdiff | M1 and later | MIT, BSD-3-Clause |
| zeroperl, latexdiff (v1.1) | v1.1 | MIT, Apache-2.0, GPL-3.0-or-later |

## Test copies only (not in the store package)

Ten CTAN packages are used only by tests. Their files come from this repository's release `test-inputs-20261015-1`
(published 2026-11-03), which holds each package whole and unchanged: TeX Live's archives of it from the pinned
snapshot (2026/10/15), and CTAN's `revtex.tds.zip`. `engine/pins.json` names each file, its archive and its
SHA-256. The release's notes give the same licences and credits as the table, and where each licence text is
inside the archives.

| Part | Version | Licence | Used for | Source |
|---|---|---|---|---|
| REVTeX (class, `.rtx` options, helper `.sty` files, `.bst` styles), unchanged from `revtex.tds.zip` | 4.2f | LPPL 1.3c | a made-up data set in the engine tests; the corpus document P2; the CTAN ZIP test of "Add a package from a file"; the REVTeX template | https://ctan.org/pkg/revtex |
| IEEEtran (`IEEEtran.cls`, `IEEEtran.bst`, `bare_jrnl.tex`) | 1.8b | LPPL 1.3 | the corpus document P3; the IEEEtran template; the speed measures | https://ctan.org/pkg/ieeetran |
| elsarticle (`.dtx`, `.ins`, a template, `elsarticle-num.bst`), built by docstrip in a test | 3.5 | LPPL 1.3 | the corpus document P4; the elsarticle template | https://ctan.org/pkg/elsarticle |
| beamer's conference-talk example (`beamerexample-conference-talk.tex`) | 3.78 | the documentation: GNU FDL 1.3 or later, or LPPL 1.3c or later (the code: GPL 2 or later, or LPPL 1.3c or later) | the corpus document P6; the engine-host design tests; the speed measures | https://ctan.org/pkg/beamer |
| ucbthesis (class and its example thesis) | 3.6 | LPPL 1.3 | the corpus document P7 | https://ctan.org/pkg/ucbthesis |
| acmart (`.dtx`, `.ins`, `ACM-Reference-Format.bst`), built by docstrip in a test | 2.20 | LPPL 1.3 | the acmart template | https://ctan.org/pkg/acmart |
| llncs (`llncs.cls`, `splncs04.bst`) | 2.26 | Copyright (c) 1996-2025 Springer, CC BY 4.0 or later (https://creativecommons.org/licenses/by/4.0/); `splncs04.bst`, generated with makebst, carries Patrick W Daly's notice: LPPL 1 or later | the llncs template | https://ctan.org/pkg/llncs |
| pgf manual, the tutorial chapter's source (`pgfmanual-en-tutorial.tex`) | 3.1.12 | LPPL 1.3c, GPL 2, GNU FDL 1.2 (the manual) | the corpus document P8 | https://ctan.org/pkg/pgf |
| DejaVu fonts (twelve TrueType files) and their `LICENSE` | 2.34 | (c) Bitstream under the Bitstream Vera terms, the DejaVu changes in the public domain, the glyphs from the Arev fonts (c) Tavmjong Bah under their terms; LPPL 1.3 for the TeX support | the font tests; the engine build's smoke test | https://ctan.org/pkg/dejavu |
| tensor (`tensor.dtx`, `tensor.ins`), built by docstrip in a test | 2.2 (2023/07/18) | LPPL 1.3c or later | the `.dtx` and `.ins` test of "Add a package from a file" | https://ctan.org/pkg/tensor |

Packages a user adds with "Add a package from a file" stay on the user's computer, under VS Code's global storage
for this extension (or in the project folder); the extension never distributes them.

## Code that follows other projects' code

- **BusyTeX** (Vadim Kantorov, MIT; https://github.com/busytex/busytex). The engine is one program that holds
  several TeX tools, chosen by name, as BusyTeX's is. Our dispatcher (`engine/build/dispatcher.c`) holds a few
  lines copied from BusyTeX's `busytex.c` at commit eb36aae169f7d71e70760a84ef80156b33c0f820, each marked "from
  BusyTeX" with its line numbers: the newline and flush after each tool (lines 39-41) and the shift of the
  arguments, so that the chosen tool sees its own options (line 108). The engine host runs the tools one after
  another in one WebAssembly instance, the way BusyTeX's `busytex_pipeline.js` does: after each tool, the memory is
  cleared and its first 64 MiB restored (`src/engine-host/engine/worker.ts`, which credits it; the code is a short
  idiom, written anew). BusyTeX's MIT notice ships as `dist/licenses/engine/BusyTeX-README-License.txt` with
  `dist/licenses/MIT.txt`.
- **fontconfig** (Keith Packard and others; https://www.freedesktop.org/software/fontconfig/release/). The data
  builder's font list writer (`scripts/lib/font-list.mjs`) describes each font as fontconfig 2.13.96 does. Its
  weight, width and slant tables follow fontconfig's `src/fcfreetype.c` (`weightConsts`, `widthConsts`,
  `slantConsts`) and `src/fcweight.c` (`map`) entry by entry, so fontconfig's notice (its `COPYING`, a permissive
  licence that asks for its notice to be kept) is kept beside it, in `scripts/lib/fontconfig-notice.txt`. The
  script runs only when the data packages are built and is not in any package. The engine's stand-in for fontconfig
  (`engine/build/fontlist/`) answers the ten fontconfig calls XeTeX makes; it is written anew, and nothing of
  fontconfig is linked into the engine.
- **TeXlyre.** Earlier development versions of liveMd2Tex ran TeXlyre's build of BusyTeX (Fares Abawi,
  https://github.com/TeXlyre/texlyre-busytex-build). None of its code or files is in this version.

## Development tools (never shipped)

The tools used to build and test the extension (esbuild-wasm, TypeScript, ESLint, Mocha, `@vscode/vsce`,
`@vscode/test-cli`, `@vscode/test-electron`, acorn, pdf-lib and their dependencies) are not in the package;
`package-lock.json` pins them.

The coverage measurement (`docs/coverage-method.md`) runs on GitHub's runners only, never on a user's computer and
never in the package. There it installs a full TeX Live (scheme-full of the pinned snapshot; each package under its
own licence, https://tug.org/texlive/) and Ubuntu's Ghostscript package (AGPL-3.0-or-later,
https://www.ghostscript.com), and downloads TeX Live packages' documentation archives from the same snapshot (each
under its package's own licence) for their example and template documents. None of them is committed, uploaded as
an artifact or shipped. The arXiv frame kept in the code, which would download arXiv papers under CC BY 4.0 or CC0
1.0 and CTAN templates, is disabled until arXiv agrees.

The engine's build (`engine/build/`) runs under Linux only, on GitHub's runner or under WSL, with Emscripten
6.0.13 and the host tools that `engine/engine-build-pins.json` lists. None of them ships; only what the engine
itself holds does ("Inside the engine").

## Test data from other projects (never shipped)

| Part | Version | Licence | Used for | Source |
|---|---|---|---|---|
| LaTeX Workshop (James-Yu.latex-workshop): its keybindings, PDF custom editor and auto-build setting, copied as data from its `package.json` into `test/unit/fixtures/latex-workshop-10.19.0.json`; no code | 10.19.0 | MIT; Copyright (c) 2016 James Yu (the licence in full: `test/unit/fixtures/latex-workshop-LICENSE.txt`) | the coexistence tests (M2-B) | https://github.com/James-Yu/LaTeX-Workshop |

`scripts/run-integration.mjs --with-latex-workshop` installs LaTeX Workshop's VSIX (pinned by SHA-256, a
development-only download kept outside the repository) into a throwaway test profile, and nowhere else.
