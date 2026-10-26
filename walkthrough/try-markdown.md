<!-- A step of the getting-started walkthrough (docs/DESIGN.md#help-for-new-users, #converter).
Written by the project (GPL-3.0-or-later, as the rest of the repository). -->

# Try Markdown

The extension also typesets Markdown. Its own converter turns the Markdown into LaTeX, and the same engine
makes the PDF.

1. Click **Make a Markdown article** on the left, and choose a folder as before.
2. `article.md` opens with its PDF beside it. The line `latex-preview: true` at the top asks for the PDF. A
   Markdown file without that line gets a PDF only when you run **Open LaTeX preview**.

What you can write:

- citations, such as `[@callaway1959]`, with the keys in `references.bib`;
- cross-references: `{#sec:method}` after a heading, then `[@sec:method]` in the text;
- maths between `$...$` or `$$...$$`;
- LaTeX commands such as `\ref{...}`, which pass through as written;
- tables, with a caption line such as `Table: Results. {#tbl:results}`.

A click in the PDF goes to the Markdown line. **Show generated LaTeX** opens the converted LaTeX beside the
Markdown. **Export LaTeX** saves it as a `.tex` file next to the Markdown file.

The **Markdown notes** starting document uses XeTeX, so Unicode text and symbols (κ, ≈, ✓) print as written.
