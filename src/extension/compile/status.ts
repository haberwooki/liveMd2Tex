// The status bar: the compile state (click for the log) and the switch between live compiles and on-save only
// (docs/DESIGN.md#live-behaviour).

import * as vscode from 'vscode';
import { COMMAND_PREFIX, DISPLAY_NAME } from '../../shared/identity';
import { isMarkdownDocument, isTexDocument } from '../languages';
import { config } from './settings';

export type CompileState = 'idle' | 'compiling' | 'done' | 'failed';

export class StatusItems implements vscode.Disposable {
  private readonly status = vscode.window.createStatusBarItem(`${COMMAND_PREFIX}.status`, vscode.StatusBarAlignment.Left, 20);
  /** The on-save-only switch (docs/DESIGN.md#live-behaviour). */
  private readonly modeItem = vscode.window.createStatusBarItem(`${COMMAND_PREFIX}.mode`, vscode.StatusBarAlignment.Left, 19);

  constructor() {
    this.status.name = DISPLAY_NAME;
    this.status.command = `${COMMAND_PREFIX}.showLog`;
    this.modeItem.name = `${DISPLAY_NAME}: when to compile`;
    this.modeItem.command = `${COMMAND_PREFIX}.toggleLive`;
    this.set('idle');
    this.updateModeItem();
  }

  /** Shows the items for a .tex or Markdown editor; the state stays once anything has compiled. */
  updateVisibility(editor: vscode.TextEditor | undefined, anyCompiled: boolean): void {
    const relevant = editor !== undefined && (isTexDocument(editor.document) || isMarkdownDocument(editor.document));
    if (relevant || anyCompiled) {
      this.status.show();
    } else {
      this.status.hide();
    }
    if (relevant) {
      this.modeItem.show();
    } else {
      this.modeItem.hide();
    }
  }

  updateModeItem(): void {
    const live = config<'pause' | 'save'>('compileOn', 'pause') === 'pause';
    const pause = (Math.max(200, config<number>('pauseMilliseconds', 1000)) / 1000).toFixed(1);
    this.modeItem.text = live ? '$(zap) Live' : '$(save) On save';
    this.modeItem.tooltip = live
      ? `${DISPLAY_NAME} compiles ${pause} s after you stop typing, and on save. Click to compile only on save.`
      : `${DISPLAY_NAME} compiles only when you save. Click to compile after each pause in typing as well.`;
  }

  /** The status bar switch: live (after a pause) or on save only. Stored as the user's setting. */
  async toggleLive(): Promise<void> {
    const live = config<'pause' | 'save'>('compileOn', 'pause') === 'pause';
    await vscode.workspace.getConfiguration(COMMAND_PREFIX).update('compileOn', live ? 'save' : 'pause', vscode.ConfigurationTarget.Global);
    this.updateModeItem();
  }

  set(state: CompileState, detail = ''): void {
    const texts = {
      idle: ['$(file-pdf) TeX', `${DISPLAY_NAME}: .tex files are compiled as you work`],
      compiling: ['$(sync~spin) TeX', `${DISPLAY_NAME}: compiling`],
      done: [`$(check) TeX ${detail}`, `${DISPLAY_NAME}: the last compile finished (click for the log)`],
      failed: [`$(error) TeX ${detail}`, `${DISPLAY_NAME}: the last compile has errors (see the Problems panel)`],
    } as const;
    [this.status.text, this.status.tooltip] = texts[state];
  }

  show(): void {
    this.status.show();
  }

  dispose(): void {
    this.status.dispose();
    this.modeItem.dispose();
  }
}
