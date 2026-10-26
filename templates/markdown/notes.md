---
title: "Lab notes"
template: notes
---

<!-- SPDX-License-Identifier: CC0-1.0 -->

<!-- A starting document from the extension's templates (Markdown, the notes template), dedicated to the public domain (CC0 1.0). The notes template is typeset with XeTeX and DejaVu fonts, so Unicode text, symbols and box drawing print as written. -->

# Setup

- Sample: A, 10 mm × 10 mm.
- Temperature: 20 °C ± 0.5 °C.
- Result: ΔT = 1.2 K, so κ ≈ 150 W m⁻¹ K⁻¹ ✓

# Code

```python
def conductivity(power, length, area, delta_t):
    return power * length / (area * delta_t)
```

# Open points

1. Check the contact resistance.
2. Repeat at 40 °C.
