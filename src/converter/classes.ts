// Class templates (docs/DESIGN.md#converter): a YAML documentclass picks a bundled class with a matching template.
// Each journal class writes its title, authors, affiliations, abstract and keywords in its own idiom, loads some
// packages itself (natbib, hyperref) and forbids or overrides others (geometry, fonts), and has its own
// bibliography style. The default article template is the fallback for any other class.
//
// Classes and their pinned sources (the pinned CTAN set, docs/DESIGN.md#engine-and-data): revtex4-2 (P2), IEEEtran (P3),
// elsarticle (P4), acmart (P12), llncs (P13); report is LaTeX's own.

export interface TitleAuthor {
  /** LaTeX (converted) name, affiliations and e-mail. */
  name: string;
  affiliations: string[];
  email?: string;
}

export interface TitleData {
  title?: string;
  subtitle?: string;
  authors: TitleAuthor[];
  date?: string;
  abstract: string[];
  keywords: string[];
}

export interface ClassTemplate {
  /** The class name written in \documentclass. */
  name: string;
  /** Options used when the front matter gives none. */
  defaultOptions: string[];
  /** Packages the default template must not load: the class loads them itself, or forbids them. */
  skip: string[];
  /** Options for natbib when the template loads it. */
  natbibOptions: string;
  /** \bibliographystyle; '' when the class chooses its own (REVTeX's aps option). */
  bibliographyStyle: string;
  /** Level-1 headings are chapters. */
  chapters: boolean;
  /** Lines before \begin{document}. */
  preambleTitle(t: TitleData): string[];
  /** Lines right after \begin{document}. */
  frontMatter(t: TitleData): string[];
}

/** Unique affiliations in order of first appearance, with each author's 1-based indices into them. */
function affiliationIndex(authors: TitleAuthor[]): { list: string[]; of: number[][] } {
  const list: string[] = [];
  const of = authors.map((a) =>
    a.affiliations.map((aff) => {
      let k = list.indexOf(aff);
      if (k < 0) {
        list.push(aff);
        k = list.length - 1;
      }
      return k + 1;
    }),
  );
  return { list, of };
}

/**
 * \maketitle looks at the token after it; without the \relax, TeX has read the next line when it sets the title,
 * and SyncTeX puts the title there (a click on the title would land on the abstract).
 */
const MAKETITLE = '\\maketitle\\relax';

const fullTitle = (t: TitleData) => (t.subtitle ? `${t.title ?? ''}\\\\\\large ${t.subtitle}` : (t.title ?? ''));

function abstractLines(t: TitleData): string[] {
  return t.abstract.length > 0 ? ['\\begin{abstract}', ...t.abstract, '\\end{abstract}'] : [];
}

const article: ClassTemplate = {
  name: 'article',
  defaultOptions: [],
  skip: [],
  natbibOptions: '',
  bibliographyStyle: 'plainnat',
  chapters: false,
  preambleTitle: (t) => {
    if (t.title === undefined) {
      return [];
    }
    const authors = t.authors.map((a) => [a.name, ...a.affiliations, ...(a.email ? [a.email] : [])].join('\\\\ '));
    return [`\\title{${fullTitle(t)}}`, `\\author{${authors.join(' \\and ')}}`, `\\date{${t.date ?? ''}}`];
  },
  frontMatter: (t) => [
    ...(t.title !== undefined ? [MAKETITLE] : []),
    ...abstractLines(t),
    ...(t.keywords.length > 0 ? [`\\noindent\\textbf{Keywords:} ${t.keywords.join(', ')}`] : []),
  ],
};

const revtex: ClassTemplate = {
  name: 'revtex4-2',
  defaultOptions: ['reprint', 'aps'],
  skip: ['natbib', 'geometry'],
  natbibOptions: '',
  bibliographyStyle: '',
  chapters: false,
  preambleTitle: () => [],
  frontMatter: (t) => {
    const out = [`\\title{${fullTitle(t)}}`];
    for (const a of t.authors) {
      out.push(`\\author{${a.name}}`);
      if (a.email) {
        out.push(`\\email{${a.email}}`);
      }
      a.affiliations.forEach((aff) => out.push(`\\affiliation{${aff}}`));
    }
    if (t.date) {
      out.push(`\\date{${t.date}}`);
    }
    out.push(...abstractLines(t));
    if (t.keywords.length > 0) {
      out.push(`\\keywords{${t.keywords.join(', ')}}`);
    }
    out.push(MAKETITLE);
    return out;
  },
};

const ieee: ClassTemplate = {
  name: 'IEEEtran',
  defaultOptions: ['journal'],
  skip: ['geometry', 'lmodern'],
  natbibOptions: 'numbers',
  bibliographyStyle: 'IEEEtran',
  chapters: false,
  preambleTitle: (t) => {
    const names = t.authors.map((a) => a.name).join(', ');
    const { list } = affiliationIndex(t.authors);
    const emails = t.authors.filter((a) => a.email).map((a) => a.email);
    const thanks = [...list, ...emails].join('; ');
    return [`\\title{${fullTitle(t)}}`, `\\author{${names}${thanks ? `\\thanks{${thanks}}` : ''}}`];
  },
  frontMatter: (t) => [
    MAKETITLE,
    ...abstractLines(t),
    ...(t.keywords.length > 0 ? ['\\begin{IEEEkeywords}', t.keywords.join(', '), '\\end{IEEEkeywords}'] : []),
  ],
};

const elsarticle: ClassTemplate = {
  name: 'elsarticle',
  defaultOptions: ['preprint', '12pt'],
  skip: ['natbib', 'geometry'],
  natbibOptions: '',
  bibliographyStyle: 'elsarticle-num',
  chapters: false,
  preambleTitle: () => [],
  frontMatter: (t) => {
    const { list, of } = affiliationIndex(t.authors);
    const out = ['\\begin{frontmatter}', `\\title{${fullTitle(t)}}`];
    t.authors.forEach((a, k) => {
      out.push(`\\author${of[k].length ? `[${of[k].join(',')}]` : ''}{${a.name}}`);
      if (a.email) {
        out.push(`\\ead{${a.email}}`);
      }
    });
    list.forEach((aff, k) => out.push(`\\affiliation[${k + 1}]{organization={${aff}}}`));
    out.push(...abstractLines(t));
    if (t.keywords.length > 0) {
      out.push('\\begin{keyword}', t.keywords.join(' \\sep '), '\\end{keyword}');
    }
    out.push('\\end{frontmatter}');
    return out;
  },
};

const acmart: ClassTemplate = {
  name: 'acmart',
  defaultOptions: ['sigconf'],
  // acmart sets its fonts (libertine, newtxmath: amssymb would clash), loads natbib and hyperref, and forbids
  // geometry.
  skip: ['natbib', 'geometry', 'lmodern', 'fontenc', 'amssymb', 'hyperref'],
  natbibOptions: '',
  bibliographyStyle: 'ACM-Reference-Format',
  chapters: false,
  preambleTitle: () => [],
  frontMatter: (t) => {
    const out = [`\\title{${fullTitle(t)}}`];
    for (const a of t.authors) {
      out.push(`\\author{${a.name}}`);
      // acmart requires a country for every affiliation: the last comma-separated part of the text.
      a.affiliations.forEach((aff) => {
        const parts = aff.split(',').map((p) => p.trim());
        const country = parts.length > 1 ? (parts.pop() as string) : aff;
        out.push(`\\affiliation{\\institution{${parts.join(', ')}}\\country{${country}}}`);
      });
      if (a.email) {
        out.push(`\\email{${a.email}}`);
      }
    }
    out.push(...abstractLines(t));
    if (t.keywords.length > 0) {
      out.push(`\\keywords{${t.keywords.join(', ')}}`);
    }
    out.push(MAKETITLE);
    return out;
  },
};

const llncs: ClassTemplate = {
  name: 'llncs',
  defaultOptions: ['runningheads'],
  skip: ['geometry'],
  natbibOptions: 'numbers',
  bibliographyStyle: 'splncs04',
  chapters: false,
  preambleTitle: () => [],
  frontMatter: (t) => {
    const { list, of } = affiliationIndex(t.authors);
    const names = t.authors.map((a, k) => `${a.name}${of[k].length ? `\\inst{${of[k].join(',')}}` : ''}`).join(' \\and ');
    const institutes = list.map((aff, k) => {
      const emails = t.authors.filter((_, j) => of[j][0] === k + 1 && t.authors[j].email).map((a) => `\\email{${a.email}}`);
      return [aff, ...emails].join(' ');
    });
    const out = [`\\title{${fullTitle(t)}}`, `\\author{${names}}`];
    if (institutes.length > 0) {
      out.push(`\\institute{${institutes.join(' \\and ')}}`);
    }
    out.push(MAKETITLE);
    if (t.abstract.length > 0 || t.keywords.length > 0) {
      out.push('\\begin{abstract}', ...t.abstract);
      if (t.keywords.length > 0) {
        out.push(`\\keywords{${t.keywords.join(' \\and ')}}`);
      }
      out.push('\\end{abstract}');
    }
    return out;
  },
};

const report: ClassTemplate = { ...article, name: 'report', chapters: true };
const book: ClassTemplate = { ...article, name: 'book', chapters: true };

const CLASSES: Record<string, ClassTemplate> = {
  article,
  report,
  book,
  'revtex4-2': revtex,
  'revtex4-1': { ...revtex, name: 'revtex4-1' },
  IEEEtran: ieee,
  elsarticle,
  acmart,
  llncs,
};

/** The template for a class name; undefined for classes without one (the article template is then used). */
export function classTemplate(name: string): ClassTemplate | undefined {
  return CLASSES[name];
}

export function articleTemplate(): ClassTemplate {
  return article;
}
