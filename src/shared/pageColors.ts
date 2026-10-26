// High Contrast page colours for the PDF viewer (docs/DESIGN.md#accessibility): under a High Contrast theme the viewer
// offers pdf.js's pageColors, which draws each page in the theme's background and foreground, behind a toggle
// (some figures need their true colours). The colours come from VS Code's theme variables
// (--vscode-editor-background and --vscode-editor-foreground); pdf.js takes them as "#rrggbb". Pure, so a unit
// test checks the mapping.

export interface PageColors {
  background: string;
  foreground: string;
}

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** A CSS colour as VS Code writes theme variables ("#fff", "#ffffff", "#ffffffcc", "rgb(…)", "rgba(…)") -> "#rrggbb". */
export function cssColorToHex(value: string): string | undefined {
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,4})$/.exec(v);
  if (m) {
    return `#${[...m[1].slice(0, 3)].map((c) => c + c).join('')}`;
  }
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(v);
  if (m) {
    return `#${m[1]}`;
  }
  m = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(v);
  if (m) {
    return `#${hex2(Number(m[1]))}${hex2(Number(m[2]))}${hex2(Number(m[3]))}`;
  }
  return undefined;
}

/**
 * pdf.js's pageColors for the theme: only under High Contrast, only when the toggle is on, and only when both
 * theme colours can be read; otherwise null (the pages keep their own colours).
 */
export function pageColorsFor(highContrast: boolean, enabled: boolean, background: string, foreground: string): PageColors | null {
  if (!highContrast || !enabled) {
    return null;
  }
  const bg = cssColorToHex(background);
  const fg = cssColorToHex(foreground);
  return bg && fg && bg !== fg ? { background: bg, foreground: fg } : null;
}
