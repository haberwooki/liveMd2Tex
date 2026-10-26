// The S3 test PDFs, read back with pdf.js under plain Node (under the stubs): five pages, the labelled lines in
// order, and a JPEG 2000 image that pdf.js decodes with its own OpenJPEG WebAssembly. This checks the
// generator and the hand-written codestream without opening a VS Code window.

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { labelOf, makeTestPdf } from '../integration/testPdfs';
import { root, stubState } from '../support/helpers';

interface TextItem {
  str?: string;
}
interface PdfPage {
  getTextContent(): Promise<{ items: TextItem[] }>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  objs: { get(id: string, callback: (data: unknown) => void): void };
}
interface PdfJs {
  OPS: Record<string, number>;
  getDocument(src: object): {
    promise: Promise<{ numPages: number; getPage(n: number): Promise<PdfPage>; loadingTask: { destroy(): Promise<void> } }>;
  };
}

describe('S3 test PDFs read back with pdf.js under Node', function () {
  this.timeout(60000);

  it('have five pages, labelled lines, and a JPEG 2000 image that pdf.js decodes with its WebAssembly', async () => {
    const state = stubState();
    state.clearBlocked();
    // pdf.js's legacy build: the modern one needs Promise.try, which Node 22 lacks (the webview's Chromium has it).
    const pdfjsRoot = path.join(root, 'node_modules', 'pdfjs-dist');
    const legacy = pathToFileURL(path.join(pdfjsRoot, 'legacy', 'build', 'pdf.mjs')).href;
    const pdfjs = (await import(legacy)) as PdfJs;
    const data = await makeTestPdf(2);
    const doc = await pdfjs.getDocument({
      data,
      // pdf.js wants folder URLs that end in "/".
      wasmUrl: `${path.join(pdfjsRoot, 'wasm').split(path.sep).join('/')}/`,
      standardFontDataUrl: `${path.join(pdfjsRoot, 'standard_fonts').split(path.sep).join('/')}/`,
      useSystemFonts: false,
      verbosity: 0,
    }).promise;
    try {
      assert.equal(doc.numPages, 5);
      const page3 = await doc.getPage(3);
      const lines = (await page3.getTextContent()).items.map((i) => i.str ?? '').filter((s) => s.trim());
      assert.equal(lines.length, 40);
      assert.equal(labelOf(lines[16]), 'P3 L17');
      assert.ok(lines[16].includes(' v2 '));

      const page1 = await doc.getPage(1);
      const ops = await page1.getOperatorList();
      const paint = ops.fnArray.indexOf(pdfjs.OPS.paintImageXObject);
      assert.ok(paint >= 0, 'page 1 paints no image: the JPEG 2000 codestream did not decode');
      // Image data arrives from the worker asynchronously; the callback form waits for it.
      const image = (await new Promise<unknown>((resolve) => page1.objs.get(String(ops.argsArray[paint][0]), resolve))) as {
        width: number;
        height: number;
        data?: Uint8Array;
      };
      assert.equal(image.width, 8);
      assert.equal(image.height, 8);
      if (image.data) {
        const values = new Set(image.data);
        assert.ok([...values].every((v) => v >= 120 && v <= 136 || v === 255), `not mid-grey: ${[...values].slice(0, 8)}`);
      }
    } finally {
      await doc.loadingTask.destroy();
    }
    assert.deepEqual(state.blocked, [], 'pdf.js tried to spawn or connect under Node');
  });
});
