---
title: "Lab notes: phonon transport ✓"
date: 2026-10-15
---

<!-- A stand-in note written for this project's Markdown-to-PDF tests, dedicated to the public domain (CC0 1.0). It uses the
characters notes typed in an editor carry: check marks, arrows, Greek, sub- and superscripts, box drawing in
code, script letters in code and math, an emoji one font has and one that no shipped font has. -->

# Status ✓

Tasks done ✓, open ✗, blocked ⚠. The mean free path ℓ → 0 at high T, so κ ∝ T⁻¹ above Θ.
Water is H₂O; the unit is W m⁻¹ K⁻¹; the step is ½ Å. A smile 😀 for the reviewers, and a rocket 🚀 that no
font has.

## The model

The kinetic estimate is $κ = \tfrac{1}{3} C v ℓ$ with $𝒩$ phonon branches and $τ^{-1} = ∑_i τ_i^{-1}$.

$$
𝒯(ω) = ∑_{q} |v_q|^2 δ(ω − ω_q) \quad ⇒ \quad κ ≈ ∫ 𝒯(ω)\, dω
$$

Inline code with script letters: `𝒩 = len(branches)` and `𝓜 ⊂ 𝒰`.

```
run/
├── input.toml      # 𝒩 = 6 branches ✓
├── phonons/
│   └── bands.dat
└── result.json     → κ(T)
```

| Quantity     | Symbol | Unit       |
|--------------|--------|------------|
| conductivity | κ      | W m⁻¹ K⁻¹  |
| velocity     | v      | m s⁻¹      |

Next: compare with Ωₘ ≥ 3 and the Γ–X branch ⟶ done ✓.
