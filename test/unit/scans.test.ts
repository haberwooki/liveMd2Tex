// The VSIX scan, its JavaScript scanner and ZIP reader, and the private-marker scan.

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { FAKE_MARKERS, fake, fakeMarkerFolder } from '../support/fakeMarkers';
import { importScript, root } from '../support/helpers';

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
    options?: { dataOnly?: boolean },
  ): { failures: string[]; hits: (Hit & { status: string })[] };
  missingNotices(entries: Map<string, Buffer>): string[];
  cc0Headers(entries: Map<string, Buffer>): string[];
  unpinnedGlue(entries: Map<string, Buffer>): string[];
  engineNoticeFiles(): string[];
  engineLinksLibpaper(entries: Map<string, Buffer>): string[];
  wrongNotices(entries: Map<string, Buffer>): string[];
  engineLinksLuaffiCode(entries: Map<string, Buffer>): string[];
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

  it('allows child_process in the fork file only', () => {
    assert.deepEqual(vsix.scanEntries(base(), [], markers).failures, []);
    const entries = base();
    entries.set('extension/dist/extension.js', Buffer.from(fork));
    const { failures } = vsix.scanEntries(entries, [], markers);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /extension\/dist\/extension\.js:1:.*child_process/);
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
    const entry = { file: 'extension/dist/engine/busytex.js', line: 7, match: 'fetch', text: 'fetch(u);', reason: 'engine test copy only' };
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
      ['extension/dist/licenses/engine/TeXlyre-BusyTeX-NOTICE.txt', real('LICENSES/engine/TeXlyre-BusyTeX-NOTICE.txt')],
    ]);
    assert.deepEqual(vsix.wrongNotices(entries), []);
    entries.set('extension/dist/licenses/engine/TeXlyre-BusyTeX-NOTICE.txt', Buffer.from('x'));
    entries.set('extension/dist/licenses/LPPL-1.3c.txt', Buffer.from('x'));
    assert.deepEqual(vsix.wrongNotices(entries).map((f) => f.split(':')[0]).sort(), ['extension/dist/licenses/LPPL-1.3c.txt', 'extension/dist/licenses/engine/TeXlyre-BusyTeX-NOTICE.txt']);
    // A data package's LICENSE.txt is its own text.
    assert.deepEqual(vsix.wrongNotices(new Map([['extension/LICENSE.txt', Buffer.from('data terms')]])), []);
  });

  it("fails an engine that holds luaffi's own code or DynASM, which the notices say are not in it (L3-02)", () => {
    const wasm = (text: string) => new Map([['extension/dist/engine/busytex.wasm', Buffer.from(text)]]);
    assert.deepEqual(vsix.engineLinksLuaffiCode(wasm('The ffi module is available for')), [], "luaffi's stub only");
    assert.equal(vsix.engineLinksLuaffiCode(wasm('dasm_link error %s; unable to convert argument %d')).length, 2);
    assert.deepEqual(vsix.engineLinksLuaffiCode(new Map()), []);
  });

  it("fails an engine whose WebAssembly holds libpaper's strings (GPL-2.0-only; the licence gate, S5)", () => {
    assert.deepEqual(vsix.engineLinksLibpaper(new Map([['extension/dist/engine/busytex.wasm', Buffer.from('no paper here')]])), []);
    const found = vsix.engineLinksLibpaper(new Map([['extension/dist/engine/busytex.wasm', Buffer.from('getenv PAPERCONF and /etc/papersize')]]));
    assert.equal(found.length, 2);
    assert.match(found[0], /holds libpaper's "PAPERCONF"/);
    assert.deepEqual(vsix.engineLinksLibpaper(new Map()), [], 'no engine, nothing to check');
  });

  it('keeps each patched glue in a folder of its own hash, which engine/pins.json names', async () => {
    const lib = await importScript<{ derivedGlueFile(sha: string): string; pinnedGluePath(root: string, pins: unknown): string }>('scripts/lib/derived-glue.mjs');
    const pins = JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8'));
    const glue = pins.sources.find((s: { id: string }) => s.id === 'texlyre-busytex').patchedGlue;
    assert.equal(glue.file, lib.derivedGlueFile(glue.sha256));
    assert.equal(lib.derivedGlueFile(glue.sha256), `derived/${glue.sha256.slice(0, 16)}/busytex.patched.js`);
    assert.equal(lib.pinnedGluePath('/assets', pins), path.join('/assets', 'derived', glue.sha256.slice(0, 16), 'busytex.patched.js'));
    assert.throws(() => lib.derivedGlueFile('not-a-hash'), /is not a SHA-256/);
  });

  it('fails an engine glue that is not the pinned patched glue (G1S-08)', () => {
    assert.deepEqual(vsix.unpinnedGlue(base()), []);
    const entries = base();
    entries.set('extension/dist/engine/busytex.js', Buffer.from('var Module = {}; // not the patched glue\n'));
    assert.match(vsix.unpinnedGlue(entries).join('\n'), /is not the pinned patched glue/);
  });

  it('fails a package without its licence texts, and a test copy without the TeX and font licences (G1S-04)', () => {
    const one = Buffer.from('x');
    const plain = [
      'extension/dist/extension.js',
      'extension/LICENSE.txt',
      'extension/THIRD_PARTY_NOTICES.md',
      ...['INDEX', 'GPL-3.0', 'AGPL-3.0', 'LGPL-3.0', 'Apache-2.0', 'LPPL-1.3c'].map((n) => `extension/dist/licenses/${n}.txt`),
    ];
    const entries = new Map<string, Buffer>(plain.map((n) => [n, one]));
    assert.deepEqual(vsix.missingNotices(entries), []);
    entries.delete('extension/dist/licenses/AGPL-3.0.txt');
    assert.deepEqual(vsix.missingNotices(entries), ['extension/dist/licenses/AGPL-3.0.txt: licence file missing from the package']);
    entries.set('extension/dist/licenses/AGPL-3.0.txt', one);
    // The engine: the notice of every part linked into it (engine/engine-notices.json; the licence gate, L-01 and
    // M2), ICU's and MakeIndex's among them.
    entries.set('extension/dist/engine/busytex.wasm', one);
    const engineNotices = vsix.engineNoticeFiles();
    assert.ok(engineNotices.includes('extension/dist/licenses/ICU.txt') && engineNotices.includes('extension/dist/licenses/MakeIndex.txt'));
    assert.ok(engineNotices.includes('extension/dist/licenses/engine/TeXlyre-BusyTeX-NOTICE.txt'));
    assert.deepEqual(
      vsix.missingNotices(entries).map((f) => f.split(':')[0]),
      engineNotices.filter((n) => !entries.has(n)),
    );
    for (const n of engineNotices) {
      entries.set(n, one);
    }
    assert.deepEqual(vsix.missingNotices(entries), []);
    entries.set('extension/dist/data/texlive-extra.data', one);
    entries.set('extension/dist/data/fonts/DejaVuSans.ttf', one);
    assert.deepEqual(
      vsix.missingNotices(entries).map((f) => f.split(':')[0]),
      ['extension/dist/data/licenses/TeX-Live-LICENSE.TL.txt', 'extension/dist/data/licenses/TeX-Live-LICENSE.CTAN.txt', 'extension/dist/data/licenses/lppl.tex', 'extension/dist/data/fonts/LICENSE'],
    );
  });

  it('wants the CC0 notices and legal text with the starting documents, and an SPDX CC0 line in each of them', () => {
    const one = Buffer.from('x');
    const spdx = (body: string) => Buffer.from(`% SPDX-License-Identifier: CC0-1.0\n${body}`);
    const plain = [
      'extension/dist/extension.js',
      'extension/LICENSE.txt',
      'extension/THIRD_PARTY_NOTICES.md',
      ...['INDEX', 'GPL-3.0', 'AGPL-3.0', 'LGPL-3.0', 'Apache-2.0', 'LPPL-1.3c'].map((n) => `extension/dist/licenses/${n}.txt`),
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
    const empty = path.join(mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-nomarkers-')), 'repo');
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
