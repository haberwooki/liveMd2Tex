// The engine's notices (engine/engine-notices.json; the licence gate, L-01 and M2 to M4): every archive and object
// TeXlyre's link line names is a component's, every notice file is pinned and present, THIRD_PARTY_NOTICES.md's table
// is the one the manifest gives, and the VSIX scan requires each file wherever the engine ships.

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { importScript, root } from '../support/helpers';

interface Component {
  id: string;
  name: string;
  links: string[];
  notices: string[];
}
interface Manifest {
  components: Component[];
  files: Record<string, { sha256: string; from: string }>;
  makefile: { lines: Record<string, string> };
  sources: { name: string; url: string; sha256: string }[];
}
interface Lib {
  loadEngineNotices(): Manifest;
  linkedFiles(m: Manifest): string[];
  noticesTable(m: Manifest): string;
  inPackage(p: string): string;
}

describe('the engine notices (engine/engine-notices.json)', () => {
  let lib: Lib;
  let manifest: Manifest;
  before(async () => {
    lib = await importScript<Lib>('scripts/lib/engine-notices.mjs');
    manifest = lib.loadEngineNotices();
  });

  it("every archive and object on TeXlyre's link line is a component's, and every component's is on it", () => {
    const linked = lib.linkedFiles(manifest);
    assert.ok(linked.length > 40, `${linked.length} files linked`);
    const covered = new Set(manifest.components.flatMap((c) => c.links));
    assert.deepEqual(linked.filter((f) => !covered.has(f)), [], 'linked but no component names it');
    assert.deepEqual([...covered].filter((f) => !linked.includes(f)), [], 'a component names a file the link line does not link');
    // LuaHBTeX is linked (the engine host runs it in ini mode), so it is named.
    assert.ok(manifest.components.some((c) => c.id === 'luahbtex' && c.links.includes('luahbtex-luatex.o')));
  });

  it('every notice file is in the repository, at its pinned bytes, and every component that needs one has one', () => {
    for (const [file, { sha256 }] of Object.entries(manifest.files)) {
      assert.equal(createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex'), sha256, file);
    }
    for (const c of manifest.components) {
      for (const n of c.notices) {
        assert.ok(existsSync(path.join(root, n)), `${c.id}: ${n}`);
        assert.ok(!n.startsWith('LICENSES/engine/') || manifest.files[n], `${c.id}: ${n} is not pinned`);
      }
    }
    const noNotice = manifest.components.filter((c) => c.notices.length === 0).map((c) => c.id).sort();
    assert.deepEqual(noNotice, ['libpaper', 'minilz4', 'web2c'], 'only libpaper (absent), MiniLZ4 (its notice is in the glue) and web2c (permissive, no notice condition) carry none');
  });

  it("THIRD_PARTY_NOTICES.md's table is the one the manifest gives, and it names the engine's sources exactly", () => {
    const notices = readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    assert.ok(notices.includes(lib.noticesTable(manifest)), 'run node scripts/lib/engine-notices.mjs and put its table under "Inside the engine"');
    for (const s of manifest.sources) {
      assert.ok(notices.includes(s.url) && notices.includes(s.sha256), s.name);
    }
    assert.match(notices, /46ebb6216a5c1fe63dd1dc885831d1a8cef2dc86/);
  });

  it("names the commit and release that engine/pins.json pins, so a new engine pin fails until the manifest follows (S2, L2-01)", () => {
    const pins = JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8')) as { sources: { id: string; tag: string }[] };
    const tag = pins.sources.find((s) => s.id === 'texlyre-busytex')?.tag;
    const m = manifest as Manifest & { build: { texlyre: { commit: string; release: string } }; makefile: { url: string; sha256: string } };
    assert.equal(m.build.texlyre.release, tag);
    assert.ok(tag?.startsWith(`build_wasm_${m.build.texlyre.commit}_`), `${tag} is not a build of ${m.build.texlyre.commit}`);
    assert.equal(m.makefile.url, `https://raw.githubusercontent.com/TeXlyre/texlyre-busytex-build/${m.build.texlyre.commit}/Makefile`);
    assert.match(m.makefile.sha256, /^[0-9a-f]{64}$/);
    // The archives GitHub makes from a commit name it, so the release check can compare their contents with it.
    const commits = (manifest.sources as { url: string; commit?: string; repository?: string }[]).filter((s) => /\/archive\//.test(s.url));
    assert.equal(commits.length, 2);
    for (const s of commits) {
      assert.equal(s.url, `${s.repository}/archive/${s.commit}.tar.gz`);
    }
  });

  it('the patched glue names the date of its last change, and fails when the patches change without it (F2, N2)', async () => {
    const glue = await importScript<{ notice: { date: string; patchesSha256: string }; patches: { id: string; count: number; find: string; replace: string }[] }>('engine/patches/busytex-glue.mjs');
    const sha = createHash('sha256')
      .update(JSON.stringify(glue.patches.map(({ id, count, find, replace }) => ({ id, count, find, replace }))))
      .digest('hex');
    assert.equal(glue.notice.patchesSha256, sha, `the patches changed: set notice.date to the day of the change and notice.patchesSha256 to ${sha}, then run scripts/engine-patch.mjs and pin the new glue`);
    assert.match(glue.notice.date, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('the search below the link line covers every linked part, with notices its parts ship (F2-M1)', () => {
    type Folder = { archive: string; path: string; components: string[]; notices: string[]; own: { text?: string; pattern?: string; notices: string[]; clauses: string[]; anyHolder?: boolean; why?: string }[]; rules: { files: string[]; notice?: string; skip?: string; covered?: string }[] };
    const search = (manifest as Manifest & { search: { folders: Folder[]; notSearched: Record<string, string>; clauses: { id: string; pattern: string }[] } }).search;
    const ids = manifest.components.map((c) => c.id);
    const searched = new Set(search.folders.flatMap((f) => f.components));
    assert.deepEqual(ids.filter((id) => !searched.has(id)).sort(), Object.keys(search.notSearched).sort(), 'each part is searched, or says why not');
    const archives = new Set((manifest.sources as { name: string }[]).map((s) => s.name));
    for (const f of search.folders) {
      assert.ok(archives.has(f.archive), `${f.path}: ${f.archive} is not one of the sources`);
      const shipped = new Set(manifest.components.filter((c) => f.components.includes(c.id)).flatMap((c) => c.notices));
      for (const n of [...f.notices, ...f.own.flatMap((o) => o.notices), ...f.rules.map((r) => r.notice).filter((x): x is string => Boolean(x))]) {
        assert.ok(shipped.has(n), `${f.path}: ${n} is not a notice of ${f.components.join(', ')}`);
      }
      for (const r of f.rules) {
        assert.equal([r.notice, r.skip, r.covered].filter(Boolean).length, 1, `${f.path}: ${r.files.join(', ')} needs one of notice, skip, covered`);
      }
      // A licence that covers any holder says why; each own licence lists the clause kinds it may cover (L5-01).
      const ids = new Set(search.clauses.map((c) => c.id));
      for (const o of f.own) {
        assert.ok(o.clauses.length > 0 && o.clauses.every((id) => ids.has(id)), `${f.path}: "${o.text ?? o.pattern}" lists no clause kinds, or one that is not in "clauses"`);
        assert.ok(!o.anyHolder || o.why, `${f.path}: "${o.text ?? o.pattern}" covers any holder, and must say why`);
      }
    }
    // The recorded run, which --since compares a new pin's run with: one entry per folder, and no problem.
    const report = JSON.parse(readFileSync(path.join(root, 'engine', 'engine-notice-search.report.json'), 'utf8')) as { folders: { archive: string; path: string; hits: Record<string, string[]> }[]; problems: string[] };
    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.folders.map((f) => `${f.archive}|${f.path}`), search.folders.map((f) => `${f.archive}|${f.path}`));
    for (const c of search.clauses) {
      assert.doesNotThrow(() => new RegExp(c.pattern, 'i'));
    }
    // Terms stated by reference are searched for too (L3-01).
    for (const words of ['Released under the MIT license', 'licensed under the BSD-style license found in the LICENSE file', 'Distributed under the Boost Software License', 'SPDX-License-Identifier: MIT', 'This file is in the public domain', 'governed by']) {
      assert.ok(search.clauses.some((c) => new RegExp(c.pattern, 'i').test(words)), words);
    }
  });

  it('the search tool: covered by the own notices, by a rule, or a problem; a stale rule is a problem too', async () => {
    const tool = await importScript<{
      holderOf(line: string, next?: string): string | null;
      searchFolder(files: Map<string, string>, folder: unknown, spec: unknown, noticeText: (f: string) => string): { covered: string[]; ruled: { file: string; how: string }[]; problems: string[] };
    }>('scripts/engine-notice-search.mjs');
    assert.equal(tool.holderOf(' * Copyright (c) 2000-2001, Aaron D. Gifford'), 'aaron d');
    assert.equal(tool.holderOf(' * Copyright 2001-2015', ' *   Francesco Zappa Nardelli'), 'francesco zappa');
    assert.equal(tool.holderOf(' * Copyright © 2018  Google, Inc.'), 'google inc');
    assert.equal(tool.holderOf('// © 2016 and later: Unicode, Inc. and others.'), 'unicode inc');
    assert.equal(tool.holderOf(' * Portions copyright (c) 2015-present, Facebook, Inc.'), 'facebook inc');
    assert.equal(tool.holderOf(' * the above copyright notice appear in all copies'), null);
    // A holder named only by generic words names nobody (L3-06).
    assert.equal(tool.holderOf(' * Copyright (c) 2021 the authors'), null);
    assert.equal(tool.holderOf(' * Copyright (c) 2021 The Contributors'), null);
    const mit = (holder: string) => `/*\n * Copyright (c) 2020 ${holder}\n *\n * Permission is hereby granted, free of charge, to any person obtaining\n * a copy of this software\n */\n`;
    const spec = JSON.parse(readFileSync(path.join(root, 'engine', 'engine-notices.json'), 'utf8')).search;
    const folder = {
      path: 'lib',
      notices: ['OWN', 'EXTRA', 'POINTED'],
      own: [
        { text: 'Permission is hereby granted, free of charge', notices: ['OWN'], clauses: ['granted'] },
        { text: 'See Copyright Notice in own.h', notices: ['POINTED'], reference: true, clauses: ['see-notice'] },
        { text: 'public domain', notices: [], anyHolder: true, why: 'no conditions', clauses: ['public-domain'] },
      ],
      rules: [{ files: ['extra.c'], notice: 'EXTRA' }, { files: ['gone/*'], skip: 'removed' }],
    };
    const texts: Record<string, string> = { OWN: 'Copyright (c) 2020 Jane Roe\nPermission is hereby granted, free of charge', EXTRA: 'x', POINTED: 'Copyright (c) 2020 Jane Roe' };
    const files = new Map([
      ['own.c', mit('Jane Roe')],
      ['extra.c', mit('Rae Doe')],
      ['stranger.c', mit('Rae Doe')],
      ['bsd.c', '/* Copyright (c) 2020 Jane Roe\n * Redistribution and use in source and binary forms */\n'],
      // Terms stated only by reference are read too (L3-01): a stranger's MIT by reference is a problem.
      ['byref.c', '/*\n** Copyright (C) 2020 Rae Doe.\n** Released under the MIT license. See elsewhere.lua for the full notice.\n*/\n'],
      ['spdx.c', '// SPDX-License-Identifier: BSD-3-Clause\nint x;\n'],
      ['bsdstyle.c', '/* Copyright (c) 2020 Rae Doe.\n * This source code is licensed under the BSD-style license found in the LICENSE file. */\n'],
      // A holder written only as "the authors" is no holder: not covered.
      ['generic.c', mit('the authors')],
      // A pointer to a notice that ships needs no holder of its own; a public-domain dedication covers any holder.
      ['pointer.c', '/*\n** See Copyright Notice in own.h\n*/\n'],
      ['pd.c', '/* Written by Somebody Else. Public domain. */\n'],
      ['plain.c', 'int x;\n'],
    ]);
    const r = tool.searchFolder(files, folder, spec, (n) => texts[n]);
    assert.deepEqual(r.covered, ['own.c', 'pd.c', 'pointer.c']);
    assert.deepEqual(r.ruled.map((x) => [x.file, x.how]), [['extra.c', 'notice']]);
    const problem = (file: string) => r.problems.find((p) => p.startsWith(`lib/${file}: `)) ?? '';
    assert.match(problem('bsd.c'), /line 2 \("Redistribution and use[^"]*"\): no own licence of the folder covers this clause \(redistribution\)/);
    assert.match(problem('stranger.c'), /line 4 \("Permission is hereby granted[^"]*"\): holders the notices do not name: rae doe/);
    assert.match(problem('byref.c'), /line 3 \("Released under the MIT license[^"]*"\): no own licence of the folder covers this clause \(released-under\)/);
    assert.match(problem('spdx.c'), /line 1 \("SPDX-License-Identifier: BSD-3-Clause[^"]*"\)/);
    assert.match(problem('bsdstyle.c'), /line 2 \("This source code is licensed under the BSD-style[^"]*"\)/);
    assert.match(problem('generic.c'), /line 4 \("Permission is hereby granted[^"]*"\): no copyright line above it/);
    assert.ok(r.problems.includes('lib: the rule for gone/* names no file with a licence clause any more'), r.problems.join('\n'));
    assert.equal(r.problems.length, 7, r.problems.join('\n'));
  });

  it("an exception holds only on the clause's own lines: a stranger's clause beside it is still a problem (L4-01)", async () => {
    const tool = await importScript<{
      searchFolder(files: Map<string, string>, folder: unknown, spec: unknown, noticeText: (f: string) => string): { covered: string[]; problems: string[] };
    }>('scripts/engine-notice-search.mjs');
    type Folder = { archive: string; path: string };
    const search = (manifest as Manifest & { search: { folders: Folder[] } }).search;
    const noticeText = (f: string) => readFileSync(path.join(root, f), 'utf8');
    /** One made-up file in a real folder, with the folder's own licences and rules: is it a problem? */
    const verdict = (folderPath: string, rel: string, text: string) => {
      const folder = search.folders.find((f) => f.path === folderPath);
      assert.ok(folder, folderPath);
      const r = tool.searchFolder(new Map([[rel, text]]), folder, search, noticeText);
      return r.covered.includes(rel) ? 'covered' : r.problems.some((p) => p.startsWith(`${folderPath}/${rel}: `)) ? 'problem' : 'ruled';
    };
    // Five probes from a licence review: a stranger's clause beside a public-domain line, a pointer to a notice that
    // does not ship, and clauses beside FreeType's and libpng's licence sentences.
    assert.equal(verdict('texk/kpathsea', 'probe.c', '/*\n * Copyright (c) 2021 Jane Q. Stranger\n * Based on public domain code by Someone Else.\n * Redistribution and use in source and binary forms, with or without\n * modification, must reproduce the above copyright notice.\n */\n'), 'problem');
    assert.equal(verdict('texk/web2c/luatexdir', 'probe.c', '/*\n** Copyright (c) 2021 Jane Q. Stranger\n** Parts of this file are in the public domain.\n** Released under the MIT license. See stranger.txt for the full notice.\n*/\n'), 'problem');
    assert.equal(verdict('texk/web2c/luatexdir', 'lua/probe.c', '/*\n** See Copyright Notice in fancy.h\n*/\n'), 'problem');
    assert.equal(verdict('libs/freetype2/freetype-src/src', 'probe.c', '/*\n * This file is part of the FreeType project, and may only be used,\n * modified, and distributed under the terms of the FreeType project\n * license, LICENSE.TXT.\n * Portions Copyright (c) 2021 Jane Q. Stranger: Permission is hereby granted, free of charge,\n * provided that this notice appears in all copies.\n */\n'), 'problem');
    assert.equal(verdict('libs/libpng/libpng-src', 'probe.c', '/*\n * This code is released under the libpng license.\n * Copyright (c) 2021 Jane Q. Stranger\n * Redistribution and use in source and binary forms are permitted provided that\n * the above copyright notice is reproduced.\n */\n'), 'problem');
    // The exceptions still hold on their own lines.
    assert.equal(verdict('texk/kpathsea', 'pd.c', '/* Written by Someone Else. Public domain. */\n'), 'covered');
    assert.equal(verdict('texk/web2c/luatexdir', 'lua/pointer.c', '/*\n** See Copyright Notice in lua.h\n*/\n'), 'covered');
    assert.equal(verdict('libs/freetype2/freetype-src/src', 'own.c', '/*\n * Copyright (C) 2021 by Someone.\n *\n * This file is part of the FreeType project, and may only be used,\n * modified, and distributed under the terms of the FreeType project\n * license, LICENSE.TXT.\n */\n'), 'covered');

    // Seven more probes from a licence review: clauses of one kind next to another kind's licence, on the same line,
    // the next line or in the same paragraph, and a denial of a dedication. An own licence covers only its own kind
    // of clause, so none of these borrows one (L5-01).
    const r5 = [
      ['texk/kpathsea', 'probe1.c', '/*\n * Released under the MIT license (this file is not public domain).\n */\n'],
      ['texk/kpathsea', 'probe2.c', '/*\n * Redistribution and use in source and binary forms must reproduce this notice;\n * the tables below are public domain.\n */\n'],
      ['libs/freetype2/freetype-src/src', 'probe3.c', '/*\n * Permission is hereby granted, free of charge, to use this file, which is\n * distributed under the terms of the FreeType project license.\n */\n'],
      ['libs/libpng/libpng-src', 'probe4.c', '/*\n * Redistribution and use in source and binary forms, released under the libpng license, must keep this notice.\n */\n'],
      ['texk/web2c/luatexdir', 'probe5.c', '/* Copyright (C) 2000-2008 by George Williams */\n/*\n * Redistribution and use in source and binary forms, with or without\n * modification, are permitted provided that the following conditions are met:\n * Parts by another author: Released under the MIT license, see COPYING.other\n */\n'],
      ['texk/web2c/luatexdir', 'probe6.c', '/* Copyright (C) 2000-2008 by George Williams */\n/*\n * Copyright (c) 2021 Jane Q. Stranger\n * Redistribution and use in source and binary forms, with or without\n * modification, are permitted provided that the following conditions are met:\n */\n'],
      ['texk/kpathsea', 'probe7.c', '/*\n * Copyright (c) 2021 Jane Q. Stranger. All rights reserved. This file is not in the public domain; its terms are in COPYING.stranger.\n */\n'],
    ] as const;
    for (const [folderPath, rel, text] of r5) {
      assert.equal(verdict(folderPath, rel, text), 'problem', `${folderPath}/${rel}`);
    }
    // A public-domain dedication still holds, in its own words.
    for (const words of ['Written in 1995 by Karl Berry.  Public domain.', 'This file is public domain.', 'This code is explicitely put in the public domain', 'Released to public domain 1-Jan-89', 'This file is public domain software donated by']) {
      assert.equal(verdict('texk/kpathsea', 'pd2.c', `/* ${words} */\n`), 'covered', words);
    }
    // A denial is no dedication: "not", "no longer", "isn't", "never" and "no" before "public domain" (L6-01).
    for (const words of ['This file is no longer in the public domain.', "This file isn't in the public domain.", 'This code was never placed in the public domain.', 'No part of this file is public domain software.']) {
      assert.equal(verdict('texk/kpathsea', 'pd3.c', `/* ${words} */\n`), 'problem', words);
    }
  });

  it('--since keys a hit on its folder, file and clause kinds, not on the archive, whose name changes with the pin', async () => {
    const tool = await importScript<{ newHits(before: unknown, after: unknown): string[] }>('scripts/engine-notice-search.mjs');
    const run = (archive: string, hits: Record<string, string[]>) => ({ folders: [{ archive, path: 'libs/x', hits }, { archive: 'other.tar.gz', path: '', hits: { 'top.c': ['granted'] } }] });
    const before = run('texlive-source-aaaaaaa.tar.gz', { 'a.c': ['granted'], 'b.c': ['public-domain'] });
    assert.deepEqual(tool.newHits(before, run('texlive-source-bbbbbbb.tar.gz', { 'a.c': ['granted'], 'b.c': ['public-domain'] })), [], 'a new pin alone brings no new hit');
    assert.deepEqual(tool.newHits(before, run('texlive-source-bbbbbbb.tar.gz', { 'a.c': ['granted', 'released-under'], 'b.c': ['public-domain'], 'c.c': ['spdx'] })), [
      'libs/x/a.c (granted, released-under)',
      'libs/x/c.c (spdx)',
    ]);
  });

  it('the VSIX scan requires every notice file wherever the engine ships', async () => {
    const vsix = await importScript<{ engineNoticeFiles(): string[]; missingNotices(e: Map<string, Buffer>): string[] }>('scripts/vsix-scan.mjs');
    const want = [...new Set(manifest.components.flatMap((c) => c.notices).map((n) => `extension/${lib.inPackage(n)}`))].sort();
    assert.deepEqual(vsix.engineNoticeFiles(), want);
    const entries = new Map<string, Buffer>([['extension/dist/engine/busytex.wasm', Buffer.from('x')]]);
    const missing = vsix.missingNotices(entries).map((m) => m.split(':')[0]);
    assert.deepEqual(want.filter((w) => !missing.includes(w)), [], 'each is required');
  });
});
