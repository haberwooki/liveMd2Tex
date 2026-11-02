// The data releases: the data packages' releases (scripts/data-release.mjs, run by .github/workflows/bundle.yml's
// release job) and their pins (scripts/lib/data-pins.mjs, checkedDataPackage), which scripts/stage-engine.mjs, the
// engine tests and scripts/run-integration.mjs use once engine/pins.json pins the two packages.

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { importScript, root } from '../support/helpers';
import { storedZip } from '../support/zipWrite';

type Entries = Map<string, Buffer>;
type Plan = { problems: string[]; releases: { set: string; file: string; tag: string }[] };
type Archive = { kind: string; url: string; sha512: string };
type DataRelease = {
  SETS: string[];
  TAG: RegExp;
  dataTag(set: string, abi: string, candidate: string | number): string;
  planReleases(packages: Map<string, Entries>, pinnedWasm: string, candidate: string | number): Plan;
  licenceGaps(entries: Entries, db: Map<string, Record<string, unknown>>, snapshotUrl: string): string[];
  releaseNotes(o: Record<string, unknown>): string;
  main(argv: string[]): number;
};
type Checked = { path: string; missing: boolean } | null;
type DataPins = {
  checkedDataPackage(pins: unknown, id: string, assetsRoot: string, env?: Record<string, string>): Checked;
  extraDataPackage(pins: unknown, assetsRoot: string, env?: Record<string, string>): string | null;
};
type StageEngine = { pinnedCoreData(repo: string, env?: Record<string, string>): string; NotPresent: new (m: string) => Error };

const ABI = 'ae9dbba0960d658f96f6f593a9434227e83f8ed56fc26eff359894e83e02f87e';
const OTHER = '228836f086a0cba4023402408ab77bc4210cb36779fca1a3aee4580d463e77bd';
const SNAPSHOT = 'https://texlive.info/tlnet-archive/2026/10/15/tlnet/';
const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const pkg = (set: string, manifest: Record<string, unknown> = {}): Entries =>
  new Map([
    ['extension/package.json', Buffer.from(JSON.stringify({ name: `livemd2tex-${set}`, version: '2026.10.15' }))],
    ['extension/data/manifest.json', Buffer.from(JSON.stringify({ format: 1, set, texLive: 2026, abi: ABI, version: '2026.10.15', snapshot: '2026/10/15', ...manifest }))],
  ]);
const build = (core = pkg('core-data'), extra = pkg('extra-data')) =>
  new Map([
    ['livemd2tex-core-data-2026.10.15.vsix', core],
    ['livemd2tex-extra-data-2026.10.15.vsix', extra],
  ]);

/** A made-up pin of a data package: a 7-byte .vsix, "package", in its folder. */
const BYTES = 'package';
const dataPin = (set: string, file: Partial<{ size: number; sha256: string }> = {}) => ({
  id: `livemd2tex-${set}`,
  folder: `livemd2tex-${set}-ae9dbba-1`,
  release: `https://github.com/haberwooki/liveMd2Tex/releases/tag/${set}-ae9dbba-1`,
  tag: `${set}-ae9dbba-1`,
  published: '2026-11-03',
  files: [{ name: `livemd2tex-${set}-2026.10.15.vsix`, url: 'https://example.invalid/x.vsix', size: BYTES.length, sha256: sha256(BYTES), ...file }],
});
const ENGINE = { id: 'livemd2tex-engine', folder: 'livemd2tex-engine-6a30018-4', files: [{ name: 'engine.wasm' }] };

describe("the data releases: the data packages' releases and pins", () => {
  let tmp = '';
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-datarel-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  /** Puts a data package's file where scripts/engine-assets.mjs would, under <tmp>/engine_assets. */
  const download = (set: string, bytes: string = BYTES) => {
    const dir = path.join(tmp, 'engine_assets', `livemd2tex-${set}-ae9dbba-1`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `livemd2tex-${set}-2026.10.15.vsix`), bytes);
    return path.join(dir, `livemd2tex-${set}-2026.10.15.vsix`);
  };

  it('names each release <set>-<the engine short hash>-<n>, the same hash and number for the two packages of one build', async () => {
    const dr = await importScript<DataRelease>('scripts/data-release.mjs');
    assert.deepEqual(dr.SETS, ['core-data', 'extra-data']);
    assert.equal(dr.dataTag('core-data', ABI, 1), 'core-data-ae9dbba-1');
    assert.equal(dr.dataTag('extra-data', ABI, '12'), 'extra-data-ae9dbba-12');
    assert.throws(() => dr.dataTag('core-data', ABI, 0), /candidate must be a number from 1/);
    assert.throws(() => dr.dataTag('core-data', ABI, '01'), /candidate/);
    assert.throws(() => dr.dataTag('fonts', ABI, 1), /not a data set/);
    assert.throws(() => dr.dataTag('core-data', 'ae9dbba', 1), /not an engine SHA-256/);
    for (const t of ['core-data-ae9dbba-1', 'extra-data-0123abc-10']) assert.ok(dr.TAG.test(t), t);
    for (const t of ['core-data-ae9dbba-0', 'data-ae9dbba-1', 'core-data-AE9DBBA-1', 'core-data-ae9dbba-1\nx']) assert.ok(!dr.TAG.test(t), t);
  });

  it('plans the two releases only for one build of both packages, made for the pinned engine', async () => {
    const dr = await importScript<DataRelease>('scripts/data-release.mjs');
    const ok = dr.planReleases(build(), ABI, 3);
    assert.deepEqual(ok.problems, []);
    assert.deepEqual(ok.releases.map((r) => [r.set, r.tag, r.file]), [
      ['core-data', 'core-data-ae9dbba-3', 'livemd2tex-core-data-2026.10.15.vsix'],
      ['extra-data', 'extra-data-ae9dbba-3', 'livemd2tex-extra-data-2026.10.15.vsix'],
    ]);
    assert.match(dr.planReleases(build(), OTHER, 1).problems.join('\n'), /built for the engine ae9dbba0\w+, not the pinned 228836f0/);
    assert.match(dr.planReleases(new Map([...build()].slice(0, 1)), ABI, 1).problems.join('\n'), /the build holds 0 extra-data packages, not one/);
    for (const [key, value] of [['snapshot', '2026/10/01'], ['texLive', 2025], ['version', '2026.10.16'], ['abi', OTHER]] as const) {
      const problems = dr.planReleases(build(pkg('core-data'), pkg('extra-data', { [key]: value })), ABI, 1).problems.join('\n');
      assert.match(problems, new RegExp(`differ in ${key}: one build makes both`), key);
    }
    assert.match(dr.planReleases(build(pkg('core-data', { set: 'extra-data' })), ABI, 1).problems.join('\n'), /its manifest says extra-data, its package\.json core-data/);
    const noManifest = new Map([['extension/package.json', Buffer.from('{"name":"livemd2tex-extra-data"}')]]);
    assert.match(dr.planReleases(build(pkg('core-data'), noManifest), ABI, 1).problems.join('\n'), /livemd2tex-extra-data-2026\.10\.15\.vsix: not a data package \(its package\.json names livemd2tex-extra-data, and it lacks data\/manifest\.json\)/);
    const notData = new Map([...build(), ['livemd2tex-0.0.1.vsix', new Map([['extension/package.json', Buffer.from('{"name":"livemd2tex"}')]])]]);
    assert.match(dr.planReleases(notData, ABI, 1).problems.join('\n'), /livemd2tex-0\.0\.1\.vsix: not a data package/);
    assert.deepEqual(dr.planReleases(build(), OTHER, 1).releases, [], 'no release when anything is wrong');
  });

  it("plan writes the release list the job reads: set, tag and package, one line each, for the repository's pinned engine", async () => {
    const dr = await importScript<DataRelease>('scripts/data-release.mjs');
    const pinned = (JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8')) as { sources: { id: string; files: { name: string; sha256: string }[] }[] }).sources
      .find((s) => s.id === 'livemd2tex-engine')
      ?.files.find((f) => f.name === 'engine.wasm')?.sha256 as string;
    const packages = path.join(tmp, 'packages');
    mkdirSync(packages);
    for (const set of ['core-data', 'extra-data']) {
      writeFileSync(path.join(packages, `livemd2tex-${set}-2026.10.15.vsix`), storedZip(Object.fromEntries([...pkg(set, { abi: pinned })])));
    }
    const out = path.join(tmp, 'release');
    const log = console.log;
    console.log = () => undefined;
    try {
      assert.equal(dr.main(['plan', '--packages', packages, '--candidate', '2', '--out', out]), 0);
    } finally {
      console.log = log;
    }
    const short = pinned.slice(0, 7);
    assert.equal(
      readFileSync(path.join(out, 'releases.tsv'), 'utf8'),
      ['core-data', 'extra-data'].map((set) => `${set}\t${set}-${short}-2\t${path.join(packages, `livemd2tex-${set}-2026.10.15.vsix`)}\n`).join(''),
    );
  });

  it('notes refuses a tag of the wrong set or engine, and a tlpdb that is not the pinned one', async () => {
    const dr = await importScript<DataRelease>('scripts/data-release.mjs');
    const vsix = path.join(tmp, 'livemd2tex-core-data-2026.10.15.vsix');
    writeFileSync(vsix, storedZip(Object.fromEntries([...pkg('core-data')])));
    const sources = path.join(tmp, 'sources');
    mkdirSync(path.join(sources, 'meta'), { recursive: true });
    writeFileSync(path.join(sources, 'sources.json'), '{"groups":{}}');
    writeFileSync(path.join(sources, 'meta', 'texlive.tlpdb.xz'), 'not the pinned tlpdb');
    const notes = (tag: string, set = 'core-data') =>
      dr.main(['notes', '--set', set, '--tag', tag, '--vsix', vsix, '--sources', sources, '--commit', 'c'.repeat(40), '--repository', 'https://github.com/haberwooki/liveMd2Tex', '--out', path.join(tmp, 'notes.md')]);
    assert.throws(() => notes('extra-data-ae9dbba-1'), /extra-data-ae9dbba-1 is not a core-data release tag/);
    assert.throws(() => notes('core-data-ae9dbba-1', 'extra-data'), /is not a extra-data release tag/);
    assert.throws(() => notes('core-data-228836f-1'), /core-data-228836f-1 does not name the engine the package is built for/);
    assert.throws(() => notes('core-data-ae9dbba-1'), /the tlpdb is not the pinned one/);
  });

  it("checks the sources' list against the pinned tlpdb: every archive of each GPL package and packed GPL font's package", async () => {
    const dr = await importScript<DataRelease>('scripts/data-release.mjs');
    const h = (s: string) => createHash('sha512').update(s).digest('hex');
    const db = new Map<string, Record<string, unknown>>([
      ['gplpkg', { containerChecksum: h('gplpkg run'), srcContainerChecksum: h('gplpkg source'), docContainerChecksum: '' }],
      ['fontpkg', { containerChecksum: h('fontpkg run'), srcContainerChecksum: '', docContainerChecksum: h('fontpkg doc') }],
      ['free', { containerChecksum: h('free run'), srcContainerChecksum: '', docContainerChecksum: '' }],
    ]);
    const archive = (name: string, kind: string, file: string): Archive => ({ kind, url: `${SNAPSHOT}archive/${file}`, sha512: h(`${name} ${kind}`) });
    const complete = {
      gplpkg: { licence: ['gpl2+'], archives: [archive('gplpkg', 'run', 'gplpkg.tar.xz'), archive('gplpkg', 'source', 'gplpkg.source.tar.xz')] },
      fontpkg: { licence: ['ofl'], archives: [archive('fontpkg', 'run', 'fontpkg.tar.xz'), archive('fontpkg', 'doc', 'fontpkg.doc.tar.xz')] },
      free: { licence: ['lppl1.3c'] },
    };
    const changes = '# header\n\nfonts/type1/x/a.pfb\tfontpkg\t' + 'a'.repeat(64) + '\turl\tpacked\t2026/10/15\n';
    const entries = (licences: unknown, more: Record<string, string> = {}) =>
      new Map<string, Buffer>(Object.entries({ 'extension/data/licences.json': JSON.stringify(licences), 'extension/LICENSES/INDEX': 'index', 'extension/LICENSES/CHANGES-GPL': changes, ...more }).map(([k, v]) => [k, Buffer.from(v)]));
    assert.deepEqual(dr.licenceGaps(entries(complete), db, SNAPSHOT), []);
    const without = (name: keyof typeof complete, kind: string) => ({ ...complete, [name]: { ...complete[name], archives: (complete[name] as { archives: Archive[] }).archives.filter((a) => a.kind !== kind) } });
    assert.deepEqual(dr.licenceGaps(entries(without('gplpkg', 'run')), db, SNAPSHOT), ["gplpkg (gpl2+): data/licences.json lacks its run archive gplpkg.tar.xz with the tlpdb's SHA-512"]);
    assert.deepEqual(dr.licenceGaps(entries(without('gplpkg', 'source')), db, SNAPSHOT), ["gplpkg (gpl2+): data/licences.json lacks its source archive gplpkg.source.tar.xz with the tlpdb's SHA-512"]);
    assert.deepEqual(dr.licenceGaps(entries(without('fontpkg', 'run')), db, SNAPSHOT), ["fontpkg (a packed font under the GPL): data/licences.json lacks its run archive fontpkg.tar.xz with the tlpdb's SHA-512"]);
    const wrongHash = { ...complete, gplpkg: { ...complete.gplpkg, archives: [{ ...complete.gplpkg.archives[0], sha512: h('other') }, complete.gplpkg.archives[1]] } };
    assert.match(dr.licenceGaps(entries(wrongHash), db, SNAPSHOT).join('\n'), /gplpkg \(gpl2\+\): data\/licences\.json lacks its run archive/);
    assert.deepEqual(dr.licenceGaps(entries({ gplpkg: complete.gplpkg, free: complete.free }), db, SNAPSHOT), ['fontpkg: LICENSES/CHANGES-GPL names it, data/licences.json does not']);
    assert.deepEqual(dr.licenceGaps(entries({ ...complete, gone: { licence: ['agpl3'] } }), db, SNAPSHOT), ['gone (agpl3): not in the pinned tlpdb']);
    const noIndex = entries(complete);
    noIndex.delete('extension/LICENSES/INDEX');
    assert.deepEqual(dr.licenceGaps(noIndex, db, SNAPSHOT), ['LICENSES/INDEX is missing']);
    // Without CHANGES-GPL (extra-data packs no fonts), a non-GPL package needs no archives.
    const noChanges = entries({ gplpkg: complete.gplpkg, fontpkg: { licence: ['ofl'] }, free: complete.free });
    noChanges.delete('extension/LICENSES/CHANGES-GPL');
    assert.deepEqual(dr.licenceGaps(noChanges, db, SNAPSHOT), []);
    assert.deepEqual(dr.licenceGaps(new Map(), db, SNAPSHOT), ['data/licences.json is missing']);
  });

  it("writes notes that name the package's hash, its engine, the sources and the licences", async () => {
    const dr = await importScript<DataRelease>('scripts/data-release.mjs');
    const notes = (set: string, packedGplFonts: boolean) =>
      dr.releaseNotes({
        set,
        tag: `${set}-ae9dbba-1`,
        vsixName: `livemd2tex-${set}-2026.10.15.vsix`,
        vsixBytes: Buffer.from('package'),
        manifest: { abi: ABI, texLive: 2026, snapshot: '2026/10/15', version: '2026.10.15' },
        sources: { groups: { [set]: [{ name: 'a.source.tar.xz' }, { name: 'a.tar.xz' }] } },
        engine: { tag: 'engine-6a30018-4' },
        commit: 'c'.repeat(40),
        repository: 'https://github.com/haberwooki/liveMd2Tex',
        snapshotUrl: SNAPSHOT,
        tlpdbSha256: 'f'.repeat(64),
        packedGplFonts,
      });
    const core = notes('core-data', true);
    assert.match(core, /^# core-data-ae9dbba-1\n/);
    assert.match(core, /`livemd2tex-core-data-2026\.10\.15\.vsix`: 7 bytes, SHA-256 `[0-9a-f]{64}`/);
    assert.match(core, new RegExp(`\`${ABI}\` \\(the package's \`abi\`\\): the engine release engine-6a30018-4`));
    assert.match(core, /`core-data-ae9dbba-1-sources\.tar`: [^\n]*AGPL, and of each package with a packed font under the GPL, [^\n]*\(2 archives\)/);
    assert.match(core, /`texlive\.tlpdb\.xz`: [^\n]*SHA-256 `f{64}`\. TeX Live signs the SHA-512 of the unpacked database, and `engine\/bundle-pins\.json` records it \(`signedSha512`\)/);
    assert.match(core, /`core-data-ae9dbba-1-LICENSES\.tar` is the package's `LICENSES\/` folder/);
    assert.match(core, /at commit c{40} of https:\/\/github\.com\/haberwooki\/liveMd2Tex/);
    // extra-data packs no fonts, so its notes do not claim any.
    const extra = notes('extra-data', false);
    assert.match(extra, /`extra-data-ae9dbba-1-sources\.tar`: [^\n]*LGPL or AGPL, as `data\/licences\.json` lists them/);
    assert.doesNotMatch(extra, /packed font/);
  });

  it('checks a pinned data package for every user of a pin: none pinned, one pinned, missing, wrong size, wrong hash, right', async () => {
    const { checkedDataPackage } = await importScript<DataPins>('scripts/lib/data-pins.mjs');
    const assets = path.join(tmp, 'engine_assets');
    const laptop = {};
    const ci = { CI: 'true' };
    const both = (file: Partial<{ size: number; sha256: string }> = {}) => ({ sources: [ENGINE, dataPin('core-data'), dataPin('extra-data', file)] });
    // No data pin: nothing to check, on any machine.
    assert.equal(checkedDataPackage({ sources: [ENGINE] }, 'livemd2tex-extra-data', assets, ci), null);
    // One pin alone: the other is not pinned; a missing file skips even on CI, since the rule keys on both pins.
    const one = { sources: [ENGINE, dataPin('core-data')] };
    assert.equal(checkedDataPackage(one, 'livemd2tex-extra-data', assets, ci), null);
    assert.deepEqual(checkedDataPackage(one, 'livemd2tex-core-data', assets, ci), { path: path.join(assets, 'livemd2tex-core-data-ae9dbba-1', 'livemd2tex-core-data-2026.10.15.vsix'), missing: true });
    // Both pinned, the file missing: a skip on a laptop, a failure on CI.
    const file = path.join(assets, 'livemd2tex-extra-data-ae9dbba-1', 'livemd2tex-extra-data-2026.10.15.vsix');
    assert.deepEqual(checkedDataPackage(both(), 'livemd2tex-extra-data', assets, laptop), { path: file, missing: true });
    assert.throws(() => checkedDataPackage(both(), 'livemd2tex-extra-data', assets, ci), /livemd2tex-extra-data-2026\.10\.15\.vsix, the pinned livemd2tex-extra-data package, is not downloaded: on CI that fails once both data packages are pinned/);
    // Both pinned, the file there: right; or of another size or SHA-256, a failure on any machine.
    download('extra-data');
    for (const env of [laptop, ci]) {
      assert.deepEqual(checkedDataPackage(both(), 'livemd2tex-extra-data', assets, env), { path: file, missing: false });
      assert.throws(() => checkedDataPackage(both({ size: 8 }), 'livemd2tex-extra-data', assets, env), /has 7 bytes, not the pinned 8/);
      assert.throws(() => checkedDataPackage(both({ sha256: sha256('pakkage') }), 'livemd2tex-extra-data', assets, env), /is not the pinned file \(SHA-256 [0-9a-f]{64}\)/);
    }
    download('extra-data', 'pakkage');
    assert.throws(() => checkedDataPackage(both(), 'livemd2tex-extra-data', assets, laptop), /is not the pinned file/, 'same size, other bytes');
    assert.throws(() => checkedDataPackage({ sources: [{ id: 'livemd2tex-extra-data', folder: 'f', files: [{ name: 'x.zip' }] }] }, 'livemd2tex-extra-data', assets, laptop), /names no \.vsix in a folder/);
    assert.throws(() => checkedDataPackage({ sources: [{ ...dataPin('extra-data'), folder: undefined }] }, 'livemd2tex-extra-data', assets, laptop), /names no \.vsix in a folder/);
  });

  it('takes the add-on from LIVEMD2TEX_EXTRA_DATA, else from its pin, and refuses a path that names nothing', async () => {
    const { extraDataPackage } = await importScript<DataPins>('scripts/lib/data-pins.mjs');
    const assets = path.join(tmp, 'engine_assets');
    const pins = { sources: [ENGINE, dataPin('core-data'), dataPin('extra-data')] };
    const local = path.join(tmp, 'out', 'extra-data');
    mkdirSync(local, { recursive: true });
    assert.equal(extraDataPackage(pins, assets, { LIVEMD2TEX_EXTRA_DATA: local, CI: 'true' }), path.resolve(local), 'a local build comes first');
    assert.throws(() => extraDataPackage(pins, assets, { LIVEMD2TEX_EXTRA_DATA: path.join(tmp, 'nothing') }), /LIVEMD2TEX_EXTRA_DATA names nothing/);
    assert.equal(extraDataPackage({ sources: [ENGINE] }, assets, {}), null, 'nothing given, nothing pinned');
    assert.equal(extraDataPackage(pins, assets, {}), null, 'pinned, not downloaded, on a laptop');
    assert.throws(() => extraDataPackage(pins, assets, { CI: 'true' }), /not downloaded: on CI that fails/);
    const file = download('extra-data');
    assert.equal(extraDataPackage(pins, assets, { CI: 'true' }), file);
    download('extra-data', 'pakkage');
    assert.throws(() => extraDataPackage(pins, assets, {}), /is not the pinned file/);
  });

  it('stage-engine stages the pinned core data only when it is the pinned file, and skips only where the rule allows', async () => {
    const { pinnedCoreData, NotPresent } = await importScript<StageEngine>('scripts/stage-engine.mjs');
    const repo = path.join(tmp, 'repo');
    mkdirSync(path.join(repo, 'engine'), { recursive: true });
    const pin = (...sources: unknown[]) => writeFileSync(path.join(repo, 'engine', 'pins.json'), JSON.stringify({ sources: [ENGINE, ...sources] }));
    const notPresent = (re: RegExp) => (err: unknown) => err instanceof NotPresent && re.test((err as Error).message);
    pin();
    assert.throws(() => pinnedCoreData(repo, {}), notPresent(/no core-data package is pinned yet/));
    pin(dataPin('core-data'), dataPin('extra-data'));
    assert.throws(() => pinnedCoreData(repo, {}), notPresent(/the pinned core-data package livemd2tex-core-data-2026\.10\.15\.vsix is not downloaded/));
    assert.throws(
      () => pinnedCoreData(repo, { CI: 'true' }),
      (err: unknown) => !(err instanceof NotPresent) && /not downloaded: on CI that fails once both data packages are pinned/.test((err as Error).message),
    );
    const file = download('core-data');
    assert.equal(pinnedCoreData(repo, { CI: 'true' }), file);
    pin({ ...dataPin('core-data', { size: 8 }) }, dataPin('extra-data'));
    assert.throws(() => pinnedCoreData(repo, {}), (err: unknown) => !(err instanceof NotPresent) && /has 7 bytes, not the pinned 8/.test((err as Error).message));
    pin({ ...dataPin('core-data', { sha256: sha256('pakkage') }) }, dataPin('extra-data'));
    assert.throws(() => pinnedCoreData(repo, {}), (err: unknown) => !(err instanceof NotPresent) && /is not the pinned file/.test((err as Error).message));
  });

  it('engine/pins.json pins both data packages or neither, so CI never runs on half of the data', () => {
    const repoPins = JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8')) as { sources: { id: string }[] };
    const ids = repoPins.sources.filter((x) => /-data$/.test(x.id)).map((x) => x.id);
    assert.ok([0, 2].includes(ids.length), ids.join(', '));
    if (ids.length === 2) assert.deepEqual(ids.sort(), ['livemd2tex-core-data', 'livemd2tex-extra-data']);
  });

  it('core-data holds mylatexformat, for a planned preamble format, with its licence as read', () => {
    const sets = JSON.parse(readFileSync(path.join(root, 'engine', 'bundle-sets.json'), 'utf8')) as Record<string, { forOwnDocuments?: Record<string, string>; packages?: string[] }>;
    const reason = sets['core-data'].forOwnDocuments?.mylatexformat ?? '';
    assert.match(reason, /^for a format that holds a pdfLaTeX document's preamble \(planned\), which the engine host would dump /);
    assert.match(reason, /LPPL 1\.3 or later, read 2026-11-02 in the pinned snapshot's archive: mylatexformat\.ltx lines 13-17 and 24, Florent Chervet, after David Carlisle's mylatex\.ltx, line 29/);
    assert.ok(!(sets['extra-data'].packages ?? []).includes('mylatexformat'), 'not named for extra-data');
  });
});
