// When a Markdown file is typeset (docs/DESIGN.md#engine-and-data): only on the explicit "Open LaTeX preview" command, or when
// its front matter or the folder config asks. These read the two opt-ins; pure functions, no file access.
//
//   front matter            latex-preview: true
//   .latexpreview.json      { "latexPreview": true, "markdown": { ... } }
//
// The folder-config switch sits beside the converter's "markdown" section, not inside it, so the converter's
// own settings stay as agent B defined them.

import { splitFrontMatter } from '../../converter/frontMatter';

export const FRONT_MATTER_KEY = 'latex-preview';
export const FOLDER_CONFIG_KEY = 'latexPreview';

function yes(value: unknown): boolean {
  return value === true || (typeof value === 'string' && /^(true|yes|on)$/i.test(value.trim()));
}

/** True when the Markdown text's YAML front matter has "latex-preview: true". */
export function frontMatterAsksForTypesetting(markdown: string): boolean {
  const text = markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
  const { frontMatter } = splitFrontMatter(text.replace(/\r\n?/g, '\n'));
  return frontMatter !== undefined && !frontMatter.error && yes(frontMatter.data[FRONT_MATTER_KEY]);
}

/** True when a .latexpreview.json text has "latexPreview": true at the top level. */
export function folderConfigAsksForTypesetting(json: string): boolean {
  try {
    const raw = JSON.parse(json) as unknown;
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>)[FOLDER_CONFIG_KEY] === true;
  } catch {
    return false;
  }
}
