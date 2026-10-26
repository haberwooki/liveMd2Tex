// A preset is a named set of converter rules a folder can switch on (docs/DESIGN.md#presets). It is a
// JSON file: shared settings plus modes (a paper, a supplement, a letter, a report ...), each mode a set of the
// options below. With no preset, every option has its default, which is the general dialect.
// The example preset in examples/presets/ shows them with neutral settings; nothing about it is built in: every
// rule it uses is an option here.

export interface EscapeOptions {
  /** 'raw-tex': pandoc's raw_tex rule (commands pass through); 'escape': every backslash prints. */
  backslash: 'raw-tex' | 'escape';
  /** Escape { and } as \{ \} (or leave them, as older scripts do). */
  braces: boolean;
  /** Write [ and ] as {[} {]} (safe after \item and \\), or leave them. */
  brackets: boolean;
  /** Write < > as \textless{} \textgreater{} (or leave them; T1 fonts print them). */
  angles: boolean;
  /** 'math': $...$ is math; 'escape': every $ prints (no math). */
  dollar: 'math' | 'escape';
  /** A lone ~ : 'escape' prints a tilde, 'sim' prints $\sim$ ("approximately"), 'nbsp' is a tie. */
  tilde: 'escape' | 'sim' | 'nbsp';
  /** How a lone ^ prints. */
  caret: 'hat' | 'textasciicircum';
  /** 'closed': an em dash takes no spaces around it (Chicago); 'spaced': as written. */
  emDash: 'spaced' | 'closed';
  /** Straight single quotes become curly (smart) or stay straight. */
  singleQuotes: 'smart' | 'straight';
  /** Straight double quotes become TeX quotes (tex) or stay straight. */
  doubleQuotes: 'tex' | 'straight';
}

export interface HeadingOptions {
  /** LaTeX command per Markdown heading level (1-6), e.g. {"2": "section"}; "section*" for unnumbered. */
  commands: Record<string, string>;
  /** Drop a leading number from the heading text: "## 3. Results" -> \section{Results}. */
  stripNumbers: boolean;
  /** Headings without a leading number become starred (unnumbered) commands. */
  starUnnumbered: boolean;
  /** Emit \label{...} after headings (pandoc identifiers). */
  labels: boolean;
}

export interface FigureOptions {
  /** 'alt': pandoc's implicit figure (the alt text is the caption); 'next-paragraph': the paragraph after the
   * image that starts with the caption label ("**Figure 3.** ...") is the caption. */
  caption: 'alt' | 'next-paragraph';
  /** The bold label that starts a caption paragraph, e.g. "Figure". */
  label: string;
  /** Keep the author's "Figure N." in the caption (LaTeX numbering then off, in the preamble), or drop it. */
  keepLabel: boolean;
  /** Use a .pdf for a .png: 'always' (by name), 'if-exists' (the caller checks), 'never'. */
  pdfForPng: 'always' | 'if-exists' | 'never';
  /** Markup: 'general' (this converter's figure), 'two-column' (single, wide and side-caption layouts),
   * 'report' (one centred float with a height cap). */
  style: 'general' | 'two-column' | 'report';
  /** Figure file stems by layout, for the two-column style. */
  wide: string[];
  sideCaption: string[];
  /**
   * The \includegraphics options of each layout of the two-column and report styles. Plain by default; a preset can
   * cap the height, e.g. "width=\linewidth,height=0.8\textheight,keepaspectratio".
   */
  graphics: { single: string; wide: string; side: string; report: string };
  /** The side-caption layout's two minipages (the figure, then the caption), as fractions of \textwidth. */
  sideCaptionWidths: number[];
}

export interface TableOptions {
  /** 'pandoc': "Table: ..." captions; 'previous-paragraph': a "**Table N.** ..." paragraph before the table. */
  caption: 'pandoc' | 'previous-paragraph';
  label: string;
  keepLabel: boolean;
  /** Markup: 'general', 'two-column' (table* with column types by content, notes folded in), 'report'
   * (all-left word tables in a table float). */
  style: 'general' | 'two-column' | 'report';
  /** A paragraph right after a table that starts with one of these is a table note, kept with the table. */
  notePrefixes: string[];
  /** Float placement for the two-column style, e.g. "tb". */
  placement: string;
  /** Supplement layout: tables stay in place ([H]). */
  inPlace: boolean;
  /**
   * LaTeX put before and after an in-place tabular (one without an X column), e.g. a \resizebox that shrinks a wide
   * table to the line. None by default: ["", ""].
   */
  wrap: string[];
}

export interface NoteOptions {
  /** Show drafting notes in the output (as margin notes) or remove them ("Export clean PDF"). */
  show: boolean;
  /** An inline note runs from this marker to the end of the line, e.g. " TODO:" (the leading space matters, so a
   * word that ends in "TODO:", such as "MYTODO:", never matches). Empty, the default: no inline notes. */
  inlineMarker: string;
  /** Block quotes whose first words are one of these are drafting notes. */
  blockquotePrefixes: string[];
  /** Sections whose heading is one of these hold drafting notes. */
  sections: string[];
}

export interface AppendixOptions {
  /** The heading the appendix gets, e.g. "Methods" (an unnumbered \section*). */
  heading: string;
  /** Source lines dropped before converting (regular expressions). */
  dropLines: string[];
  /** Sub-headings become unnumbered. */
  starred: boolean;
  /** Start the appendix on a new page. */
  clearpage: boolean;
}

export interface PresetMode {
  /** Mode name, for messages. */
  name: string;
  escape: EscapeOptions;
  /** Text replacements applied before the default Unicode table, longest first: [from, LaTeX]. */
  unicode: [string, string][];
  emphasis: 'emph' | 'textit';
  /** Code spans: 'general'; 'text' (escaped like ordinary text); 'text-breaks' (also break points after / _ .). */
  code: 'general' | 'text' | 'text-breaks';
  /** Author-year citations "[Surname 2020; Other 2019a]": 'off', 'cite' (\cite{surname2020,other2019a}),
   * or 'text' (printed "(Surname 2020; Other 2019a)", for a letter with no bibliography). */
  authorYear: 'off' | 'cite' | 'text';
  /** Pandoc [@key] citations (natbib or biblatex). */
  pandocCitations: boolean;
  /** Bare web and e-mail addresses become links (GFM autolinks). */
  autolinks: boolean;
  headings: HeadingOptions;
  /** Horizontal rules: drawn or dropped. */
  rules: 'rule' | 'drop';
  /** Block quotes: a quote environment, a small quote, or dropped (drafting notes in a paper). */
  blockquotes: 'quote' | 'small-quote' | 'drop';
  /** Options appended to \begin{itemize} and \begin{enumerate}, e.g. "[leftmargin=*]" (needs enumitem). */
  listOptions: string;
  /** Front matter: pandoc YAML; bold labels ("**Authors:** ..."); a setext-style block (# Title, then author
   * and date lines up to a ---); or none (# headings dropped, for letters). */
  frontMatter: 'yaml' | 'bold-labels' | 'title-block' | 'drop-title';
  /** The body starts at the first line that begins with this text (e.g. "## 1."); before it is front matter. */
  bodyStart: string;
  /** Title: \maketitle, a two-column banner, a centred heading, or none. */
  title: 'maketitle' | 'banner' | 'heading' | 'none';
  /** Text of the centred heading for title "heading". */
  titleText: string;
  /** Labels the banner title uses before the corresponding author and the abstract. */
  titleLabels: { correspondence: string; abstract: string };
  /**
   * The engine the mode's documents are meant for; 'xelatex' keeps Unicode characters as they are. 'auto':
   * pdfLaTeX, unless the document has characters pdfLaTeX cannot print as single characters (an accented name
   * such as ė, a box-drawing line); then XeTeX with xetexPreamble, when the mode has one.
   */
  engine: 'pdflatex' | 'xelatex' | 'auto';
  /** Break the title after a question mark onto a second line. */
  titleBreakAfterQuestion: boolean;
  /** In a block where any line ends with two spaces, every line keeps its break (signatures, lists). */
  blockLineBreaks: boolean;
  figures: FigureOptions;
  tables: TableOptions;
  notes: NoteOptions;
  /** The LaTeX preamble up to and including \begin{document}; empty: the default template. */
  preamble: string;
  /** The preamble used when engine 'auto' chooses XeTeX (from xetexPreambleFile); empty: none. */
  xetexPreamble: string;
  /** \bibliographystyle and \bibliography at the end; empty style: none. */
  bibliographyStyle: string;
  bibliographyFiles: string[];
  appendix?: AppendixOptions;
}

export function defaultMode(): PresetMode {
  return {
    name: 'default',
    escape: {
      backslash: 'raw-tex',
      braces: true,
      brackets: true,
      angles: true,
      dollar: 'math',
      tilde: 'escape',
      caret: 'hat',
      emDash: 'spaced',
      singleQuotes: 'smart',
      doubleQuotes: 'tex',
    },
    unicode: [],
    emphasis: 'emph',
    code: 'general',
    authorYear: 'off',
    pandocCitations: true,
    autolinks: true,
    headings: {
      commands: { '1': 'section', '2': 'subsection', '3': 'subsubsection', '4': 'paragraph', '5': 'subparagraph', '6': 'subparagraph' },
      stripNumbers: false,
      starUnnumbered: false,
      labels: true,
    },
    rules: 'rule',
    blockquotes: 'quote',
    listOptions: '',
    frontMatter: 'yaml',
    bodyStart: '',
    title: 'maketitle',
    titleText: '',
    titleLabels: { correspondence: 'Correspondence: ', abstract: 'Abstract.' },
    engine: 'pdflatex',
    titleBreakAfterQuestion: false,
    blockLineBreaks: false,
    figures: {
      caption: 'alt',
      label: 'Figure',
      keepLabel: false,
      pdfForPng: 'if-exists',
      style: 'general',
      wide: [],
      sideCaption: [],
      graphics: { single: 'width=\\linewidth', wide: 'width=\\textwidth', side: 'width=\\linewidth', report: 'width=\\linewidth' },
      sideCaptionWidths: [0.6, 0.37],
    },
    tables: { caption: 'pandoc', label: 'Table', keepLabel: false, style: 'general', notePrefixes: [], placement: 'htbp', inPlace: false, wrap: ['', ''] },
    notes: { show: false, inlineMarker: '', blockquotePrefixes: [], sections: [] },
    preamble: '',
    xetexPreamble: '',
    bibliographyStyle: '',
    bibliographyFiles: [],
  };
}
