# Ansys Report Builder

Drop a folder of Ansys screenshots. Each image is read, classified, grouped with its detail
views, placed into the report template, and given a caption. Export is a real `.pptx` you can
open in PowerPoint and edit, plus a CSV index that traces every figure back to its source file.

Runs entirely on your machine — no upload, no account, no npm install.

```bash
cd ansys-reporter
node server.js            # → http://localhost:4000
```

---

## What it does with one drop

```
screenshots  →  read            →  classify            →  group        →  place        →  write        →  export
                pixels, legend     type, load case,       full view +    correct         captions with   .pptx
                colourbar,          component, view,      its zoom /     slide in the    verified        + CSV index
                sharpness, chrome   zoom or section       section        template        numbers only
```

### The classification, per image

| Axis | Values | Read from |
|---|---|---|
| Result type | von Mises, principal, shear, total/directional deformation, strain, safety factor, contact, thermal, fatigue, modal, CFD, mesh, BC, geometry, graph | filename, then pixels, then a vision model if configured |
| Load case | `LC1`…, or named (`Torsion`, `Burst`) | filename |
| Component | whatever is left in the name after the standard words are stripped | filename |
| View | isometric, front, side, top, cut section, zoomed | filename + pixels |
| Detail kind | **zoom** or **cut section** | filename keywords + frame-fill + hatches |
| Source | filename · pixels · vision model · you | always recorded |

Every field carries a confidence and its source, and the review panel shows you
*why* it decided something — because a wrong result type in an FEA report is a correctness
problem, not a cosmetic one.

### Zoom views and cut sections ride with their parent

This is the part built for your workflow. A zoomed view or a cut section never gets a slide of
its own: it is detected, tied to its full view, and placed **as an inset on the same slide**.

```
┌──────────────────────────────────────────────┐
│ Stress — LC2 · Bracket                       │
│ ┌───────────────────────────┐  ┌───────────┐ │
│ │                           │  │ Detail A  │ │
│ │        full model         │  │ (zoomed)  │ │
│ │                           │  ├───────────┤ │
│ │                           │  │ Section B │ │
│ └───────────────────────────┘  │ (cut)     │ │
│ Figure 7 — Equivalent (von Mises) stress …   │
└──────────────────────────────────────────────┘
```

Detection combines the filename (`zoom`, `cut`, `section`, `detail`, `half`, `close`), the pixel
signature (the model fills the frame at ~0% background, dense line work with one dominant edge
direction ⇒ a section cut), and **relative** comparison inside the group — a frame-filling plot
is only a zoom *next to* the same plot with background around it. If a group has a detail but no
full view, that is reported as a gap rather than silently promoted.

---

## The rules it will not break

These came out of the design review and they are enforced in code, not in documentation.

1. **Numbers come from the pipeline, never from generated prose.** Every caption passes a
   numeric firewall: any digit that is not in the verified table is replaced with `—` and
   reported. A fabricated peak is impossible.
2. **Empty beats wrong.** An unreadable value stays empty and says `peak value not entered`.
   Nothing is interpolated or guessed.
3. **Every number is shown next to a crop of the colourbar it came from**, so you verify by
   looking rather than trusting.
4. **Pass/fail only from inputs you supplied.** Enter the allowable once; the summary table then
   computes FoS and verdict and shows the arithmetic. No allowable → no verdict, just `—`.
5. **Suspicion-weighted review.** The queue lists only what is uncertain or unconfirmed. A clean
   batch needs no clicks.
6. **Nothing leaves the machine.** No cloud call anywhere in the pipeline.

## Review shortcuts

| Key | Action |
|---|---|
| `j` / `k` | next / previous image |
| `Enter` | confirm the value on the selected image |
| `z` / `c` / `f` | mark as zoom / cut section / full view |
| `x` | exclude from the report |

## The template is a file, not code

`templates/fea-report.json` defines the sections, their order, capacities and the caption
wording. Change that file (or load a different one from the **Template & details** panel) and the
whole deck re-maps — no code changes.

```json
{ "id": "mesh", "kind": "figures", "title": "Mesh",
  "accepts": { "types": ["Mesh"], "capacity": 2 },
  "bullets": ["Element type and order.", "Global element size.", "…"] }
```

Sections ship in the order a review normally expects: cover → scope → geometry → materials →
mesh → boundary conditions → results (one slide per load case, details as insets) → summary
table → conclusions → appendix.

**The default template is a well-grounded starting point, not your company's actual layout.**
The two sample PDFs and the original `.pptx` master never made it into this workspace, so the
sections follow the standard FEA report order rather than your specific one. Hand over the master
and this file becomes an exact match — or better, point the app at the master directly.

## Verified by tests

```bash
npm test
```

- **`test/pipeline.test.mjs` — 61 checks.** CV signals on synthetic Ansys-like images (legend
  detection, rainbow spectrum, mesh line work, frame-fill), filename parsing including
  `Screenshot 2026-10-01 141322.png` and `image(14).png` (which must yield nothing invented),
  zoom-vs-full discrimination, grouping with and without a parent, duplicate detection, deck
  assembly, the numeric firewall, captions, the summary table and coverage gaps.
- **`test/pptx.test.mjs` — 10 checks.** Builds a real 11-slide deck and validates the generated
  package with `test/verify_pptx.py`: ZIP integrity, XML well-formedness of every part, content
  types covering every part, every relationship target resolving, every image relationship
  declared, and every slide listed in `presentation.xml`.

## Limits, stated honestly

- **Peak values are typed, not read.** The colourbar is located and cropped for you, and its
  value is yours to type and confirm. Automatic OCR of the legend is the obvious next step;
  until it is calibrated it would only add a way to be confidently wrong.
- **The vision model is optional and not wired in yet.** Everything above works with no key.
  Hard cases (`Screenshot 2024-11-02 093311.png` with no naming convention) currently land in
  the review queue rather than being guessed at; a vision model would resolve those, at the cost
  of uploading the image — which for confidential work may be off the table anyway.
- **The template is the grounded default, not your master.** See above.
- **HEIC** decodes in Safari only. JPG, PNG and WebP work everywhere.

## Layout

```
ansys-reporter/
  server.js                 zero-dependency static server
  templates/fea-report.json the report template (sections, captions, rules)
  public/
    index.html              dropzone · live preview · review panel
    css/styles.css
    js/cv.js                pixel analysis: legend, spectrum, mesh, chrome, hashes
    js/classify.js          filename + pixels → taxonomy, grouping, duplicates
    js/report.js            deck assembly, captions, numeric firewall, summary table
    js/pptx.js              OOXML writer (text, images, tables) — no dependencies
    js/zip.js               ZIP writer (stored entries, CRC32)
    js/app.js               the application
  test/                     pipeline + pptx tests, python validator
  docs/council-01.md        the design review this app implements
```
