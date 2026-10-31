// The engine build's own tools (engine/build/tools; docs/DEVELOPING.md, "The TeX engine: our own build"), on made-up llvm-nm listings, link traces and link maps:
// the rename and shared lists, the library clashes, the deny list, the libpaper strings, the link map's parts and
// the musl notices.

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { importScript, root } from '../support/helpers';

type Data = unknown;
interface RenameList {
  fromTexts(t: { progs?: Record<string, string>; libsDef?: Record<string, string>; libsUndef?: Record<string, string> }): Data;
  computeCandidates(d: Data): { clashes: { name: string }[]; traced: string[] };
  computeLists(d: Data, traced: string[], libraryFiles: string[], trace: string): { stops: string[]; result?: { shared: { name: string }[]; renamed: Record<string, string[]>; xetexKeepsUnlinked: { name: string }[] }; headerTexts?: Record<string, string> };
  computeVerify(d: Data, result: unknown): { failures: string[]; libraryClashes: { name: string; members: { archive: string; member: string }[] }[] };
}
interface WasmInspect {
  deniedImport(name: string): boolean;
  stringChecks(wasm: Buffer, glue?: string | null): { text: string; inWasm: boolean }[];
  requiredStrings(wasm: Buffer): { text: string; inWasm: boolean }[];
}
interface LinkReport {
  partOf(rel: string): string | null;
  mapCheck(map: string, root: string, lists?: unknown, clashes?: unknown[]): { parts: Record<string, number>; unmapped: string[]; staticEnd: number; failures: string[]; pass: boolean; libraryClashes: { loaded: string[] }[] };
  fileNotice(text: string): { text: string } | null;
  normalizeNotice(text: string): string;
  LINK_PARTS: Record<string, string[]>;
}

const R = '/r';
const W2C = `${R}/wasm/texk/web2c`;
const LIB = `${W2C}/lib/lib.a`;
const PPLIB = `${R}/wasm/libs/pplib/libpplib.a`;

/** A minimal set of listings: four programs, web2c's lib.a and pplib. */
function listings(extra: { progs?: Record<string, string[]>; lib?: string[]; libUndef?: string[]; pplib?: string[] } = {}) {
  const prog = (p: string, lines: string[]) => [`${W2C}/${p}-${p}0.o: 00000010 T ${p}_own`, ...lines].join('\n');
  return {
    progs: {
      pdftex: prog('pdftex', extra.progs?.pdftex ?? []),
      xetex: prog('xetex', extra.progs?.xetex ?? []),
      xdvipdfmx: prog('xdvipdfmx', extra.progs?.xdvipdfmx ?? []),
      bibtex8: prog('bibtex8', extra.progs?.bibtex8 ?? []),
    },
    libsDef: { 'wasm-texk-web2c-lib-lib': (extra.lib ?? []).join('\n'), 'wasm-libs-pplib-libpplib': (extra.pplib ?? []).join('\n') },
    libsUndef: { 'wasm-texk-web2c-lib-lib': (extra.libUndef ?? []).join('\n') },
  };
}

interface Face {
  file: string;
  index: number;
  family: string[];
  style: string[];
  full: string[];
  postscript: string | null;
}
interface Rule {
  name: string;
  first: string;
}
interface FontList {
  orderFaces(faces: Face[], rules?: Rule[]): { faces: Face[]; collisions: { name: string; rule: Rule | null }[]; unmetRules: Rule[]; staleRules: Rule[] };
  joinSets(sets: { name: string; faces: Face[] }[], rules?: Rule[]): { faces: Face[]; crossSet: { name: string; firstSet: string; otherSet: string }[]; unmetRules: Rule[]; staleRules: (Rule & { why: string })[] };
}

const face = (file: string, family: string, style = 'Regular', ps: string | null = null): Face => ({ file, index: 0, family: [family], style: [style], full: [`${family} ${style}`], postscript: ps });

describe('the engine build tools (engine/build/tools)', () => {
  let rl: RenameList;
  let wi: WasmInspect;
  let lr: LinkReport;
  let fl: FontList;
  before(async () => {
    rl = await importScript<RenameList>('engine/build/tools/rename-list.mjs');
    wi = await importScript<WasmInspect>('engine/build/tools/wasm-inspect.mjs');
    lr = await importScript<LinkReport>('engine/build/tools/link-report.mjs');
    fl = await importScript<FontList>('scripts/lib/font-list.mjs');
  });

  describe('the manifest writer\'s check for the build machine\'s paths and names (write-manifest.mjs)', () => {
    type Leaks = (text: string, o: { repo: string; home: string; user: string }) => { what: string }[];
    let leaks: Leaks;
    before(async () => {
      leaks = (await importScript<{ manifestLeaks: Leaks }>('engine/build/tools/write-manifest.mjs')).manifestLeaks;
    });
    const manifest = (inside: string) => `{\n "toolchain": {\n  "runnerImage": { "os": "ubuntu26", "version": "20261026.180.1" }\n },\n "flags": ["-ffile-prefix-map=${inside}=/src"]\n}\n`;

    it('passes a manifest on GitHub\'s runner (user "runner", key "runnerImage") and under WSL', () => {
      assert.deepEqual(leaks(manifest('<root>'), { repo: '/home/runner/work/liveMd2Tex/liveMd2Tex', home: '/home/runner', user: 'runner' }), []);
      assert.deepEqual(leaks(manifest('<root>'), { repo: '/home/someone/engine-src', home: '/home/someone', user: 'someone' }), []);
    });

    it('refuses a path of the build machine, and the user name as a path element anywhere', () => {
      const on = { repo: '/home/runner/work/liveMd2Tex/liveMd2Tex', home: '/home/runner', user: 'runner' };
      assert.deepEqual(leaks(manifest('/home/runner/work/_temp/engine-build'), on).map((l) => l.what), ['the home folder', 'a path under /home/', 'the user name in a path']);
      assert.deepEqual(leaks(manifest('/srv/runner/build'), on).map((l) => l.what), ['the user name in a path']);
      assert.deepEqual(leaks(manifest('/srv/runners/build'), on), []);
      assert.deepEqual(leaks(manifest('/mnt/c/x'), on).map((l) => l.what), ['a path under /mnt/']);
    });
  });

  describe('the font list\'s order and its fontOrder rules (scripts/lib/font-list.mjs)', () => {
    it('writes axis values as FreeType does in a variation\'s PostScript name (sfdriver.c, fixed2float)', () => {
      const f = (fl as unknown as { fixed2float(x: number): string }).fixed2float;
      assert.deepEqual([300, 87.5, 112.5, 0.5, -2].map((x) => f(x * 65536)), ['300', '87.5', '112.5', '.5', '-2']);
      assert.equal(f(0), '0');
      assert.equal(f(1), '.00002');
      assert.equal(f(65535), '.99998');
    });

    it('applies a rule, and reports a collision without a rule, an unmet rule and a rule that decides nothing', () => {
      const faces = [face('/f/a.otf', 'Sans', 'Regular', 'Sans-A'), face('/f/b.otf', 'Sans', 'Regular', 'Sans-B'), face('/f/c.otf', 'Solo')];
      const plain = fl.orderFaces(faces);
      assert.deepEqual(plain.faces.map((f) => f.file), ['/f/a.otf', '/f/b.otf', '/f/c.otf']);
      assert.ok(plain.collisions.some((c) => c.name === 'Sans Regular' && c.rule === null));
      const ruled = fl.orderFaces(faces, [{ name: 'Sans Regular', first: '/f/b.otf' }]);
      assert.deepEqual(ruled.faces.map((f) => f.file), ['/f/b.otf', '/f/a.otf', '/f/c.otf']);
      assert.deepEqual(ruled.unmetRules, []);
      assert.deepEqual(ruled.staleRules, []);
      // Two rules that pull the same name two ways: the later one wins, so the earlier no longer holds.
      const both = fl.orderFaces(faces, [{ name: 'Sans Regular', first: '/f/b.otf' }, { name: 'Sans Regular', first: '/f/a.otf' }]);
      assert.deepEqual(both.unmetRules.map((r) => r.first), ['/f/b.otf']);
      // A rule whose file lacks the name, and one for a name only one file has.
      const stale = fl.orderFaces(faces, [{ name: 'Serif Regular', first: '/f/a.otf' }, { name: 'Solo Regular', first: '/f/c.otf' }]);
      assert.deepEqual(stale.staleRules.map((r) => r.name), ['Serif Regular', 'Solo Regular']);
    });

    it('joins the sets in mount order, core first, applies each rule within its set, and reports a name two sets share', () => {
      const core = [face('/texlive/x/b.otf', 'Book'), face('/texlive/x/a.otf', 'Book')];
      const extra = [face('/texmf-extra/y/z.otf', 'Zed'), face('/texmf-extra/y/m.otf', 'Book')];
      const j = fl.joinSets([{ name: 'core', faces: core }, { name: 'extra', faces: extra }], [{ name: 'Book Regular', first: '/texlive/x/b.otf' }]);
      assert.deepEqual(j.faces.map((f) => f.file), ['/texlive/x/b.otf', '/texlive/x/a.otf', '/texmf-extra/y/m.otf', '/texmf-extra/y/z.otf']);
      assert.ok(j.crossSet.some((c) => c.name === 'Book Regular' && c.firstSet === 'core' && c.otherSet === 'extra'), JSON.stringify(j.crossSet));
      assert.deepEqual(j.unmetRules, []);
      // A rule cannot pull an add-on face ahead of the core: it belongs to the add-on set, where it decides nothing.
      const pull = fl.joinSets([{ name: 'core', faces: core }, { name: 'extra', faces: extra }], [{ name: 'Book Regular', first: '/texmf-extra/y/m.otf' }]);
      assert.equal(pull.faces[0].file, '/texlive/x/a.otf');
      assert.deepEqual(pull.staleRules.map((r) => r.why), ['no other file has the name']);
      const stray = fl.joinSets([{ name: 'core', faces: core }], [{ name: 'Book Regular', first: '/elsewhere.otf' }]);
      assert.deepEqual(stray.staleRules.map((r) => r.why), ['no set holds its file']);
    });
  });

  describe('the rename and shared lists (rename-list.mjs)', () => {
    it('shares a data clash that a loaded library member reads, and renames the other programs\' clashes', () => {
      const data = rl.fromTexts(
        listings({
          progs: {
            pdftex: [`${W2C}/pdftexdir/pdftex-pdftexextra.o: 00000004 D nameoffile`, `${W2C}/pdftex-pdftex0.o: 00000008 T mainbody`],
            xetex: [`${W2C}/xetexdir/xetex-xetexextra.o: 00000004 D nameoffile`, `${W2C}/xetex-xetex0.o: 00000008 T mainbody`],
          },
          libUndef: [`${LIB}:openclose.o:          U nameoffile`, `${LIB}:main.o:          U mainbody`],
        }),
      );
      const c = rl.computeCandidates(data);
      assert.deepEqual(c.traced.sort(), ['mainbody', 'nameoffile']);
      // main.o (which reads mainbody) is never loaded; openclose.o is.
      const trace = [`${LIB}(openclose.o): reference to nameoffile`, `${W2C}/xetexdir/xetex-xetexextra.o: definition of nameoffile`, `${LIB}: lazy definition of mainbody`].join('\n');
      const r = rl.computeLists(data, c.traced, [LIB, PPLIB], trace);
      assert.deepEqual(r.stops, []);
      assert.deepEqual(r.result?.shared.map((s) => s.name), ['nameoffile']);
      assert.deepEqual(r.result?.renamed.pdftex, ['mainbody']);
      assert.deepEqual(r.result?.renamed.xetex, []);
      assert.match(r.headerTexts?.pdftex ?? '', /^#define mainbody pdftex_mainbody$/m);
    });

    it('stops on a function two programs define that a loaded library member calls', () => {
      const data = rl.fromTexts(
        listings({
          progs: { pdftex: [`${W2C}/pdftex-pdftex0.o: 00000008 T readline`], xetex: [`${W2C}/xetex-xetex0.o: 00000008 T readline`] },
          libUndef: [`${LIB}:texmfmp.o:          U readline`],
        }),
      );
      const c = rl.computeCandidates(data);
      const r = rl.computeLists(data, c.traced, [LIB], `${LIB}(texmfmp.o): reference to readline`);
      assert.equal(r.stops.length, 1);
      assert.match(r.stops[0], /^readline: a function/);
    });

    it('stops when XeTeX and a loaded library member define one name, and keeps XeTeX\'s when the member is not loaded', () => {
      const data = rl.fromTexts(
        listings({
          progs: { xetex: [`${W2C}/xetex-xetexini.o: 00000004 D argv`] },
          lib: [`${LIB}:main.o: 00000004 D argv`],
        }),
      );
      const c = rl.computeCandidates(data);
      assert.deepEqual(c.traced, ['argv']);
      const loaded = rl.computeLists(data, c.traced, [LIB], `${LIB}(main.o): definition of argv`);
      assert.equal(loaded.stops.length, 1);
      assert.match(loaded.stops[0], /^argv: XeTeX and the linked library members/);
      const unloaded = rl.computeLists(data, c.traced, [LIB], `${LIB}: lazy definition of argv\n${W2C}/xetex-xetexini.o: definition of argv`);
      assert.deepEqual(unloaded.stops, []);
      assert.deepEqual(unloaded.result?.xetexKeepsUnlinked.map((x) => x.name), ['argv']);
    });

    it('stops when the trial link printed no trace line', () => {
      const data = rl.fromTexts(listings({ progs: { pdftex: [`${W2C}/a.o: 00000004 D x`], xetex: [`${W2C}/b.o: 00000004 D x`] }, libUndef: [`${LIB}:c.o:          U x`] }));
      const r = rl.computeLists(data, ['x'], [LIB], 'wasm-ld: error: something else');
      assert.match(r.stops[0], /no --trace-symbol line/);
    });

    it('reports a strong name two libraries define (weak ones never clash), and the check after the recompile', () => {
      const data = rl.fromTexts(
        listings({
          lib: [`${LIB}:main.o: 00000010 T __main_argc_argv`, `${LIB}:inline.o: 00000010 W shared_inline`],
          pplib: [`${PPLIB}:pptest1.o: 00000010 T __main_argc_argv`, `${PPLIB}:inline.o: 00000010 W shared_inline`],
        }),
      );
      const v = rl.computeVerify(data, { shared: [], xetexKeepsUnlinked: [] });
      assert.deepEqual(v.failures, []);
      assert.deepEqual(v.libraryClashes, [{ name: '__main_argc_argv', members: [{ archive: LIB, member: 'main.o' }, { archive: PPLIB, member: 'pptest1.o' }] }]);
      // A clash left after the recompile fails.
      const left = rl.fromTexts(listings({ progs: { pdftex: [`${W2C}/a.o: 00000004 D y`], bibtex8: [`${R}/wasm/texk/bibtex-x/b.o: 00000004 D y`] } }));
      assert.equal(rl.computeVerify(left, { shared: [] }).failures.length, 1);
    });
  });

  describe('the deny list and the strings (wasm-inspect.mjs)', () => {
    it('denies Emscripten 6.0.13\'s shell, script, loading, wget, fetch, socket and name entry points, in any spelling', () => {
      for (const n of [
        '__emscripten_system', '_emscripten_run_script', '_emscripten_async_load_script', '__dlopen_js', '__dlsym_catchup_js',
        '_emscripten_wget', '_emscripten_wget_data', '_emscripten_start_fetch', '__wasmfs_create_fetch_backend_js',
        '_emscripten_websocket_new', '___syscall_socket', '___syscall_connect', '___syscall_accept4', '_getaddrinfo', '_getnameinfo',
      ]) {
        assert.ok(wi.deniedImport(n), n);
      }
    });

    it('denies none of the shipped engine\'s 46 imports', () => {
      const shipped = '___assert_fail _exit invoke_iii invoke_iiii invoke_iiiii invoke_v ___syscall_fcntl64 invoke_vii _fd_close invoke_viii invoke_vi _fd_write invoke_i invoke_ii _fd_read ___syscall_openat _emscripten_date_now ___cxa_throw __emscripten_throw_longjmp _emscripten_resize_heap _emscripten_get_heap_max ___syscall_renameat ___syscall_rmdir ___syscall_unlinkat ___syscall_readlinkat ___syscall_getdents64 ___syscall_pipe2 __mmap_js __munmap_js __gmtime_js __localtime_js _clock_time_get _fd_seek ___syscall_getuid32 _environ_get _environ_sizes_get ___syscall_getcwd ___syscall_lstat64 ___syscall_newfstatat ___syscall_stat64 ___syscall_ioctl ___syscall_dup ___syscall_faccessat __abort_js _proc_exit __tzset_js'.split(' ');
      assert.equal(shipped.length, 46);
      assert.deepEqual(shipped.filter((n) => wi.deniedImport(n)), []);
    });

    it('finds libpaper by its paper table and PAPERSIZE (whole), and requires dvipdfmx\'s isob3 to isob6', () => {
      const z = '\0';
      const withLibpaper = Buffer.from(`${z}a4${z}halfexecutive${z}csheet${z}flse${z}PAPERSIZE${z}`, 'latin1');
      const own = Buffer.from(`${z}a4${z}isob3${z}isob4${z}isob5${z}isob6${z}MYPAPERSIZEX${z}flsex${z}`, 'latin1');
      const found = (b: Buffer) => wi.stringChecks(b).filter((s) => s.inWasm).map((s) => s.text);
      assert.deepEqual(found(withLibpaper), ['halfexecutive', 'csheet', 'flse', 'PAPERSIZE']);
      assert.deepEqual(found(own), []);
      assert.deepEqual(wi.requiredStrings(withLibpaper).filter((s) => !s.inWasm).map((s) => s.text), ['isob3', 'isob4', 'isob5', 'isob6']);
      assert.deepEqual(wi.requiredStrings(own).filter((s) => !s.inWasm), []);
    });
  });

  describe('the link map (link-report.mjs)', () => {
    const line = (addr: number, size: number, text: string) => `${addr.toString(16).padStart(8)} ${'0'.padStart(8)} ${size.toString(16).padStart(8)}         ${text}`;
    const sys = `${R}/emsdk/upstream/emscripten/cache/sysroot/lib/wasm32-emscripten`;
    const everyPart = Object.values({
      pdftex: `${W2C}/pdftex-pdftex0.o`, xetex: `${W2C}/libxetex.a(XeTeXOTMath.o)`, web2c: `${LIB}(openclose.o)`, libmd5: `${W2C}/libmd5.a(md5.o)`,
      synctex: `${W2C}/synctexdir/xetex-synctex.o`, bibtex8: `${R}/wasm/texk/bibtex-x/bibtex8-bibtex.o`, xdvipdfmx: `${R}/wasm/texk/dvipdfm-x/dvi.o`,
      kpathsea: `${R}/wasm/texk/kpathsea/.libs/libkpathsea.a(tex-file.o)`, harfbuzz: `${R}/wasm/libs/harfbuzz/libharfbuzz.a(harfbuzz.o)`,
      graphite2: `${R}/wasm/libs/graphite2/libgraphite2.a(Face.o)`, teckit: `${R}/wasm/libs/teckit/libTECkit.a(Engine.o)`,
      freetype: `${R}/wasm/libs/freetype2/libfreetype.a(ftbase.o)`, libpng: `${R}/wasm/libs/libpng/libpng.a(png.o)`, zlib: `${R}/wasm/libs/zlib/libz.a(inflate.o)`,
      pplib: `${PPLIB}(pparray.o)`, xpdf: `${R}/wasm/libs/xpdf/libxpdf.a(Object.o)`, icu: `${R}/wasm/libs/icu/icu-build/lib/libicudata.a(icudt78l_dat.o)`,
      musl: `${sys}/libc.a(qsort.o)`, emscripten: `${sys}/libdlmalloc.a(dlmalloc.o)`, llvm: `${sys}/libclang_rt.builtins.a(ashldi3.o)`, livemd2tex: `${R}/link/stubs.o`,
    });
    const map = (inputs: string[], extra: string[] = []) =>
      [
        '    Addr      Off     Size Out     In      Symbol',
        line(0x800000, 0x100, '.rodata'),
        ...inputs.map((f) => line(0x800000, 4, `${f}:(.rodata.x)`)),
        line(0x900000, 0x10, '.data'),
        line(0x900010, 0x2000, '.bss'),
        line(0x900010, 4, `${W2C}/xetexdir/xetex-xetexextra.o:(.bss.nameoffile)`),
        ...extra,
      ].join('\n');

    it('maps every input to its part, counts each part and reads the static end, .bss included', () => {
      const r = lr.mapCheck(map(everyPart), R, { shared: [{ name: 'nameoffile' }] });
      assert.deepEqual(r.failures, []);
      assert.equal(r.staticEnd, 0x900010 + 0x2000);
      assert.equal(r.parts.xetex, 2);
      assert.equal(r.parts.musl, 1);
    });

    it('fails on an input no part claims, on a dropped part, and on a shared name outside .bss', () => {
      const r = lr.mapCheck(map([...everyPart, `${R}/wasm/libs/gmp/libgmp.a(add.o)`, `${R}/wasm/libs/libpaper/libpaper.a(paper.o)`]), R, { shared: [{ name: 'nameoffile' }, { name: 'namelength' }] });
      assert.ok(r.failures.some((f) => f.startsWith('<root>/wasm/libs/gmp/libgmp.a(add.o): no part')), r.failures.join('\n'));
      assert.ok(r.failures.some((f) => /libpaper\.a\(paper\.o\): belongs to a dropped part/.test(f)), r.failures.join('\n'));
      assert.ok(r.failures.some((f) => /^shared namelength: 0 definitions/.test(f)), r.failures.join('\n'));
      const data = lr.mapCheck(map(everyPart, [line(0x900000, 4, `${W2C}/xetexdir/xetex-xetexextra.o:(.data.namelength)`)]), R, { shared: [{ name: 'namelength' }] });
      assert.ok(data.failures.some((f) => /namelength: defined in \.data/.test(f)), data.failures.join('\n'));
    });

    it('says which member of a library clash the link loaded, and fails when it loaded two', () => {
      const clash = { name: '__main_argc_argv', members: [{ archive: LIB, member: 'main.o' }, { archive: PPLIB, member: 'pptest1.o' }] };
      assert.deepEqual(lr.mapCheck(map(everyPart), R, null, [clash]).libraryClashes[0].loaded, []);
      const both = lr.mapCheck(map([...everyPart, `${LIB}(main.o)`, `${PPLIB}(pptest1.o)`]), R, null, [clash]);
      assert.ok(both.failures.some((f) => f.startsWith('__main_argc_argv: defined by the loaded members')), both.failures.join('\n'));
    });

    it('the draft notices (engine/engine-notices.next.json) link each component to exactly its parts of the map, and pin every file', () => {
      const next = JSON.parse(readFileSync(path.join(root, 'engine', 'engine-notices.next.json'), 'utf8')) as {
        components: { id: string; links: string[] }[];
        files: Record<string, { sha256: string; release?: { archive: string; path: string } }>;
      };
      for (const c of next.components) assert.deepEqual(c.links, lr.LINK_PARTS[c.id] ?? [], c.id);
      for (const id of Object.keys(lr.LINK_PARTS)) assert.ok(next.components.some((c) => c.id === id), id);
      for (const [file, f] of Object.entries(next.files)) {
        // A file the release takes from a source archive (musl's COPYRIGHT of 6.0.13) is pinned there.
        if (f.release) continue;
        assert.equal(createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex'), f.sha256, file);
      }
    });

    it('reads a file\'s own notice from its Copyright line, and leaves out the Emscripten Authors\' own', () => {
      const tre = '/*\n  regexec.c - TRE POSIX compatible matching functions.\n\n  Copyright (c) 2001-2009 Ville Laurikari\n  All rights reserved.\n*/\nint x;\n';
      const n = lr.fileNotice(tre);
      assert.equal(n?.text, 'Copyright (c) 2001-2009 Ville Laurikari All rights reserved.');
      assert.equal(lr.fileNotice('/*\n * Copyright 2021 The Emscripten Authors.  All rights reserved.\n */\n'), null);
      assert.equal(lr.fileNotice('/* no notice */\nint y;\n'), null);
      const held = lr.normalizeNotice('Source: x\n\n/*\n  regcomp.c - TRE\n\n  Copyright (c) 2001-2009 Ville Laurikari\n  All rights reserved.\n*/\n');
      assert.ok(held.includes(n?.text ?? '?'));
    });
  });
});
