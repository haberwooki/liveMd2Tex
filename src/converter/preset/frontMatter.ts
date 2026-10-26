// Front matter written as text rather than YAML (docs/DESIGN.md#presets):
//   - 'bold-labels': "**Working title:** *Title*", "**Authors:** ...", "**Affiliations:** ...",
//     "**Corresponding author:** ...", "**Abstract:** ..." anywhere before the body, which starts at the first
//     line beginning with the mode's bodyStart (e.g. "## 1."); everything before it is front matter;
//   - 'title-block': "# Title", then the author line and the date line (and any further lines) up to a line of
//     dashes;
//   - 'drop-title': no front matter; every "#" heading line is a draft label and is dropped (letters).
// The front matter lines are blanked in the text handed to the parser, so every token keeps its source line.

import type { PresetMode } from './types';

export interface PresetFront {
  title?: string;
  authors?: string;
  affiliations?: string;
  corresponding?: string;
  abstract?: string;
  date?: string;
  extra: string[];
  /** 1-based source line of each field. */
  lines: Record<string, number>;
}

const LABELS: [keyof PresetFront, RegExp][] = [
  ['title', /^\*\*Working title[^:]*:\*\*\s*\*?(.+?)\*?\s*$/],
  ['authors', /\*\*Authors:\*\*\s*(.+)/],
  ['abstract', /\*\*Abstract:\*\*\s*(.+)/],
  ['affiliations', /\*\*Affiliations:\*\*\s*(.+)/],
  ['corresponding', /\*\*Corresponding author:\*\*\s*(.+)/],
];

export function splitPresetFront(text: string, mode: PresetMode): { front: PresetFront; body: string } {
  const lines = text.split('\n');
  const front: PresetFront = { extra: [], lines: {} };
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < lines.length; k++) {
      lines[k] = '';
    }
  };
  if (mode.frontMatter === 'bold-labels') {
    for (const [field, re] of LABELS) {
      for (let k = 0; k < lines.length; k++) {
        const m = re.exec(lines[k]);
        if (m) {
          (front[field] as string) = m[1].trim().replace(/^\*+|\*+$/g, '');
          front.lines[field] = k + 1;
          break;
        }
      }
    }
    const start = mode.bodyStart ? lines.findIndex((l) => l.startsWith(mode.bodyStart)) : -1;
    if (start > 0) {
      blank(0, start);
    }
  } else if (mode.frontMatter === 'title-block') {
    const t = lines.findIndex((l) => l.startsWith('# '));
    if (t >= 0) {
      front.title = lines[t].slice(2).trim();
      front.lines.title = t + 1;
      let k = t + 1;
      const rest: { text: string; line: number }[] = [];
      while (k < lines.length && !lines[k].startsWith('---')) {
        if (lines[k].trim()) {
          rest.push({ text: lines[k].trim(), line: k + 1 });
        }
        k++;
      }
      if (rest[0]) {
        front.authors = rest[0].text;
        front.lines.authors = rest[0].line;
      }
      if (rest[1]) {
        front.date = rest[1].text;
        front.lines.date = rest[1].line;
      }
      front.extra = rest.slice(2).map((r) => r.text);
      blank(0, Math.min(k + 1, lines.length));
    }
  } else if (mode.frontMatter === 'drop-title') {
    lines.forEach((l, k) => {
      if (l.startsWith('#')) {
        lines[k] = '';
      }
    });
  }
  return { front, body: lines.join('\n') };
}
