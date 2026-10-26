// Type declarations for the two markdown-it plugins that ship none (both MIT, plain markdown-it plugins).
declare module 'markdown-it-footnote' {
  import type MarkdownIt from 'markdown-it';
  const footnote: (md: MarkdownIt.MarkdownIt) => void;
  export default footnote;
}

declare module 'markdown-it-deflist' {
  import type MarkdownIt from 'markdown-it';
  const deflist: (md: MarkdownIt.MarkdownIt) => void;
  export default deflist;
}
