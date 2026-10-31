# Third-party notices

This file lists every part of other people's work that ships inside the liveMd2Tex extension package
(`haberwooki.livemd2tex`), with its licence. The package holds the extension, PDF.js and the TeX engine
(`dist/engine/`). The data packages hold TeX's files and no code; their own `LICENSE.txt` and `LICENSES/` give
those files' terms (see "The data packages" below). The package's shape is in docs/DESIGN.md#store-and-packaging.

## This version and its source

The extension as a whole is released under GPL-3.0-or-later (see `LICENSE`). Its `package.json` declares
`GPL-3.0-or-later AND AGPL-3.0-only` because TeXlyre's BusyTeX build (its JavaScript glue and the engine
WebAssembly) keeps its AGPL-3.0 terms inside the combined work. Copyright (C) 2026 the liveMd2Tex authors
(`AUTHORS.md` in the repository says who they are).

The source code of each release is the tag of its version in this repository: for this version, the tag `v0.0.1`
of https://github.com/haberwooki/liveMd2Tex. Each release is tagged `v<version>`, with the version in
`package.json`, on the commit its packages are built from, and its page links the tag's tree. That tree holds the
whole source, with our changes to the engine's glue in `engine/patches/`. The release workflow
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
  LGPL-3.0, AGPL-3.0, Apache-2.0 and MIT texts from the SPDX licence list, v3.27.0; and the LPPL 1.3c as the LaTeX
  Project publishes it (https://www.latex-project.org/lppl/lppl-1-3c.txt), since the LPPL allows only verbatim
  copies of itself and SPDX's copy has the version 1.3 appendix;
- ICU's licence (`ICU.txt`, ICU's own LICENSE file from release 78.2) and MakeIndex's notice (`MakeIndex.txt`,
  from TeX Live's sources), for the two built into the engine;
- the CC0 1.0 Universal legal code (`CC0-1.0.txt`: Creative Commons' own plain text,
  https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt, byte for byte, which is also SPDX's);
- `dist/licenses/engine/`: the notice of every part of the engine that asks for one, each taken from that part's
  own source at the version the engine builds ("Inside the engine" below).

The test copy adds `dist/data/fonts/LICENSE` (DejaVu) and `dist/data/licenses/` (TeX Live's and CTAN's licence
notes and the LPPL, copied out of the image). A "Licences" command that shows them comes before the first release.

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
| isomorphic-git (only the read commands: resolveRef, readBlob, readCommit, currentBranch; the network commands are left out of the bundle) | 1.42.5 | MIT | the Git reader | https://github.com/isomorphic-git/isomorphic-git |
| isomorphic-git's `path.join` code, copied by isomorphic-git from @zenfs/core (Copyright (c) James Prevett and other ZenFS contributors) | 1.42.5 | LGPL-3.0-or-later (`dist/licenses/LGPL-3.0.txt`) | the Git reader's path joining, inside `dist/extension.js` | https://github.com/zen-fs/core |
| pako | 1.0.11 | MIT AND Zlib (`dist/licenses/pako.txt`: pako's MIT licence, then the zlib notice of Jean-loup Gailly and Mark Adler, as pako's `lib/zlib/` files state it) | isomorphic-git: zlib inflate of Git objects | https://github.com/nodeca/pako |
| sha.js | 2.4.12 | MIT AND BSD-3-Clause | isomorphic-git: SHA-1 | https://github.com/browserify/sha.js |
| crc-32 1.2.2, clean-git-ref 2.0.1 | | Apache-2.0 | isomorphic-git: pack checksums, ref names | https://github.com/SheetJS/js-crc32, https://github.com/TheSavior/clean-git-ref |
| async-lock 1.4.1, pify 4.0.1, diff3 0.0.3, ignore 5.3.2, safe-buffer 5.2.1, to-buffer 1.2.2, inherits 2.0.4 (ISC) | | MIT, ISC | isomorphic-git's helpers | npm |
| get-intrinsic, call-bind, call-bound, call-bind-apply-helpers, define-data-property, set-function-length, has-property-descriptors, es-define-property, es-errors, es-object-atoms, gopd, hasown, has-symbols, has-tostringtag, get-proto, dunder-proto, math-intrinsics, for-each, is-callable, is-typed-array, which-typed-array, typed-array-buffer, available-typed-arrays, possible-typed-array-names, isarray | (lockfile) | MIT | small helpers pulled in by sha.js and to-buffer (function-bind is replaced by a one-line file of ours, `scripts/shims/function-bind.cjs`, because its fallback builds code from text) | npm |

The licence of each row is the one stated in the file named beside it (read 2026-10-15); B1's licence scan
rechecks every row before a release.

## The TeX engine (`dist/engine/`)

The engine ships in the extension's own package, in `dist/engine/`: `busytex.wasm` (the engine WebAssembly) and
`busytex.js` (its JavaScript glue, patched), both from TeXlyre's BusyTeX build 46ebb62, with our engine
configuration (`texmf-override.cnf`, `fonts.conf`; GPL-3.0-or-later). The data packages carry no code, so the
engine is never in them. `node scripts/vsix-scan.mjs --with-engine` builds the package with the engine; the
plain package of the other scans leaves it out.

TeXlyre-BusyTeX: Copyright (c) 2026 Fares Abawi (TeXlyre), AGPL-3.0; based on BusyTeX by Vadim Kantorov, MIT.
TeXlyre's NOTICE ships as `dist/licenses/engine/TeXlyre-BusyTeX-NOTICE.txt`. It reads:

```
TeXlyre-BusyTeX
Copyright (c) 2026 [Fares Abawi](https://abawi.me)

This project is based on BusyTeX (https://github.com/busytex/busytex)
Original BusyTeX work is MIT licensed.

Modifications (AGPL-3.0 licensed) include:
- Fixes LuaHBTeX build (broken in upstream BusyTeX since TeXlive 2022)
- Fixes to TeXlive 2026 build process
- Adds SyncTeX detection
- Adds TeXlive package and font hosting for download
- Adds multilingual hyphenation formatting to all engines
```

Our changes to the glue. `dist/engine/busytex.js` is TeXlyre's `busytex.js` with our patches, which close every
route out of the engine (no shell, no network fetch, no socket). Its first lines say that it was modified, by
whom and on which date, keep TeXlyre's copyright and licence notice, release the modified file under the AGPL-3.0
and name the patches (AGPL-3.0 section 5(a) and (b)). Each change is marked "PATCHED". The patches are
`engine/patches/busytex-glue.mjs`, with the diff `engine/patches/busytex.js.diff`, at the release's tag. The
patched glue ships as readable JavaScript, so the shipped file is its own source.

### Inside the engine

Every archive and object that TeXlyre's Makefile links into `busytex.wasm` belongs to one row below: its link line
(Makefile line 376) and the object lists it names (lines 77 to 86). `engine/engine-notices.json` holds a copy of
those lines, and `test/unit/engineNotices.test.ts` checks every file they link against the rows, in both
directions. The test reads the manifest's copy. It also checks that the manifest names the TeXlyre commit and
release that `engine/pins.json` pins, so a new engine pin fails it until the manifest is updated. The release check
(`scripts/release-sources.mjs`) compares the copy with the Makefile inside TeXlyre's archive at that commit, by the
Makefile's SHA-256 and line by line. The versions are from TeX Live's `libs/*/version.ac` at tag texlive-2026.0 and
TeXlyre's `versions.txt`. Each notice file is the part's own, copied from its source at that version
(`engine/engine-notices.json` pins each one). `scripts/vsix-scan.mjs` fails a package with the engine that lacks
one, or holds one with other bytes.

Below the link line. A linked library can hold code by other authors under terms of their own.
`scripts/engine-notice-search.mjs` helps a person find it; it is an aid to reading, not a proof. It searches the
compiled sources of every linked library, in the four source archives below, for licence clauses that match its
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
own, which is checked against the first author's holder above it. So on every change of the engine pin a person
reads the search's new hits and its rules before a release (docs/DEVELOPING.md). The search of 2026-10-26 found
these, and their notices ship:
- pplib's SHA-2 code (`util/utilsha.c`, Aaron D. Gifford, BSD-3-Clause) and MD5 code (`util/utilmd5.c`, L. Peter
  Deutsch, Zlib-style);
- the Mersenne Twister in xdvipdfmx (`mt19937ar.c`, Makoto Matsumoto and Takuji Nishimura, BSD-3-Clause);
- FreeType's BDF and PCF drivers and its hash code (Francesco Zappa Nardelli; Computing Research Labs, New Mexico
  State University; MIT), and the PCF driver's `pcfutil.c` (The Open Group, X11 terms);
- in HarfBuzz, `hb-ucd.cc` (Grigori Goronzy, ISC), the fasthash function in `hb-algs.hh` (Zilong Tan, MIT) and
  Elie Roux's copyright line in the BASE table, which HarfBuzz's COPYING does not list;
- IBM's decNumber in MetaPost's `libmputil` (Copyright (c) IBM Corporation, the ICU License 1.8.1);
- one more copyright line each in XeTeX (`XeTeX_web.h`, Peter Breitenlohner), in LuaTeX's `texluac.c` (Taco
  Hoekwater, MIT), in SyncTeX's LuaTeX glue (Taco Hoekwater), in FontForge's `stemdb.c` (Alexey Kryukov) and in
  fontconfig's `fcmatrix.c` (Tuomas J. Lukka);
- Expat's per-file copyright lines, which name more contributors than its COPYING.

DynASM's notice (`dynasm/dasm_x86.h` and `dynasm.lua`, Mike Pall, MIT) was added from a review, not found by the
search: DynASM's headers state their licence by reference, which the first search did not read. The search now
reads them, and covers them by that notice. On wasm32, luaffi builds only TeX Live's stub `luaopen_ffi` (its
`ffi.h` finds no supported architecture, so `ffi.c` compiles the stub), and none of luaffifb's own code or of
DynASM's is in `busytex.wasm`: none of their strings is in it, and `scripts/vsix-scan.mjs` fails an engine that
holds one. Their notices ship all the same.

| Part | Version | Licence | Notices in the package |
|---|---|---|---|
| TeXlyre-BusyTeX build (busytex.c changes, kpse_remote.c, font_index.cpp, the JavaScript glue); Copyright (c) 2026 Fares Abawi (TeXlyre) | build 46ebb62 | AGPL-3.0-only | `dist/licenses/engine/TeXlyre-BusyTeX-NOTICE.txt`, `dist/licenses/AGPL-3.0.txt` |
| BusyTeX (the original BusyTeX build, which TeXlyre-BusyTeX is based on); by Vadim Kantorov, who made 2,046 of its 2,069 contributions on GitHub (read 2026-10-26); its README states the MIT licence, and BusyTeX has no LICENSE file | main eb36aae (the commit its README was read at) | MIT | `dist/licenses/engine/BusyTeX-README-License.txt`, `dist/licenses/MIT.txt` |
| pdfTeX | TeX Live 2026 | GPL-2.0-or-later | `dist/licenses/GPL-2.0.txt`, `dist/licenses/GPL-3.0.txt` |
| XeTeX (and XeTeX_web.h's further copyright line, Peter Breitenlohner) | TeX Live 2026 | MIT/X11 | `dist/licenses/engine/XeTeX-COPYING.txt`, `dist/licenses/engine/XeTeX-web-notice.txt` |
| LuaHBTeX (LuaTeX with HarfBuzz; the engine host runs it in ini mode only, and liveMd2Tex offers no LuaLaTeX) | TeX Live 2026 | GPL-2.0-or-later; its hyphenation code (lang/hyphen.c, lang/hnjalloc.c) is derived from LibHnj, under the GNU Library GPL version 2 or later, or the MPL: LGPL code inside a GPL program | `dist/licenses/engine/LuaTeX-notice.txt`, `dist/licenses/GPL-2.0.txt`, `dist/licenses/GPL-3.0.txt`, `dist/licenses/engine/LuaTeX-texluac-notice.txt`, `dist/licenses/LGPL-2.1.txt` |
| MetaPost library (mplib), inside LuaHBTeX, with IBM's decNumber | TeX Live 2026 | LGPL-3.0-or-later (its source is public domain; the executables are under the LGPL); decNumber: Copyright (c) IBM Corporation, the ICU License 1.8.1 (in ICU.txt, 'ICU License - ICU 1.8.1 to ICU 57.1') | `dist/licenses/engine/MetaPost-notice.txt`, `dist/licenses/engine/MetaPost-lmplib-notice.txt`, `dist/licenses/LGPL-3.0.txt`, `dist/licenses/GPL-3.0.txt`, `dist/licenses/engine/MetaPost-decNumber-notice.txt`, `dist/licenses/ICU.txt` |
| FontForge's code in LuaTeX (libff, LuaTeX's font loader; unilib), by George Williams, and in stemdb.c with Alexey Kryukov | TeX Live 2026 | BSD-3-Clause (George Williams) | `dist/licenses/engine/FontForge-LICENSE.txt`, `dist/licenses/engine/FontForge-unilib-notice.txt`, `dist/licenses/engine/FontForge-stemdb-notice.txt` |
| luaharfbuzz | TeX Live 2026 | MIT | `dist/licenses/engine/luaharfbuzz-LICENSE.txt` |
| LuaTeX's Lua libraries: LuaFileSystem, LPeg 1.0.1, LuaZip, lzlib, slnunicode, luamd5 | TeX Live 2026 | MIT; slnunicode: the Lua 5.0 licence (MIT) and Tcl's terms; luamd5 states none in TeX Live's copy | `dist/licenses/engine/LuaFileSystem-LICENSE.txt`, `dist/licenses/engine/LPeg-notice.txt`, `dist/licenses/engine/LuaZip-notice.txt`, `dist/licenses/engine/lzlib-README.txt`, `dist/licenses/engine/slnunicode-notice.txt`, `dist/licenses/MIT.txt` |
| LuaSocket (compiled in; the engine host never uses it) | TeX Live 2026 | MIT | `dist/licenses/engine/luasocket-LICENSE.txt` |
| luaffi: Facebook's luaffifb, which contains James R. McKaskill's luaffi. On wasm32 luaffi builds only TeX Live's stub luaopen_ffi, so neither luaffifb's own code nor DynASM (Mike Pall) is in busytex.wasm; their notices ship all the same | TeX Live 2026 | BSD-3-Clause (Copyright (c) 2015, Facebook, Inc.) AND MIT (Copyright (c) 2011 James R. McKaskill), as its LICENSE gives them; its PATENTS file is Facebook's 'Additional Grant of Patent Rights Version 2'; DynASM: MIT | `dist/licenses/engine/luaffi-LICENSE.txt`, `dist/licenses/engine/luaffi-PATENTS.txt`, `dist/licenses/engine/luaffi-dynasm-notice.txt` |
| Lua | 5.3.6 | MIT | `dist/licenses/engine/Lua-notice.txt` |
| web2c's library and TeX's own code (TeX, e-TeX) | TeX Live 2026 | Knuth's terms and web2c's (permissive) | none needed |
| libmd5 (L. Peter Deutsch, Aladdin Enterprises) | TeX Live 2026 | Zlib-style | `dist/licenses/engine/libmd5-notice.txt` |
| SyncTeX (Jérôme Laurens; its LuaTeX glue by Taco Hoekwater) | TeX Live 2026 | MIT | `dist/licenses/engine/SyncTeX-notice.txt`, `dist/licenses/engine/SyncTeX-luatex-notice.txt` |
| bibtex8 | TeX Live 2026 | GPL-1.0-or-later | `dist/licenses/GPL-2.0.txt`, `dist/licenses/GPL-3.0.txt` |
| xdvipdfmx (dvipdfmx), with the Mersenne Twister (Makoto Matsumoto and Takuji Nishimura) | TeX Live 2026 | GPL-2.0-or-later; mt19937ar.c: BSD-3-Clause; the MD5, SHA-256, SHA-384/512 and ARC4 code in dpxcrypt.c comes from libgcrypt (LGPL-2.1-or-later, Free Software Foundation): LGPL code inside a GPL program | `dist/licenses/GPL-2.0.txt`, `dist/licenses/GPL-3.0.txt`, `dist/licenses/engine/xdvipdfmx-mt19937ar-notice.txt`, `dist/licenses/LGPL-2.1.txt` |
| MakeIndex | TeX Live 2026 | MakeIndex Distribution Notice | `dist/licenses/MakeIndex.txt` |
| kpathsea, with kpsewhich, kpsestat, kpseaccess and kpsereadlink | TeX Live 2026 | LGPL-2.1-or-later | `dist/licenses/LGPL-2.1.txt` |
| HarfBuzz (with hb-subset), with Grigori Goronzy's hb-ucd.cc, Zilong Tan's fasthash, and Elie Roux's line in its BASE table | 12.3.2 | Old MIT; hb-ucd.cc: ISC; fasthash (in hb-algs.hh): MIT; its Unicode data tables: the Unicode License V3, in ICU.txt | `dist/licenses/engine/HarfBuzz-COPYING.txt`, `dist/licenses/engine/HarfBuzz-ucd-notice.txt`, `dist/licenses/engine/HarfBuzz-fasthash-notice.txt`, `dist/licenses/engine/HarfBuzz-base-notice.txt`, `dist/licenses/ICU.txt` |
| Graphite2 | 1.3.14 | LGPL-2.1-or-later (or MPL-2.0 or GPL-2.0-or-later); the LGPL taken | `dist/licenses/engine/graphite2-COPYING.txt`, `dist/licenses/LGPL-2.1.txt` |
| TECkit | 2.5.13 | LGPL-2.1-or-later (or CPL-0.5); the LGPL taken | `dist/licenses/engine/TECkit-LICENSING.txt`, `dist/licenses/LGPL-2.1.txt` |
| FreeType, with its BDF and PCF drivers and its hash code (Francesco Zappa Nardelli; Computing Research Labs, New Mexico State University; The Open Group) | 2.14.1 | GPL-2.0-or-later: the GPL option of FreeType's dual licence (FTL or GPL-2.0-or-later), since the engine also holds GPL code; the BDF and PCF drivers and fthash: MIT, and pcfutil.c: The Open Group's X11 terms | `dist/licenses/engine/FreeType-LICENSE.txt`, `dist/licenses/engine/FreeType-FTL.txt`, `dist/licenses/GPL-2.0.txt`, `dist/licenses/engine/FreeType-bdf-notice.txt`, `dist/licenses/engine/FreeType-fthash-notice.txt`, `dist/licenses/engine/FreeType-pcf-notice.txt`, `dist/licenses/engine/FreeType-pcfutil-notice.txt` |
| libpng | 1.6.55 | libpng-2.0 | `dist/licenses/engine/libpng-LICENSE.txt` |
| zlib | 1.3.2 | Zlib | `dist/licenses/engine/zlib-LICENSE.txt` |
| zziplib | 0.13.72 | LGPL-2.0-or-later (or MPL-1.1); the LGPL taken | `dist/licenses/engine/zziplib-README-COPYING.txt`, `dist/licenses/engine/zziplib-COPYING.LIB.txt` |
| pplib (Paweł Jackowski), used by LuaTeX and XeTeX | 2.05.0 | pplib's own files state no licence: recorded as shipped as part of LuaTeX, under LuaTeX's terms (GPL-2.0-or-later). Two of its files state their authors' terms: util/utilsha.c (SHA-2, Aaron D. Gifford): BSD-3-Clause; util/utilmd5.c (MD5, L. Peter Deutsch, Aladdin Enterprises): Zlib-style | `dist/licenses/GPL-2.0.txt`, `dist/licenses/engine/pplib-utilsha-notice.txt`, `dist/licenses/engine/pplib-utilmd5-notice.txt` |
| xpdf (its PDF reading code, used by pdfTeX) | 4.06 | GPL-2.0 or GPL-3.0 | `dist/licenses/engine/xpdf-README.txt`, `dist/licenses/GPL-2.0.txt`, `dist/licenses/GPL-3.0.txt` |
| ICU (and its data file, icudt78l.dat) | 78.2 | Unicode-3.0 | `dist/licenses/ICU.txt` |
| fontconfig (and fcmatrix.c's notice, Tuomas J. Lukka) | 2.13.96 (the tarball TeXlyre hosts) | HPND (MIT-style) | `dist/licenses/engine/fontconfig-COPYING.txt`, `dist/licenses/engine/fontconfig-fcmatrix-notice.txt` |
| Expat (and each source file's copyright lines) | 2.5.0 | MIT | `dist/licenses/engine/expat-COPYING.txt`, `dist/licenses/engine/expat-file-notices.txt` |
| libpaper | TeX Live 2026 | GPL-2.0-only | none: on the link line, but none of its code is in the WebAssembly (no PAPERCONF or /etc/papersize string; scripts/vsix-scan.mjs checks this): it ships nothing, and it would not combine with the AGPL-3.0 parts |
| Emscripten's runtime (in busytex.js) and system libraries (in busytex.wasm) | 5.0.4 | MIT or NCSA | `dist/licenses/engine/Emscripten-LICENSE.txt` |
| musl libc, inside Emscripten | Emscripten 5.0.4 | MIT | `dist/licenses/engine/musl-COPYRIGHT.txt` |
| libc++, libc++abi and compiler-rt, inside Emscripten | Emscripten 5.0.4 | Apache-2.0 WITH LLVM-exception (no notice needed for compiled forms) | `dist/licenses/engine/LLVM-libcxx-LICENSE.txt`, `dist/licenses/Apache-2.0.txt` |
| MiniLZ4, Emscripten's LZ4 decoder in busytex.js (Pierre Curto) |  | MIT | its notice is kept in dist/engine/busytex.js |

Notes on the table:

- **LuaHBTeX.** The engine host runs LuaHBTeX in ini mode only (`src/engine-host/engine/worker.ts`). liveMd2Tex
  offers no LuaLaTeX.
- **luaffi.** TeX Live's copy, at commit f26cc5ed05a1f784d1e694fe5b9cfc3ce992c03d, is Facebook's luaffifb. Its
  `LICENSE` is "BSD License For luaffifb software, Copyright (c) 2015, Facebook, Inc.", which contains James R.
  McKaskill's luaffi under the MIT licence ("Copyright (c) 2011 James R. McKaskill"). Its `PATENTS` file is
  Facebook's "Additional Grant of Patent Rights Version 2": a patent licence for the software, which ends for
  anyone who brings a patent assertion against Facebook, as the file words it. Both ship
  (`luaffi-LICENSE.txt`, `luaffi-PATENTS.txt`). Facebook's own repository, now archived at
  https://github.com/facebookarchive/luaffifb (master a1cb731b08c91643b0665935eb5622b3d621211b), still has both
  files, the same bytes, last changed on 2015-09-16. In this build, the only code from luaffi's files in
  `busytex.wasm` is TeX Live's stub `luaopen_ffi` (above); luaffifb's own code is in the source archive that each
  release carries, not in the binary. Open: whether the patent grant raises a question for the GPL-3 and AGPL-3
  parts. The FSF's licence list (https://www.gnu.org/licenses/license-list.html, as archived on 2026-10-17) has no
  entry for this grant. Its nearest entry is WebM's, a Modified BSD licence with a separate patent grant, which it
  calls GPL-compatible. The two grants end differently. WebM's ends for patent litigation "alleging that any of
  these implementations of WebM or any code incorporated within any of these implementations of WebM" infringes
  (https://www.webmproject.org/license/additional/). Facebook's ends for any patent assertion against Facebook or
  its affiliates, for any arising from Facebook's software, products or services, and for any relating to
  luaffifb, as `PATENTS` words it. LuaTeX, which is
  GPL-2.0-or-later, ships this code in TeX Live. This is recorded for the maintainer to decide.
- **FreeType** is dual-licensed: the FreeType License (FTL) or GPL-2.0-or-later. The FTL does not combine with the
  GPL, and the engine holds GPL code, so FreeType is taken here under its GPL option. Its credit, as the FTL words
  it, is kept anyway: Portions of this software are copyright © 2025 The FreeType Project (https://freetype.org).
  All rights reserved. Its BDF and PCF drivers and its hash code are under their own MIT and X11 terms (above).
- **libpaper** is GPL-2.0-only, which does not combine with the AGPL-3.0 parts. It is on TeXlyre's link line, but
  none of its code is in this build: the WebAssembly holds neither its environment variable (`PAPERCONF`) nor its
  file (`/etc/papersize`). `scripts/vsix-scan.mjs` fails a package whose engine holds either, so a new engine build
  that brings it in is caught.
- **pplib** (Paweł Jackowski). Its own files state no licence; it is recorded as shipped as part of LuaTeX, under
  LuaTeX's terms (GPL-2.0-or-later). Two of its files state their authors' terms, and their notices ship:
  `util/utilsha.c` (BSD-3-Clause) and `util/utilmd5.c` (Zlib-style). Debian records pplib as GPL-2+, and Fedora
  covers it inside its LuaTeX packages as GPL-2.0-or-later.
- **MetaPost's decNumber.** Its files say "This software is made available under the terms of the ICU License --
  ICU 1.8.1 and later". That licence's text is in `dist/licenses/ICU.txt` ("ICU License - ICU 1.8.1 to ICU 57.1"),
  and decNumber's own copyright lines are in `dist/licenses/engine/MetaPost-decNumber-notice.txt`.
- **MakeIndex.** Its notice asks that "the entire modified work must be covered by a permission notice identical
  to this permission notice", and it counts anything "usable only in conjunction with" a derived program as a
  modified version. TeXlyre links MakeIndex into the same binary as GPL and AGPL code. Open: ask TeXlyre or TUG
  for a reading of this before the first release. The notice is in full at the end of this file.
- **MiniLZ4**, Emscripten's LZ4 decoder inside `busytex.js` (Copyright (c) 2012 Pierre Curto, MIT), keeps its
  notice in that file.

### The engine's source

The engine's corresponding source is the following, as TeXlyre's Makefile (`URL_texlive`, `URL_expat`,
`URL_fontconfig`, lines 8, 12 and 13), its `versions.txt` and its workflow `build-wasm.yml` name it. Each SHA-256
is that of the archive as downloaded on 2026-10-26.

| What | Archive | SHA-256 |
|---|---|---|
| TeXlyre's build scripts and C files at commit 46ebb6216a5c1fe63dd1dc885831d1a8cef2dc86 | https://github.com/TeXlyre/texlyre-busytex-build/archive/46ebb6216a5c1fe63dd1dc885831d1a8cef2dc86.tar.gz | `b5356166679565d3f7dc00710cd37c687e1bbe886debbceb9ca30237fa86f8d4` |
| TeX Live's source tree at commit f26cc5ed05a1f784d1e694fe5b9cfc3ce992c03d, the head of branch tags/texlive-2026.0, which TeXlyre's Makefile fetches | https://github.com/TeX-Live/texlive-source/archive/f26cc5ed05a1f784d1e694fe5b9cfc3ce992c03d.tar.gz | `34d0a84101893a26bf1a2805e7b545b40faa3da3c84b5ac6d15f35fb707ca697` |
| Expat 2.5.0 | https://github.com/libexpat/libexpat/releases/download/R_2_5_0/expat-2.5.0.tar.gz | `6b902ab103843592be5e99504f846ec109c1abb692e85347587f237a4ffa1033` |
| fontconfig 2.13.96, as TeXlyre hosts it | https://github.com/TeXlyre/texlyre-busytex-build/releases/download/fontconfig-2.13.96/fontconfig-2.13.96.tar.gz | `dbabc038d41cfc3f14da1b173ae103ba7cc678efb17e091b9e801c6286b3f684` |

- TeXlyre's release of the binaries is `build_wasm_46ebb6216a5c1fe63dd1dc885831d1a8cef2dc86_31802832436_1`
  (https://github.com/TeXlyre/texlyre-busytex-build/releases), built from commit
  46ebb6216a5c1fe63dd1dc885831d1a8cef2dc86, whose tree is
  https://github.com/TeXlyre/texlyre-busytex-build/tree/46ebb6216a5c1fe63dd1dc885831d1a8cef2dc86.
- TeXlyre's Makefile fetches TeX Live's source from the branch `tags/texlive-2026.0` of TeX Live's source mirror.
  The archive above is the branch's head, commit f26cc5ed05a1f784d1e694fe5b9cfc3ce992c03d, taken by its commit
  because a branch can move. Its tree: https://github.com/TeX-Live/texlive-source/tree/f26cc5ed05a1f784d1e694fe5b9cfc3ce992c03d,
  a copy of TeX Live's Subversion repository (https://tug.org/texlive/svn/).
- The compiler is Emscripten 5.0.4 (https://github.com/emscripten-core/emscripten/tree/5.0.4), whose system
  libraries (musl, libc++, libc++abi, compiler-rt) are compiled into the engine under their permissive licences.
  It has a tree link here, not an archive with a SHA-256.
- Our patches to the glue are `engine/patches/` at the release's tag (above).

Each release of liveMd2Tex that ships the engine carries a copy of the four archives, attached before the release
is published (`.github/workflows/release-sources.yml`, run on the draft release). The workflow downloads them,
checks each one's bytes against the SHA-256 above, checks the files of the two archives GitHub makes from a commit
against that commit's tree, and checks TeXlyre's Makefile against the manifest. It then attaches them as
`engine-sources-v<version>.tar`, with their list in `sources.json`. So the source stays available from
liveMd2Tex's own releases, as GPL-3 and AGPL-3 section 6(d) ask; every GPL part of the engine is under "version 2
or later", or GPL-2 or GPL-3 (xpdf), so section 6(d) of version 3 applies. GitHub makes the two `archive/` files
on request, and it promises the same files for a commit, not the same bytes. If one comes back with other bytes
but the commit's files, the workflow attaches it with its new SHA-256 and says so; if its files differ, the
workflow stops.

## In the test copy

`node scripts/vsix-scan.mjs --test-copy` builds the development machine's test copy: the package with the engine,
plus TeXlyre's interim TeX image and the DejaVu fonts in `dist/data/`, for a throwaway VS Code profile only. The
store packages get these files from the data packages instead.

| Part | Version | Licence | Where in the test copy | Source |
|---|---|---|---|---|
| TeX Live macro packages, classes and fonts in TeXlyre's `texlive-extra` image, unchanged | TeX Live 2026 | LPPL 1.3c and others, package by package (`dist/data/licenses/`: TeX Live's `LICENSE.TL`, `LICENSE.CTAN` and `lppl.tex`; `dist/licenses/LPPL-1.3c.txt`); B1's licence scan lists each package | `dist/data/texlive-extra.data` | https://ctan.org, https://tug.org/texlive/ |
| DejaVu fonts (Sans, Serif, Sans Mono; 12 TrueType files) | 2.34 | Bitstream Vera licence with DejaVu's changes; public domain for the changes (`dist/data/fonts/LICENSE`) | `dist/data/fonts/` | https://dejavu-fonts.github.io, https://ctan.org/pkg/dejavu |

## The data packages (core-data, extra-data; B1, prepared, not yet built)

TeX Live's packages, classes and fonts in the data packages are unchanged as TeX reads them. core-data stores
most of its Type 1 fonts with their encryption removed, and the engine host restores each one to the original
bytes, checked against its SHA-256, before TeX reads it; the package's `LICENSE.txt` says so and quotes the LPPL's
clause 9. Which fonts are stored so is decided font by font, by each font's own header: fonts under the SIL OFL,
IBM's Courier fonts and fonts with no clear terms are stored as they are, and so are all fonts of amsfonts,
inconsolata, rsfs and newtx (`engine/bundle-sets.json`, `t1cSkip`). courier's `LICENSES` folder holds IBM's
notice, as its fonts state it, and IBM's terms as X.Org ships them.

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
  GUST font manifests, Apache-2.0 `NOTICE` files and statements of terms from its archives. core-data also ships
  ICU's licence for the ICU data file it takes from the engine build.
- **Changes to GPL fonts.** core-data's `LICENSES/CHANGES-GPL` lists each packed font under the GPL: its path,
  its original's SHA-256, the snapshot archive that holds the original unmodified, what was done and the date, as
  the GPL asks of a changed file.
- **Where the sources are.** CTAN keeps only each package's newest version. So each data package's `LICENSE.txt`
  names the pinned TeX Live snapshot (https://texlive.info/tlnet-archive/2026/10/15/tlnet/), which keeps every
  package as shipped: `archive/<package>.tar.xz`, and its `.source.tar.xz` and `.doc.tar.xz` where it has them.
  For each package under the GPL, LGPL or AGPL, and each package with a packed GPL font, `data/licences.json`
  lists those archives with their URLs and the SHA-512 of TeX Live's package database. The release of a data
  package carries a copy of each (`.github/workflows/release-sources.yml`, as `<set>-sources-<tag>.tar`).

## Added later (planned; not in the package yet)

| Part | Milestone | Licence (docs/DESIGN.md#store-and-packaging) |
|---|---|---|
| KaTeX, jsdiff | M1 and later | MIT, BSD-3-Clause |
| zeroperl, latexdiff (v1.1) | v1.1 | MIT, Apache-2.0, GPL-3.0-or-later |

## Test copies only (not in the store package)

The test copy (`node scripts/vsix-scan.mjs --test-copy`) also carries TeXlyre's interim TeX image, unchanged, with
the rows above, and two files derived from that image's own file list and package files:
`dist/data/texlive-extra.index.json` and `dist/data/packages.json` (which package each file name belongs to, and
which files each package loads; docs/DESIGN.md#architecture, #engine-and-data). Two CTAN packages are used only by
tests and by the stand-in for the Extra Packages add-on, `out/vsix/livemd2tex-extra-data-0.0.1-standin.vsix`,
which is never published:

| Part | Version | Licence | Used for | Source |
|---|---|---|---|---|
| REVTeX (class, `.rtx` options, helper `.sty` files, `.bst` styles), unchanged from `revtex.tds.zip` | 4.2f | LPPL 1.3c | the stand-in add-on; the corpus document P2 | https://ctan.org/pkg/revtex |
| tensor (`tensor.dtx`, `tensor.ins`), built by docstrip in a test | 2.2 (2023/07/18) | LPPL 1.3c or later | the `.dtx` and `.ins` test of "Add a package from a file" | https://ctan.org/pkg/tensor |

Packages a user adds with "Add a package from a file" stay on the user's computer, under VS Code's global storage
for this extension (or in the project folder); the extension never distributes them.

## Code that follows other projects' code

- The engine host runs the TeX tools one after another in one WebAssembly instance, the way BusyTeX's
  `busytex_pipeline.js` does (Vadim Kantorov, MIT; https://github.com/busytex/busytex): after each tool, the
  memory is cleared and its first 64 MiB restored (`src/engine-host/engine/worker.ts`, which credits it). The code
  is a short idiom, written anew; BusyTeX's MIT notice ships as
  `dist/licenses/engine/BusyTeX-README-License.txt` with `dist/licenses/MIT.txt`.

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

## Test data from other projects (never shipped)

| Part | Version | Licence | Used for | Source |
|---|---|---|---|---|
| LaTeX Workshop (James-Yu.latex-workshop): its keybindings, PDF custom editor and auto-build setting, copied as data from its `package.json` into `test/unit/fixtures/latex-workshop-10.19.0.json`; no code | 10.19.0 | MIT; Copyright (c) 2016 James Yu (the licence in full: `test/unit/fixtures/latex-workshop-LICENSE.txt`) | the coexistence tests (M2-B) | https://github.com/James-Yu/LaTeX-Workshop |

`scripts/run-integration.mjs --with-latex-workshop` installs LaTeX Workshop's VSIX (pinned by SHA-256, a
development-only download kept outside the repository) into a throwaway test profile, and nowhere else.

## MakeIndex's notice

The engine contains MakeIndex in executable form. Its notice asks that such a copy carry the notice and say how to
get the source. The engine is TeXlyre's build 46ebb62, which compiles TeX Live's source tree at tag texlive-2026.0
(its Makefile's `URL_texlive`). MakeIndex's source is in that tree, in `texk/makeindexk`:
https://github.com/TeX-Live/texlive-source/tree/tags/texlive-2026.0/texk/makeindexk (a copy of TeX Live's
Subversion repository, https://tug.org/texlive/svn/), and in the TeX Live source archive that each release
carries ("The engine's source"). The notice, as `texk/makeindexk/COPYING` gives it (also
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
