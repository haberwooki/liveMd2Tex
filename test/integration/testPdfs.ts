// Public test PDFs for the S3 viewer spike, generated in memory with pdf-lib (MIT); nothing is downloaded and
// no private PDF is used. Every version has the same layout; only a version tag in each line changes, so a
// swap that keeps the reading position shows the same line with the new tag.

import {
  PDFDocument,
  StandardFonts,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from 'pdf-lib';

export const PAGE_HEIGHT = 792;
export const FIRST_BASELINE = 720;
export const LEADING = 16;
export const LINES_PER_PAGE = 40;
export const PAGES = 5;

/** PDF y of the baseline of a 1-based line on any page. */
export const baselineOf = (line: number): number => FIRST_BASELINE - (line - 1) * LEADING;

/** The label that starts every line: "P3 L17". */
export const labelOf = (text: string | null): string => (text ?? '').split(' ').slice(0, 2).join(' ');

/**
 * A minimal JPEG 2000 codestream, written by hand: an 8 x 8 grey image with one tile, no wavelet levels and
 * one empty packet, so it decodes to flat mid-grey. Its only job is to make pdf.js load its OpenJPEG
 * WebAssembly decoder from wasmUrl.
 */
export const TINY_J2K = Uint8Array.from([
  0xff, 0x4f, // SOC
  0xff, 0x51, 0x00, 0x29, // SIZ, length 41
  0x00, 0x00, // Rsiz
  0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x08, // image 8 x 8
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // image offset
  0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x08, // tile 8 x 8
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // tile offset
  0x00, 0x01, // one component
  0x07, 0x01, 0x01, // 8-bit unsigned, no subsampling
  0xff, 0x52, 0x00, 0x0c, // COD, length 12
  0x00, // default precincts
  0x00, 0x00, 0x01, 0x00, // LRCP, one layer, no colour transform
  0x00, 0x04, 0x04, 0x00, 0x01, // no decomposition, 64 x 64 code-blocks, style 0, 5-3 reversible
  0xff, 0x5c, 0x00, 0x04, 0x40, 0x40, // QCD: no quantisation, 2 guard bits; LL exponent 8
  0xff, 0x90, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0f, 0x00, 0x01, // SOT: tile 0, 15 bytes, part 1 of 1
  0xff, 0x93, // SOD
  0x00, // one empty packet
  0xff, 0xd9, // EOC
]);

export async function makeTestPdf(version: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Viewer spike test document, version ${version}`);
  doc.setProducer('pdf-lib (test generator)');
  doc.setCreationDate(new Date(Date.UTC(2026, 0, 1)));
  doc.setModificationDate(new Date(Date.UTC(2026, 0, 1)));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= PAGES; p++) {
    const page = doc.addPage([612, PAGE_HEIGHT]);
    if (p === 1) {
      const image = doc.context.register(
        doc.context.stream(TINY_J2K, {
          Type: 'XObject',
          Subtype: 'Image',
          Width: 8,
          Height: 8,
          ColorSpace: 'DeviceGray',
          BitsPerComponent: 8,
          Filter: 'JPXDecode',
        }),
      );
      const name = page.node.newXObject('Jpx', image);
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(32, 0, 0, 32, 480, 735), drawObject(name), popGraphicsState());
    }
    for (let l = 1; l <= LINES_PER_PAGE; l++) {
      page.drawText(`P${p} L${l} v${version} The quick brown fox jumps over the lazy dog.`, {
        x: 72,
        y: baselineOf(l),
        size: 12,
        font,
        color: rgb(0, 0, 0),
      });
    }
  }
  return doc.save({ useObjectStreams: false });
}
