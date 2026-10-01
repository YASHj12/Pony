# Council Round 1 — Ansys Report Automation

**Subject:** an app that ingests Ansys result images and produces the company report, in the company template.
**Inputs available to the council:** your two verbal descriptions. **The two sample PDFs were not attached** — every statement about the template in this document is marked `[ASSUMPTION — verify against PDF]`.
**Date:** 2026-10-01

---

## The council

| Member | Mandate | Red line |
|---|---|---|
| **1. The Simulation Engineer** | Physical and numerical correctness | Will not ship a result that misrepresents the analysis |
| **2. The QA Approver** | Liability, traceability, sign-off | No unverified number reaches an issued report |
| **3. The Automation Architect** | Feasibility, speed, integration | No architecture that breaks under 200 images |
| **4. The Adversarial Red-Teamer** | Find how it fails before the customer does | Any silent failure is a blocking defect |
| **5. The Report Author** (end user) | Daily workflow, speed, ergonomics | If review takes longer than doing it by hand, it dies |

Each member was asked the same question first: *"Given these images, what does the app actually have to do to be worth using?"* Their independent answers disagree, which is the point.

---

# ROUND 1 — Opening positions

## Member 1 — The Simulation Engineer

"Everyone is describing an image sorter. That is the small half of the problem.

An Ansys result image is not a picture of a cat. It is a **claim about a structure**. `vonMises_LC2.png` showing a red hotspot is a claim that the part sees 187 MPa there. If the app files that image under 'Results' and writes 'peak stress 187 MPa' without knowing four things, it is producing a document that can get a bracket signed off that should not have been:

1. **Deformation scale.** Almost every deformation plot is exaggerated. If the image says `Auto Scale Factor: 12.4` and the caption doesn't, the report is wrong. The app must read and quote that stamp. For stress plots, the app must verify it says *True Scale* — an exaggerated stress shape is a category error.
2. **Averaged vs unaveraged, and where the peak is.** A peak sitting on a constrained node, a point load, or a sharp re-entrant corner is frequently a **numerical singularity** — it diverges with mesh refinement and is not a real material stress. Reporting it as the design driver is the single most common FEA report error. The app should flag it: *'peak located at a constrained edge — likely singularity; check the node-averaged value at 5 mm from the constraint.'*
3. **Units and magnitude.** Legs come in Pa, MPa, ksi, and scientific notation. `1.874e8` in Pa is 187 MPa; a naive read gives 187,000,000 and the report is off by 10⁶. Normalisation is mandatory, and the unit must be echoed in the caption.
4. **Mesh convergence.** A stress result without a convergence statement is not evidence. If the company template has a convergence slide, the app must refuse to fill results until it is present.

And the largest point: **sorting is 20% of the value.** The other 80% is stating whether the design passes and why. That requires the material data (allowable yield/ultimate), which requires the app to read the materials table, not the pictures. If the app can say *'peak 187 MPa vs 250 MPa allowable → FoS 1.34, PASS with 12% margin, driven by LC2 torsion'*, you have built something an engineer actually uses. If it only says 'this is a stress plot', you have built a filing cabinet."

**Would ship:** full taxonomy (6 axes), unit normalisation, scale-factor reading, singularity flag, pass/fail against allowable.
**Would block:** any auto-generated numeric claim that the pipeline did not read from a verifiable source.

---

## Member 2 — The QA Approver

"I will be the unpopular one. My position: **the app must be structurally incapable of publishing an unverified number.**

A wrong caption is embarrassing. A wrong peak stress in an issued FEA report is a liability — it can be the difference between a recall and a footnote. So:

- **Every extracted number is a candidate, not a fact.** It becomes a fact when a human clicks it. Export is blocked while any number is unconfirmed. Not a warning — a hard block.
- **Provenance on screen.** A number is never displayed alone. It is displayed next to a **crop of the legend it came from**. The reviewer verifies by looking, not by trusting. This one decision removes most of the risk of the whole project.
- **Empty beats wrong.** If the legend is unreadable or cropped, the field stays `—` and is flagged `REQUIRES MANUAL INPUT`. The pipeline may never interpolate, guess, or infer a digit.
- **Audit trail.** Which image, which crop, which value, confirmed by whom, at what time, against which revision of the template. If a report is ever questioned, we answer in ten seconds.
- **Automatic completeness check before export.** *'No safety-factor image for LC3. No mesh convergence image. Materials table present. 3 of 41 values unconfirmed.'* The app should find holes the author forgot.

My objection to the engineers in this room: they are designing a pipeline that produces data. Data without provenance is a rumour. I am designing the thing that lets a manager sign their name on it — and that signature, not the image sorting, is what makes this app adoptable in a company."

**Would ship:** confirmation gate, legend-crop provenance, hard block on export, audit log, missing-slot detection.
**Would block:** bulk auto-confirm, "trust me" modes, any silent fallback.

---

## Member 3 — The Automation Architect

"I agree with the goals of both of you and I think you are both drawing the pipeline in the wrong place. Three corrections:

**1. Stop reading numbers from pixels whenever the numbers exist as data.** An image is the worst possible source of a number and the best possible source of *meaning*. Ansys can export result tables, reaction forces, mass, mesh statistics as CSV or text. If the company's workflow already produces those files, the correct architecture is:

```
numbers  ←  Ansys exported data (CSV / text / worksheet)   → 100% accurate, free
meaning  ←  images (what kind of plot, is it readable)     → this is what vision is for
prose    ←  the language model, given the verified numbers → this is what LLMs are for
```

If those exports don't exist in your workflow, that is a one-time setup cost worth paying once per project — it removes the highest-risk component of the whole app. If they truly cannot be produced, then OCR is the fallback and it needs the confirmation gate Member 2 demands.

**2. Numbers must never originate from the language model.** This is not a preference, it is a correctness boundary. The LLM writes sentences. The pipeline supplies digits. Any digit in generated prose that is not in the verified table is rejected by a **numeric firewall** (a regex check over the output) and regenerated. An LLM that reads the legend itself will, eventually, write 187 as 178 — and it will be fluent while doing it. That is the failure mode that kills this project, and the firewall is three lines of code that make it impossible.

**3. Fill the real .pptx, don't rebuild it.** Your master has your logo, fonts, slide geometry and theme. Rebuilding from a PDF gets you approximate forever. Filling placeholders in the master gets you exact. So: capture the template once as a machine-readable **slot schema** (slot id, type, expected content, example), the company owns and edits that schema, and the app fills it. Verify the library's placeholder behaviour against the real master before we commit — masters have a habit of not using named placeholders.

**Performance budget:** 200 images end-to-end under two minutes on a normal work laptop with no GPU. That means the expensive model is called once per *slide*, not once per *pixel*, and the local CV/OCR work is done in parallel."

**Would ship:** template-as-slot-schema, data-first extraction, numeric firewall, parallel local processing.
**Would block:** rebuilding the template from scratch; LLMs anywhere near numbers.

---

## Member 4 — The Adversarial Red-Teamer

"My job is to make the previous three uncomfortable. Here is how this app fails in the wild, in the order I expect to see it:

1. **The confidential leak.** Engineers screenshot a window that has an email behind it, a taskbar with a project codename, a chat notification, a browser tab with a client name. The app is about to put that in an issued PDF. → The app must detect and warn on incidental content outside the plot area, and offer one-click crop to the plot region.
2. **The cropped legend.** The single most common real-world case: the value that matters is cut off at the image edge. Any pipeline that assumes a legend exists will confidently emit garbage or nulls. → Legend-presence detection is a first-class check, and its absence is a *visible* state, not a silent one.
3. **The wrong-legend read.** Multi-load-step legends stack several colour bars with several sets of numbers. The pipeline reads the wrong one and is confidently wrong by 40%.
4. **Dirty OCR inputs.** Dark-theme screenshots, JPEG-compressed legends, comma decimal separators (`187,4`), thousands separators (`1,874`), scientific notation, and the Ansys version watermark `2023 R2` read as value `2023`.
5. **The duplicate.** The same image submitted twice, or `LC1` pasted where `LC2` belongs. → perceptual hashing and load-case cross-checks catch this; a human reviewer at 4 pm on a Friday does not.
6. **Design intent drift.** The report says 4 mm plate; the CAD image is from the 6 mm revision. Nothing in the pipeline notices, because nobody told it to compare.
7. **False confidence.** This is the killer, and it is the reason I back Member 2 over Member 1. A pipeline that fails *loudly* costs an hour. A pipeline that fails *silently* costs the project's credibility, permanently, the first time it happens.

**Therefore: no accuracy target is meaningful until it is measured.** Before we claim anything, we take 50 labelled images from a real past report — human-labelled ground truth — and we report precision/recall per field. Confidence scores must be calibrated against that set, not invented. A confidence gate that has never been tested is theatre."

**Would ship:** leak detection, legend-presence check, duplicate detection, perceptual hashing, and a 50-image ground-truth test set before any accuracy claim.
**Would block:** shipping without the labelled test set.

---

## Member 5 — The Report Author

"I am the only one here who has to use this on a Tuesday afternoon before a design review, so let me say what the others have not: **I do not care about your pipeline. I care about the ninety seconds after the drop.**

What I want:

- **Drop the folder. See the report take shape.** A live preview of the actual slides, filling in, on the left. Unplaced images in a tray on the right.
- **Fix by keyboard.** Tab through the uncertainties, arrow keys to swap a slot, Enter to confirm. Forty images reviewed in under a minute. If review takes longer than building it by hand, I will not use it, no matter how clever it is.
- **Tell me why, briefly.** Hover a classification: *'called it LC2 because the filename says so and the caption text in the image says Load Step 2.'* When it is wrong, I need to know which signal lied so I can correct it in one keystroke — not file a ticket.
- **Learn my correction once.** If I move all my `*_iso.png` images to Overview, the app should notice the pattern and offer to apply it to the rest. One correction, not forty.
- **Do the tedious things I hate.** Deformation scale in every caption. The same boilerplate scope paragraph. The appendix index. The numbering in the right order. That's where my hours actually go.
- **Show me what's missing.** *'You have no thermal results, but LC4 is a thermal case.'* I forget; the app shouldn't.
- **Run on my work laptop, offline, in a meeting room with bad wifi.** No GPU, no cloud round-trip for every image. If it needs the internet, it needs to degrade gracefully.

And one thing that would genuinely impress me, which nobody has raised: **when I run twelve thickness variants, I want the comparison table and the stress-versus-mass chart generated without me asking.** That is the part of my job I actually dread, and it is the part where an app can make me look good in front of my manager."

**Would ship:** live preview, keyboard review, correction memory, boilerplate automation, missing-item warnings, parametric comparison charts.
**Would block:** any UI that requires reading a manual, and any cloud dependency for basic operation.

---

# ROUND 2 — Cross-examination

Each member was handed the others' positions and asked for their strongest objection.

### Engineer → Architect
"Your data-first source is correct in principle and I want it. But you are assuming the company exports result tables today. Most engineers I know screenshot and move on. If the answer is 'no exports exist', your architecture collapses back to OCR and you have to be honest that your accuracy claim just dropped. Don't sell me a data pipeline that exists only in the ideal case."

### Architect → Engineer
"Agreed, and that is why I specified OCR as a **first-class fallback**, not a footnote. Counter-objection: your singularity check is a heuristic on an image. You cannot detect 'peak at a constrained node' from a contour plot alone — that information lives in the model, not the picture. Either we get the model/mesh metadata, or your feature is a caption hint, not a detector. Please don't promise physics from pixels."

### Engineer → (conceding, partly)
"Fair. Then the honest version is: flag *possible* singularity and require the reviewer to confirm. QA's gate makes that safe."

### QA → Engineer
"Your pass/fail feature worries me most of all, and it is your favourite. A pass/fail verdict is the highest-consequence sentence in the report, and it depends on an allowable you want to read from a table image. If you misread 250 MPa as 205 MPa, a failing design passes. So: the allowable is a **required human input** the first time, remembered per material afterwards, and never auto-read from a picture."

### Engineer → QA
"Accepted. Better that than a wrong verdict."

### Red-Teamer → QA
"Your confirmation gate is right and I will break it anyway. Confirm-all buttons get clicked. A reviewer with 200 numbers will click through in twenty seconds and your model will record 'verified by human', which is worse than no gate at all because it launders the error with a signature. The gate must be **suspicion-weighted**: the app only asks me to confirm the values it is unsure about, and it shows me the crop for those. Confirm the 8 uncertain numbers, not all 200. That is both faster and actually safe."

### QA → Red-Teamer
"Accepted, with one change: the audit log records the confidence of each value, so we can always distinguish 'confirmed after being flagged' from 'auto-accepted at 99%'. And the reviewer can always expand to full review."

### Author → QA + Red-Teamer
"Both of you have just designed a tool that interrupts me constantly. Here is my constraint, and it is a hard one: **the default path must be zero-interruption for a clean batch.** If everything is high confidence, I should be able to export without touching anything, with a single summary line: *'41 values auto-verified at ≥97% confidence, 3 flagged, review required before export.'* Your gate applies to the 3, not the 41."

### QA → Author
"The 3 block the export. The 41 do not. That is the deal."

### Architect → Red-Teamer
"Your 50-image ground-truth set is the best idea in this room and I will fund it as Phase 0 — but be honest about what it costs. Someone at the company has to spend a day labelling real images. That is a real ask, and it is the first thing the user should say yes or no to."

### Red-Teamer → Architect
"Then we ask for 20 images instead of 50 to start. Twenty labelled images will expose the top failure modes. Fifty is the calibration set later."

### Author → Engineer + Architect
"Everything you two want — data first, singularity hints, convergence checks — adds setup work for me before I ever see value. Sell it to me in this order: **first run gets me a filled report in five minutes with what I already have (screenshots). Every later run gets better as the company adds exports and the model metadata.** Value first, rigour second, or I never get past my manager to install it."

---

# ROUND 3 — The three collisions, and how they resolve

## Collision 1 — Rigour vs. speed
*Engineer + QA + Red-Teamer:* verify everything, hard-block export.
*Author:* zero interruption on a clean batch.
**Resolution — suspicion-weighted gating.** The app is silent when it is confident and loud when it is not. The gate is measured, not blanket: confirm the uncertain, auto-accept the certain, always log which was which. This satisfies QA *better* than a blanket gate, because a blanket gate gets rubber-stamped.

## Collision 2 — Pixels vs. data
*Architect:* read numbers from exported data, never from pixels.
*Reality:* the company may have no exports today.
**Resolution — tiered intake, one interface.** The app accepts three sources, in preference order: (1) Ansys exported tables/text → exact numbers; (2) filename conventions → category, load case, component; (3) image OCR + vision → everything else, always confidence-scored. The tier used is recorded per value. When an export is added later, accuracy improves without changing the UI.

## Collision 3 — App intelligence vs. engineer judgement
*Engineer:* the app should judge pass/fail.
*QA:* the app must not originate any number, including the allowable.
**Resolution — the app reasons, the human authorises.** The app may compute, compare and recommend (FoS, margin, verdict) **only from inputs that are already human-confirmed or human-entered**, and it displays its arithmetic. The allowable is entered once per material, remembered, and editable. The app is a calculator with a memory, not an oracle.

---

# DECISION RECORD

**Competing architectures put to the vote:**

| | A — Deterministic-first | B — Vision-LLM-first | C — Hybrid, human-gated |
|---|---|---|---|
| Numbers | OCR + rules only | model reads the image | exported data → OCR, **never** the LLM |
| Classification | filename + CV signatures | model, zero-shot | filename + CV first, model for the ambiguous |
| Prose | templates | model, freely | model, constrained to verified facts |
| Template | rebuilt from spec | rebuilt from spec | **the company's real master** |
| Trust model | high accuracy, brittle | flexible, silently wrong | gated, auditable |
| Vote | Engineer ✔ | none | **5 / 5** |

**Decision: Architecture C.**

### The eight rules the council agreed unanimously

1. **Numbers come from the pipeline, never from the language model.** A numeric firewall rejects any digit in generated prose that is not in the verified fact table.
2. **Empty beats wrong.** Unreadable means `—` plus a flag. Never interpolate, never infer a digit.
3. **Every number is shown next to a crop of its source** until confirmed.
4. **The gate is suspicion-weighted.** Confirm the uncertain; auto-accept and log the certain.
5. **Fill the company's real .pptx master**, driven by a slot schema the company owns.
6. **The app reasons, the human authorises.** Recommended verdicts show their arithmetic.
7. **Accuracy is measured, never asserted.** Phase 0 is a labelled test set, however small.
8. **Offline-capable, no GPU.** Cloud is an upgrade, not a dependency.

### Feature tiers

**Tier 1 — the app is worth using**
Bulk drop → classification (type, quantity, load case, component, view, solver) → auto-placement into the master template → captions with unit and scale factor → confidence-gated review → .pptx + .pdf export → CSV/Excel index.

**Tier 2 — the app is adopted**
Exported-data intake, legend-crop provenance, missing-slot detection, duplicate and leak detection, correction memory, audit log, completeness checklist before export.

**Tier 3 — the app is impressive**
Pass/fail against allowable with margin, singularity hints, parametric comparison table and stress-vs-mass chart across design iterations, "what changed since revision B" diff, and a one-page executive summary generated from the verified numbers.

### Blockers that must be resolved before code is written

1. **The two sample PDFs and the original .pptx master.** Without them the slot schema is fiction.
2. **Where it runs: company network or cloud?** If results are confidential, the cloud path is off the table and the local model tier becomes mandatory. This decision changes the architecture, the hardware requirement and the schedule.
3. **Do Ansys result exports (CSV/text) exist, or is it screenshots only?** Determines the accuracy ceiling.
4. **Do filenames carry meaning today, or are they `image(14).png`?** Determines how much the model must do.
5. **How many images per report, and how many reports a month?** Determines whether the model is called per slide or per image.
6. **Is the deliverable .pptx, .pdf, or both?**

### What the council will do with the PDFs when they arrive

- Reverse-engineer the template into a **slot schema** (slot → type → expected content → example), then walk it back to you for correction.
- Extract the **caption style** (numbering, tense, units, level of detail) and turn it into caption templates with variable slots.
- Extract the **classification decision tree** implied by the sample — what distinguishes a "Result" image from a "Model" image in *your* report, which is a company convention, not a universal one.
- Re-run this council against the real template. Members 1–5 have all stated that at least one of their positions changes once the actual report structure is visible.

---

## Appendix — Classification taxonomy v0.1 (to be corrected against the PDFs)

Every image gets six independent labels. Placement follows from the combination.

| Axis | Values |
|---|---|
| **Result type** | Equivalent (von Mises) stress · Maximum principal · Minimum principal · Shear stress · Total deformation · Directional deformation · Equivalent strain · Safety factor · Contact pressure · Contact status · Reaction force · Temperature · Total heat flux · Fatigue life · Damage · Modal shape · Frequency response · Velocity · Pressure · Turbulence · Volume fraction · **Mesh** · **Boundary conditions** · **Geometry / CAD** · **Graph** · **Table** |
| **Quantity + unit** | value, unit and read-source (`0.002 → 187.4`, MPa, legend-left) |
| **Load case** | LC1…LCn, or the company's scenario names |
| **Component** | from the CAD tree / assembly naming |
| **View** | isometric · front · side · section / cut plane · zoom on peak · full assembly |
| **Solver** | Static Structural · Modal · Thermal · Transient · Explicit · Fluent (CFD) |

**Worked example.** `LC2_vonMises_bracket_iso.png` → Result: *Equivalent stress* · `187.4 MPa` (legend, left, confidence 0.94) · LC2 (torsion, 500 N) · bracket · isometric cut section · Static Structural → **Slot: Results / LC2 / Stress**, caption: *"Figure 7 — Equivalent (von Mises) stress, load case 2 (torsion, 500 N). Peak 187.4 MPa at the fillet radius; scale: true. Mesh convergence shown in Figure 5."* → **Review queue:** none (all values ≥ 0.97) · **Completeness:** safety-factor image for LC2 missing.

---

*Council Round 1 closed. Awaiting the sample PDFs, the .pptx master, and answers to the six blockers before Round 2 convenes against the real template.*
