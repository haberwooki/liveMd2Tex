// The compile records: one per compile, as the log shows it and as the tests read it. The last 200 are kept
// (build gate 1, G1E-12). A compile command answers with its own compile's record (nextFinished).

import * as vscode from 'vscode';
import type { StubReport } from '../../shared/engineProtocol';
import type { PassKind } from './scheduler';

/** How many compile records stay in memory (G1E-12). */
export const MAX_RECORDS = 200;

/** One compile, as logged and as the tests read it. */
export interface CompileRecord {
  /** The root document's URI: the .tex root, or the Markdown file. */
  root: string;
  /** The root's file name (the Markdown file's name for a converted file). */
  main: string;
  source: 'tex' | 'markdown';
  /** What asked for it (edit, save, file, command, rerun; several when they were merged) and the pass kind. */
  trigger: string;
  pass: PassKind;
  generation: number;
  engine: string;
  engineReason: string;
  ok: boolean;
  cancelled: boolean;
  passes: number;
  bibtexRan: boolean;
  errors: number;
  warnings: number;
  pdfBytes: number;
  pdfWritten: string | null;
  /** Why no PDF was written next to the source, when one came back but was not written. */
  pdfNotWritten?: string;
  collectMs: number;
  engineStartMs: number;
  workerMs: number;
  /** The job went to a standby worker that had already loaded the engine. */
  warmWorker: boolean;
  texMs: number;
  engineTotalMs: number;
  /** From the last event (keystroke, save or command) to the PDF painted in the viewer; null when hidden. */
  saveToPreviewMs: number | null;
  /** From the last event to the end of the compile (the PDF written, when it is). */
  saveToDoneMs: number;
  /** From the last keystroke this compile includes to the PDF painted; null without an edit or a viewer. */
  keystrokeToPreviewMs: number | null;
  /** The log asks for another pass or for bibtex8 (a full pass follows a quick one). */
  wantsFullPass: boolean;
  /** Project files the compile read (watched for changes). */
  readFiles: string[];
  /** Files the preamble scan found in no installed data set (docs/DESIGN.md#engine-and-data). */
  missingPackages?: string[];
  /** What the engine host's stubs recorded (tests only; null when no stubs are loaded, as in normal use). */
  engineStubs: StubReport | null;
  error?: string;
}

/** The records kept in memory, and the event each finished compile fires. */
export class CompileRecords implements vscode.Disposable {
  readonly list: CompileRecord[] = [];
  private readonly emitter = new vscode.EventEmitter<CompileRecord>();
  readonly onCompiled = this.emitter.event;

  /** Keeps `record` (the last MAX_RECORDS stay) and tells the listeners. */
  add(record: CompileRecord): CompileRecord {
    this.list.push(record);
    if (this.list.length > MAX_RECORDS) {
      this.list.splice(0, this.list.length - MAX_RECORDS);
    }
    this.emitter.fire(record);
    return record;
  }

  /**
   * The next finished compile of `key` from generation `from` on. A compile command answers with the compile it
   * asked for (or a later one), never with one that was already running when it came: that one started from older
   * text or older installed packages, and a document's first compile is never cancelled, so its record can arrive
   * after the command (the cause of a flaky M6 test, build gate 3 preparation).
   */
  nextFinished(key: string, from = 0): Promise<CompileRecord> {
    return new Promise((resolve) => {
      const sub = this.onCompiled((record) => {
        if (record.root === key && !record.cancelled && record.generation >= from) {
          sub.dispose();
          resolve(record);
        }
      });
    });
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
