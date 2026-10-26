// The PDF viewer page (runs inside the webview; S3 spike, docs/DESIGN.md#live-behaviour).
//
// - pdf.js's PDFViewer, double-buffered: a new PDF renders in a hidden slot at the old reading position, then
//   the slots swap and the old document is destroyed.
// - pdf.js runs in a module worker built from a blob: URL (CSP worker-src blob:) holding the worker's source
//   text, which the extension sends. A worker cannot load files by URL here: VS Code 1.141's webview service
//   worker routes a resource request by the requesting page's webview id, which a blob: worker lacks, so the
//   request waits 30 s and fails with 408 (it is answered inside VS Code and never reaches the network).
// - So useWorkerFetch is off: pdf.js loads cMaps, standard fonts and its WASM decoders on this page's main
//   thread, from cMapUrl, standardFontDataUrl and wasmUrl inside the extension, and hands them to the worker,
//   which compiles the WASM. (pdf.js 6.4 then skips ICC colour management; CMYK uses its built-in conversion.)
// - The page's own code fetches nothing; every load goes through pdf.js to the extension's own files.

import type * as PdfJs from 'pdfjs-dist';
import type * as PdfJsViewer from 'pdfjs-dist/web/pdf_viewer.mjs';
import { TINY_WASM_ADD } from '../shared/engineProtocol';
import type {
  FromViewer,
  PagePoint,
  ToViewer,
  ViewerCommand,
  ViewerConfig,
  ViewLocation,
  WasmResult,
  WorkerProbeRecord,
} from '../shared/viewerProtocol';
import type { Rect } from '../synctex/parser';
import { pageColorsFor, type PageColors } from '../shared/pageColors';

/**
 * A page view, with pdf.js's own types (PDFViewer.getPageView is typed "any"): a method pdf.js drops then fails the
 * type check instead of the viewer (build gate 1, G1B-S-06).
 */
type PageView = PdfJsViewer.PDFPageView;

interface TextItemLike {
  str?: string;
  transform?: number[];
  width?: number;
}

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState?(): unknown; setState?(state: unknown): void };

const vscodeApi = acquireVsCodeApi();
const post = (msg: FromViewer): void => vscodeApi.postMessage(msg);
const log = (message: string): void => post({ type: 'log', message });
const config = JSON.parse(document.body.dataset.config ?? '{}') as ViewerConfig;

// Every message from the extension arrives here; the worker source is taken out first, the rest is queued
// until the page is ready to handle it.
const inbox: ToViewer[] = [];
let deliver: ((msg: ToViewer) => void) | null = null;
let workerSource: Promise<Uint8Array> | null = null;
let resolveWorkerSource: ((data: Uint8Array) => void) | null = null;
window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as ToViewer;
  if (msg.type === 'workerSource') {
    if (!(msg.data instanceof Uint8Array)) {
      log(`the worker source arrived as ${Object.prototype.toString.call(msg.data)}, not as bytes`);
    }
    resolveWorkerSource?.(msg.data);
    return;
  }
  if (deliver) {
    deliver(msg);
  } else {
    inbox.push(msg);
  }
});

function requestWorkerSource(): Promise<Uint8Array> {
  workerSource ??= new Promise<Uint8Array>((resolve) => {
    resolveWorkerSource = resolve;
    post({ type: 'needWorkerSource' });
  });
  return workerSource;
}

/** Resolves when pdf.js's worker has loaded (it posts a "ready" message); rejects on error or timeout. */
function workerReady(worker: Worker, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the pdf.js worker did not start within ${ms} ms`)), ms);
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { sourceName?: string; action?: string } | undefined;
      if (data?.sourceName === 'worker' && data.action === 'ready') {
        clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        resolve();
      }
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', (event: ErrorEvent) => {
      clearTimeout(timer);
      reject(new Error(`the pdf.js worker failed: ${event.message || 'error event'}`));
    });
  });
}

interface Slot {
  el: HTMLDivElement;
  eventBus: PdfJsViewer.EventBus;
  linkService: PdfJsViewer.PDFLinkService;
  viewer: PdfJsViewer.PDFViewer;
  doc: PdfJs.PDFDocumentProxy | null;
  drawn: Set<number>;
  textDone: Set<number>;
  /** The page colours its viewer was made with ("" for the pages' own). */
  colors: string;
  /** The tag of the PDF in this slot (sent with the load message, reported with each click). */
  tag?: number;
}

interface VisiblePages {
  views: { id: number }[];
}

/** WebAssembly under this page's CSP: compiles and runs only if script-src allows 'wasm-unsafe-eval'. */
async function wasmCheck(): Promise<WasmResult> {
  try {
    const { instance } = await WebAssembly.instantiate(TINY_WASM_ADD);
    const add = instance.exports.add as (a: number, b: number) => number;
    return { ok: true, result: add(2, 3) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function setStatus(text: string): void {
  const el = document.getElementById('status');
  if (el) {
    el.textContent = text;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

async function main(): Promise<void> {
  const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '';
  const wasm = await wasmCheck();

  let pdfjsLib: typeof PdfJs;
  let viewerLib: typeof PdfJsViewer;
  try {
    pdfjsLib = (await import(config.pdfjs)) as typeof PdfJs;
    (globalThis as unknown as { pdfjsLib: typeof PdfJs }).pdfjsLib = pdfjsLib;
    viewerLib = (await import(config.pdfjsViewer)) as typeof PdfJsViewer;
  } catch (err) {
    post({ type: 'ready', csp, wasm, pdfjsVersion: null, error: `pdf.js failed to load: ${String(err)}` });
    return;
  }

  // The pdf.js worker, built from its source text (see the header).
  const probe: WorkerProbeRecord[] = [];
  let worker: Worker;
  try {
    const source = await requestWorkerSource();
    const workerUrl = URL.createObjectURL(
      new Blob([config.workerProbe ?? '', '\n', source as BlobPart], { type: 'text/javascript' }),
    );
    worker = new Worker(workerUrl, { type: 'module', name: 'pdfjs-worker' });
    worker.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { livemd2texProbe?: WorkerProbeRecord } | undefined;
      if (data?.livemd2texProbe) {
        probe.push(data.livemd2texProbe);
      }
    });
    await workerReady(worker, 15000);
    log(`pdf.js worker ready (${source.byteLength} bytes of source)`);
  } catch (err) {
    post({ type: 'ready', csp, wasm, pdfjsVersion: pdfjsLib.version, error: String(err) });
    return;
  }
  // One worker for every document: pdf.js destroys only workers it created itself.
  const pdfWorker = pdfjsLib.PDFWorker.create({ port: worker });

  // ---- Accessibility (M2-B, docs/DESIGN.md#accessibility): page colours under High Contrast, page labels, the toolbar --------

  // The toggle survives the page being reloaded (the panel hidden and shown) through the webview's state.
  let themeColours = (vscodeApi.getState?.() as { themeColours?: boolean } | undefined)?.themeColours === true;
  const highContrast = () => document.body.classList.contains('vscode-high-contrast') || document.body.classList.contains('vscode-high-contrast-light');
  const currentPageColors = (): PageColors | null => {
    const style = getComputedStyle(document.body);
    return pageColorsFor(highContrast(), themeColours, style.getPropertyValue('--vscode-editor-background'), style.getPropertyValue('--vscode-editor-foreground'));
  };
  const colorsKey = (c: PageColors | null) => (c ? `${c.background}/${c.foreground}` : '');

  let active: Slot | null = null;

  /** Each page is a labelled region ("Page 3 of 12"); its text layer holds the words a screen reader reads. */
  const labelPages = (slot: Slot) => {
    const pages = slot.el.querySelectorAll<HTMLElement>('.page');
    pages.forEach((p) => {
      p.setAttribute('role', 'region');
      p.setAttribute('aria-label', `Page ${p.dataset.pageNumber ?? '?'} of ${pages.length}`);
    });
  };

  const button = (id: string) => document.getElementById(id) as HTMLButtonElement | null;
  const updateToolbar = () => {
    const slot = active;
    const pages = slot?.doc?.numPages ?? 0;
    const page = pages > 0 ? (slot?.viewer.currentPageNumber ?? 0) : 0;
    const pageInfo = document.getElementById('pageInfo');
    if (pageInfo) {
      pageInfo.textContent = pages > 0 ? `${page} / ${pages}` : '';
    }
    const zoomInfo = document.getElementById('zoomInfo');
    if (zoomInfo) {
      zoomInfo.textContent = slot?.doc ? `${Math.round(slot.viewer.currentScale * 100)}%` : '';
    }
    const previous = button('previousPage');
    const next = button('nextPage');
    if (previous && next) {
      previous.disabled = page <= 1;
      next.disabled = page >= pages;
      previous.setAttribute('aria-label', pages > 0 ? `Previous page (page ${page} of ${pages})` : 'Previous page');
      next.setAttribute('aria-label', pages > 0 ? `Next page (page ${page} of ${pages})` : 'Next page');
    }
    for (const id of ['zoomOut', 'zoomIn', 'fitWidth', 'toSource']) {
      const b = button(id);
      if (b) {
        b.disabled = !slot?.doc;
      }
    }
    const theme = button('themeColours');
    if (theme) {
      theme.hidden = !highContrast();
      theme.setAttribute('aria-pressed', String(themeColours));
    }
  };

  /** pdf.js's viewer for a slot, with the page colours of the moment (pdf.js reads them when it is made). */
  const buildViewer = (slot: Slot) => {
    const eventBus = new viewerLib.EventBus();
    // Links inside the document move the view (pdf.js); links to web or e-mail addresses are taken out of the
    // browser's hands below and opened by the extension (build gate 1, G1E-22).
    const linkService = new viewerLib.PDFLinkService({ eventBus, externalLinkTarget: viewerLib.LinkTarget.NONE, externalLinkRel: 'noopener noreferrer nofollow' });
    const colors = currentPageColors();
    const viewer = new viewerLib.PDFViewer({
      container: slot.el,
      viewer: slot.el.querySelector('.pdfViewer') as HTMLDivElement,
      eventBus,
      linkService,
      textLayerMode: 1,
      ...(colors ? { pageColors: colors } : {}),
    });
    linkService.setViewer(viewer);
    eventBus.on('pagerendered', (e: { pageNumber: number }) => {
      slot.drawn.add(e.pageNumber);
      labelPages(slot);
    });
    eventBus.on('textlayerrendered', (e: { pageNumber: number }) => slot.textDone.add(e.pageNumber));
    eventBus.on('pagesinit', () => labelPages(slot));
    eventBus.on('pagechanging', () => slot === active && updateToolbar());
    eventBus.on('scalechanging', () => slot === active && updateToolbar());
    slot.eventBus = eventBus;
    slot.linkService = linkService;
    slot.viewer = viewer;
    slot.colors = colorsKey(colors);
  };
  const makeSlot = (id: string): Slot => {
    const slot = { el: document.getElementById(id) as HTMLDivElement, doc: null, drawn: new Set<number>(), textDone: new Set<number>() } as unknown as Slot;
    buildViewer(slot);
    return slot;
  };
  const slots = [makeSlot('slotA'), makeSlot('slotB')];
  updateToolbar();

  // ---------------------------------------------------------------------------------------------------------
  // SyncTeX (M2-A): a double-click or a Ctrl/Cmd-click on a page asks for its source; the extension shows a
  // source line's boxes here with a brief highlight. Points are in PDF points from the page's top-left corner
  // (SyncTeX's frame), converted with pdf.js's viewport, which knows the page's MediaBox and rotation.

  const pageView = (slot: Slot, page: number) => slot.viewer.getPageView(page - 1) as PageView | undefined;

  /**
   * The text of the typeset line around a text-layer span: the spans of its layer at the same height, left to
   * right, up to a gap wider than 0.6 of the line height, about 0.8 of the font size (a column gutter, a table's
   * column gap). A line of a code block or of the title block often comes in several spans.
   */
  const lineTextOf = (span: HTMLElement): string => {
    const layer = span.closest('.textLayer');
    const box = span.getBoundingClientRect();
    if (!layer || box.height === 0) {
      return span.textContent ?? '';
    }
    const middle = box.top + box.height / 2;
    const row = [...layer.querySelectorAll<HTMLElement>('span')]
      .filter((s) => !s.querySelector('span'))
      .map((s) => ({ s, r: s.getBoundingClientRect() }))
      .filter((o) => o.r.height > 0 && Math.abs(o.r.top + o.r.height / 2 - middle) < box.height / 2)
      .sort((a, b) => a.r.left - b.r.left);
    const at = row.findIndex((o) => o.s === span);
    if (at < 0) {
      return span.textContent ?? '';
    }
    const gap = 0.6 * box.height;
    let first = at;
    let last = at;
    while (first > 0 && row[first].r.left - row[first - 1].r.right <= gap) {
      first--;
    }
    while (last < row.length - 1 && row[last + 1].r.left - row[last].r.right <= gap) {
      last++;
    }
    return row
      .slice(first, last + 1)
      .map((o) => o.s.textContent ?? '')
      .join(' ');
  };

  /**
   * The word under a point of the window and the typeset line around it (`context`, at most 300 characters), from
   * the text layer: pdf.js keeps its text in spans there, one per text run of the PDF.
   */
  const wordAt = (clientX: number, clientY: number): { word?: string; context?: string } => {
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const position = doc.caretPositionFromPoint?.(clientX, clientY);
    const range = position ? null : doc.caretRangeFromPoint?.(clientX, clientY);
    const node: Node | null = position ? position.offsetNode : (range?.startContainer ?? null);
    const offset = position ? position.offset : (range?.startOffset ?? 0);
    if (!node || node.nodeType !== Node.TEXT_NODE || !node.parentElement?.closest('.textLayer')) {
      return {};
    }
    const text = node.textContent ?? '';
    const line = lineTextOf(node.parentElement as HTMLElement);
    const context = line.trim() ? line.slice(0, 300) : undefined;
    for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
      const start = m.index ?? 0;
      if (start <= offset && offset <= start + m[0].length) {
        return { word: m[0], context };
      }
    }
    return { context };
  };

  /** The PDF point under a window point on a page element. */
  const pagePoint = (slot: Slot, pageEl: HTMLElement, clientX: number, clientY: number): PagePoint | null => {
    const page = Number(pageEl.dataset.pageNumber);
    const view = pageView(slot, page);
    if (!view) {
      return null;
    }
    const box = pageEl.getBoundingClientRect();
    const [px, py] = view.viewport.convertToPdfPoint(clientX - box.left - pageEl.clientLeft, clientY - box.top - pageEl.clientTop);
    const [x0, , , y1] = view.viewport.viewBox;
    return { page, x: px - x0, y: y1 - py, ...wordAt(clientX, clientY), tag: slot.tag };
  };

  const onInverse = (slot: Slot, event: MouseEvent) => {
    if (slot !== active) {
      return;
    }
    const pageEl = (event.target as HTMLElement | null)?.closest<HTMLElement>('.page');
    const point = pageEl ? pagePoint(slot, pageEl, event.clientX, event.clientY) : null;
    if (point) {
      post({ type: 'inverse', ...point });
    }
  };
  /**
   * A link to a web or e-mail address (pdf.js puts it in an <a> of the annotation layer): the page stops the click
   * before the browser or VS Code's own webview code sees it, and asks the extension to open the address, which
   * goes through VS Code's prompt (build gate 1, G1E-22). Ctrl/Cmd-click on a link is still inverse search.
   */
  const linkOf = (event: MouseEvent) => (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>('.annotationLayer a') ?? null;
  const onLinkClick = (slot: Slot, event: MouseEvent) => {
    const link = linkOf(event);
    const href = link?.getAttribute('href') ?? '';
    if (!link || href === '' || href.startsWith('#')) {
      return; // not a link, or one pdf.js handles itself (a place in the document, a named action)
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.type === 'click' && (event.ctrlKey || event.metaKey)) {
      onInverse(slot, event);
    } else if (slot === active && event.detail <= 1 && (event.type === 'click' || event.button === 1)) {
      // A plain or middle click, or Enter on the link; the second click of a double-click only asks for the source.
      post({ type: 'openLink', url: href });
    }
  };
  /** A link pdf.js handled itself (in its own click handler): VS Code's webview code need not see the click. */
  const keepLinkClick = (event: MouseEvent) => {
    if (linkOf(event)) {
      event.stopPropagation();
    }
  };
  for (const slot of slots) {
    slot.el.addEventListener('click', (e) => onLinkClick(slot, e), true);
    slot.el.addEventListener('auxclick', (e) => onLinkClick(slot, e), true);
    slot.el.addEventListener('click', keepLinkClick);
    slot.el.addEventListener('auxclick', keepLinkClick);
    slot.el.addEventListener('dblclick', (e) => onInverse(slot, e));
    slot.el.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        onInverse(slot, e);
      }
    });
  }

  // The text of each page of the shown document, for finding the cursor's word in a box.
  const textCache = new Map<PdfJs.PDFDocumentProxy, Map<number, Promise<TextItemLike[]>>>();
  const pageText = (doc: PdfJs.PDFDocumentProxy, page: number): Promise<TextItemLike[]> => {
    let byPage = textCache.get(doc);
    if (!byPage) {
      textCache.clear();
      byPage = new Map();
      textCache.set(doc, byPage);
    }
    let items = byPage.get(page);
    if (!items) {
      items = doc
        .getPage(page)
        .then((p) => p.getTextContent())
        .then((c) => c.items as TextItemLike[])
        .catch(() => []);
      byPage.set(page, items);
    }
    return items;
  };

  /** True when the page's text has the word on a baseline inside the box. */
  const boxHolds = async (slot: Slot, doc: PdfJs.PDFDocumentProxy, rect: Rect, word: string): Promise<boolean> => {
    const view = pageView(slot, rect.page);
    if (!view) {
      return false;
    }
    const [x0, , , y1] = view.viewport.viewBox;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u');
    return (await pageText(doc, rect.page)).some((item) => {
      if (!item.str || !item.transform || !re.test(item.str)) {
        return false;
      }
      const x = item.transform[4] - x0;
      const y = y1 - item.transform[5];
      return x <= rect.left + rect.width + 1 && x + (item.width ?? 0) >= rect.left - 1 && y >= rect.top - 2 && y <= rect.top + rect.height + 2;
    });
  };

  let highlightTimers: number[] = [];
  const reveal = async (seq: number, rects: Rect[], firstPage: number, word: string | undefined, announce: string): Promise<void> => {
    const slot = active;
    if (!slot?.doc || rects.length === 0) {
      post({ type: 'revealed', seq, page: 0, boxes: 0 });
      return;
    }
    let page = firstPage;
    if (word) {
      for (const rect of rects) {
        if (await boxHolds(slot, slot.doc, rect, word)) {
          page = rect.page;
          break;
        }
      }
    }
    const onPage = rects.filter((r) => r.page === page);
    const view = pageView(slot, page);
    if (!view || onPage.length === 0) {
      post({ type: 'revealed', seq, page: 0, boxes: 0 });
      return;
    }
    const [x0, , , y1] = view.viewport.viewBox;
    const top = Math.min(...onPage.map((r) => r.top));
    slot.viewer.scrollPageIntoView({
      pageNumber: page,
      destArray: [null, { name: 'XYZ' }, null, y1 - Math.max(0, top - 48), null],
      allowNegativeOffset: true,
    });
    await nextFrame();
    // The highlight: one box per PDF line, inside the page element, fading after a moment.
    for (const t of highlightTimers) {
      clearTimeout(t);
    }
    highlightTimers = [];
    document.querySelectorAll('.syncHighlight').forEach((e) => e.remove());
    const drawn: HTMLElement[] = [];
    for (const r of onPage) {
      // pdf.js 6 has no convertToViewportRectangle; two corners through convertToViewportPoint do the same.
      const [a, b] = view.viewport.convertToViewportPoint(r.left + x0, y1 - (r.top + r.height));
      const [c, d] = view.viewport.convertToViewportPoint(r.left + r.width + x0, y1 - r.top);
      const box = document.createElement('div');
      box.className = 'syncHighlight';
      box.setAttribute('aria-hidden', 'true');
      Object.assign(box.style, {
        left: `${Math.min(a, c)}px`,
        top: `${Math.min(b, d)}px`,
        width: `${Math.abs(c - a)}px`,
        height: `${Math.abs(d - b)}px`,
      });
      view.div.appendChild(box);
      drawn.push(box);
    }
    highlightTimers.push(
      window.setTimeout(() => drawn.forEach((e) => e.classList.add('fading')), 1500),
      window.setTimeout(() => drawn.forEach((e) => e.remove()), 2600),
    );
    setStatus(`${announce}: page ${page}`);
    post({ type: 'revealed', seq, page, boxes: drawn.length });
  };

  /** The PDF point at the centre of the view (for the keyboard: no caret inside a page). */
  const centre = (seq: number): void => {
    post({ type: 'centre', seq, point: centrePoint() });
  };

  /** The PDF point at the centre of the view, with the word there (no caret inside a page for the keyboard). */
  const centrePoint = (): PagePoint | null => {
    const slot = active;
    let point: PagePoint | null = null;
    if (slot?.doc) {
      const box = slot.el.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      let cy = box.top + box.height / 2;
      let pageEl = document.elementsFromPoint(cx, cy).map((e) => e.closest<HTMLElement>('.page')).find((e) => e && slot.el.contains(e));
      if (!pageEl) {
        // Between two pages: the nearest page below the centre, else above.
        const pages = [...slot.el.querySelectorAll<HTMLElement>('.page')];
        pageEl = pages.find((p) => p.getBoundingClientRect().top > cy) ?? pages.reverse().find((p) => p.getBoundingClientRect().bottom < cy);
        if (pageEl) {
          const r = pageEl.getBoundingClientRect();
          cy = Math.min(Math.max(cy, r.top + 1), r.bottom - 1);
        }
      }
      point = pageEl ? pagePoint(slot, pageEl, cx, cy) : null;
    }
    return point;
  };

  // ---- Commands: the toolbar's buttons, and VS Code's commands for the keyboard (M2-B) ----------------------

  /** The last PDF's bytes, to draw it again in other page colours. */
  let lastData: Uint8Array | null = null;

  /** Draws the shown PDF again when the page colours it was drawn with are no longer the ones wanted. */
  const recolour = async (): Promise<void> => {
    if (lastData && active && active.colors !== colorsKey(currentPageColors())) {
      await load(-1, lastData, active.tag); // the same PDF: the same tag (its SyncTeX data stays)
    }
    updateToolbar();
  };

  const runCommand = async (name: ViewerCommand): Promise<void> => {
    const slot = active;
    switch (name) {
      case 'nextPage':
        slot?.viewer.nextPage();
        break;
      case 'previousPage':
        slot?.viewer.previousPage();
        break;
      case 'zoomIn':
        slot?.viewer.increaseScale();
        break;
      case 'zoomOut':
        slot?.viewer.decreaseScale();
        break;
      case 'fitWidth':
        if (slot) {
          slot.viewer.currentScaleValue = 'page-width';
        }
        break;
      case 'focus':
        slot?.el.focus();
        break;
      case 'toggleThemeColours':
        themeColours = !themeColours;
        vscodeApi.setState?.({ themeColours });
        await recolour();
        setStatus(themeColours ? "Pages drawn in the theme's colours" : 'Pages drawn in their own colours');
        break;
    }
    await nextFrame();
    updateToolbar();
  };

  // Toolbar clicks and theme changes wait their turn with the extension's messages (a re-colour loads the PDF).
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch((err: unknown) => log(`viewer task failed: ${String(err)}`));
  };
  for (const b of document.querySelectorAll<HTMLButtonElement>('#toolbar button[data-command]')) {
    b.addEventListener('click', () => enqueue(() => runCommand(b.dataset.command as ViewerCommand)));
  }
  document.getElementById('toSource')?.addEventListener('click', () => {
    const point = centrePoint();
    if (point) {
      post({ type: 'inverse', ...point });
    }
  });
  // A theme change (to or from High Contrast) may change the page colours.
  new MutationObserver(() => enqueue(recolour)).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  const location = (slot: Slot): ViewLocation | null => {
    if (!slot.doc) {
      return null;
    }
    slot.viewer.update();
    const loc = (slot.viewer as unknown as { _location: ViewLocation | null })._location;
    if (!loc) {
      return null;
    }
    return { pageNumber: loc.pageNumber, top: loc.top, left: loc.left, scale: slot.viewer.currentScaleValue };
  };

  /** The text of the topmost line whose upper half is inside the view. */
  const firstVisibleLine = (slot: Slot): string | null => {
    const box = slot.el.getBoundingClientRect();
    let best: { top: number; left: number; text: string } | null = null;
    for (const span of slot.el.querySelectorAll<HTMLElement>('.textLayer span')) {
      const r = span.getBoundingClientRect();
      if (r.height === 0 || !span.textContent?.trim()) {
        continue;
      }
      if (r.top + r.height / 2 < box.top || r.top >= box.bottom) {
        continue;
      }
      if (!best || r.top < best.top - 0.5 || (Math.abs(r.top - best.top) <= 0.5 && r.left < best.left)) {
        best = { top: r.top, left: r.left, text: span.textContent };
      }
    }
    return best?.text ?? null;
  };

  const visiblePagesReady = async (slot: Slot): Promise<void> => {
    const deadline = performance.now() + 20000;
    for (;;) {
      slot.viewer.update();
      const visible = (slot.viewer as unknown as { _getVisiblePages(): VisiblePages })._getVisiblePages();
      if (visible.views.length > 0 && visible.views.every((v) => slot.drawn.has(v.id) && slot.textDone.has(v.id))) {
        return;
      }
      if (performance.now() > deadline) {
        throw new Error('The visible pages did not finish rendering.');
      }
      await nextFrame();
    }
  };

  const load = async (seq: number, data: Uint8Array, tag: number | undefined): Promise<void> => {
    const t0 = performance.now();
    const target = slots.find((s) => s !== active) ?? slots[0];
    const before = active ? location(active) : null;
    const lineBefore = active ? firstVisibleLine(active) : null;
    setStatus('Loading the new PDF');
    // A copy for drawing the same PDF again in other page colours (pdf.js hands the bytes to its worker).
    const kept = data.slice();
    if (target.colors !== colorsKey(currentPageColors())) {
      buildViewer(target);
    }
    const doc = await withTimeout(
      pdfjsLib.getDocument({
        data,
        worker: pdfWorker,
        cMapUrl: config.cMapUrl,
        cMapPacked: true,
        standardFontDataUrl: config.standardFontDataUrl,
        wasmUrl: config.wasmUrl,
        iccUrl: config.iccUrl,
        useWorkerFetch: false,
        useSystemFonts: false,
        enableXfa: false,
      }).promise,
      20000,
      'Opening the PDF',
    );
    // A load that failed after this point left its document in the hidden slot: destroy it before the slot is
    // reused, so a run of failed loads does not keep their documents (build gate 1, G1E-09).
    if (target !== active && target.doc) {
      const stale = target.doc;
      target.doc = null;
      await stale.loadingTask.destroy();
    }
    target.drawn.clear();
    target.textDone.clear();
    const pagesInit = new Promise<void>((resolve) => target.eventBus.on('pagesinit', () => resolve(), { once: true }));
    target.linkService.setDocument(doc, null);
    target.viewer.setDocument(doc);
    target.doc = doc;
    target.tag = tag;
    await pagesInit;
    target.viewer.currentScaleValue = before?.scale ?? 'page-width';
    if (before) {
      target.viewer.scrollPageIntoView({
        pageNumber: Math.min(before.pageNumber, doc.numPages),
        destArray: [null, { name: 'XYZ' }, before.left, before.top, null],
        allowNegativeOffset: true,
      });
    }
    await visiblePagesReady(target);

    // Swap: show the new slot, hide and empty the old one, destroy the old document.
    target.el.classList.remove('standby');
    target.el.removeAttribute('aria-hidden');
    target.el.tabIndex = 0;
    const old = active;
    const hadFocus = old !== null && old.el.contains(document.activeElement);
    active = target;
    lastData = kept;
    if (hadFocus) {
      target.el.focus({ preventScroll: true });
    }
    if (old) {
      old.el.classList.add('standby');
      old.el.setAttribute('aria-hidden', 'true');
      old.el.tabIndex = -1;
      const oldDoc = old.doc;
      old.viewer.setDocument(null as unknown as PdfJs.PDFDocumentProxy);
      old.linkService.setDocument(null);
      old.doc = null;
      old.tag = undefined;
      await oldDoc?.loadingTask.destroy();
    }
    await nextFrame();
    const after = location(target);
    if (!after) {
      throw new Error('No location after the swap.');
    }
    updateToolbar();
    setStatus('Preview updated');
    post({
      type: 'loaded',
      seq,
      pages: doc.numPages,
      before,
      after,
      lineBefore,
      lineAfter: firstVisibleLine(target),
      ms: Math.round(performance.now() - t0),
      tag,
    });
  };

  /** Test only: clicks the first web link on the shown pages, as a user would (the link handler above runs). */
  const clickLink = async (seq: number): Promise<void> => {
    const deadline = performance.now() + 5000;
    let link: HTMLAnchorElement | null = null;
    // The annotation layer (where pdf.js puts links) is drawn after the page itself.
    while (!link && performance.now() < deadline) {
      link = active?.el.querySelector<HTMLAnchorElement>('.annotationLayer a[href]:not([href^="#"]):not([href=""])') ?? null;
      if (!link) {
        await nextFrame();
      }
    }
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, view: window, detail: 1 });
    link?.dispatchEvent(event);
    post({ type: 'clickedLink', seq, url: link?.getAttribute('href') ?? null, prevented: event.defaultPrevented });
  };

  /** The first visible page's canvas as drawn: the corner pixel, and the pixel farthest from it. */
  const pagePixels = (slot: Slot): { background: string; ink: string } | null => {
    const visible = (slot.viewer as unknown as { _getVisiblePages(): VisiblePages })._getVisiblePages();
    const view = visible.views[0] ? pageView(slot, visible.views[0].id) : undefined;
    const canvas = view?.div.querySelector('canvas');
    const context = canvas && canvas.width > 4 && canvas.height > 4 ? canvas.getContext('2d') : null;
    if (!canvas || !context) {
      return null;
    }
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const hex = (i: number) => `#${[data[i], data[i + 1], data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    const corner = 4 * (2 * canvas.width + 2);
    let ink = corner;
    let far = -1;
    for (let i = 0; i < data.length; i += 4) {
      const d = Math.abs(data[i] - data[corner]) + Math.abs(data[i + 1] - data[corner + 1]) + Math.abs(data[i + 2] - data[corner + 2]);
      if (d > far) {
        far = d;
        ink = i;
      }
    }
    return { background: hex(corner), ink: hex(ink) };
  };

  const state = async (seq: number, pixels = false): Promise<void> => {
    if (active) {
      await visiblePagesReady(active);
    }
    post({
      type: 'state',
      seq,
      location: active ? location(active) : null,
      line: active ? firstVisibleLine(active) : null,
      resources: performance.getEntriesByType('resource').map((e) => e.name),
      workerProbe: probe.slice(),
      liveDocuments: slots.filter((s) => s.doc !== null).length,
      pages: active?.doc?.numPages ?? 0,
      themeColours,
      pageColors: active ? currentPageColorsApplied(active) : null,
      highContrast: highContrast(),
      focused: document.activeElement ? document.activeElement.id || document.activeElement.tagName.toLowerCase() : '',
      ...(pixels ? { pixels: active ? pagePixels(active) : null } : {}),
    });
  };

  /** The page colours the slot's viewer draws with (null: the pages' own). */
  const currentPageColorsApplied = (slot: Slot): PageColors | null => {
    const [background, foreground] = slot.colors.split('/');
    return slot.colors ? { background, foreground } : null;
  };

  const handle = async (msg: ToViewer): Promise<void> => {
    switch (msg.type) {
      case 'workerSource':
        return;
      case 'load':
        return load(msg.seq, msg.data, msg.tag);
      case 'scrollTo':
        if (active) {
          active.viewer.scrollPageIntoView({
            pageNumber: msg.pageNumber,
            destArray: [null, { name: 'XYZ' }, 0, msg.top, null],
            allowNegativeOffset: true,
          });
        }
        await nextFrame();
        return state(msg.seq);
      case 'state':
        return state(msg.seq, msg.pixels === true);
      case 'reveal':
        return reveal(msg.seq, msg.rects, msg.firstPage, msg.word, msg.announce);
      case 'centre':
        return centre(msg.seq);
      case 'clickLink':
        return clickLink(msg.seq);
      case 'announce':
        setStatus(msg.text);
        return;
      case 'command':
        await runCommand(msg.name);
        return state(msg.seq);
    }
  };

  // Messages are handled one at a time, in order (with the toolbar's tasks).
  deliver = (msg: ToViewer) => {
    if (msg.type === 'workerSource') {
      return;
    }
    queue = queue
      .then(() => handle(msg))
      .catch((err: unknown) => {
        post({ type: 'error', seq: 'seq' in msg ? msg.seq : undefined, message: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) });
      });
  };
  for (const msg of inbox.splice(0)) {
    deliver(msg);
  }

  post({ type: 'ready', csp, wasm, pdfjsVersion: pdfjsLib.version });
}

main().catch((err: unknown) => post({ type: 'error', message: `viewer start failed: ${String(err)}` }));
