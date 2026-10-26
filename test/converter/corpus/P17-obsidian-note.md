---
title: Phonon scattering reading notes
tags: [physics, reading]
aliases: [scattering notes]
created: 2026-10-15
---

%% Written for the test corpus of this project and dedicated to the public domain (CC0 1.0). %%

# Phonon scattering

Links to other notes stay as text: [[Umklapp process]], [[Debye model|the Debye model]]
and [[Thermal conductivity#Kinetic theory]]. Tags such as #physics/phonons are plain text.

> [!info] Source
> Chapter 8 of the textbook, read on 2026-10-14.

> [!tip]
> Keep the three scattering rates separate until the end.

> [!question]- Why does Umklapp need a reciprocal lattice vector?
> Because the total crystal momentum changes by $\hbar \mathbf{G}$.

> [!warning] Common mistake
> Matthiessen's rule ==adds rates, not times==.
>
> > [!example] Nested callout
> > $\tau^{-1} = \tau_U^{-1} + \tau_B^{-1}$

## Key ideas

1. Normal processes conserve momentum and do not ==limit the conductivity== by themselves.
2. Umklapp processes do, with a rate $\propto e^{-\theta_D / 3T}$. %%check the factor 3%%
3. Boundary scattering dominates at low $T$.

The kinetic formula:

$$
\kappa = \frac{1}{3} C v \ell
$$

![[phonon-dispersion.png]]

![[spectrum-sketch.png|300]]

%%
A longer private comment
that spans several lines
and is dropped from the output.
%%

## To do

- [ ] Read the Callaway paper
- [x] Sketch the dispersion
- [ ] Ask about the 3 in $e^{-\theta_D/3T}$

Footnotes work as usual.[^1]

[^1]: Obsidian renders them at the end of the note.
