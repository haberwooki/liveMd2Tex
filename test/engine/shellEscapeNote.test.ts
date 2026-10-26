// epstopdf's "Shell escape feature is not enabled" note (docs/DESIGN.md#help-for-new-users): every pdfLaTeX
// document that loads graphicx gets it, because the extension never runs outside programs. It matters only to an
// .eps figure, so it is left out when the project has no .eps file, and shown with plain help when it has one;
// the failed conversion of an .eps figure gets its own help.
// The two fixtures in test/fixtures/shell-escape/ (CC0) go through the extension's own compile route: the
// pipeline, the engine service with its stubs, and the runner's withErrorHelp.

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { withErrorHelp } from '../../src/extension/diagnostics/errorHelp';
import { diagnosticsFor, prepareCompile } from '../../src/extension/compile/pipeline';
import type { EngineService } from '../../src/extension/engine/engineService';
import { root } from '../support/helpers';
import { nodeFs } from '../support/nodeFs';
import { markdownEngineService } from './markdownRoute';

describe("epstopdf's shell-escape note, on the engine", function () {
  this.timeout(600000);
  let service: EngineService;

  before(function () {
    const s = markdownEngineService();
    if (!s) {
      this.skip(); // needs node scripts/stage-engine.mjs --data after the build
    }
    service = s as EngineService;
  });

  after(async () => {
    await service?.stop();
  });

  /** The fixture's problems as TeX gives them, and as the Problems panel shows them. */
  async function problems(name: string) {
    const folder = path.join(root, 'test', 'fixtures', 'shell-escape', name);
    const prepared = await prepareCompile({ fs: nodeFs(folder), mainRel: 'main.tex', engineSetting: 'pdflatex' });
    const { result } = await service.compile(prepared.job);
    const raw = diagnosticsFor(result, prepared);
    return { raw, shown: withErrorHelp(raw, prepared.job.files.map((f) => f.path)) };
  }
  const note = (d: { message: string }) => /Shell escape feature is not enabled/.test(d.message);

  it('is left out for a document with no .eps file', async () => {
    const { raw, shown } = await problems('no-eps');
    assert.ok(raw.some(note), 'TeX no longer writes the note; this test proves nothing');
    assert.deepEqual(shown.filter(note), []);
  });

  it('with an .eps figure, the failed conversion says why and what to do; the note, if any, has help too', async () => {
    const { shown } = await problems('with-eps');
    // epstopdf tries the conversion (its program is never run) and pdfTeX misses the converted file.
    const missed = shown.find((d) => d.severity === 'error' && /figure-eps-converted-to\.pdf/.test(d.message));
    assert.ok(missed, shown.map((d) => d.message).join(' | '));
    assert.equal(missed.help?.id, 'file-not-found');
    assert.match(missed.help?.help ?? '', /The \.eps figure figure\.eps was not turned into PDF.*PDF copy beside it/);
    for (const d of shown.filter(note)) {
      assert.equal(d.help?.id, 'eps-needs-pdf-copy');
    }
  });
});
