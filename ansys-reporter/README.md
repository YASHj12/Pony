# Ansys Report Builder

Drop a folder of Ansys screenshots. Each image is read, classified, grouped with its zoom and
cut-section views, placed into **your** report template, and given the wording the sample reports
use. Export is a real `.pptx` you can open and edit, plus a CSV index tracing every figure back to
its source file.

Runs entirely on your machine — no upload, no account, no npm install.

```bash
cd ansys-reporter
node server.js            # → http://localhost:4000
```

---

## The template is now your template

Took apart from `sample.pptx`, `6203_KCP_MLD.pptx`, `sample.pdf` and `Sample_1.pdf`
(repo: <https://github.com/YASHj12/report>). Both decks share one structure, and the app
reproduces it slide for slide:

| # | Slide | Filled from |
|---|---|---|
| 1 | **FEA REPORT** · "Static Structural Analysis Of \<part\>" · Report No · Date · Client | Report details panel |
| 2 | **1. Material Properties** — Material, Item, Young's Modulus (MPa), Poisson's Ratio, Density (t/mm³), Yield Stress (MPa), **Allowable** + units line + `σall = Syt / FOS  FOS = 1.3` | your material row; allowable computed |
| 3 | **2. \<part\> Geometry** — one or two views, label above each ("Top view", "Isometric") | geometry images |
| 4 | **3. \<part\> Mesh** | mesh image |
| 5 | **Case N: \<description\>** — BC image left, "Boundary Conditions" + your A) B) C) text right | BC image + the text you write |
| 6 | **Case N: Results** — *Total deformation* ⟨left⟩ and *Von-mises stress* ⟨right⟩, label above, value line below | deformation + stress images |
| 6b | …with **Detail / Section insets on the same slide** | zoom and cut-section images |
| 7 | **Case N: Observation & Summary** | generated from the confirmed values |
| 11 | **Final Summary** — Load Case \| Max. Deformation \| Max. Von-Mises Stress \| Allowable Stress | the confirmed values |

House details that were matched deliberately:

- **Allowable = floor(Yield ÷ FOS)** — `213 / 1.3 → 163` and `380 / 1.3 → 292`, exactly as the two
  decks print them (plain rounding would give 164).
- **"Exceeding Limit"** replaces the stress value in the summary table when the peak is over the
  allowable, as in both decks.
- The verdict sentence: *"The stress is within the material's allowable limit of 163 MPa."* /
  *"The stress exceeds the material's allowable limit of 163 MPa."*
- Observation bullets: *"Total deformation in the GG is 3 mm."* / *"Von-Mises stress in the GG
  exceeds the material's allowable stress limit of 163 MPa."*
- The part's **short name** (GG, Blade) is what the sentences use.
- `Sample_1.pdf`'s older wording ("Max. Total Deformation = 1.7 mm", "…are within the materials
  allowable stress limit (i.e. 140 Mpa).") is kept in the template as `phrasesLegacy` — one button
  switches house style.

Everything above lives in `templates/fea-report.json` — sections, order, columns, phrases. Edit the
file or load your own; the engine re-maps and no code changes.

## Zoom and cut-section views land on their parent's slide

This is the behaviour you asked for. A zoom or a cut section never gets its own page:

```
┌───────────────────────────────────────────────────────────┐
│ Case 2: Results                                           │
│ ┌───────────────────────┐  ┌───────────────────────┐      │
│ │   Total deformation   │  │    Von-mises stress   │      │
│ │   [ full model ]      │  │    [ full model ]     │      │
│ │  Maximum Total        │  │  The stress exceeds   │      │
│ │  Deformation – 4 mm   │  │  …limit of 163 MPa.   │      │
│ └───────────────────────┘  └───────────────────────┘      │
│ DETAIL VIEWS OF THE ABOVE                                 │
│ ┌────────┐ ┌────────┐                                     │
│ │Section │ │Detail  │                                     │
│ │  A     │ │  B     │                                     │
│ └────────┘ └────────┘                                     │
└───────────────────────────────────────────────────────────┘
```

Detection uses three signals: the **filename** (`zoom`, `cut`, `section`, `detail`, `half`, `clip`),
the **pixels** (the model fills the frame at ~2% background, dense line work with one dominant edge
direction ⇒ a section cut), and **relative** comparison inside the case — a frame-filling plot is
only a zoom *next to* the same plot with background around it. A group with a detail but no full
view is reported as a gap, never silently promoted.

## The rules it will not break

1. **Numbers come from the pipeline, never from generated prose.** Every sentence passes a numeric
   firewall; digits that are not confirmed values are replaced with `—` and reported.
2. **Empty beats wrong.** An unconfirmed value never reaches the report — the line reads
   "value not entered" and the summary cell shows `—`.
3. **Every value is shown next to a crop of the colourbar it came from.**
4. **The app reasons, you authorise.** FoS and the verdict are computed only from the allowable you
   entered and the peak you confirmed, and the arithmetic is shown.
5. **Suspicion-weighted review.** Only uncertain or unconfirmed items appear in the review queue.
6. **Nothing leaves the machine.**

## Review shortcuts

`j`/`k` next/previous · `Enter` confirm value · `z` mark zoom · `c` mark cut section · `f` mark full
view · `x` exclude.

## Verified by tests

```bash
npm test      # 57 pipeline checks + 16 pptx checks
```

- **`test/pipeline.test.mjs` (57).** Filename parsing (`LC2_vonMises_bracket_iso.png`,
  `LC2_cut_section_stress.png`, and the two that must yield *nothing*: `image(14).png`,
  `Screenshot 2026-10-01 141322.png`), detail-vs-full discrimination, the exact slide order against
  the sample decks, the value lines, the verdict for within/exceeds, the four summary columns,
  "Exceeding Limit", allowable rounding (213→163, 380→292), the firewall, and the gap warnings.
- **`test/pptx.test.mjs` (16).** Builds the full 11-slide report and validates the generated
  package with `test/verify_pptx.py`: ZIP integrity, XML well-formedness of every part, content
  types, relationship resolution (every image and layout rel), slide list in `presentation.xml`.
  Then asserts the deck's actual text: report number, the material row, the house labels, the value
  lines, the verdict sentence, the insets, and the summary table.
- `test/dump_pptx.py` prints each slide's text for inspection — run it on your own export.

## Limits, stated honestly

- **Peak values are typed, not read.** The colourbar is located and cropped for you to read; the
  value is yours to type and confirm. Automatic legend OCR is the obvious next step, and until it
  is calibrated against real screenshots it would only add a way to be confidently wrong.
- **Boundary-conditions text is yours to write.** The app gives the slide and the placeholder; it
  will not invent "A) … B) … C) …".
- **Case descriptions are yours.** `LC1` from a filename becomes "Case 1"; the description
  ("Gate Fully Closed (Self Weight + Pressure)") is typed once in the Cases panel.
- **Template vs. your master.** The structure, wording and colours are taken from the sample decks;
  the master's logo, exact fonts and any custom layout will only match pixel-perfect when you load
  the real `.pptx` master. Template loading by file is already supported.
- **HEIC** decodes in Safari only. JPG, PNG and WebP work everywhere.

## Layout

```
ansys-reporter/
  server.js                  zero-dependency static server
  templates/fea-report.json  the report template (sections, columns, phrases, detail rules)
  public/
    index.html               dropzone · live slide preview · review · materials · cases
    css/styles.css
    js/cv.js                 pixel analysis: legend, spectrum, mesh, chrome, hashes
    js/classify.js           filename + pixels → taxonomy, detail detection, grouping
    js/report.js             cases, sentences, firewall, deck assembly, summary table
    js/pptx.js               OOXML writer: cover, tables, figure rows, insets, figure+text, grid
    js/zip.js                ZIP writer (stored entries, CRC32)
    js/app.js                the application
  test/                      pipeline + pptx tests, python validator and slide dumper
  docs/council-01.md         the design review this app implements
```
