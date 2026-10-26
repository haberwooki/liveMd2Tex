// Is a PDF whole? When xdvipdfmx fails, or the TeX program stops in the middle of a page, the engine leaves a
// PDF that was cut short (15 and 782 bytes in the probes of build gate 1). Such a file must not replace the last
// good PDF in the viewer, nor be written next to the source. A whole PDF made by pdfTeX or xdvipdfmx starts with
// "%PDF-" and ends with "startxref", the offset of its cross-reference section and "%%EOF"; the offset points at
// "xref" or at the cross-reference stream's "N G obj". A quick structural check, not a full parse.

const latin1 = (bytes: Uint8Array, start: number, end: number): string => {
  let s = '';
  for (let i = Math.max(0, start); i < Math.min(bytes.length, end); i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
};

/** Why `pdf` is not a whole PDF, or null when it looks whole. */
export function pdfProblem(pdf: Uint8Array): string | null {
  if (pdf.length < 64) {
    return `it is only ${pdf.length} bytes`;
  }
  if (!latin1(pdf, 0, 1024).includes('%PDF-')) {
    return 'it does not start with a PDF header';
  }
  const tail = latin1(pdf, pdf.length - 1024, pdf.length);
  const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  if (!m) {
    return 'it does not end with "startxref" and "%%EOF"';
  }
  const offset = Number(m[1]);
  if (offset <= 0 || offset >= pdf.length) {
    return 'its cross-reference offset lies outside the file';
  }
  const at = latin1(pdf, offset, offset + 32);
  if (!/^(xref|\d+\s+\d+\s+obj)/.test(at)) {
    return 'its cross-reference offset does not point at a cross-reference section';
  }
  return null;
}
