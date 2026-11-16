# STARWHALE — make.fun ai-excited-01

A program that draws one image: **STARWHALE** — a galaxy-sized luminous
whale arcing through a nebula, its body dusted with stars, blowing a spiral
of golden stars from its mouth, a tiny astronaut standing on its back waving,
and a ringed planet watching from the corner.

Everything is drawn procedurally in code (no image files, no network):
a float RGB buffer, Catmull-Rom spline whale, seeded stars, a hand-written
PNG encoder. The output is fully deterministic — same bytes every run.

## Run

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

Writes `out/entry.png` (1024×1024, ≤ 1 MiB) and prints its size and sha256.
Node 22, standard library only.
