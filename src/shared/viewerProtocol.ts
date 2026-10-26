// Messages between the extension host and the PDF viewer webview (docs/DESIGN.md#live-behaviour; SyncTeX both ways, M2-A).

import type { Rect } from '../synctex/parser';
import type { PageColors } from './pageColors';

/** The viewer's commands (toolbar buttons, and VS Code commands for the keyboard; M2-B). */
export type ViewerCommand = 'nextPage' | 'previousPage' | 'zoomIn' | 'zoomOut' | 'fitWidth' | 'toggleThemeColours' | 'focus';

/** URLs inside the extension (webview resource URIs) and switches, passed to the webview page. */
export interface ViewerConfig {
  pdfjs: string;
  pdfjsViewer: string;
  /** Folder URLs end with "/", as pdf.js expects. */
  cMapUrl: string;
  standardFontDataUrl: string;
  wasmUrl: string;
  iccUrl: string;
  /** Test only: JavaScript prepended to the pdf.js worker source to record what the worker loads. */
  workerProbe?: string;
}

export interface ViewLocation {
  pageNumber: number;
  /** PDF user-space y of the top edge of the view (points, origin bottom-left). */
  top: number;
  left: number;
  /** pdf.js scale value, e.g. "page-width" or "1.25". */
  scale: string;
}

export interface WasmResult {
  ok: boolean;
  result?: number;
  error?: string;
}

export interface WorkerProbeRecord {
  kind: 'xhr' | 'fetch' | 'wasm';
  url?: string;
  status?: number;
  bytes?: number;
  ok?: boolean;
  detail?: string;
}

export type ToViewer =
  | { type: 'workerSource'; data: Uint8Array }
  /** A new PDF. `tag` names it: the viewer reports it with each click, so the click is answered from that PDF's
   *  SyncTeX data (build gate 1, G1E-07). */
  | { type: 'load'; seq: number; data: Uint8Array; tag?: number }
  | { type: 'scrollTo'; seq: number; pageNumber: number; top: number }
  /** The viewer's state; with `pixels`, also colours read from the first page's canvas (for the tests). */
  | { type: 'state'; seq: number; pixels?: boolean }
  /** Forward search: show the source line's boxes (top-left PDF points) with a brief highlight. */
  | { type: 'reveal'; seq: number; rects: Rect[]; firstPage: number; word?: string; announce: string }
  /** The point at the centre of the view, for "go to the source of the view's centre". */
  | { type: 'centre'; seq: number }
  /** A note for screen readers (the page's aria-live status). */
  | { type: 'announce'; text: string }
  /** A viewer command; answered with the state after it. */
  | { type: 'command'; seq: number; name: ViewerCommand }
  /** Test only: clicks the first web link on the shown pages as a user would, and reports what happened. */
  | { type: 'clickLink'; seq: number };

export interface ViewerReady {
  type: 'ready';
  csp: string;
  wasm: WasmResult;
  pdfjsVersion: string | null;
  error?: string;
}

export interface ViewerLoaded {
  type: 'loaded';
  seq: number;
  pages: number;
  before: ViewLocation | null;
  after: ViewLocation;
  lineBefore: string | null;
  lineAfter: string | null;
  ms: number;
  /** The tag of the PDF now shown (from the load message). */
  tag?: number;
}

export interface ViewerState {
  type: 'state';
  seq: number;
  location: ViewLocation | null;
  line: string | null;
  /** Every resource the page itself loaded (Resource Timing), for the "nothing outside the extension" check. */
  resources: string[];
  workerProbe: WorkerProbeRecord[];
  /** Number of documents alive in the page (the old one is destroyed after each swap). */
  liveDocuments: number;
  /** Pages of the shown PDF (0: none). */
  pages: number;
  /** The page colours from the theme (the High Contrast toggle) are on, and the colours applied, if any. */
  themeColours: boolean;
  pageColors: PageColors | null;
  highContrast: boolean;
  /** The id (or tag) of the focused element in the page, for the keyboard tests. */
  focused: string;
  /**
   * When asked: the first visible page's canvas as drawn, its background (a pixel at the corner) and its ink (the
   * pixel farthest from the background), "#rrggbb". The High Contrast check reads the real page, not a setting.
   */
  pixels?: { background: string; ink: string } | null;
}

/** A point on a page, top-left origin in PDF points, and the word and typeset line under it (from the text layer), if any. */
export interface PagePoint {
  page: number;
  x: number;
  y: number;
  word?: string;
  /** The typeset line around the point (from the text layer), which places a click on a symbol or a code line. */
  context?: string;
  /** The tag of the PDF the point is on (see the load message). */
  tag?: number;
}

export interface ViewerRevealed {
  type: 'revealed';
  seq: number;
  /** The page shown, or 0 when there was no document. */
  page: number;
  /** Highlight boxes drawn. */
  boxes: number;
}

export interface ViewerCentre {
  type: 'centre';
  seq: number;
  point: PagePoint | null;
}

/** Test only: the answer to clickLink. */
export interface ViewerClickedLink {
  type: 'clickedLink';
  seq: number;
  /** The link's address, or null when the shown pages have no web link. */
  url: string | null;
  /** Whether the page stopped the browser's own handling of the click. */
  prevented: boolean;
}

export type FromViewer =
  | { type: 'needWorkerSource' }
  | { type: 'log'; message: string }
  | ViewerReady
  | ViewerLoaded
  | ViewerState
  | ViewerRevealed
  | ViewerCentre
  | ViewerClickedLink
  /** A click on a link to a web or e-mail address in the PDF: the extension opens it through VS Code (G1E-22). */
  | { type: 'openLink'; url: string }
  /** Inverse search: a double-click, or a Ctrl/Cmd-click, on a page. */
  | ({ type: 'inverse' } & PagePoint)
  | { type: 'error'; seq?: number; message: string };
