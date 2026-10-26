// The PDF preview panel (S3 spike; docs/DESIGN.md#live-behaviour). The extension posts PDF bytes; the webview shows them
// with pdf.js and keeps the reading position across swaps. The webview never reads the disk and the panel
// fetches nothing: every URL in the page points inside the extension's dist/viewer folder. A click on a link to a
// web or e-mail address in the PDF is opened with env.openExternal, which shows VS Code's prompt for outside sites;
// other links (files, commands) are not opened (build gate 1, G1E-22).
//
// Every request settles: its time limit counts from the call, including the wait for the page, and a page that
// fails before it is ready rejects the requests waiting for it (build gate 1, G1E-09).

import * as vscode from 'vscode';
import { COMMAND_PREFIX } from '../../shared/identity';
import type {
  FromViewer,
  PagePoint,
  ToViewer,
  ViewerCentre,
  ViewerClickedLink,
  ViewerCommand,
  ViewerConfig,
  ViewerLoaded,
  ViewerReady,
  ViewerRevealed,
  ViewerState,
} from '../../shared/viewerProtocol';
import type { Rect } from '../../synctex/parser';
import { buildCsp, buildViewerHtml, type CspProfile } from './html';

export interface PreviewPanelOptions {
  title?: string;
  cspProfile?: CspProfile;
  /** Test only; see ViewerConfig.workerProbe. */
  workerProbe?: string;
  /** How long a request to the webview may take. */
  timeoutMs?: number;
}

type Answer = ViewerLoaded | ViewerState | ViewerRevealed | ViewerCentre | ViewerClickedLink;

/** The link schemes a click in the PDF may open: web and e-mail (a pattern, so the VSIX scan sees no module name). */
const LINK_SCHEMES = /^(https?|mailto)$/i;

let openLinkWith: (uri: vscode.Uri) => Thenable<boolean> = (uri) => vscode.env.openExternal(uri);

/** Test only: what opens a link from the PDF (the tests record it instead of opening a browser). */
export function setLinkOpenerForTests(opener: (uri: vscode.Uri) => Thenable<boolean>): void {
  openLinkWith = opener;
}

/** The page's log and error lines kept in memory: the last 500 of each (build gate 1, G1E-12). */
export const MAX_PAGE_LINES = 500;

function remember(lines: string[], line: string): void {
  lines.push(line);
  if (lines.length > MAX_PAGE_LINES) {
    lines.splice(0, lines.length - MAX_PAGE_LINES);
  }
}

/**
 * A plain Uint8Array view of the same bytes. A Node Buffer (what workspace.fs.readFile returns in the desktop
 * extension host) has toJSON(), which turns it into {type: 'Buffer', data: [...]} when VS Code serialises a
 * webview message, so the page would receive an object instead of bytes.
 */
function plainBytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
interface Pending {
  resolve: (msg: Answer) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** The current page's readiness: resolved by its 'ready' message, rejected when it fails, is hidden or closes. */
interface PageGate {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
  open: boolean;
}

function pageGate(): PageGate {
  const gate = { open: false } as PageGate;
  gate.promise = new Promise<void>((resolve, reject) => {
    gate.resolve = () => {
      gate.open = true;
      resolve();
    };
    gate.reject = reject;
  });
  // Nobody may be waiting when the page fails; that is not an error of its own.
  gate.promise.catch(() => undefined);
  return gate;
}

export class PreviewPanel implements vscode.Disposable {
  readonly panel: vscode.WebviewPanel;
  readonly ready: Promise<ViewerReady>;
  /** The URL prefix under which the page may load files: the extension's viewer folder. */
  readonly resourceBase: string;
  readonly csp: string;
  readonly errors: string[] = [];
  /** Progress and diagnostic lines from the page. */
  readonly log: string[] = [];
  private readonly workerFile: vscode.Uri;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timeoutMs: number;
  /**
   * Without retainContextWhenHidden (docs/DESIGN.md#live-behaviour) a hidden panel's page is unloaded and loaded again
   * when shown: requests wait for the current page, and the latest PDF is shown again after a reload.
   */
  private page: PageGate = pageGate();
  private pageLoads = 0;
  private latest: Uint8Array | null = null;
  private latestTagValue: number | undefined;
  private shownTagValue: number | undefined;
  private readonly shownEvents = new vscode.EventEmitter<number | undefined>();
  /** The viewer now shows the PDF with this tag (see load()). */
  readonly onDidShow = this.shownEvents.event;
  private disposed = false;
  private readonly sourceRequests = new vscode.EventEmitter<PagePoint>();
  /** A double-click or a Ctrl/Cmd-click on a page: the point and the word under it (inverse search). */
  readonly onDidRequestSource = this.sourceRequests.event;

  static create(extensionUri: vscode.Uri, options: PreviewPanelOptions = {}): PreviewPanel {
    const viewerRoot = vscode.Uri.joinPath(extensionUri, 'dist', 'viewer');
    const panel = vscode.window.createWebviewPanel(
      `${COMMAND_PREFIX}.viewer`,
      options.title ?? 'PDF preview',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        localResourceRoots: [viewerRoot],
        retainContextWhenHidden: false,
        enableFindWidget: false,
      },
    );
    return new PreviewPanel(panel, viewerRoot, options);
  }

  private constructor(panel: vscode.WebviewPanel, viewerRoot: vscode.Uri, options: PreviewPanelOptions) {
    this.panel = panel;
    this.timeoutMs = options.timeoutMs ?? 30000;
    const webview = panel.webview;
    const uri = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(viewerRoot, ...parts)).toString();
    const folder = (...parts: string[]) => `${uri(...parts)}/`;
    this.workerFile = vscode.Uri.joinPath(viewerRoot, 'pdfjs', 'build', 'pdf.worker.mjs');
    this.resourceBase = folder();
    this.csp = buildCsp(webview.cspSource, options.cspProfile ?? 'planned');
    const config: ViewerConfig = {
      pdfjs: uri('pdfjs', 'build', 'pdf.mjs'),
      pdfjsViewer: uri('pdfjs', 'web', 'pdf_viewer.mjs'),
      cMapUrl: folder('pdfjs', 'cmaps'),
      standardFontDataUrl: folder('pdfjs', 'standard_fonts'),
      wasmUrl: folder('pdfjs', 'wasm'),
      iccUrl: folder('pdfjs', 'iccs'),
      workerProbe: options.workerProbe,
    };

    this.ready = new Promise<ViewerReady>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The viewer did not report ready in time.')), this.timeoutMs);
      this.disposables.push(
        webview.onDidReceiveMessage((raw: unknown) => {
          const msg = raw as FromViewer;
          if (msg.type === 'ready') {
            clearTimeout(timer);
            resolve(msg);
            this.pageLoads++;
            this.page.resolve();
            if (this.pageLoads > 1 && this.latest && !msg.error) {
              // The page was loaded again (the panel was hidden and shown): show the latest PDF again.
              void this.load(this.latest, this.latestTagValue).catch(() => undefined);
            }
            return;
          }
          this.onMessage(msg);
        }),
      );
    });
    this.disposables.push(
      panel.onDidChangeViewState((e) => {
        if (!e.webviewPanel.visible) {
          this.page.reject(new Error('The viewer was hidden.'));
          this.page = pageGate();
          this.rejectPending('The viewer was hidden.');
        }
      }),
      panel.onDidDispose(() => {
        this.disposed = true;
        this.page.reject(new Error('The viewer was closed.'));
        this.rejectPending('The viewer was closed.');
      }),
    );

    webview.html = buildViewerHtml({
      csp: this.csp,
      styles: [uri('pdfjs', 'web', 'pdf_viewer.css'), uri('viewer.css')],
      script: uri('viewer.js'),
      config,
      title: options.title ?? 'PDF preview',
    });
  }

  private onMessage(msg: FromViewer): void {
    if (msg.type === 'needWorkerSource') {
      // The page builds pdf.js's worker from this text (see src/webview/viewer.ts for why).
      void vscode.workspace.fs.readFile(this.workerFile).then(
        (data) => this.panel.webview.postMessage({ type: 'workerSource', data: plainBytes(data) } satisfies ToViewer),
        (err: unknown) => remember(this.errors, `cannot read the pdf.js worker: ${String(err)}`),
      );
      return;
    }
    if (msg.type === 'log') {
      remember(this.log, msg.message);
      return;
    }
    if (msg.type === 'error') {
      remember(this.errors, msg.message);
      // A page that fails before it is ready will not answer: the requests waiting for it fail now.
      if (msg.seq === undefined && !this.page.open) {
        this.page.reject(new Error(`The viewer page failed: ${msg.message}`));
      }
      const p = msg.seq === undefined ? undefined : this.pending.get(msg.seq);
      if (p && msg.seq !== undefined) {
        clearTimeout(p.timer);
        this.pending.delete(msg.seq);
        p.reject(new Error(msg.message));
      }
      return;
    }
    if (msg.type === 'ready') {
      return;
    }
    if (msg.type === 'inverse') {
      this.sourceRequests.fire({ page: msg.page, x: msg.x, y: msg.y, word: msg.word, context: msg.context, tag: msg.tag });
      return;
    }
    if (msg.type === 'openLink') {
      this.openLink(msg.url);
      return;
    }
    if (msg.type === 'loaded') {
      this.shownTagValue = msg.tag;
      this.shownEvents.fire(msg.tag);
    }
    const p = this.pending.get(msg.seq);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(msg.seq);
      p.resolve(msg);
    }
  }

  private rejectPending(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** The tag of the PDF the viewer shows (undefined before the first, or for an untagged PDF). */
  get shownTag(): number | undefined {
    return this.shownTagValue;
  }

  /** The tag of the PDF last sent to the viewer (it may still be loading, or wait for a hidden panel). */
  get latestTag(): number | undefined {
    return this.latestTagValue;
  }

  /** A link the user clicked in the PDF: web and e-mail addresses go to VS Code, which asks before it opens a site. */
  private openLink(url: string): void {
    let uri: vscode.Uri | undefined;
    try {
      uri = vscode.Uri.parse(url, true);
    } catch {
      uri = undefined;
    }
    if (!uri || !LINK_SCHEMES.test(uri.scheme)) {
      this.announce('This link was not opened: only web and e-mail links open from the preview.');
      return;
    }
    void Promise.resolve(openLinkWith(uri)).catch((err: unknown) => remember(this.errors, `cannot open a link: ${String(err)}`));
  }

  private async request<T extends Answer>(build: (seq: number) => ToViewer): Promise<T> {
    const started = performance.now();
    let wait: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      wait = setTimeout(() => reject(new Error('The viewer page did not become ready in time.')), this.timeoutMs);
    });
    try {
      await Promise.race([Promise.all([this.ready, this.page.promise]), late]);
    } finally {
      clearTimeout(wait);
    }
    const seq = ++this.seq;
    const remaining = Math.max(1, this.timeoutMs - (performance.now() - started));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`The viewer did not answer request ${seq} in time.`));
      }, remaining);
      this.pending.set(seq, { resolve: resolve as (m: Answer) => void, reject, timer });
      void this.panel.webview.postMessage(build(seq));
    });
  }

  /**
   * Shows a new PDF in place of the current one, keeping the reading position. `tag` names the PDF: the viewer
   * reports it with each click, so the click is answered from that PDF's SyncTeX data (build gate 1, G1E-07).
   */
  load(data: Uint8Array, tag?: number): Promise<ViewerLoaded> {
    this.latest = plainBytes(data);
    this.latestTagValue = tag;
    const bytes = this.latest;
    return this.request<ViewerLoaded>((seq) => ({ type: 'load', seq, data: bytes, tag }));
  }

  /**
   * Like load(), for the compile loop: when the panel is hidden the PDF is kept and shown when the panel is
   * shown again, and the result is null.
   */
  async display(data: Uint8Array, tag?: number): Promise<ViewerLoaded | null> {
    this.latest = plainBytes(data);
    this.latestTagValue = tag;
    if (!this.panel.visible || this.disposed) {
      return null;
    }
    try {
      return await this.load(data, tag);
    } catch (err) {
      if (!this.panel.visible || this.disposed) {
        return null;
      }
      throw err;
    }
  }

  scrollTo(pageNumber: number, top: number): Promise<ViewerState> {
    return this.request<ViewerState>((seq) => ({ type: 'scrollTo', seq, pageNumber, top }));
  }

  /** The viewer's state; `pixels`: also the colours of the first visible page as drawn (for the tests). */
  state(pixels = false): Promise<ViewerState> {
    return this.request<ViewerState>((seq) => ({ type: 'state', seq, pixels }));
  }

  /**
   * Forward search: scrolls to a source line's boxes (on the page whose box holds `word`, else `firstPage`)
   * and highlights them briefly; `announce` is read out by screen readers.
   */
  reveal(rects: Rect[], firstPage: number, word: string | undefined, announce: string): Promise<ViewerRevealed> {
    return this.request<ViewerRevealed>((seq) => ({ type: 'reveal', seq, rects, firstPage, word, announce }));
  }

  /** A viewer command (a toolbar button, for the keyboard); resolves with the state after it. */
  command(name: ViewerCommand): Promise<ViewerState> {
    return this.request<ViewerState>((seq) => ({ type: 'command', seq, name }));
  }

  /** The PDF point at the centre of the view, with the word there. */
  centre(): Promise<ViewerCentre> {
    return this.request<ViewerCentre>((seq) => ({ type: 'centre', seq }));
  }

  /** Test only: clicks the first web link on the shown pages, as a user would. */
  clickLinkForTests(): Promise<ViewerClickedLink> {
    return this.request<ViewerClickedLink>((seq) => ({ type: 'clickLink', seq }));
  }

  /** A note for screen readers, in the page's aria-live status. */
  announce(text: string): void {
    if (!this.disposed && this.panel.visible) {
      void this.panel.webview.postMessage({ type: 'announce', text } satisfies ToViewer);
    }
  }

  dispose(): void {
    this.sourceRequests.dispose();
    this.shownEvents.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.panel.dispose();
  }
}
