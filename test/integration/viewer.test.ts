// S3 viewer spike (docs/DESIGN.md#testing): pdf.js in a webview panel.
//   - A PDF is swapped five times and the reading position stays within one text line.
//   - WebAssembly instantiates under the planned CSP (default-src 'none'; scripts from the webview's
//     cspSource with 'wasm-unsafe-eval'; worker-src blob:), and pdf.js loads its own OpenJPEG WebAssembly from
//     the in-extension wasmUrl and its standard font from the in-extension standardFontDataUrl.
//   - Nothing the page or the pdf.js worker loads comes from outside the extension.
//   - Negative control: without 'wasm-unsafe-eval' the same page cannot compile WebAssembly.

import * as assert from 'node:assert/strict';
import type { TestApi } from '../../src/extension/extension';
import { activateExtension, ownAttempts, reportBlocked, stubState } from './support';
import { LEADING, baselineOf, labelOf, makeTestPdf } from './testPdfs';
import { WORKER_PROBE } from './workerProbe';

describe('S3 viewer spike (pdf.js in a webview)', function () {
  this.timeout(180000);
  let api: TestApi;
  let pdfs: Uint8Array[];

  before(async () => {
    api = await activateExtension();
    pdfs = await Promise.all([0, 1, 2, 3, 4, 5].map((v) => makeTestPdf(v)));
  });

  after(() => reportBlocked('after the viewer tests'));

  it('swaps a PDF five times, keeps the position within one text line, and loads only extension files', async () => {
    const blockedBefore = stubState().blocked.length;
    const panel = api.openViewer({ title: 'S3 spike', workerProbe: WORKER_PROBE });
    try {
      const ready = await panel.ready;
      assert.equal(ready.error, undefined, ready.error);
      assert.equal(ready.pdfjsVersion, '6.4.299');
      assert.equal(ready.csp, panel.csp, 'the page runs under the policy the extension set');
      assert.ok(ready.csp.startsWith("default-src 'none'; script-src "), ready.csp);
      assert.ok(ready.csp.includes("'wasm-unsafe-eval'"), ready.csp);
      assert.ok(ready.csp.includes('worker-src blob:'), ready.csp);
      assert.deepEqual(ready.wasm, { ok: true, result: 5 }, 'WebAssembly instantiated under the CSP');

      const first = await panel.load(pdfs[0]);
      assert.equal(first.pages, 5);
      assert.equal(first.before, null);

      // Put line 17 of page 3 at the top: the view's top edge 3 points above the line's text.
      const top = baselineOf(17) + 12;
      const scrolled = await panel.scrollTo(3, top);
      assert.equal(scrolled.location?.pageNumber, 3);
      assert.ok(Math.abs((scrolled.location?.top ?? 0) - top) < 1, `scrolled to ${JSON.stringify(scrolled.location)}`);
      assert.equal(labelOf(scrolled.line), 'P3 L17', `first visible line: ${scrolled.line}`);

      const swaps = [];
      for (let v = 1; v <= 5; v++) {
        const r = await panel.load(pdfs[v]);
        swaps.push(r);
        assert.ok(r.before && r.after, `swap ${v}: no position`);
        assert.equal(r.after.pageNumber, r.before.pageNumber, `swap ${v}: page changed`);
        const drift = Math.abs(r.after.top - r.before.top);
        assert.ok(drift < LEADING, `swap ${v}: moved ${drift.toFixed(2)} pt, more than one line (${LEADING} pt)`);
        assert.equal(labelOf(r.lineAfter), labelOf(r.lineBefore), `swap ${v}: first visible line changed`);
        assert.ok(r.lineAfter?.includes(` v${v} `), `swap ${v}: the new version is not on screen: ${r.lineAfter}`);
      }

      const state = await panel.state();
      assert.equal(state.liveDocuments, 1, 'the old documents were destroyed');
      // Browsers decode the "%2B" in the webview resource host; compare normalised URLs.
      const base = new URL(panel.resourceBase).href;
      const inside = (u: string) => new URL(u).href.startsWith(base);
      const outside = state.resources.filter((u) => !inside(u) && !u.startsWith('blob:'));
      assert.deepEqual(outside, [], 'the page loaded something from outside the extension');

      // The worker loads nothing by URL (useWorkerFetch off; see src/webview/viewer.ts). pdf.js fetched the
      // standard font and its OpenJPEG WebAssembly on the page, from inside the extension, and the worker
      // compiled the WebAssembly.
      const probe = state.workerProbe;
      const workerLoads = probe.filter((p) => p.kind === 'xhr' || p.kind === 'fetch');
      assert.deepEqual(workerLoads, [], 'the pdf.js worker tried to load a file by URL');
      const fonts = state.resources.filter((u) => u.includes('/standard_fonts/'));
      assert.ok(fonts.length > 0, `no standard font loaded from standardFontDataUrl: ${JSON.stringify(state.resources)}`);
      const jpx = state.resources.filter((u) => u.endsWith('/wasm/openjpeg.wasm'));
      assert.equal(jpx.length, 1, 'pdf.js did not load its OpenJPEG WebAssembly from wasmUrl');
      const compiled = probe.filter((p) => p.kind === 'wasm');
      assert.ok(compiled.some((p) => p.ok === true), `no WebAssembly compiled in the worker: ${JSON.stringify(probe)}`);
      assert.deepEqual(compiled.filter((p) => p.ok === false), [], 'a WebAssembly compile failed in the worker');
      assert.deepEqual(panel.errors, []);
      assert.deepEqual(
        ownAttempts(stubState(), blockedBefore).map((b) => `${b.kind}: ${b.detail}`),
        [],
        'the extension tried to spawn or connect',
      );

      console.log(`      CSP: ${ready.csp}`);
      console.log(`      swap times (ms): ${swaps.map((s) => s.ms).join(', ')}`);
      console.log(
        `      drift (pt): ${swaps.map((s) => Math.abs((s.after.top ?? 0) - (s.before?.top ?? 0)).toFixed(3)).join(', ')}`,
      );
      console.log(`      first visible line before and after swap 5: "${swaps[4].lineBefore}" -> "${swaps[4].lineAfter}"`);
      console.log(`      worker WebAssembly: ${compiled.map((p) => `${p.detail} ${p.bytes ?? ''} ${p.ok}`).join('; ')}`);
      console.log(
        `      page resources (${state.resources.length}, all inside the extension): ` +
          state.resources.map((u) => new URL(u).href.slice(base.length)).join(', '),
      );
      console.log(`      viewer log: ${panel.log.join(' | ')}`);
    } catch (err) {
      console.log(`      viewer log: ${JSON.stringify(panel.log)}\n      viewer errors: ${JSON.stringify(panel.errors)}`);
      throw err;
    } finally {
      panel.dispose();
    }
  });

  it("cannot compile WebAssembly when the CSP lacks 'wasm-unsafe-eval' (negative control)", async () => {
    const panel = api.openViewer({ title: 'S3 negative control', cspProfile: 'no-wasm-eval' });
    try {
      const ready = await panel.ready;
      assert.ok(!ready.csp.includes('wasm-unsafe-eval'), ready.csp);
      assert.equal(ready.wasm.ok, false, 'WebAssembly compiled without wasm-unsafe-eval: the CSP is not enforced');
      console.log(`      without wasm-unsafe-eval: ${ready.wasm.error}`);
    } finally {
      panel.dispose();
    }
  });
});
