// "New document from template" on the engine (src/extension/templates/; docs/DESIGN.md#help-for-new-users): each
// starting document is written into a folder as the command writes it (templateFiles), then typeset the way the
// extension typesets it: a LaTeX document through the compile pipeline with the preamble scan, a Markdown
// document through the converter (with the folder config and the example preset for the preset paper) and the
// Markdown route. Each typesets with no TeX error, no undefined reference or citation, no "Missing character"
// line, and no spawn or connection. The journal classes are not in the core data: the scan names the class
// before the compile, and with the class files from the pinned CTAN set (standing in for the add-on) the
// document typesets.
// Results (numbers only) go to ../s1_runs/.

import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { metaDefaults, parseFolderConfig } from '../../src/converter/config';
import type { ConvertOptions } from '../../src/converter/markdownToLatex';
import { modeForFile, parsePresetFile, resolveMode } from '../../src/converter/preset/load';
import { diagnosticsFor, prepareCompile } from '../../src/extension/compile/pipeline';
import { packageContext, readCoreData } from '../../src/extension/engine/dataSets';
import type { EngineService } from '../../src/extension/engine/engineService';
import { TEMPLATES, templateFiles, type DocumentTemplate } from '../../src/extension/templates/catalog';
import type { CompileResult } from '../../src/shared/engineJobs';
import { EXTRA_DATA_NAME } from '../../src/shared/identity';
import { root } from '../support/helpers';
import { nodeFs } from '../support/nodeFs';
import { haveCtanClasses, journalClassFiles, type JournalClass } from './classFiles';
import { markdownEngineService, typesetMarkdown } from './markdownRoute';
import { analyse, record, writeResults } from './support';

const read = async (from: string) => new Uint8Array(readFileSync(path.join(root, ...from.split('/'))));

/** What the scan lists for each journal template (the class, and the .bst its \bibliographystyle names), and its CTAN files. */
const JOURNAL: Record<string, { missing: string[]; files: JournalClass }> = {
  revtex: { missing: ['revtex4-2.cls'], files: 'revtex' }, // the class names its own .bst
  ieeetran: { missing: ['IEEEtran.cls', 'IEEEtran.bst'], files: 'ieeetran' },
  elsarticle: { missing: ['elsarticle.cls', 'elsarticle-num.bst'], files: 'elsarticle' },
};

/** The converter options the extension takes from a folder config and its preset (markdown/conversion.ts). */
function folderOptions(folder: string, main: string): ConvertOptions {
  const configFile = path.join(folder, '.latexpreview.json');
  if (!existsSync(configFile)) {
    return {};
  }
  const { config, problems } = parseFolderConfig(readFileSync(configFile, 'utf8'));
  assert.deepEqual(problems, []);
  if (!config.markdown.preset) {
    return { defaults: metaDefaults(config) };
  }
  const presetFile = path.join(folder, ...config.markdown.preset.split('/'));
  const parsed = parsePresetFile(readFileSync(presetFile, 'utf8'));
  assert.ok(parsed.preset, parsed.problems.join('; '));
  const modeName = config.markdown.mode ?? modeForFile(parsed.preset, main);
  assert.ok(modeName, `no preset mode for ${main}`);
  const files: Record<string, string> = {};
  for (const spec of [parsed.preset.defaults ?? {}, ...Object.values(parsed.preset.modes)]) {
    for (const name of [spec.preambleFile, spec.xetexPreambleFile]) {
      if (typeof name === 'string') {
        files[name] = readFileSync(path.join(path.dirname(presetFile), name), 'utf8');
      }
    }
  }
  const resolved = resolveMode(parsed.preset, modeName, files, config.markdown.presetOverrides);
  assert.deepEqual(resolved.problems, []);
  const appendix = resolved.appendixEntry ? readFileSync(path.join(folder, resolved.appendixEntry), 'utf8') : undefined;
  return { defaults: metaDefaults(config), preset: resolved.mode, appendix };
}

describe('New document from template: each starting document typesets as the command writes it', function () {
  this.timeout(1800000);
  let service: EngineService;
  let tmp = '';
  let core: Awaited<ReturnType<typeof readCoreData>> = null;
  const compile = async (j: Parameters<EngineService['compile']>[0]): Promise<CompileResult> => (await service.compile(j)).result;

  before(async function () {
    const s = markdownEngineService();
    if (!s) {
      this.skip(); // needs node scripts/stage-engine.mjs --data after the build
    }
    service = s as EngineService;
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-new-'));
    core = await readCoreData(path.join(root, 'dist', 'data'));
  });

  after(async () => {
    await service?.stop();
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`      results: ${writeResults()}`);
  });

  /** Writes the template's files as the command does, into a folder of its own. */
  async function materialize(t: DocumentTemplate): Promise<string> {
    const folder = path.join(tmp, t.id, t.folder);
    for (const f of await templateFiles(t, read)) {
      const file = path.join(folder, ...f.to.split('/'));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, f.data);
    }
    return folder;
  }

  async function addClass(t: DocumentTemplate, folder: string): Promise<void> {
    const journal = JOURNAL[t.id.replace(/^(tex|md)-/, '')];
    for (const f of await journalClassFiles(journal.files, compile)) {
      writeFileSync(path.join(folder, f.path), f.data);
    }
  }

  function assertClean(name: string, result: CompileResult, errors: string[], expectBibtex: boolean) {
    assert.ok(result.pdf, `${name}: no PDF (${result.error ?? ''})\n${result.log.split('\n').slice(-20).join('\n')}`);
    assert.deepEqual(errors, [], `${name}: TeX errors`);
    assert.equal(analyse(result).undefinedRefs, 0, `${name}: undefined references or citations`);
    assert.equal(result.bibtexRan, expectBibtex, `${name}: bibtex8 ${expectBibtex ? 'did not run' : 'ran'}`);
    assert.deepEqual(result.stubs?.blocked, [], `${name}: the compile worker tried to spawn or connect`);
    record(`M4-new-${name}`, { pages: analyse(result).pages, passes: result.passes, ms: result.timings.totalMs });
    console.log(`      ${name}: ${analyse(result).pages} page(s), ${result.passes} pass(es)${result.bibtexRan ? ' + bibtex8' : ''}, ${result.timings.totalMs} ms`);
  }

  for (const t of TEMPLATES) {
    it(`${t.id}: ${t.label}`, async function () {
      if (t.extra && !haveCtanClasses()) {
        this.skip(); // the journal classes come from the pinned CTAN set (npm run engine:assets)
      }
      const folder = await materialize(t);
      const bib = t.files.some((f) => f.to.endsWith('.bib'));

      if (t.kind === 'tex') {
        const packages = core ? packageContext(core, []) : undefined;
        let prepared = await prepareCompile({ fs: nodeFs(folder), mainRel: t.main, engineSetting: 'pdflatex', packages });
        const missing = prepared.packageScan?.missing ?? [];
        if (t.extra) {
          // What the user sees first: the scan names the class (and its .bst). It offers the add-on for each file
          // the core manifest lists there; until B1 that list is the stand-in add-on's (REVTeX only), and the
          // other files get the CTAN route.
          const journal = JOURNAL[t.id.replace(/^tex-/, '')];
          if (core) {
            assert.deepEqual(missing.map((m) => m.file), journal.missing, `${t.id}: the scan's list`);
            for (const m of missing) {
              const listed = core.elsewhere.some((set) => set.id === EXTRA_DATA_NAME && m.file in set.files);
              assert.equal(m.offer?.id, listed ? EXTRA_DATA_NAME : undefined, `${t.id}: the offer for ${m.file}`);
            }
            record(`M4-new-${t.id}-scan`, missing.map((m) => ({ file: m.file, offer: m.offer?.id ?? null })));
          }
          await addClass(t, folder);
          prepared = await prepareCompile({ fs: nodeFs(folder), mainRel: t.main, engineSetting: 'pdflatex', packages });
        }
        assert.deepEqual(prepared.packageScan?.missing.map((m) => m.file) ?? [], [], `${t.id}: reported missing`);
        const result = await compile(prepared.job);
        const errors = diagnosticsFor(result, prepared).filter((d) => d.severity === 'error').map((d) => `${d.file}:${d.line}: ${d.message}`);
        assertClean(t.id, result, errors, bib);
        if (t.id === 'tex-beamer') {
          assert.ok((analyse(result).pages ?? 0) >= 4, 'tex-beamer: a title page and three slides');
        }
        return;
      }

      if (t.extra) {
        await addClass(t, folder);
      }
      const text = readFileSync(path.join(folder, t.main), 'utf8');
      const typeset = await typesetMarkdown(service, nodeFs(folder), t.main, text, folderOptions(folder, t.main));
      assert.deepEqual(typeset.conversion.diagnostics.filter((d) => d.kind === 'unsupported').map((d) => d.message), [], `${t.id}: unsupported constructs`);
      assert.deepEqual(typeset.missing, [], `${t.id}: Missing character lines`);
      const errors = typeset.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.file}:${d.line}: ${d.message}`);
      assertClean(t.id, typeset.result, errors, bib);
      if (t.id === 'md-preset-paper') {
        // The preset's paper mode: two columns, the Methods appendix after the bibliography.
        assert.match(typeset.conversion.latex, /twocolumn/);
        assert.match(typeset.conversion.latex, /Methods/);
      }
      if (t.id === 'md-notes') {
        assert.equal(typeset.conversion.engine, 'xelatex');
      }
    });
  }
});
