// The GitHub Actions workflows (.github/workflows), prepared before G0 and not yet run on GitHub: each one parses,
// and the matrix is the one docs/DESIGN.md#store-and-packaging sets for the private phase (Linux x64 and arm64 and Windows x64 on
// every push; Windows arm64 and Apple Silicon on release candidates), with the floor test on VS Code 1.105 and
// the marker scan over the whole history.

import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';
import { importScript, root } from '../support/helpers';

type Workflow = { on: Record<string, unknown>; jobs: Record<string, Record<string, unknown>> };
const folder = path.join(root, '.github', 'workflows');
const load = (name: string) => parse(readFileSync(path.join(folder, name), 'utf8')) as Workflow;

describe('GitHub Actions workflows (G0 preparation)', () => {
  it('every workflow parses and asks only for read access to the repository', () => {
    const files = readdirSync(folder).filter((f) => f.endsWith('.yml'));
    assert.deepEqual(files.sort(), ['bundle.yml', 'ci.yml', 'coverage.yml', 'floor.yml', 'references.yml', 'test-runner.yml']);
    for (const f of files) {
      const w = load(f) as Workflow & { permissions?: Record<string, string> };
      // The coverage measurement also reads another run's artifacts (the bundle's data packages).
      assert.deepEqual(w.permissions, f === 'coverage.yml' ? { contents: 'read', actions: 'read' } : { contents: 'read' }, f);
      assert.doesNotMatch(readFileSync(path.join(folder, f), 'utf8'), /git push|git remote add|vsce publish|ovsx publish/, f);
    }
  });

  it('the private-phase matrix: three runners on main and pull requests, Linux x64 weekly, two more on release candidates', () => {
    const ci = load('ci.yml') as Workflow & { on: { push: { branches: string[] }; pull_request: { branches: string[] } } };
    const runners = (job: string) => (ci.jobs[job].strategy as { matrix: { runner: string[] | string } }).matrix.runner;
    const everyPush = String(runners('every-push'));
    assert.ok(everyPush.includes(`github.event_name == 'schedule' && '["ubuntu-latest"]'`), everyPush);
    assert.ok(everyPush.includes(`'["ubuntu-latest", "ubuntu-24.04-arm", "windows-latest"]'`), everyPush);
    assert.deepEqual(runners('release-candidates'), ['windows-11-arm', 'macos-latest']);
    // A branch push is not run twice: pushes run on main (and tags), branches through their pull request (G2S-06).
    assert.deepEqual(ci.on.push.branches, ['main']);
    assert.deepEqual(ci.on.pull_request.branches, ['main']);
    assert.match(String(ci.jobs['release-candidates'].if), /-rc/);
    const markers = JSON.stringify(ci.jobs.markers);
    assert.match(markers, /marker-scan\.mjs --tree/);
    assert.match(markers, /marker-scan\.mjs --history/);
    assert.match(markers, /"fetch-depth":0/);
    // The markers come from a secret; a fork's pull request skips the scan with a notice (G2S-01).
    assert.ok(markers.includes('secrets.LIVEMD2TEX_PRIVATE_MARKERS'));
    assert.match(markers, /::notice::/);
    for (const job of ['every-push', 'release-candidates', 'node-24']) {
      assert.equal(ci.jobs[job].secrets, 'inherit', job);
    }
    assert.equal((ci.jobs['node-24'].with as { 'node-version': string })['node-version'], '24');
  });

  it('the runner job downloads VS Code only with the CI switch, runs Linux under xvfb, and caches the engine inputs by their pins', () => {
    const text = readFileSync(path.join(folder, 'test-runner.yml'), 'utf8');
    assert.match(text, /LIVEMD2TEX_ALLOW_VSCODE_DOWNLOAD: '1'/);
    assert.match(text, /xvfb-run -a npm run test:integration/);
    assert.match(text, /key: engine-assets-\$\{\{ hashFiles\('engine\/pins\.json'\) \}\}/);
    assert.match(text, /npm ci --omit=optional/);
    assert.ok(text.includes('!out/vsix/*-standin.vsix'));
    assert.ok(text.includes('libnss3 libgbm1'));
    assert.ok(text.includes('npm pkg set "engines.vscode=^$VSCODE_VERSION"'));
    // No workflow input inside a run line (G2R-05), and the marker secret only on the scan step (G2E-R2).
    assert.doesNotMatch(text, /run: [^\n]*\$\{\{ inputs\./);
    const job = (load('test-runner.yml').jobs.check as { env: Record<string, string>; steps: { name?: string; env?: Record<string, string> }[] });
    assert.equal(job.env.LIVEMD2TEX_PRIVATE_MARKERS, undefined);
    assert.deepEqual(job.steps.filter((s) => s.env?.LIVEMD2TEX_PRIVATE_MARKERS).map((s) => s.name), ['VSIX scans (plain package and test copy)']);
  });

  it('the floor test starts at VS Code 1.105 and goes back', () => {
    const floor = load('floor.yml') as Workflow & { on: { workflow_dispatch: { inputs: { versions: { default: string } } } } };
    const versions = JSON.parse(floor.on.workflow_dispatch.inputs.versions.default) as string[];
    assert.equal(versions[0], '1.105.0');
    assert.ok(versions.length > 1);
    // Each run accepts the version it tests, so an older VS Code fails on an API, not on the engines field (G2E-09).
    assert.equal((floor.jobs.floor.with as { floor: boolean }).floor, true);
  });
  it('B1: the bundle builds by hand only, in jobs that each keep their report; TeX Live is installed only as the reference', () => {
    type Step = { name?: string; run?: string; uses?: string; if?: string; with?: Record<string, unknown> };
    const text = readFileSync(path.join(folder, 'bundle.yml'), 'utf8');
    const bundle = load('bundle.yml');
    const jobs = bundle.jobs as Record<string, { needs?: string; if?: string; 'timeout-minutes'?: number; steps: Step[]; strategy?: { matrix: { shard: string } } }>;
    assert.deepEqual(Object.keys(bundle.on), ['workflow_dispatch']);
    // No workflow input inside a run script (G2R-05): inputs reach scripts through env.
    for (const [name, job] of Object.entries(jobs)) {
      for (const s of job.steps) {
        assert.doesNotMatch(s.run ?? '', /\$\{\{\s*inputs\./, `${name}: ${s.name ?? s.run}`);
      }
    }
    // Split, each with its own time limit (GB1E-03); the header gives the minutes (GB1E-07).
    assert.deepEqual(Object.keys(jobs), ['pin', 'fetch', 'build', 'closure', 'corpus', 'reference']);
    for (const [name, job] of Object.entries(jobs)) {
      assert.ok((job['timeout-minutes'] ?? 0) > 0 && (job['timeout-minutes'] ?? 0) <= 150, name);
    }
    assert.match(text, /^# The minutes, estimated/m);
    assert.deepEqual([jobs.build.needs, jobs.closure.needs, jobs.corpus.needs, jobs.reference.needs], ['fetch', 'build', 'build', 'corpus']);
    const at = (job: string, re: RegExp) => jobs[job].steps.findIndex((s) => re.test(`${s.name ?? ''} ${s.run ?? ''} ${s.uses ?? ''}`));
    const run = (job: string) => jobs[job].steps.map((s) => s.run ?? '').join('\n');
    // The pin: gpg verifies TeX Live's signature with the key whose fingerprint the repository pins, and the builder
    // checks the signer against that pin (GB1E-02).
    const pins = JSON.parse(readFileSync(path.join(root, 'engine', 'bundle-pins.json'), 'utf8'));
    assert.equal(pins.signingKey.fingerprint, 'C78B82D8C79512F79CC0D7C80D5E5D9106BAB6BC');
    assert.ok(at('pin', /gpg --batch --status-file .* --verify .*texlive\.tlpdb\.sha512\.asc/) >= 0);
    assert.ok(at('pin', /--stage pin --local "\$RUNNER_TEMP\/pin\/tlnet" --signed-sha512 .* --signed-by "\$SIGNED_BY"/) > at('pin', /--verify/));
    assert.match(run('pin'), /require\('\.\/engine\/bundle-pins\.json'\)\.signingKey\.fingerprint/);
    assert.doesNotMatch(text, /C78B82D8/, 'the fingerprint lives in engine/bundle-pins.json only');
    // The archives' cache is restored before the fetch and saved after it even when it fails (GB1E-03).
    const restore = at('fetch', /actions\/cache\/restore@/);
    const save = at('fetch', /actions\/cache\/save@/);
    assert.ok(restore >= 0 && restore < at('fetch', /--stage fetch/) && save > at('fetch', /--stage fetch/));
    assert.equal(jobs.fetch.steps[save].if, 'always()');
    assert.equal(jobs.build.steps[at('build', /actions\/cache\/restore@/)].with?.['fail-on-cache-miss'], true);
    // curl downloads (texlive.info's bot check admits curl, not Node); the builder only reads the downloaded copy.
    assert.match(run('fetch'), /--curl-config "\$RUNNER_TEMP\/to-fetch\.curl"[\s\S]*curl --parallel [^\n]*-K "\$RUNNER_TEMP\/to-fetch\.curl"[\s\S]*--stage fetch --local "\$CACHE" --out/);
    for (const [name, job] of Object.entries(jobs)) {
      for (const line of job.steps.flatMap((s) => (s.run ?? '').split('\n')).filter((l) => /build-bundle\.mjs --stage (pin|fetch|build)/.test(l))) {
        assert.match(line, /--local /, `${name}: ${line}`);
      }
    }
    // Every job keeps its report, also on a failure; the packages are kept 3 days, the rest 7 (GB1E-07).
    for (const [name, job] of Object.entries(jobs)) {
      const uploads = job.steps.filter((s) => s.uses?.startsWith('actions/upload-artifact@'));
      assert.ok(uploads.some((s) => s.if === 'always()'), `${name} keeps its report`);
      for (const u of uploads) {
        assert.ok(Number(u.with?.['retention-days']) <= 7, `${name}: ${u.with?.name}`);
      }
    }
    assert.equal(jobs.build.steps.find((s) => s.with?.name === 'bundle-packages')?.with?.['retention-days'], 3);
    // The packages' SHA-256 goes into the job summary in the build job, before any other job runs.
    assert.match(run('build'), /sha256sum \.\/\*\.vsix[\s\S]*GITHUB_STEP_SUMMARY/);
    // The closure test: core first, sharded over a matrix, on the packages as they ship (GB1E-03).
    assert.equal((bundle.on.workflow_dispatch as { inputs: { closure: { default: string } } }).inputs.closure.default, 'core');
    assert.match(String(jobs.closure.strategy?.matrix.shard), /\[0, 1, 2, 3\]/);
    assert.match(run('closure'), /--stage closure --closure "\$SCOPE" --shard "\$SHARD\/\$SHARDS"/);
    assert.match(run('closure'), /unzip -q .*livemd2tex-\$set-\*\.vsix 'extension\/data\/\*'/);
    // Perl only in the reference job, without root, after its installer was verified; the reference downloads the
    // corpus and the selection, not the packages (GB1E-07, GB1E-08).
    for (const [name, job] of Object.entries(jobs)) {
      const perl = job.steps.filter((s) => /\bperl\b/.test(s.run ?? ''));
      assert.equal(perl.length, name === 'reference' ? 1 : 0, name);
    }
    assert.doesNotMatch(text, /\bsudo\b/);
    assert.ok(at('reference', /install-tl-unx\.tar\.gz\.sha512\.asc/) < at('reference', /perl \.\/install-tl/));
    assert.match(run('reference'), /sha512sum -c install-tl-unx\.tar\.gz\.sha512/);
    assert.match(run('reference'), /bundle-reference\.mjs --profile "\$TL"/);
    assert.match(run('reference'), /tlmgr" install \$\(node .*bundle-reference\.mjs" --packages /);
    assert.ok(at('reference', /bundle-reference\.mjs --out/) > at('reference', /perl \.\/install-tl/));
    assert.deepEqual(
      jobs.reference.steps.filter((s) => s.uses?.startsWith('actions/download-artifact@')).map((s) => s.with?.name),
      ['bundle-corpus', 'bundle-build'],
    );
    assert.doesNotMatch(text, /scheme-full/);
  });

  it('B1: the reference installs the collections the bundle draws from and the build\'s packages, all under one folder', async () => {
    const ref = await importScript<{
      referenceProfile(sets: unknown, dir: string): string;
      referencePackages(selection: { core?: string[]; extra?: string[] }): string[];
    }>('scripts/bundle-reference.mjs');
    const sets = JSON.parse(readFileSync(path.join(root, 'engine', 'bundle-sets.json'), 'utf8'));
    const profile = ref.referenceProfile(sets, '/tmp/tl/');
    assert.match(profile, /^selected_scheme scheme-custom\nTEXDIR \/tmp\/tl\n/);
    for (const c of ['collection-basic', 'collection-latex', 'collection-latexextra', 'collection-publishers', 'collection-xetex']) {
      assert.match(profile, new RegExp(`^${c} 1$`, 'm'), c);
    }
    for (const line of profile.split('\n').filter((l) => /^TEXMF/.test(l))) {
      assert.match(line, /^TEXMF[A-Z]* \/tmp\/tl\//, line);
    }
    assert.match(profile, /^tlpdbopt_install_docfiles 0$/m);
    assert.deepEqual(ref.referencePackages({ core: ['latex', 'amsmath'], extra: ['revtex', 'latex', '$(rm -rf /)'] }), ['amsmath', 'latex', 'revtex']);
  });
  it('M5: the coverage measurement runs by hand, fetches from arXiv in one job only, and never keeps a source in an artifact', () => {
    type Step = { name?: string; run?: string; uses?: string; if?: string; id?: string; with?: Record<string, unknown> };
    type Job = { needs?: string | string[]; if?: string; 'timeout-minutes'?: number; steps: Step[]; concurrency?: { group: string; 'cancel-in-progress': boolean } };
    const text = readFileSync(path.join(folder, 'coverage.yml'), 'utf8');
    const coverage = load('coverage.yml') as Workflow & { permissions: Record<string, string> };
    const jobs = coverage.jobs as Record<string, Job>;
    assert.deepEqual(Object.keys(coverage.on), ['workflow_dispatch']);
    // Read access only; actions: read to take the data packages from a bundle run.
    assert.deepEqual(coverage.permissions, { contents: 'read', actions: 'read' });
    assert.deepEqual(Object.keys(jobs), ['pin', 'sources', 'texlive', 'compile', 'report']);
    assert.match(text, /^# The minutes, estimated/m);
    for (const [name, job] of Object.entries(jobs)) {
      // GitHub's hosted runners stop a job at 360 minutes.
      assert.ok((job['timeout-minutes'] ?? 0) > 0 && (job['timeout-minutes'] ?? 0) <= 360, name);
      for (const s of job.steps.filter((x) => x.uses?.startsWith('actions/checkout@'))) {
        assert.equal(s.with?.['persist-credentials'], false, `${name}: the checkout keeps no token in .git/config`);
      }
      for (const s of job.steps) {
        assert.doesNotMatch(s.run ?? '', /\$\{\{\s*inputs\./, `${name}: ${s.name ?? s.run}`);
      }
    }
    const run = (job: string) => jobs[job].steps.map((s) => s.run ?? '').join('\n');
    const at = (job: string, re: RegExp) => jobs[job].steps.findIndex((s) => re.test(`${s.name ?? ''} ${s.run ?? ''} ${s.uses ?? ''}`));
    // Only the sources job asks arXiv, and two runs never do it at once (arXiv's terms: one connection).
    for (const [name] of Object.entries(jobs)) {
      const fetches = /--stage (sample|fetch)\b/.test(run(name));
      assert.equal(fetches, name === 'sources', name);
    }
    assert.deepEqual(jobs.sources.concurrency, { group: 'coverage-arxiv', 'cancel-in-progress': false });
    assert.doesNotMatch(Object.keys(jobs).map(run).join('\n'), /arxiv\.org/i, 'the addresses live in engine/coverage-frame.json');
    // The sources stay in the cache: saved also on a failure, under a key of their own per attempt (a key is written
    // once), keyed by the frame alone; restored by the compile jobs from this run's newest entry; never uploaded.
    const save = at('sources', /actions\/cache\/save@/);
    assert.ok(save > at('sources', /--stage fetch/));
    assert.equal(jobs.sources.steps[save].if, 'always()');
    const sourcesKey = "coverage-sources-${{ hashFiles('engine/coverage-frame.json') }}-${{ github.run_id }}-${{ github.run_attempt }}";
    assert.equal(jobs.sources.steps[save].with?.key, sourcesKey);
    const restored = jobs.compile.steps[at('compile', /The sources the sources job fetched/)];
    assert.equal(restored.with?.key, sourcesKey);
    assert.equal(restored.with?.['restore-keys'], "coverage-sources-${{ hashFiles('engine/coverage-frame.json') }}-${{ github.run_id }}-");
    assert.equal(restored.with?.['fail-on-cache-miss'], true);
    // The job that reads untrusted sources saves no cache.
    assert.ok(!jobs.compile.steps.some((s) => /^actions\/cache(\/save)?@/.test(s.uses ?? '')), 'compile saves a cache');
    // The harvest and the fetch stop before the job does, so the save step always runs.
    for (const re of [/--stage sample/, /--stage fetch/]) {
      const t = (jobs.sources.steps[at('sources', re)] as Step & { 'timeout-minutes'?: number })['timeout-minutes'] ?? 0;
      assert.ok(t > 0 && t < (jobs.sources['timeout-minutes'] ?? 0), String(re));
    }
    for (const [name, job] of Object.entries(jobs)) {
      for (const u of job.steps.filter((s) => s.uses?.startsWith('actions/upload-artifact@'))) {
        assert.doesNotMatch(String(u.with?.path), /sources|work\/docs|\/coverage\s*$/, `${name} uploads sources`);
        assert.ok(Number(u.with?.['retention-days']) <= 7, `${name}: ${u.with?.name}`);
      }
      if (name !== 'texlive') {
        assert.ok(job.steps.some((s) => s.uses?.startsWith('actions/upload-artifact@') && s.if === 'always()'), `${name} keeps its report`);
      }
    }
    // The reference: scheme-full, its installer verified with gpg and the pinned key, installed without root.
    // install-tl (TeX Live's Perl installer) runs in the texlive job only; TeX Live's own Perl tools (repstopdf,
    // biber) run inside the reference step's sandbox below.
    for (const [name, job] of Object.entries(jobs)) {
      assert.equal(job.steps.filter((s) => /\bperl\b/.test(s.run ?? '')).length, name === 'texlive' ? 1 : 0, name);
    }
    // Root in two lines only, both in the compile job: Ghostscript from Ubuntu's archive, and the reference's
    // network namespace, which drops back to the runner's user before anything runs in it.
    const sudo = text.split('\n').filter((l) => /\bsudo\b/.test(l) && !/^\s*#/.test(l)).map((l) => l.trim());
    assert.deepEqual(sudo, [
      'sudo apt-get update -q && sudo apt-get install -y -q --no-install-recommends ghostscript',
      'sudo unshare --net --setuid "$(id -u)" --setgid "$(id -g)" -- env -i PATH="$TLBIN:/usr/bin:/bin" HOME="$RUNNER_TEMP/reference-home" CI=true LANG=C.UTF-8 "$(command -v node)" scripts/coverage.mjs --stage reference --work "$RUNNER_TEMP/work" --minutes 60',
    ]);
    assert.ok(at('compile', /install .*ghostscript/) < at('compile', /--stage reference/));
    assert.match(run('compile'), /df -h/);
    assert.ok(at('texlive', /install-tl-unx\.tar\.gz\.sha512\.asc/) < at('texlive', /perl \.\/install-tl/));
    assert.match(run('texlive'), /require\('\.\/engine\/bundle-pins\.json'\)\.signingKey\.fingerprint/);
    assert.match(run('texlive'), /--stage profile --texdir "\$TL"/);
    // The compile jobs: the extension's route with the stubs loaded, then the reference, each with its budget.
    assert.match(run('compile'), /node --require \.\/test\/stubs\/register-unit\.cjs out\/test\/engine\/coverageRun\.js .*--minutes 150/);
    assert.ok(at('compile', /--stage reference/) > at('compile', /coverageRun\.js/));
    assert.equal(jobs.compile.steps.find((s) => s.with?.name === 'bundle-packages')?.with?.['run-id'], '${{ inputs.bundle_run }}');
    assert.deepEqual(jobs.compile.needs, ['sources', 'texlive']);
    assert.equal(jobs.report.if, "always() && (inputs.job == 'measure' || inputs.job == 'rehearse')");
    // The rehearsal, the default job: texlive, compile and report on the public corpus and the probes. The sources
    // job, the only one that asks arXiv, runs for "measure" alone; the compile job builds the rehearsal's documents
    // from the repository instead of restoring the sources.
    const job = (coverage.on as { workflow_dispatch: { inputs: { job: { options: string[]; default: string } } } }).workflow_dispatch.inputs.job;
    assert.deepEqual([job.options, job.default], [['rehearse', 'measure', 'pin'], 'rehearse']);
    assert.equal(jobs.sources.if, "inputs.job == 'measure'");
    assert.equal(jobs.texlive.if, "inputs.job == 'measure' || inputs.job == 'rehearse'");
    assert.match(String(jobs.compile.if), /needs\.sources\.result == 'success' \|\| inputs\.job == 'rehearse'/);
    assert.equal(restored.if, "inputs.job == 'measure'");
    for (const name of ['compile', 'report']) {
      const step = jobs[name].steps[at(name, /--stage rehearse/)];
      assert.equal(step?.if, "inputs.job == 'rehearse'", name);
    }
    assert.ok(at('compile', /--stage rehearse/) < at('compile', /--stage prepare/));
    assert.ok(at('report', /--stage rehearse/) < at('report', /--stage report/));
    // The reference runs without network; the templates have a cache key of their own, so re-pinning one keeps the
    // arXiv sources; the report knows how many shards to expect, so a lost shard is counted.
    assert.match(jobs.compile.steps[at('compile', /--stage reference/)].run ?? '', /sudo unshare --net --setuid/);
    assert.ok(jobs.sources.steps.some((s) => s.with?.key === "coverage-templates-${{ hashFiles('engine/coverage-templates.json') }}"));
    assert.match(run('report'), /--stage report .*--shards "\$SHARDS"/);
  });
});
