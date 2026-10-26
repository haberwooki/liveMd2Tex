---
title: "A short, informative title for a Springer LNCS paper"
author:
  - name: First Author
    affiliation: Department of Physics, Example University, City, Country
    email: first.author@example.org
  - name: Second Author
    affiliation: Example Institute, City, Country
abstract: |
  One paragraph: the question, what you did, what you found, and why it matters.
keywords: [first keyword, second keyword]
documentclass: llncs
classoption: [runningheads]
bibliography: references.bib
---

<!-- SPDX-License-Identifier: CC0-1.0 -->

<!-- A starting document from the extension's templates (llncs), dedicated to the public domain (CC0 1.0). Replace the text and keep the structure you need. -->

# Introduction {#sec:intro}

State the problem and why it matters. Cite sources as [@callaway1959] or
[@slack1973; @ziman1960], and refer to [@sec:methods], [@eq:model] and [@tbl:results].

# Methods {#sec:methods}

The kinetic model gives the thermal conductivity as

$$
\kappa = \frac{1}{3} C v \ell
$$ {#eq:model}

where $C$ is the heat capacity per volume, $v$ a sound velocity and $\ell$ the mean free path.

# Results {#sec:results}

Table: Measured values for two samples. {#tbl:results}

| Sample | $\kappa$ (W/m K) | Uncertainty |
|:-------|-----------------:|------------:|
| A | 150 | 5 |
| B | 140 | 6 |

To add a figure, put the image next to this file and write `![Caption text.](figure.pdf)` on a line
of its own; an attribute block in curly braces right after it, holding #fig:name and width=80%, labels and sizes it.

# Conclusion

Summarise what you found.
