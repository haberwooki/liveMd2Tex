# Manuscript draft: a stand-in for the preset tests

> Drafting notes before the body are not part of the paper. Written for this project's tests and dedicated
> to the public domain (CC0 1.0).

**Working title:** *Do layered crystals conduct heat? A stand-in study of anisotropy*

**Authors:** Ada Example and Ben Sample

**Affiliations:** Department of Physics, Example University

**Corresponding author:** Ada Example (ada@example.org)

**Abstract:** We measure the in-plane and cross-plane conductivity of a layered crystal and find a ratio near ~100 [Slack 1973].

---

## 1. Introduction

Layered crystals conduct heat well along their layers [Callaway 1959; Ziman 1960] and poorly across them —
a contrast that the relaxation-time model explains [Minnich
2015]. The ratio |κ| exceeds 10², and ΔT stays below 5 K. TODO: check this number against the 2019 data
The code lives in `scripts/fit_kappa.py`, and the tilt is 30° at most.

> Note to coauthors: this paragraph needs a second source.

We write the model as $\kappa = C v \ell / 3$, *the kinetic formula*, and "quote" it.[^def]

[^def]: The heat capacity $C$ is per unit volume.

## 2. Measurements

**Table 1.** Conductivity of three samples. The **Ratio** column is in-plane over cross-plane.

| Sample | In-plane | Cross-plane | Ratio | Comment |
|--------|---------:|------------:|------:|---------|
| A | 150 | 1.5 | 100 | grown along the layers, as described in the methods |
| B | 140 | 1.6 | 88 | slight misalignment |

Units: W m⁻¹ K⁻¹; ratios rounded.

![Figure 1](figs/fig_single.png)

**Figure 1.** The ratio against temperature, for both samples.

![Figure 2](figs/wide_figure.png)

**Figure 2.** A wide figure across both columns.

![Figure 3](figs/side_figure.png)

**Figure 3.** A wide figure with its caption beside it.

| x | y |
|---|---|
| 1 | 2 |

### Notes to coauthors

These lines are drafting notes and are removed.

## 3. Conclusion

The anisotropy follows from the layering.
