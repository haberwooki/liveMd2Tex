// pandoc's metadata names, read from the YAML front matter and the folder config (docs/DESIGN.md#converter):
// title, subtitle, author (a string, a list, or a list of {name, affiliation, email}), date, abstract,
// keywords, bibliography, documentclass, classoption, fontsize, geometry, header-includes, lang, toc,
// numbersections, link-citations, biblio-style, natbib or biblatex (and cite-method), engine (or pdf-engine)
// and template (the extension's own: xelatex or pdflatex, notes or default), plus pandoc-crossref's
// cref and its prefix names. Values that are Markdown (title, abstract, ...) stay Markdown here; the writer
// converts them.

import type { FrontMatter } from './frontMatter';

export interface Author {
  name: string;
  affiliations: string[];
  email?: string;
}

export type CitationPackage = 'natbib' | 'biblatex';

export type EngineName = 'pdflatex' | 'xelatex';

export type TemplateName = 'default' | 'notes';

export interface CrossrefPrefixes {
  fig: [string, string];
  tbl: [string, string];
  eq: [string, string];
  sec: [string, string];
  lst: [string, string];
}

export interface DocumentMeta {
  title?: string;
  subtitle?: string;
  authors: Author[];
  date?: string;
  abstract?: string;
  keywords: string[];
  bibliography: string[];
  documentclass: string;
  classoptions: string[];
  fontsize?: string;
  geometry: string[];
  headerIncludes: string[];
  lang?: string;
  toc: boolean;
  numbersections: boolean;
  citationPackage: CitationPackage;
  biblioStyle?: string;
  cref: boolean;
  prefixes: CrossrefPrefixes;
  csl?: string;
  /** engine (or pdf-engine): xelatex or pdflatex; absent: chosen from the characters. */
  engine?: EngineName;
  /** template: notes (the XeTeX notes template) or default; absent: chosen from the characters. */
  template?: TemplateName;
  /** 1-based source line of each key that was set, for the line map of the preamble. */
  lines: Record<string, number>;
}

/** Defaults a folder config may set; front matter wins over them. */
export interface MetaDefaults {
  citationPackage?: CitationPackage;
  cref?: boolean;
  numbersections?: boolean;
  documentclass?: string;
  classoptions?: string[];
  geometry?: string[];
  biblioStyle?: string;
  engine?: EngineName;
  template?: TemplateName;
}

export const DEFAULT_PREFIXES: CrossrefPrefixes = {
  fig: ['fig.', 'figs.'],
  tbl: ['tbl.', 'tbls.'],
  eq: ['eq.', 'eqns.'],
  sec: ['sec.', 'secs.'],
  lst: ['lst.', 'lsts.'],
};

function asString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return undefined;
}

/** xelatex or pdflatex (also "xetex", "pdftex"); undefined for anything else. */
export function asEngine(value: unknown): EngineName | undefined {
  const s = asString(value)?.toLowerCase().trim();
  return s === 'xelatex' || s === 'xetex' ? 'xelatex' : s === 'pdflatex' || s === 'pdftex' ? 'pdflatex' : undefined;
}

/** notes or default (also "article"); undefined for anything else. */
export function asTemplate(value: unknown): TemplateName | undefined {
  const s = asString(value)?.toLowerCase().trim();
  return s === 'notes' ? 'notes' : s === 'default' || s === 'article' ? 'default' : undefined;
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(asString).filter((s): s is string => s !== undefined);
  }
  const s = asString(value);
  return s === undefined ? [] : [s];
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    if (/^(true|yes|on)$/i.test(value)) {
      return true;
    }
    if (/^(false|no|off)$/i.test(value)) {
      return false;
    }
  }
  return undefined;
}

function readAuthors(value: unknown): Author[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const authors: Author[] = [];
  for (const entry of list) {
    if (typeof entry === 'string' || typeof entry === 'number') {
      authors.push({ name: String(entry), affiliations: [] });
    } else if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      // pandoc allows {name: ...}, and also the one-key form {"Jane Doe": {affiliation: ...}}.
      let name = asString(record.name);
      let details = record;
      const keys = Object.keys(record);
      if (name === undefined && keys.length === 1 && record[keys[0]] && typeof record[keys[0]] === 'object') {
        name = keys[0];
        details = record[keys[0]] as Record<string, unknown>;
      }
      if (name === undefined) {
        continue;
      }
      authors.push({
        name,
        affiliations: [...asList(details.affiliation), ...asList(details.affiliations), ...asList(details.institute)],
        email: asString(details.email),
      });
    }
  }
  return authors;
}

function prefixPair(value: unknown, fallback: [string, string]): [string, string] {
  if (Array.isArray(value)) {
    const list = asList(value);
    if (list.length >= 2) {
      return [list[0], list[1]];
    }
    if (list.length === 1) {
      return [list[0], list[0]];
    }
  }
  const s = asString(value);
  return s === undefined ? fallback : [s, s];
}

export function readMetadata(frontMatter: FrontMatter | undefined, defaults: MetaDefaults = {}): DocumentMeta {
  const d = frontMatter?.data ?? {};
  let citationPackage: CitationPackage = defaults.citationPackage ?? 'natbib';
  const method = asString(d['cite-method'])?.toLowerCase();
  if (asBool(d.biblatex) === true || method === 'biblatex') {
    citationPackage = 'biblatex';
  } else if (asBool(d.natbib) === true || method === 'natbib') {
    citationPackage = 'natbib';
  }
  const crossref = (d.crossref && typeof d.crossref === 'object' ? d.crossref : {}) as Record<string, unknown>;
  const pick = (name: string) => d[name] ?? crossref[name];
  const meta: DocumentMeta = {
    title: asString(d.title),
    subtitle: asString(d.subtitle),
    authors: readAuthors(d.author ?? d.authors),
    date: asString(d.date),
    abstract: asString(d.abstract),
    keywords: asList(d.keywords),
    bibliography: asList(d.bibliography),
    documentclass: asString(d.documentclass) ?? defaults.documentclass ?? 'article',
    classoptions: d.classoption !== undefined ? asList(d.classoption) : [...(defaults.classoptions ?? [])],
    fontsize: asString(d.fontsize),
    geometry: d.geometry !== undefined ? asList(d.geometry) : [...(defaults.geometry ?? ['margin=1in'])],
    headerIncludes: asList(d['header-includes']),
    lang: asString(d.lang),
    toc: asBool(d.toc) ?? asBool(d['table-of-contents']) ?? false,
    numbersections: asBool(d.numbersections) ?? defaults.numbersections ?? true,
    citationPackage,
    biblioStyle: asString(d['biblio-style']) ?? defaults.biblioStyle,
    cref: asBool(pick('cref')) ?? defaults.cref ?? false,
    prefixes: {
      fig: prefixPair(pick('figPrefix'), DEFAULT_PREFIXES.fig),
      tbl: prefixPair(pick('tblPrefix'), DEFAULT_PREFIXES.tbl),
      eq: prefixPair(pick('eqnPrefix'), DEFAULT_PREFIXES.eq),
      sec: prefixPair(pick('secPrefix'), DEFAULT_PREFIXES.sec),
      lst: prefixPair(pick('lstPrefix'), DEFAULT_PREFIXES.lst),
    },
    csl: asString(d.csl),
    engine: asEngine(d.engine ?? d['pdf-engine']) ?? defaults.engine,
    template: asTemplate(d.template) ?? defaults.template,
    lines: { ...(frontMatter?.keyLines ?? {}) },
  };
  return meta;
}

/** babel names for the common BCP 47 tags pandoc's lang takes; undefined when unknown. */
export function babelLanguage(lang: string): string | undefined {
  const tag = lang.toLowerCase();
  const table: Record<string, string> = {
    en: 'english', 'en-us': 'american', 'en-gb': 'british', 'en-au': 'australian', 'en-ca': 'canadian',
    de: 'ngerman', 'de-de': 'ngerman', 'de-at': 'naustrian', 'de-ch': 'nswissgerman', fr: 'french',
    'fr-fr': 'french', 'fr-ca': 'canadien', es: 'spanish', it: 'italian', pt: 'portuguese', 'pt-br': 'brazil',
    nl: 'dutch', sv: 'swedish', da: 'danish', nb: 'norsk', nn: 'nynorsk', no: 'norsk', fi: 'finnish',
    pl: 'polish', cs: 'czech', sk: 'slovak', sl: 'slovene', hr: 'croatian', hu: 'magyar', ro: 'romanian',
    tr: 'turkish', ca: 'catalan', eu: 'basque', gl: 'galician', et: 'estonian', lv: 'latvian', lt: 'lithuanian',
    is: 'icelandic', ga: 'irish', cy: 'welsh', la: 'latin', id: 'indonesian', ms: 'malay',
  };
  return table[tag] ?? table[tag.split('-')[0]];
}
