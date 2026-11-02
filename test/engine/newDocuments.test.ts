// "New document from template" on the engine (src/extension/templates/; docs/DESIGN.md#help-for-new-users): each
// starting document is written into a folder as the command writes it (templateFiles), then typeset the way the
// extension typesets it: a LaTeX document through the compile pipeline with the preamble scan, a Markdown
// document through the converter (with the folder config and the example preset for the preset paper) and the
// Markdown route. Each typesets with no TeX error, no undefined reference or citation, no "Missing character"
// line, and no spawn or connection. Each typesets with the core data alone, the add-on not installed: the journal
// classes (REVTeX, IEEEtran, elsarticle) and every package the templates and the example preset load are in
// core-data (engine/bundle-sets.json, "forOwnDocuments"), so the scan names nothing.
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
import { root } from '../support/helpers';
import { nodeFs } from '../support/nodeFs';
import { markdownEngineService, typesetMarkdown } from './markdownRoute';
import { analyse, record, writeResults } from './support';

const read = async (from: string) => new Uint8Array(readFileSync(path.join(root, ...from.split('/'))));

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
    assert.ok(core, 'the staged core data');
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
    it(`${t.id}: ${t.label}`, async () => {
      assert.equal(t.extra ?? false, false, `${t.id}: a template that needs the add-on (none does)`);
      const folder = await materialize(t);
      const bib = t.files.some((f) => f.to.endsWith('.bib'));
      // The core data alone: the extension's own documents never need the add-on.
      const packages = packageContext(core as NonNullable<typeof core>, []);

      if (t.kind === 'tex') {
        const prepared = await prepareCompile({ fs: nodeFs(folder), mainRel: t.main, engineSetting: 'pdflatex', packages });
        assert.deepEqual(prepared.packageScan?.missing.map((m) => m.file) ?? [], [], `${t.id}: reported missing`);
        const result = await compile(prepared.job);
        const errors = diagnosticsFor(result, prepared).filter((d) => d.severity === 'error').map((d) => `${d.file}:${d.line}: ${d.message}`);
        assertClean(t.id, result, errors, bib);
        if (t.id === 'tex-beamer') {
          assert.ok((analyse(result).pages ?? 0) >= 4, 'tex-beamer: a title page and three slides');
        }
        return;
      }

      const text = readFileSync(path.join(folder, t.main), 'utf8');
      const typeset = await typesetMarkdown(service, nodeFs(folder), t.main, text, folderOptions(folder, t.main), packages);
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
