<!-- Written for the test corpus of this project and dedicated to the public domain (CC0 1.0). -->

<p align="center">
  <img src="docs/logo.png" alt="tidyheat logo" width="160">
</p>

# tidyheat

[![Build](https://img.shields.io/badge/build-passing-brightgreen.svg)](https://example.org/ci) [![Licence: CC0](https://img.shields.io/badge/licence-CC0-blue.svg)](https://creativecommons.org/publicdomain/zero/1.0/)

**tidyheat** solves the steady heat equation on small grids.<br>
It is a toy project, written as a test document: it has no code behind it.

> [!NOTE]
> The solver assumes a uniform grid. Non-uniform grids are on the roadmap.

> [!TIP]
> Run `tidyheat --demo` to see a worked example.

> [!IMPORTANT]
> Version 2 changes the default boundary condition.

> [!WARNING]
> Large grids (over 10<sup>6</sup> cells) need a lot of memory.

> [!CAUTION]
> Never point the solver at a file you have not backed up.

## Installation

```bash
pip install tidyheat
```

Or from source:

```bash
git clone https://example.org/tidyheat.git
cd tidyheat && pip install -e .
```

## The equation

tidyheat solves $\nabla \cdot (k \nabla T) = -q$ on a rectangle, with the GitHub-style
inline form $`k \geq 0`$ as well. In one dimension and for constant $k$:

```math
T(x) = T_0 + \frac{q}{2k}\, x (L - x)
```

and the total heat flow is

```math
Q = -k A \left.\frac{dT}{dx}\right|_{x=0}
```

## Usage

| Option | Default | Meaning |
|:-------|:-------:|--------:|
| `--nx` | 64 | grid points in *x* |
| `--ny` | 64 | grid points in *y* |
| `--tol` | 1e-8 | stopping tolerance |

Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to stop a long run. The result file is H<sub>2</sub>O-free
and saved as `result.npz`.

<details>
<summary>Advanced options</summary>

- `--precond jacobi` uses a Jacobi preconditioner.
- `--precond none` turns preconditioning off.

</details>

### Roadmap

- [x] Uniform grids
- [x] Dirichlet boundaries
- [ ] Neumann boundaries
- [ ] ~~GPU support~~ (dropped)

## Contributing

See [the installation section](#installation), open an issue at <https://example.org/tidyheat/issues>,
or write to maintainers@example.org. Visit www.example.org for more.

## Licence

Dedicated to the public domain under CC0 1.0.[^cc0]

[^cc0]: See https://creativecommons.org/publicdomain/zero/1.0/ for the full text.
