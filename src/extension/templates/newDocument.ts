// "New document from template" (docs/DESIGN.md#help-for-new-users): the user picks a starting document
// (catalog.ts) and a place; the extension makes a new folder there with the document and what it needs (its
// bibliography, a preset), opens the main file and shows its preview. Nothing is overwritten (place.ts): the folder
// gets a free name (paper, paper-2, ...), a parent that cannot be listed or a folder that is already there is
// refused, and each file is created only if it does not exist. Files go through VS Code's file system only, as
// they are: CC0, with their own SPDX lines, and no licence header of the extension's.

import * as vscode from 'vscode';
import { COMMAND_PREFIX } from '../../shared/identity';
import { TEMPLATES, templateFiles, type DocumentTemplate } from './catalog';
import { NewDocumentRefused, oneAtATime, placeNewFolder, type FolderOps } from './place';

const notFound = (err: unknown) => err instanceof vscode.FileSystemError && err.code === 'FileNotFound';

/** VS Code's file system under `parent`, with "create only" files (a workspace edit that may not overwrite). */
export function vscodeFolderOps(parent: vscode.Uri): FolderOps {
  const at = (rel: string) => vscode.Uri.joinPath(parent, ...rel.split('/'));
  return {
    async listParent() {
      try {
        return (await vscode.workspace.fs.readDirectory(parent)).map(([name]) => name);
      } catch (err) {
        if (notFound(err)) {
          return 'missing';
        }
        throw err;
      }
    },
    async exists(rel) {
      try {
        await vscode.workspace.fs.stat(at(rel));
        return true;
      } catch (err) {
        if (notFound(err)) {
          return false;
        }
        throw err;
      }
    },
    async makeFolder(rel) {
      await vscode.workspace.fs.createDirectory(at(rel));
    },
    async createNew(rel, data) {
      // workspace.fs.writeFile always overwrites; a workspace edit with neither overwrite nor ignoreIfExists
      // cannot be applied over an existing file.
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(at(rel), { overwrite: false, ignoreIfExists: false, contents: data });
      if (!(await vscode.workspace.applyEdit(edit))) {
        throw new Error('it already exists, or it could not be written');
      }
    },
  };
}

/** Makes the template's folder under `parent`; returns the main file. Writes nothing when a template file cannot be read. */
export async function createFromTemplate(extensionUri: vscode.Uri, template: DocumentTemplate, parent: vscode.Uri, ops = vscodeFolderOps(parent)): Promise<vscode.Uri> {
  // Every file is read first, so a missing one leaves nothing half-made.
  const files = await templateFiles(template, (from) => vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, ...from.split('/'))));
  const label = parent.scheme === 'file' ? parent.fsPath : parent.toString(true);
  // One run at a time: two runs at once would both choose the same free name.
  const folder = await oneAtATime(() => placeNewFolder(ops, template.folder, files, label));
  return vscode.Uri.joinPath(parent, folder, ...template.main.split('/'));
}

/** Where the new folder goes: the folder given, else the one the user picks (the first workspace folder first). */
async function chooseParent(given: vscode.Uri | undefined): Promise<vscode.Uri | undefined> {
  if (given) {
    return given;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    openLabel: 'Make the new folder here',
    title: 'Where should the new document go? A new folder is made inside the one you choose.',
  });
  return picked?.[0];
}

/**
 * The command: `id` (a template id) and `parent` (a folder) may be given, as the walkthrough and the tests do;
 * otherwise the user picks them. Opens the main file and shows its preview; returns the main file.
 */
export async function newDocument(extensionUri: vscode.Uri, id?: string, parent?: vscode.Uri): Promise<vscode.Uri | undefined> {
  const template =
    TEMPLATES.find((t) => t.id === id) ??
    (
      await vscode.window.showQuickPick(
        TEMPLATES.map((t) => ({ label: t.label, description: t.kind === 'tex' ? 'LaTeX' : 'Markdown', detail: t.detail, template: t })),
        { title: 'New document from template', placeHolder: 'Pick a starting document', matchOnDetail: true },
      )
    )?.template;
  if (!template) {
    return undefined;
  }
  const where = await chooseParent(parent);
  if (!where) {
    return undefined;
  }
  let main: vscode.Uri;
  try {
    main = await createFromTemplate(extensionUri, template, where);
  } catch (err) {
    if (err instanceof NewDocumentRefused) {
      void vscode.window.showErrorMessage(err.message);
      return undefined;
    }
    throw err;
  }
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(main), { viewColumn: vscode.ViewColumn.One, preview: false });
  // The preview: a compile for LaTeX, the LaTeX preview for Markdown (both ask first in Restricted Mode). For a
  // journal class, the compile's package scan names the class and offers the add-on; nothing more is said here.
  void vscode.commands.executeCommand(template.kind === 'tex' ? `${COMMAND_PREFIX}.compile` : `${COMMAND_PREFIX}.openLatexPreview`).then(undefined, () => undefined);
  return main;
}

export function registerNewDocument(context: vscode.ExtensionContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(`${COMMAND_PREFIX}.newDocument`, (id?: unknown, parent?: unknown) =>
      newDocument(context.extensionUri, typeof id === 'string' ? id : undefined, parent instanceof vscode.Uri ? parent : undefined),
    ),
  ];
}
