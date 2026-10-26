// The viewer page and its Content Security Policy (docs/DESIGN.md#live-behaviour). Free of the vscode module so unit
// tests check the exact policy string.

import type { ViewerConfig } from '../../shared/viewerProtocol';

/**
 * 'planned' is the policy of docs/DESIGN.md#live-behaviour. 'no-wasm-eval' drops 'wasm-unsafe-eval' and exists only as
 * the negative control of the S3 test: under it, WebAssembly must fail to compile.
 */
export type CspProfile = 'planned' | 'no-wasm-eval';

export function buildCsp(cspSource: string, profile: CspProfile = 'planned'): string {
  const scriptSrc = profile === 'planned' ? `${cspSource} 'wasm-unsafe-eval'` : cspSource;
  return [
    `default-src 'none'`,
    `script-src ${scriptSrc}`,
    `worker-src blob:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `img-src ${cspSource} blob: data:`,
    `font-src ${cspSource} blob: data:`,
    `connect-src ${cspSource}`,
  ].join('; ');
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface ViewerHtmlInput {
  csp: string;
  styles: string[];
  script: string;
  config: ViewerConfig;
  title: string;
}

export function buildViewerHtml(input: ViewerHtmlInput): string {
  const links = input.styles.map((href) => `<link rel="stylesheet" href="${escapeAttribute(href)}">`).join('\n    ');
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(input.csp)}">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${links}
    <title>${escapeAttribute(input.title)}</title>
  </head>
  <body data-config="${escapeAttribute(JSON.stringify(input.config))}">
    <div id="status" class="status" role="status" aria-live="polite"></div>
    <div id="toolbar" class="toolbar" role="toolbar" aria-label="PDF preview tools" aria-controls="slotA slotB">
      <button type="button" id="previousPage" data-command="previousPage" aria-label="Previous page" title="Previous page">&#8249;</button>
      <span id="pageInfo" class="info" aria-hidden="true"></span>
      <button type="button" id="nextPage" data-command="nextPage" aria-label="Next page" title="Next page">&#8250;</button>
      <span class="separator" aria-hidden="true"></span>
      <button type="button" id="zoomOut" data-command="zoomOut" aria-label="Zoom out" title="Zoom out (Ctrl+-)">&#8722;</button>
      <span id="zoomInfo" class="info" aria-hidden="true"></span>
      <button type="button" id="zoomIn" data-command="zoomIn" aria-label="Zoom in" title="Zoom in (Ctrl+=)">+</button>
      <button type="button" id="fitWidth" data-command="fitWidth" aria-label="Fit the page width" title="Fit the page width (Ctrl+0)">Fit width</button>
      <span class="separator" aria-hidden="true"></span>
      <button type="button" id="toSource" aria-label="Go to the source of the view's centre" title="Go to the source of the view's centre (Shift+Alt+J; or double-click a word)">Source</button>
      <button type="button" id="themeColours" data-command="toggleThemeColours" aria-pressed="false" hidden
        aria-label="Draw the pages in the theme's colours" title="Draw the pages in the High Contrast theme's colours">Theme colours</button>
    </div>
    <div id="slotA" class="slot" tabindex="0" aria-label="PDF preview"><div class="pdfViewer"></div></div>
    <div id="slotB" class="slot standby" tabindex="-1" aria-hidden="true"><div class="pdfViewer"></div></div>
    <script type="module" src="${escapeAttribute(input.script)}"></script>
  </body>
</html>
`;
}
