// The structure of a LaTeX document, for the corpus tests (docs/DESIGN.md#testing): section list, figure and
// table count, citation keys, footnote count, equation count, labels and references. It reads LaTeX, not our
// tokens, so the same function will read pandoc's reference output when CI builds it.

export interface Structure {
  /** [level, plain title]; level 1 is \section (0 \chapter, -1 \part). Starred sections are included. */
  sections: [number, string][];
  figures: number;
  /** Tabular environments (tabular, tabularx, tabular*, longtable). */
  tables: number;
  /** Table floats with a caption. */
  tableCaptions: number;
  /** Bibliography keys cited (\cite..., \autocite..., \textcite..., ...), sorted, unique. */
  citations: string[];
  footnotes: number;
  /** Display equations: \[...\], $$...$$ and the equation-like environments (outermost only). */
  equations: number;
  labels: string[];
  refs: string[];
}

const SECTION_LEVEL: Record<string, number> = {
  part: -1,
  chapter: 0,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
};

/** Removes comments and the bodies of verbatim environments, keeping line structure. */
function stripCommentsAndVerbatim(latex: string): string {
  const withoutVerbatim = latex.replace(/\\begin\{(verbatim\*?|Verbatim|lstlisting|minted)\}[\s\S]*?\\end\{\1\}/g, (m) => m.replace(/[^\n]/g, ' '));
  return withoutVerbatim
    .split('\n')
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '\\') {
          i++;
        } else if (line[i] === '%') {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

/** The balanced {...} group starting at text[pos] === '{': [content, index after it]. */
export function braceGroup(text: string, pos: number): [string, number] | undefined {
  if (text[pos] !== '{') {
    return undefined;
  }
  let depth = 0;
  for (let i = pos; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return [text.slice(pos + 1, i), i + 1];
      }
    }
  }
  return undefined;
}

function bracketGroupEnd(text: string, pos: number): number {
  if (text[pos] !== '[') {
    return pos;
  }
  let depth = 0;
  for (let i = pos; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
    } else if (ch === '{') {
      const g = braceGroup(text, i);
      if (!g) {
        return pos;
      }
      i = g[1] - 1;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return pos;
}

/** Plain text of a LaTeX fragment: commands dropped, their braced arguments kept, specials unescaped. */
export function plainLatex(text: string): string {
  return text
    .replace(/\\(label|footnote|protect|hypertarget)\s*(\{[^{}]*\})?/g, '')
    .replace(/\\(textbackslash)\{\}/g, '\\')
    .replace(/\\([{}$&%#_])/g, '$1')
    .replace(/\\(?:textless|textgreater|textbar|textasciitilde|textasciicircum|ldots|textquotedbl)\{\}/g, (m) =>
      ({ '\\textless{}': '<', '\\textgreater{}': '>', '\\textbar{}': '|', '\\textasciitilde{}': '~', '\\textasciicircum{}': '^', '\\ldots{}': '...', '\\textquotedbl{}': '"' })[m] ?? '',
    )
    .replace(/\\[A-Za-z]+\*?(\[[^\]]*\])?/g, '')
    .replace(/[{}]/g, '')
    .replace(/``|''/g, '"')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CITE_COMMAND = /\\((?:[Cc]ite(?!text)[a-zA-Z]*)|[Aa]utocites?|[Tt]extcites?|[Pp]arencites?|[Ff]ootcites?|[Ss]martcites?|[Ss]upercites?|fullcite|nocite)\*?(?![A-Za-z])/g;
const EQUATION_ENVS = /\\begin\{(equation|align|gather|multline|flalign|alignat|eqnarray|displaymath|math)(\*?)\}/g;

export function extractStructure(latex: string): Structure {
  const text = stripCommentsAndVerbatim(latex);
  const sections: [number, string][] = [];
  for (const m of text.matchAll(/\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*/g)) {
    let pos = (m.index ?? 0) + m[0].length;
    pos = bracketGroupEnd(text, pos);
    const group = braceGroup(text, pos);
    if (group) {
      sections.push([SECTION_LEVEL[m[1]], plainLatex(group[0])]);
    }
  }
  const count = (re: RegExp) => [...text.matchAll(re)].length;

  const citations = new Set<string>();
  for (const m of text.matchAll(CITE_COMMAND)) {
    let pos = (m.index ?? 0) + m[0].length;
    for (;;) {
      while (text[pos] === ' ') {
        pos++;
      }
      if (text[pos] === '[') {
        pos = bracketGroupEnd(text, pos);
        continue;
      }
      const group = braceGroup(text, pos);
      if (!group) {
        break;
      }
      group[0]
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)
        .forEach((k) => citations.add(k));
      pos = group[1];
      // multi-cite commands (\autocites) take several {keys} groups; single ones stop here.
      if (!/cites$/i.test(m[1])) {
        break;
      }
    }
  }

  const labels: string[] = [];
  for (const m of text.matchAll(/\\label\s*\{([^{}]*)\}/g)) {
    labels.push(m[1]);
  }
  const refs: string[] = [];
  for (const m of text.matchAll(/\\(?:ref|eqref|cref|Cref|autoref|pageref|nameref|vref)\s*\{([^{}]*)\}/g)) {
    m[1].split(',').forEach((r) => refs.push(r.trim()));
  }

  // Outermost display math only: drop environments nested in another display.
  let equations = 0;
  let depth = 0;
  const events: { at: number; open: boolean }[] = [];
  for (const m of text.matchAll(EQUATION_ENVS)) {
    events.push({ at: m.index ?? 0, open: true });
  }
  for (const m of text.matchAll(/\\end\{(equation|align|gather|multline|flalign|alignat|eqnarray|displaymath|math)\*?\}/g)) {
    events.push({ at: m.index ?? 0, open: false });
  }
  for (const m of text.matchAll(/(?<!\\)\\\[/g)) {
    events.push({ at: m.index ?? 0, open: true });
  }
  for (const m of text.matchAll(/(?<!\\)\\\]/g)) {
    events.push({ at: m.index ?? 0, open: false });
  }
  events.sort((a, b) => a.at - b.at);
  for (const e of events) {
    if (e.open) {
      if (depth === 0) {
        equations++;
      }
      depth++;
    } else {
      depth = Math.max(0, depth - 1);
    }
  }
  equations += Math.floor(count(/(?<![\\$])\$\$(?!\$)/g) / 2);

  return {
    sections,
    figures: count(/\\begin\{figure\*?\}/g),
    tables: count(/\\begin\{(tabular\*?|tabularx|longtable|tabulary)\}/g),
    tableCaptions: [...text.matchAll(/\\begin\{table\*?\}[\s\S]*?\\end\{table\*?\}/g)].filter((m) => /\\caption\s*[[{]/.test(m[0])).length,
    citations: [...citations].sort(),
    footnotes: count(/\\footnote\s*[[{]/g),
    equations,
    labels: [...labels].sort(),
    refs: [...new Set(refs)].sort(),
  };
}
