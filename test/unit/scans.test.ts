// The VSIX scan, its JavaScript scanner and ZIP reader, and the private-marker scan.

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
import { FAKE_MARKERS, fake, fakeMarkerFolder } from '../support/fakeMarkers';
import { importScript, root, tempFolder } from '../support/helpers';

interface Hit {
  file: string;
  line: number;
  kind: 'module' | 'name' | 'code';
  match: string;
}
interface JsScan {
  scanJavaScript(source: string, file: string): Hit[];
}
interface Finding {
  file: string;
  line: number;
  marker: string;
}
interface MarkerScan {
  loadMarkers(root?: string, env?: Record<string, string>): unknown[];
  scanEncoded(text: string, file: string, values: { id: string; kind: string; value: string }[], rules?: unknown[]): Finding[];
  loadAllowRules(root?: string): unknown[];
  scanText(text: string, file: string, markers: unknown[], rules?: unknown[]): Finding[];
  scanPath(file: string, markers: unknown[]): Finding[];
}
interface AllowEntry {
  file: string;
  line: number;
  match: string;
  text: string;
  reason: string;
}
interface VsixScan {
  FORK_FILE: string;
  scanEntries(
    entries: Map<string, Buffer>,
    allowlist: AllowEntry[],
    markers: unknown[],
    pinned?: Map<string, string>,
    options?: { dataOnly?: boolean; markerValues?: unknown[] },
  ): { failures: string[]; hits: (Hit & { status: string })[] };
  missingNotices(entries: Map<string, Buffer>): string[];
  dataOnlyTexts(entries: Map<string, Buffer>): string[];
  cc0Headers(entries: Map<string, Buffer>): string[];
  engineNoticeFiles(): string[];
  wrongNotices(entries: Map<string, Buffer>): string[];
  pinnedEngine(entries: Map<string, Buffer>, pinsFile?: string, recordFile?: string): string[];
  engineStrings(entries: Map<string, Buffer>): string[];
  engineImports(entries: Map<string, Buffer>, recordFile?: string): Promise<string[]>;
  engineHeader(entries: Map<string, Buffer>, recordFile?: string): string[];
  engineByContent(entries: Map<string, Buffer>): string[];
  noticesForEngine(entries: Map<string, Buffer>, noticesFile?: string, recordFile?: string): string[];
}
interface Zip {
  readZip(zip: Buffer): Map<string, Buffer>;
}

/** Builds a ZIP in memory (stored or deflated entries) for the reader test. */
function makeZip(files: [string, string, boolean][]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text, deflate] of files) {
    const data = Buffer.from(text);
    const body = deflate ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe('JavaScript scanner (scripts/lib/js-scan.mjs)', () => {
  let js: JsScan;
  before(async () => {
    js = await importScript<JsScan>('scripts/lib/js-scan.mjs');
  });

  it('finds every watched module however it is loaded', () => {
    const src = [
      'const a = require("child_process");',
      'import b from "node:net";',
      'const c = await import("https");',
      'const d = process.getBuiltinModule("tls");',
      'const e = require(`dgram`);',
      'export { f } from "ws";',
      'const g = require("node:http2");',
      'const h = "http";',
    ].join('\n');
    const hits = js.scanJavaScript(src, 'x.mjs');
    assert.deepEqual(
      hits.map((h) => `${h.line}:${h.kind}:${h.match}`),
      ['1:module:child_process', '2:module:net', '3:module:https', '4:module:tls', '5:module:dgram', '6:module:ws', '7:module:http2', '8:module:http'],
    );
  });

  it('finds the watched globals, but not property names, methods or comments', () => {
    const src = [
      'fetch(url);',
      'new WebSocket(u);',
      'globalThis.fetch(u);',
      'window["fetch"](u);',
      'new XMLHttpRequest();',
      'navigator.sendBeacon(u, d);',
      'xref.fetch(ref);',
      'class A { fetch() { return 1; } }',
      'const o = { fetch: 1, WebSocket: 2 };',
      '// fetch(url) and require("net") in a comment',
      'const re = /http/;',
      'const s = "child_process_x";',
    ].join('\n');
    const hits = js.scanJavaScript(src, 'x.js');
    assert.deepEqual(
      hits.map((h) => `${h.line}:${h.match}`),
      ['1:fetch', '2:WebSocket', '3:fetch', '4:fetch', '5:XMLHttpRequest', '6:sendBeacon'],
    );
  });

  it('finds dns, inspector, cluster and undici, and code built from text (build gate 1, G1S-07)', () => {
    const src = [
      'const a = require("node:dns");',
      'const b = require("inspector");',
      'const c = require("cluster");',
      'const d = require("undici");',
      'eval(s);',
      'const f = new Function("return 1");',
      'const g = Function("x", "return x");',
      'const w = new Worker("1", { eval: true });',
      'const p = process.binding("fs");',
      'const ok = new Worker(file, { workerData: 1 });',
      'obj.eval(s);',
    ].join('\n');
    const hits = js.scanJavaScript(src, 'x.js');
    assert.deepEqual(
      hits.map((h) => `${h.line}:${h.kind}:${h.match}`),
      ['1:module:dns', '2:module:inspector', '3:module:cluster', '4:module:undici', '5:code:eval', '6:code:Function', '7:code:Function', '8:code:Worker eval', '9:code:process.binding'],
    );
  });

  it('refuses a file it cannot parse', () => {
    assert.throws(() => js.scanJavaScript('function (', 'bad.js'), /does not parse/);
  });
});

describe('ZIP reader (scripts/lib/zip.mjs)', () => {
  it('reads stored and deflated entries and checks their CRC', async () => {
    const { readZip } = await importScript<Zip>('scripts/lib/zip.mjs');
    const zip = makeZip([
      ['a.txt', 'hello', false],
      ['dir/b.js', 'const x = 1;\n'.repeat(100), true],
    ]);
    const entries = readZip(zip);
    assert.deepEqual([...entries.keys()], ['a.txt', 'dir/b.js']);
    assert.equal(entries.get('a.txt')?.toString(), 'hello');
    assert.equal(entries.get('dir/b.js')?.toString(), 'const x = 1;\n'.repeat(100));
    const corrupt = Buffer.from(zip);
    corrupt[35] ^= 0xff; // a byte inside a.txt's data
    assert.throws(() => readZip(corrupt), /CRC/);
  });
});

describe('VSIX scan rules (scripts/vsix-scan.mjs)', () => {
  let vsix: VsixScan;
  let markers: unknown[];
  before(async () => {
    vsix = await importScript<VsixScan>('scripts/vsix-scan.mjs');
    markers = (await importScript<MarkerScan>('scripts/marker-scan.mjs')).loadMarkers(fakeMarkerFolder(), {});
  });
  const fork = 'var cp = require("node:child_process");\n';
  const base = (): Map<string, Buffer> => new Map([['extension/dist/fork.js', Buffer.from(fork)]]);

  it('a data package (M6) needs no fork file and may hold no JavaScript at all', () => {
    const data = new Map([['extension/data/manifest.json', Buffer.from('{}')], ['extension/data/texmf/tex/latex/x/x.sty', Buffer.from('% x')]]);
    assert.deepEqual(vsix.scanEntries(data, [], markers, new Map(), { dataOnly: true }).failures, []);
    data.set('extension/data/helper.js', Buffer.from('var a = 1;\n'));
    const { failures } = vsix.scanEntries(data, [], markers, new Map(), { dataOnly: true });
    assert.ok(failures.some((f) => /JavaScript in a data package/.test(f)));
  });

  it('reads a data image file by file through its index: text files as text, binary files for path-like markers', async () => {
    const { buildDataImage } = await importScript<{ buildDataImage(f: [string, Uint8Array][], o?: { compress?: boolean }): { data: Buffer; index: unknown } }>('scripts/lib/data-image.mjs');
    const pkg = (files: [string, Uint8Array][], compress = true, manifest: Record<string, unknown> = {}) => {
      const image = buildDataImage(files, { compress });
      return new Map<string, Buffer>([
        ['extension/data/manifest.json', Buffer.from(JSON.stringify({ format: 1, image: { file: 'x.data', index: 'x.index.json' }, ...manifest }))],
        ['extension/data/x.data', image.data],
        ['extension/data/x.index.json', Buffer.from(JSON.stringify(image.index))],
      ]);
    };
    const scan = (e: Map<string, Buffer>) => vsix.scanEntries(e, [], markers, new Map(), { dataOnly: true, markerValues: FAKE_MARKERS }).failures;
    const text = (t: string) => Buffer.from(t, 'utf8');
    const surname = fake('surname');
    const userPath = `C:/Users/${fake('laptop-user-path')}/build`;
    assert.deepEqual(scan(pkg([['tex/latex/a/a.sty', text('% a\n')]])), []);
    // A marker in a text file fails, whether its chunk is compressed or not.
    for (const compress of [true, false]) {
      assert.match(scan(pkg([['tex/latex/a/a.sty', text(`%% ${'x'.repeat(40)}\n%% by ${surname}\n`)]], compress)).join('\n'), /x\.data!\/tex\/latex\/a\/a\.sty:2:\d+: private marker \(surname\)/);
    }
    // A text marker inside a font's bytes is chance (a scan of the image's raw bytes would have reported it).
    const font = Buffer.concat([Buffer.from([0, 1, 0, 0]), text(`xx${surname}xx`), Buffer.alloc(64)]);
    const chance = pkg([['fonts/truetype/a/a.ttf', font]], false);
    assert.ok((chance.get('extension/data/x.data') as Buffer).includes(text(surname)), 'the raw image holds the marker');
    assert.deepEqual(scan(chance), []);
    // The laptop's user path fails in a binary file too, and inside a format's gzip compression.
    assert.match(scan(pkg([['fonts/truetype/a/a.ttf', Buffer.concat([font, text(userPath)])]], false)).join('\n'), /a\.ttf:\d+:\d+: private marker \(laptop-user-path\)/);
    assert.match(scan(pkg([['texmf-var/web2c/pdftex/pdflatex.fmt', gzipSync(Buffer.concat([Buffer.alloc(8), text(userPath), Buffer.alloc(8)]))]])).join('\n'), /pdflatex\.fmt:\d+:\d+: private marker \(laptop-user-path\)/);
    // A marker in a file's path fails.
    assert.match(scan(pkg([[`tex/latex/${fake('coauthor-handle')}/a.sty`, text('% a\n')]])).join('\n'), /private marker \(coauthor-handle\)/);
    // In TeX Live's own files (those the manifest's package index lists) the name-like markers (kind "word") are left
    // out: TeX packages hold people's names by coincidence. Every other marker is still searched there, and every
    // marker in a file the builder wrote (not listed), such as ls-R.
    const given = fake('coauthor-given-name');
    const named = text(`% by ${given} and ${surname}\n`);
    const listed = { index: { format: 1, packages: { a: { kind: 'tex', files: ['tex/latex/a/a.sty'] } }, files: {} } };
    const markersIn = (failures: string[]) => failures.map((x) => /private marker \(([^)]+)\)/.exec(x)?.[1]).sort();
    assert.deepEqual(markersIn(scan(pkg([['tex/latex/a/a.sty', named]], true, listed))), ['surname'], "a package's own file: the text marker, not the name");
    // A name in a package's own path is left out in the image; the manifest and the image's index, which the builder
    // wrote, list the path and are searched for every marker.
    const listedNamed = { index: { format: 1, packages: { a: { kind: 'tex', files: [`tex/latex/a/${given}.sty`] } }, files: {} } };
    assert.deepEqual(
      scan(pkg([[`tex/latex/a/${given}.sty`, text('% a\n')]], true, listedNamed)).map((x) => x.split(':')[0]),
      ['extension/data/manifest.json', 'extension/data/x.index.json'],
    );
    assert.deepEqual(markersIn(scan(pkg([['ls-R', named]], true, listed))), ['coauthor-given-name', 'surname'], 'a file the builder wrote: every marker');
    assert.deepEqual(markersIn(scan(pkg([['tex/latex/b/b.sty', named]], true, listed))), ['coauthor-given-name', 'surname'], 'a file no package lists: every marker');
    assert.match(scan(pkg([['tex/latex/a/a.sty', text(`% built in ${userPath}\n`)]], true, listed)).join('\n'), /private marker \(laptop-user-path\)/, "the user path in a package's own file");
    // The core's files are listed under its texmf root.
    const core = { core: { root: '/texlive/texmf-dist' }, index: listed.index };
    assert.deepEqual(markersIn(scan(pkg([['texlive/texmf-dist/tex/latex/a/a.sty', named]], true, core))), ['surname']);
    // The name-like markers in their encoded forms are left out of a package's own file too, and searched elsewhere.
    const b64 = text(`% ${Buffer.from(`${given} wrote this`).toString('base64')}\n`);
    assert.deepEqual(scan(pkg([['tex/latex/a/a.sty', b64]], true, listed)), []);
    assert.ok(scan(pkg([['tex/latex/b/b.sty', b64]], true, listed)).some((x) => /coauthor-given-name/.test(x)));
    // An image its index cannot read fails.
    const broken = pkg([['tex/latex/a/a.sty', text('% a\n')]]);
    broken.set('extension/data/x.index.json', Buffer.from('{}'));
    assert.match(scan(broken).join('\n'), /x\.data: the data image cannot be read through its index/);
  });

  it('allows child_process in the fork file only', () => {
    assert.deepEqual(vsix.scanEntries(base(), [], markers).failures, []);
    const entries = base();
    entries.set('extension/dist/extension.js', Buffer.from(fork));
    const { failures } = vsix.scanEntries(entries, [], markers);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /extension\/dist\/extension\.js:1:.*child_process/);
  });

  it('fails a packaged script that holds the speed probe', () => {
    const entries = base();
    entries.set('extension/dist/engine-worker.js', Buffer.from("var probe = process.env.LIVEMD2TEX_SPEED_PROBE === '1';\n"));
    const { failures } = vsix.scanEntries(entries, [], markers);
    assert.ok(failures.some((f) => /engine-worker\.js: holds the speed probe/.test(f)));
  });

  it('never lets the allow-list allow child_process', () => {
    const entries = base();
    entries.set('extension/x.js', Buffer.from(fork));
    const entry = { file: 'extension/x.js', line: 1, match: 'child_process', text: fork.trim(), reason: 'no' };
    const { failures } = vsix.scanEntries(entries, [entry], markers);
    assert.ok(failures.some((f) => /tries to allow child_process/.test(f)));
    assert.ok(failures.some((f) => /extension\/x\.js:1:/.test(f)));
  });

  it('passes a reviewed hit, fails an unreviewed one, and fails a stale entry', () => {
    const entries = base();
    entries.set('extension/v.js', Buffer.from('const a = 1;\nfetch(u);\n'));
    const entry = { file: 'extension/v.js', line: 2, match: 'fetch', text: 'fetch(u);', reason: 'test' };
    assert.deepEqual(vsix.scanEntries(entries, [entry], markers).failures, []);
    assert.equal(vsix.scanEntries(entries, [], markers).failures.length, 1);
    const moved = { ...entry, line: 1 };
    const stale = vsix.scanEntries(entries, [moved], markers).failures;
    assert.ok(stale.some((f) => /stale allow-list entry/.test(f)));
    assert.ok(stale.some((f) => /not allowed/.test(f)));
  });

  it('does not check an allow-list entry whose file is not in the package', () => {
    const entry = { file: 'extension/dist/engine/engine.js', line: 7, match: 'fetch', text: 'fetch(u);', reason: 'engine test copy only' };
    assert.deepEqual(vsix.scanEntries(base(), [entry], markers).failures, []);
  });

  it('fails native files, shell scripts, source maps, node_modules, private markers and a missing fork file', () => {
    const marker = Buffer.from(fake('manuscript-name')); // a made-up manuscript-name marker (test/support/fakeMarkers.ts)
    const entries = new Map<string, Buffer>([
      ['extension/bin/tool.exe', Buffer.from('MZ')],
      ['extension/run.sh', Buffer.from('#!/bin/sh')],
      ['extension/dist/a.js.map', Buffer.from('{}')],
      ['extension/node_modules/x/index.js', Buffer.from('module.exports = 1;')],
      ['extension/readme.md', Buffer.concat([Buffer.from('built from '), marker])],
    ]);
    const { failures } = vsix.scanEntries(entries, [], markers);
    for (const pattern of [/tool\.exe: native/, /run\.sh: native/, /a\.js\.map: source map/, /node_modules in the VSIX/, /readme\.md:1:\d+: private marker \(manuscript-name\)/, /fork\.js is missing/]) {
      assert.ok(failures.some((f) => pattern.test(f)), `expected a failure matching ${pattern}: ${JSON.stringify(failures)}`);
    }
  });

  it('fails a licence text or notice that is not the pinned one, not only a missing one (the licence gate, L2-05)', () => {
    const real = (rel: string) => readFileSync(path.join(root, rel));
    const entries = new Map<string, Buffer>([
      ['extension/dist/extension.js', Buffer.from('')],
      ['extension/LICENSE.txt', real('LICENSE')],
      ['extension/dist/licenses/GPL-3.0.txt', real('LICENSE')],
      ['extension/dist/licenses/LPPL-1.3c.txt', real('LICENSES/LPPL-1.3c.txt')],
      ['extension/dist/licenses/engine/MiniLZ4-notice.txt', real('LICENSES/engine/MiniLZ4-notice.txt')],
    ]);
    assert.deepEqual(vsix.wrongNotices(entries), []);
    entries.set('extension/dist/licenses/engine/MiniLZ4-notice.txt', Buffer.from('x'));
    entries.set('extension/dist/licenses/LPPL-1.3c.txt', Buffer.from('x'));
    assert.deepEqual(vsix.wrongNotices(entries).map((f) => f.split(':')[0]).sort(), ['extension/dist/licenses/LPPL-1.3c.txt', 'extension/dist/licenses/engine/MiniLZ4-notice.txt']);
    // A data package's LICENSE.txt is its own text.
    assert.deepEqual(vsix.wrongNotices(new Map([['extension/LICENSE.txt', Buffer.from('data terms')]])), []);
  });

  // A tiny WebAssembly file: one function import ("a"."a") and a memory of `pages` 64 KiB pages.
  const tinyWasm = (pages: number) => {
    const leb = (n: number) => {
      const out = [];
      do {
        let byte = n & 0x7f;
        n >>>= 7;
        if (n) byte |= 0x80;
        out.push(byte);
      } while (n);
      return out;
    };
    const section = (id: number, body: number[]) => [id, ...leb(body.length), ...body];
    return Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...section(1, [1, 0x60, 0, 0]), ...section(2, [1, 1, 0x61, 1, 0x61, 0, 0]), ...section(5, [1, 0, ...leb(pages)])]);
  };
  const WASM = 'extension/dist/engine/engine.wasm';
  const GLUE = 'extension/dist/engine/engine.js';
  const engine = (wasm: Buffer, glue: string) => new Map<string, Buffer>([[WASM, wasm], [GLUE, Buffer.from(glue)]]);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  /** A build record and a pin file for the given engine files, in a temporary folder. */
  const records = (wasm: Buffer, glue: string, record: Record<string, unknown> = {}) => {
    const dir = tempFolder('livemd2tex-scan-');
    const pins = path.join(dir, 'pins.json');
    const build = path.join(dir, 'engine-build.json');
    writeFileSync(pins, JSON.stringify({ sources: [{ id: 'livemd2tex-engine', files: [{ name: 'engine.wasm', sha256: sha(wasm) }, { name: 'engine.js', sha256: sha(Buffer.from(glue)) }] }] }));
    const mib = 2 ** 20;
    writeFileSync(build, JSON.stringify({ outputs: { wasm: { sha256: sha(wasm) } }, imports: [{ resolved: '___syscall_openat' }], emscriptenSettingsOff: { NODERAWFS: false, NODERAWSOCKETS: false, NODEFS: false }, layout: { initialMemory: 64 * mib, stackFirst: true, stackSize: 8 * mib, dataEnd: 31 * mib, staticEnd: 34 * mib }, ...record }));
    return { pins, build };
  };

  it('fails an engine that is not the pinned one (check 1): the wasm and glue by SHA-256, the wasm also against the build record', () => {
    const wasm = tinyWasm(1024);
    const glue = 'var wasmImports = { a: ___syscall_openat };\n';
    const r = records(wasm, glue);
    assert.deepEqual(vsix.pinnedEngine(engine(wasm, glue), r.pins, r.build), []);
    assert.equal(vsix.pinnedEngine(engine(wasm, `${glue}// changed\n`), r.pins, r.build).length, 1);
    const other = records(tinyWasm(512), glue);
    assert.equal(vsix.pinnedEngine(engine(wasm, glue), other.pins, other.build).length, 2, 'the wasm is neither the pinned one nor the recorded one');
    assert.match(vsix.pinnedEngine(new Map([[WASM, wasm]]), r.pins, r.build)[0], /without extension\/dist\/engine\/engine\.js/);
    assert.match(vsix.pinnedEngine(new Map([[GLUE, Buffer.from(glue)]]), r.pins, r.build)[0], /holds extension\/dist\/engine\/engine\.js without extension\/dist\/engine\/engine\.wasm/);
    const noPin = path.join(tempFolder('livemd2tex-scan-'), 'pins.json');
    writeFileSync(noPin, JSON.stringify({ sources: [{ id: 'ctan-x', files: [] }] }));
    assert.deepEqual(vsix.pinnedEngine(engine(wasm, glue), noPin, r.build), ['engine/pins.json pins no livemd2tex-engine source']);
    assert.deepEqual(vsix.pinnedEngine(new Map()), [], 'no engine, nothing to check');
  });

  it('fails an engine that holds libpaper, MakeIndex, LuaTeX, luaffi or remote-fetch code (checks 2, 4, 5, 6)', () => {
    const clean = Buffer.from('dvipdfmx \0isob3\0isob4\0isob5\0isob6\0 paper sizes');
    assert.deepEqual(vsix.engineStrings(engine(clean, 'var x;')), []);
    for (const [text, part] of [
      ['PAPERCONF', 'libpaper'],
      ['/etc/papersize', 'libpaper'],
      ['halfexecutive', 'libpaper'],
      ['encap_prefix', 'MakeIndex'],
      ['luatexversion', 'LuaTeX'],
      ['dasm_link error', 'luaffi'],
      ['busytexfontindex', 'remote'],
    ]) {
      const found = vsix.engineStrings(engine(Buffer.concat([clean, Buffer.from(text)]), 'var x;'));
      assert.ok(found.some((f) => f.includes(`"${text}" (${part}`)), `${text}: ${found.join(' | ')}`);
    }
    assert.ok(vsix.engineStrings(engine(clean, 'var e = "TEXLIVE_REMOTE_ENDPOINT";')).some((f) => f.startsWith(`${GLUE}: holds "TEXLIVE_REMOTE_ENDPOINT"`)));
    assert.ok(vsix.engineStrings(engine(Buffer.from('no paper table'), 'var x;')).some((f) => /lacks "isob3".*built with libpaper/.test(f)));
  });

  it('fails a denied, unresolved or unrecorded import, a network setting that is on, and a watched glue name (check 3)', async () => {
    const wasm = tinyWasm(1024);
    const ok = 'var wasmImports = { a: ___syscall_openat };\n';
    assert.deepEqual(await vsix.engineImports(engine(wasm, ok), records(wasm, ok).build), []);
    const system = 'var wasmImports = { a: __emscripten_system };\n';
    assert.match((await vsix.engineImports(engine(wasm, system), records(wasm, system, { imports: [{ resolved: '__emscripten_system' }] }).build)).join('\n'), /resolves to __emscripten_system, which is denied/, 'denied even when the record lists it');
    const socket = 'var wasmImports = { a: ___syscall_socket };\n';
    assert.match((await vsix.engineImports(engine(wasm, socket), records(wasm, socket).build)).join('\n'), /which is denied/);
    const other = 'var wasmImports = { a: _fd_write };\n';
    assert.match((await vsix.engineImports(engine(wasm, other), records(wasm, other).build)).join('\n'), /_fd_write is not on engine\/engine-build\.json's list/);
    const none = 'var wasmImports = { b: ___syscall_openat };\n';
    assert.match((await vsix.engineImports(engine(wasm, none), records(wasm, none).build)).join('\n'), /does not resolve through the glue/);
    assert.match((await vsix.engineImports(engine(wasm, ok), records(wasm, ok, { emscriptenSettingsOff: { NODERAWFS: true, NODERAWSOCKETS: false } }).build)).join('\n'), /NODERAWFS is on[\s\S]*records no NODEFS/);
    const sockfs = `${ok}var x = SOCKFS;\n`;
    assert.match((await vsix.engineImports(engine(wasm, sockfs), records(wasm, sockfs).build)).join('\n'), /the glue holds "SOCKFS", line 2/);
    // A watched name in a comment that a reviewed entry names (by the glue's SHA-256, line and text) is allowed;
    // the same comment in another glue is not.
    const { glueChecks } = await importScript<{ glueChecks(glue: string, allow: unknown[]): { failures: string[]; allowed: string[] } }>('engine/build/tools/wasm-inspect.mjs');
    const commented = `${ok}// SOCKFS is not linked\n`;
    const entry = { glueSha256: sha(Buffer.from(commented)), line: 2, text: 'SOCKFS', reason: 'a comment' };
    const passed = glueChecks(commented, [entry]);
    assert.deepEqual(passed.failures, []);
    assert.equal(passed.allowed.length, 1);
    assert.match(glueChecks(`${commented}var y;\n`, [entry]).failures.join('\n'), /in a comment no entry of glue-allow\.json names/);
  });

  it('fails an engine whose memory header is not the worker\'s (check 8)', () => {
    const wasm = tinyWasm(1024);
    const glue = 'var x;';
    assert.deepEqual(vsix.engineHeader(engine(wasm, glue), records(wasm, glue).build), []);
    const mib = 2 ** 20;
    const bad = records(wasm, glue, { layout: { initialMemory: 32 * mib, stackFirst: false, stackSize: 4 * mib, dataEnd: 40 * mib, staticEnd: 40 * mib } });
    assert.equal(vsix.engineHeader(engine(wasm, glue), bad.build).length, 4);
    assert.match(vsix.engineHeader(engine(tinyWasm(512), glue), records(wasm, glue).build).join('\n'), /initial memory 33554432, not 64 MiB/);
    // A wasm whose memory is imported states no size of its own.
    const imported = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x02, 0x0a, 0x01, 0x01, 0x61, 0x01, 0x6d, 0x02, 0x00, 0x80, 0x08, 0x00]);
    assert.match(vsix.engineHeader(engine(imported, glue), records(wasm, glue).build).join('\n'), /its memory is imported/);
  });

  it('finds the engine by its content, and the engine\'s build anywhere (check 9)', () => {
    const wasm = tinyWasm(1024);
    const known = new Map<string, Buffer>([
      [WASM, wasm],
      [GLUE, Buffer.from('var wasmImports = {}; FS.createLazyFile = 1;\n')],
      ['extension/dist/viewer/pdfjs/wasm/jbig2.wasm', wasm],
    ]);
    assert.deepEqual(vsix.engineByContent(known), []);
    const fails = (name: string, data: Buffer) => vsix.engineByContent(new Map([...known, [name, data]]));
    assert.match(fails('extension/dist/engine/busytex.wasm', wasm).join('\n'), /busytex\.wasm: WebAssembly that is neither the pinned engine/);
    assert.match(fails('extension/dist/data/blob.bin', wasm).join('\n'), /blob\.bin: WebAssembly/, 'by content, whatever the name');
    assert.match(fails('extension/dist/other.js', Buffer.from('var wasmImports = {}; function createLazyFile() {}\n')).join('\n'), /other\.js: Emscripten's glue under a name/);
    for (const name of ['extension/engine/build/build.mjs', 'extension/dist/x/engine/build/a.h', 'extension/dist/dispatcher.c', 'extension/stubs.c', 'extension/dist/fontlist.c', 'extension/glue-allow.json', 'extension/dist/engine-build-pins.json']) {
      assert.match(fails(name, Buffer.from('x')).join('\n'), /the engine's build scripts and sources/, name);
    }
  });

  it("fails a package whose engine notices describe another engine than the build record's", () => {
    const entries = new Map<string, Buffer>([[WASM, tinyWasm(1024)]]);
    assert.deepEqual(vsix.noticesForEngine(entries), [], "the repository's notices and record agree");
    const dir = tempFolder('livemd2tex-scan-');
    const notices = JSON.parse(readFileSync(path.join(root, 'engine', 'engine-notices.json'), 'utf8')) as { build: { texLive: { commit: string } } };
    notices.build.texLive.commit = 'f26cc5ed05a1f784d1e694fe5b9cfc3ce992c03d';
    writeFileSync(path.join(dir, 'notices.json'), JSON.stringify(notices));
    assert.match(vsix.noticesForEngine(entries, path.join(dir, 'notices.json')).join('\n'), /TeX Live's commit f26cc5e\w+, engine\/engine-build\.json 6a30018\w+: the notices describe another engine/);
    assert.deepEqual(vsix.noticesForEngine(new Map()), [], 'no engine, nothing to check');
  });

  it('fails an extension package that holds a licence text only the data packages ship (AGPL-3.0, MakeIndex)', () => {
    const ext = new Map<string, Buffer>([['extension/dist/extension.js', Buffer.from('')], ['extension/dist/licenses/GPL-3.0.txt', Buffer.from('x')]]);
    assert.deepEqual(vsix.dataOnlyTexts(ext), []);
    ext.set('extension/dist/licenses/AGPL-3.0.txt', Buffer.from('x'));
    ext.set('extension/dist/licenses/MakeIndex.txt', Buffer.from('x'));
    assert.deepEqual(vsix.dataOnlyTexts(ext).map((f) => f.split(':')[0]), ['extension/dist/licenses/AGPL-3.0.txt', 'extension/dist/licenses/MakeIndex.txt']);
    // A data package ships them, for its TeX packages.
    assert.deepEqual(vsix.dataOnlyTexts(new Map([['extension/LICENSES/texts/AGPL-3.0.txt', Buffer.from('x')]])), []);
  });

  it('fails a package without its licence texts, and a test copy without its core data\'s licence folder (G1S-04)', () => {
    const one = Buffer.from('x');
    const plain = [
      'extension/dist/extension.js',
      'extension/LICENSE.txt',
      'extension/THIRD_PARTY_NOTICES.md',
      ...['INDEX', 'GPL-3.0', 'LGPL-3.0', 'Apache-2.0', 'LPPL-1.3c'].map((n) => `extension/dist/licenses/${n}.txt`),
    ];
    const entries = new Map<string, Buffer>(plain.map((n) => [n, one]));
    assert.deepEqual(vsix.missingNotices(entries), []);
    entries.delete('extension/dist/licenses/LGPL-3.0.txt');
    assert.deepEqual(vsix.missingNotices(entries), ['extension/dist/licenses/LGPL-3.0.txt: licence file missing from the package']);
    entries.set('extension/dist/licenses/LGPL-3.0.txt', one);
    // The engine: the notice of every part linked into it (engine/engine-notices.json; the licence gate, L-01 and
    // M2), ICU's and MiniLZ4's among them. MakeIndex is not in the engine, so its notice is not required (the data
    // packages ship it for the makeindex package's styles).
    entries.set('extension/dist/engine/engine.wasm', one);
    const engineNotices = vsix.engineNoticeFiles();
    assert.ok(engineNotices.includes('extension/dist/licenses/ICU.txt') && engineNotices.includes('extension/dist/licenses/engine/MiniLZ4-notice.txt'));
    assert.ok(!engineNotices.includes('extension/dist/licenses/MakeIndex.txt') && !engineNotices.includes('extension/dist/licenses/AGPL-3.0.txt'));
    assert.deepEqual(
      vsix.missingNotices(entries).map((f) => f.split(':')[0]),
      engineNotices.filter((n) => !entries.has(n)),
    );
    for (const n of engineNotices) {
      entries.set(n, one);
    }
    assert.deepEqual(vsix.missingNotices(entries), []);
    entries.set('extension/dist/data/manifest.json', one);
    assert.deepEqual(vsix.missingNotices(entries).map((f) => f.split(':')[0]), ['extension/dist/data/LICENSES/INDEX']);
  });

  it('wants the CC0 notices and legal text with the starting documents, and an SPDX CC0 line in each of them', () => {
    const one = Buffer.from('x');
    const spdx = (body: string) => Buffer.from(`% SPDX-License-Identifier: CC0-1.0\n${body}`);
    const plain = [
      'extension/dist/extension.js',
      'extension/LICENSE.txt',
      'extension/THIRD_PARTY_NOTICES.md',
      ...['INDEX', 'GPL-3.0', 'LGPL-3.0', 'Apache-2.0', 'LPPL-1.3c'].map((n) => `extension/dist/licenses/${n}.txt`),
    ];
    const entries = new Map<string, Buffer>(plain.map((n) => [n, one]));
    entries.set('extension/templates/tex/article/main.tex', spdx('\\documentclass{article}\n'));
    entries.set('extension/examples/presets/two-column-paper/preset.json', Buffer.from('{"name": "x"}'));
    assert.deepEqual(
      vsix.missingNotices(entries).map((f) => f.split(':')[0]),
      ['extension/templates/LICENSE.md', 'extension/dist/licenses/CC0-1.0.txt', 'extension/examples/presets/LICENSE.md'],
    );
    for (const n of ['extension/templates/LICENSE.md', 'extension/examples/presets/LICENSE.md', 'extension/dist/licenses/CC0-1.0.txt']) {
      entries.set(n, one);
    }
    assert.deepEqual(vsix.missingNotices(entries), []);
    assert.deepEqual(vsix.cc0Headers(entries), []);
    entries.set('extension/templates/markdown/notes.md', Buffer.from('# Notes\n'));
    entries.set('extension/examples/presets/two-column-paper/paper-preamble.tex', spdx('% Released under the GNU General Public License\n'));
    assert.deepEqual(vsix.cc0Headers(entries).map((f) => f.split(':')[0]), [
      'extension/templates/markdown/notes.md',
      'extension/examples/presets/two-column-paper/paper-preamble.tex',
    ]);
  });
});

describe('private-marker scan (scripts/marker-scan.mjs)', () => {
  let scan: MarkerScan;
  let markers: unknown[];
  let rules: unknown[];

  before(async () => {
    scan = await importScript<MarkerScan>('scripts/marker-scan.mjs');
    markers = scan.loadMarkers(fakeMarkerFolder(), {});
    rules = scan.loadAllowRules(root);
  });

  it('holds no marker list of its own, and fails closed when no source gives one (build gate 2, G2S-01)', () => {
    const empty = path.join(tempFolder('livemd2tex-nomarkers-'), 'repo');
    assert.throws(() => scan.loadMarkers(empty, {}), /No private markers/);
    // The CI secret alone is enough.
    const fromSecret = scan.loadMarkers(empty, { LIVEMD2TEX_PRIVATE_MARKERS: JSON.stringify({ markers: [{ id: 'surname', kind: 'text', value: 'Zebrowski' }] }) });
    assert.equal(fromSecret.length, 1);
    const source = readFileSync(path.join(root, 'scripts', 'marker-scan.mjs'), 'utf8');
    assert.doesNotMatch(source, /ENCODED_MARKERS|b64:/);
  });

  it('finds every marker in ordinary text', () => {
    for (const m of FAKE_MARKERS) {
      const text = m.kind === 'user-path' ? `see C:\\Users\\${m.value}\\docs` : `see ${m.value} here`;
      const findings = scan.scanText(text, 'notes.md', markers, rules);
      assert.ok(findings.some((f) => f.marker === m.id), `${m.id} not found`);
    }
  });

  it('finds a marker in base64 at every alignment, in hex and in percent encoding', () => {
    const values = FAKE_MARKERS.filter((m) => m.id === 'surname');
    for (const prefix of ['', 'a', 'ab']) {
      const b64 = Buffer.from(`${prefix}${fake('surname')} wrote this`).toString('base64');
      assert.equal(scan.scanEncoded(`x = "${b64}";`, 'f.js', values)[0]?.marker, 'surname (base64)', prefix);
    }
    assert.equal(scan.scanEncoded(`0x${Buffer.from(fake('surname')).toString('hex').toUpperCase()}`, 'f.txt', values)[0]?.marker, 'surname (hex)');
    assert.equal(scan.scanEncoded(encodeURIComponent('ö').concat([...fake('surname')].map((c) => `%${c.charCodeAt(0).toString(16)}`).join('')), 'f.txt', values)[0]?.marker, 'surname (percent)');
    assert.deepEqual(scan.scanEncoded('nothing to see', 'f.txt', values), []);
  });

  it('finds a made-up marker in each of twenty-two encodings (build gate 2, G2R-01; base32, G3S-05)', () => {
    const values = FAKE_MARKERS.filter((m) => m.id === 'surname');
    const word = fake('surname'); // a made-up name, written in title case as names are
    const lowerWord = word.toLowerCase();
    const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
    const utf16le = (s: string) => Buffer.from(s, 'utf16le');
    const utf16be = (s: string) => Buffer.from(s, 'utf16le').swap16();
    const base32 = (s: string) => {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      let bits = '';
      for (const byte of Buffer.from(s)) {
        bits += byte.toString(2).padStart(8, '0');
      }
      let out = '';
      for (let i = 0; i < bits.length; i += 5) {
        out += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
      }
      return out;
    };
    const cases: [string, string][] = [
      ['base64 of the title-case value', `"${b64(`by ${word}`)}"`],
      ['base64 at an odd alignment', `"${b64(`x ${lowerWord}`)}"`],
      ['URL-safe base64', b64(`?? ${word} ??`).replace(/\+/g, '-').replace(/\//g, '_')],
      ['hex', Buffer.from(`by ${word}`).toString('hex')],
      ['hex from the second nibble', `0${Buffer.from(`by ${word}`).toString('hex')}`],
      ['percent encoding', [...Buffer.from(`by ${word}`)].map((c) => `%${c.toString(16)}`).join('')],
      ['\\u escapes', [...word].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')],
      ['\\u{} escapes', [...word].map((c) => `\\u{${c.charCodeAt(0).toString(16)}}`).join('')],
      ['\\x escapes', [...word].map((c) => `\\x${c.charCodeAt(0).toString(16)}`).join('')],
      ['decimal HTML entities', [...word].map((c) => `&#${c.charCodeAt(0)};`).join('')],
      ['hex HTML entities', [...word].map((c) => `&#x${c.charCodeAt(0).toString(16)};`).join('')],
      ['character codes', [...word].map((c) => c.charCodeAt(0)).join(', ')],
      ['UTF-16LE bytes', utf16le(`by ${word}`).toString('latin1')],
      ['UTF-16BE bytes', utf16be(`by ${word}`).toString('latin1')],
      ['UTF-16LE in base64', b64(utf16le(`by ${word}`))],
      ['UTF-16BE in hex', utf16be(`by ${word}`).toString('hex')],
      ['base32', `"${base32(`by ${word}`)}"`],
      ['base32 in lower case, at an odd start', `${base32(`x, ${word}!`).toLowerCase()}`],
      ['ROT13', `by ${word}`.replace(/[A-Za-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) & 31) + 12) % 26 + (c <= 'Z' ? 65 : 97)))],
      ['backwards', [...`by ${word}`].reverse().join('')],
      ['split letter by letter', [...word].join(' ')],
      ['zero-width characters inside', [...word].join('​')],
    ];
    for (const [what, text] of cases) {
      assert.ok(scan.scanEncoded(text, 'f.txt', values).length > 0, `not found: ${what}`);
    }
  });

  it('decoded noise is not a finding: hashes, number lists and ordinary words', () => {
    const values = [...FAKE_MARKERS, { id: 'short', kind: 'word', value: 'zqx' }];
    const hashes = Array.from({ length: 200 }, (_, i) => `"integrity": "sha512-${createHash('sha512').update(String(i)).digest('base64')}" ${createHash('sha256').update(String(i)).digest('hex')}`).join('\n');
    const numbers = Array.from({ length: 5000 }, (_, i) => (i * 7919) % 1000003).join(',');
    const prose = 'The quick brown fox jumps over the lazy dog; a long_identifier_name and anotherIdentifier follow.';
    assert.deepEqual(scan.scanEncoded(`${hashes}\n[${numbers}]\n${prose}`, 'f.json', values), []);
  });

  it('finds the laptop path in every spelling', () => {
    const user = fake('laptop-user-path');
    for (const text of [
      `C:\\Users\\${user}\\x`,
      `C:/Users/${user}/x`,
      `"C:\\\\Users\\\\${user}\\\\x"`,
      `/c/Users/${user}/x`,
      `file:///C:/Users/${user}/x`,
      `C%3A%5CUsers%5C${user}%5Cx`,
    ]) {
      assert.equal(scan.scanText(text, 'f.txt', markers, rules)[0]?.marker, 'laptop-user-path', text);
    }
  });

  it('matches name markers as words only, and finds markers in file names', () => {
    const given = fake('coauthor-given-name');
    const family = fake('coauthor-surname');
    assert.deepEqual(scan.scanText(`a c${family} of Au${given}tus`, 'f.txt', markers, rules), []);
    assert.equal(scan.scanText(`${given}_x`, 'f.txt', markers, rules)[0]?.marker, 'coauthor-given-name');
    assert.equal(scan.scanPath(`docs/${fake('manuscript-name')}.tex`, markers)[0]?.marker, 'manuscript-name');
  });

  it('applies the allow-list of docs/DESIGN.md#store-and-packaging and nothing more', () => {
    const surname = fake('surname');
    const copyright = `Copyright (C) 2026 Someone ${surname}`;
    assert.deepEqual(scan.scanText(copyright, 'LICENSE', markers, rules), []);
    assert.equal(scan.scanText(copyright, 'NOTICE', markers, rules).length, 1);
    assert.deepEqual(scan.scanText(`  "author": "Someone ${surname}",`, 'package.json', markers, rules), []);
    assert.equal(scan.scanText(`  "description": "by ${surname}",`, 'package.json', markers, rules).length, 1);
    assert.equal(scan.scanText(`Copyright (C) 2026 ${fake('coauthor-handle')}`, 'LICENSE', markers, rules).length, 1);
  });
});
