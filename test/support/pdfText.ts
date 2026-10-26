// The text layer of a PDF, as the extension's viewer (pdf.js, pdfjs-dist) reads it: every page's text items
// joined, a line break after each item that ends a line. For the M1 checks that a character or a name is whole
// in the PDF's text, not just drawn.

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers';

interface TextItem {
  str: string;
  hasEOL?: boolean;
}

interface PdfJs {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(src: Record<string, unknown>): {
    promise: Promise<{ numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }> }>;
    destroy(): Promise<void>;
  };
}

export async function pdfText(pdf: Uint8Array): Promise<string> {
  const build = path.join(root, 'node_modules', 'pdfjs-dist', 'legacy', 'build');
  const pdfjs = (await import(pathToFileURL(path.join(build, 'pdf.mjs')).href)) as PdfJs;
  // In VS Code's extension host pdf.js does not take the process for Node and asks where its worker is; it then
  // runs that file in this thread (no Worker exists there).
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(build, 'pdf.worker.mjs')).href;
  }
  const task = pdfjs.getDocument({ data: pdf.slice(), verbosity: 0, isEvalSupported: false, useSystemFonts: false, disableFontFace: true });
  const doc = await task.promise;
  let out = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const item of content.items as TextItem[]) {
      if (typeof item.str === 'string') {
        out += item.str + (item.hasEOL ? '\n' : '');
      }
    }
    out += '\n';
  }
  await task.destroy();
  return out;
}

/** The text without any white space, for comparisons that line breaks and spacing must not upset. */
export function squeeze(text: string): string {
  return text.replace(/\s+/g, '');
}
