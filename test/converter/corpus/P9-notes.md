# Lab notes: thermal conductivity runs

Written for the test corpus of this project and dedicated to the public domain (CC0 1.0).
These are plain Markdown notes of the kind people keep beside an experiment: no front matter,
some math, a few tables, Unicode symbols and code.

[TOC]

## Setup

The sample sits between two copper blocks at T₁ = 300 K and T₂ = 310 K, so ΔT ≈ 10 K.
Heat flows from hot → cold; the flux obeys Fourier's law, $q = -k \nabla T$.
The heater gives 2.5 W ± 0.1 W, and the thermocouples read to 0.05 °C.

- Sample length: $L = 12.0$ mm
- Cross-section: $A = 4.0 \times 4.0$ mm²
- Contact resistance: *assumed* negligible (to be checked)

### Checklist before each run

- [x] Grease both contacts
- [x] Wait 20 min for steady state
- [ ] Log the room temperature
- [ ] Photograph the setup

## Results

| Run | $\Delta T$ (K) | $P$ (W) | $k$ (W m⁻¹ K⁻¹) | Notes |
|:---:|---------------:|--------:|----------------:|-------|
| 1   | 10.2 | 2.50 | 147 | first try, **good** contact |
| 2   | 9.8  | 2.48 | 152 | re-greased |
| 3   | 10.5 | 2.51 | 143 | room was warm (≥ 24 °C) |

The conductivity follows from

$$
k = \frac{P L}{A \, \Delta T}
$$

and the mean of the three runs is $\bar k = 147 \pm 4$ W m⁻¹ K⁻¹.[^copper]
Inline display math works too: $$\sigma_k = \sqrt{\frac{1}{N-1}\sum_i (k_i - \bar k)^2}$$ inside a sentence.

[^copper]: Copper itself is about 400 W m⁻¹ K⁻¹, so the blocks are not the bottleneck.

> Remember: the heater lead resistance adds ~0.3 Ω, which is ~2 % of the heater.
> Correct for it next time.

## Analysis script

The fit lives in `fit_k.py`; run it with `python fit_k.py --runs 1-3`.

```python
import numpy as np

def conductivity(P, L, A, dT):
    """k = P L / (A dT), all in SI units."""
    return P * L / (A * dT)

runs = np.array([[2.50, 10.2], [2.48, 9.8], [2.51, 10.5]])
print([conductivity(P, 0.012, 1.6e-5, dT) for P, dT in runs])
```

Output layout of the logger (box drawing in a code block):

```
┌──────┬────────┐
│ run  │ k      │
├──────┼────────┤
│ 1    │ 147    │
└──────┴────────┘
```

## Open questions

1. Is the contact resistance really negligible?
2. Should we switch to a guarded hot plate?
   - Pro: less radial loss
   - Con: three more thermocouples
3. ~~Order new copper blocks~~ (done, arrived Monday)

Symbols seen in these notes: α, β, γ, ✓, ≤, ≥, ≠, ∞, →, ←, ⇒, × and ½.

---

Last edited after run 3. Next: see [the setup section](#setup) and the [project page](https://example.org/thermal).
