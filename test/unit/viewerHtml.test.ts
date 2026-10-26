// The viewer's CSP is exactly docs/DESIGN.md#live-behaviour's, and the page has no inline script.

import * as assert from 'node:assert/strict';
import { buildCsp, buildViewerHtml } from '../../src/extension/viewer/html';

const SOURCE = 'https://*.vscode-cdn.net';

describe('viewer page and CSP', () => {
  it('builds the planned policy', () => {
    assert.equal(
      buildCsp(SOURCE),
      `default-src 'none'; script-src ${SOURCE} 'wasm-unsafe-eval'; worker-src blob:; ` +
        `style-src ${SOURCE} 'unsafe-inline'; img-src ${SOURCE} blob: data:; ` +
        `font-src ${SOURCE} blob: data:; connect-src ${SOURCE}`,
    );
  });

  it('drops only wasm-unsafe-eval in the negative-control policy', () => {
    // Written out in full, not derived from the planned policy (build gate 1, G1E-17).
    assert.equal(
      buildCsp(SOURCE, 'no-wasm-eval'),
      `default-src 'none'; script-src ${SOURCE}; worker-src blob:; ` +
        `style-src ${SOURCE} 'unsafe-inline'; img-src ${SOURCE} blob: data:; ` +
        `font-src ${SOURCE} blob: data:; connect-src ${SOURCE}`,
    );
  });

  it('puts the policy in a meta tag and loads only an external module script', () => {
    const html = buildViewerHtml({
      csp: buildCsp(SOURCE),
      styles: ['https://x/a.css'],
      script: 'https://x/viewer.js',
      config: {
        pdfjs: 'https://x/pdf.mjs',
        pdfjsViewer: 'https://x/pdf_viewer.mjs',
        cMapUrl: 'https://x/cmaps/',
        standardFontDataUrl: 'https://x/standard_fonts/',
        wasmUrl: 'https://x/wasm/',
        iccUrl: 'https://x/iccs/',
        workerProbe: '"<script>"&',
      },
      title: 'T',
    });
    assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${buildCsp(SOURCE)}">`));
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    assert.deepEqual(scripts, ['<script type="module" src="https://x/viewer.js">']);
    assert.ok(!html.includes('"<script>"'), 'config must be attribute-escaped');
    assert.ok(html.includes('&lt;script&gt;') && html.includes('&amp;'));
  });
});
