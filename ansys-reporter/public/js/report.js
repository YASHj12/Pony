/* Ansys Report — deck assembly for the company template.
 *
 * The slide order and wording here were read out of sample.pptx and
 * 6203_KCP_MLD.pptx:
 *
 *   1  FEA REPORT / Static Structural Analysis Of <part> / Report No / Date / Client
 *   2  1. Material Properties        table + units line + σall = Syt / FOS
 *   3  2. <part> Geometry            one or two labelled views
 *   4  3. <part> Mesh                one view
 *   5  Case N: <description>         boundary-conditions image + A) B) C) text
 *   6  Case N: Results               deformation | von Mises, value line under each
 *   7  Case N: Observation & Summary generated from the confirmed values
 *   …  repeat per load case
 *   11 Final Summary                 Load Case | Max. Deformation | Max. Von-Mises Stress | Allowable Stress
 *
 * Council rule #1 still holds: every number in every generated sentence comes
 * from a value a human typed and confirmed, and passes the numeric firewall.
 */

import { familyOf, FAMILY_LABEL, describeGroup } from './classify.js';

export const RESULT_FAMILIES = ['stress', 'deformation', 'strain', 'factor', 'contact', 'force', 'thermal', 'fatigue', 'modal', 'cfd'];

/* ───────────────────────── the numeric firewall ───────────────────────── */

/**
 * @param {string} text
 * @param {Set<string>|string[]} allowed exact numeric tokens that may appear
 * @returns {{text: string, blocked: string[]}}
 */
export function enforceNumericFirewall(text, allowed) {
  const set = allowed instanceof Set ? allowed : new Set(allowed || []);
  const blocked = [];
  const cleaned = String(text ?? '').replace(/\d+(?:[.,]\d+)*/g, (token) => {
    const plain = token.replace(',', '.');
    if (set.has(token) || set.has(plain)) return token;
    blocked.push(token);
    return '—';
  });
  return { text: cleaned, blocked };
}

export function formatValue(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const abs = Math.abs(n);
  if (abs >= 100000 || (abs > 0 && abs < 0.01)) return n.toExponential(3).replace('e+', 'E');
  if (abs >= 100) return String(Math.round(n * 10) / 10);
  if (abs >= 1) return String(Math.round(n * 100) / 100);
  return String(Math.round(n * 10000) / 10000);
}

/** "3 mm", "0.085 mm", "163 MPa" — number and unit together, never split. */
const withUnit = (value, unit) => (value == null ? null : `${formatValue(value)}${unit ? ` ${unit}` : ''}`);

export function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null || vars[k] === '' ? '' : String(vars[k])));
}

/** Tokens the reader expects regardless of the analysis: labels and dates. */
export function structuralTokens(extra = []) {
  const set = new Set();
  for (const e of extra) if (e != null && e !== '') set.add(String(e));
  return set;
}

/* ───────────────────────── allowable stress ───────────────────────── */

/**
 * σall = Syt / FOS, rounded the way the sample reports do.
 * 213 / 1.3 = 163.85 → the deck says 163, so the default rounding is floor.
 */
export function computeAllowable(yieldStress, fos = 1.3, rounding = 'floor') {
  const y = Number(yieldStress);
  const f = Number(fos);
  if (!Number.isFinite(y) || !Number.isFinite(f) || f === 0) return null;
  const raw = y / f;
  if (rounding === 'floor') return Math.floor(raw);
  if (rounding === 'ceil') return Math.ceil(raw);
  return Math.round(raw);
}

export function materialRowsWithAllowable(materials, meta) {
  const rows = (materials?.rows || []).map((row) => [...row]);
  const idx = (materials?.columns || []).findIndex((c) => /allowable/i.test(c));
  const yieldIdx = (materials?.columns || []).findIndex((c) => /yield/i.test(c));
  if (idx >= 0) {
    for (const row of rows) {
      const computed = computeAllowable(row[yieldIdx], meta.fos, meta.allowableRounding);
      if (computed != null) row[idx] = String(computed);
    }
  }
  return rows;
}

export function allowableFromMaterials(materials, meta) {
  const rows = materialRowsWithAllowable(materials, meta);
  const idx = (materials?.columns || []).findIndex((c) => /allowable/i.test(c));
  const first = rows.find((r) => r[idx]);
  return first ? Number(first[idx]) : null;
}

/* ───────────────────────── case derivation ───────────────────────── */

const caseSortKey = (id) => {
  const m = String(id || '').match(/(\d+)/);
  return m ? Number(m[1]) : 999;
};

/** Everything the report needs, grouped by load case, in the sample's order. */
export function deriveCases(photos, meta = {}) {
  const active = photos.filter((p) => !p.excluded && p.cls);
  const byCase = new Map();

  for (const p of active) {
    const id = p.cls.loadCase || 'unassigned';
    if (!byCase.has(id)) byCase.set(id, []);
    byCase.get(id).push(p);
  }

  const cases = [];

  /* Result images that never got a load case still deserve a slide, so they land
   * in one "unassigned" case rather than vanishing from the report. */
  const ids = [...byCase.keys()].sort((a, b) => {
    if (a === 'unassigned') return 1;
    if (b === 'unassigned') return -1;
    return caseSortKey(a) - caseSortKey(b) || String(a).localeCompare(String(b));
  });

  ids.forEach((id, index) => {
    const members = byCase.get(id);
    const override = (meta.cases || {})[id] || {};
    const label = override.label || (id === 'unassigned' ? 'Unassigned results' : `Case ${caseSortKey(id) === 999 ? index + 1 : caseSortKey(id)}`);
    const description = override.description || '';

    const pick = (predicate) => members.filter(predicate);
    const deformation = pick((p) => p.cls.family === 'deformation');
    const stress = pick((p) => p.cls.family === 'stress' || p.cls.family === 'contact');
    const bc = pick((p) => p.cls.family === 'bc');
    const details = members.filter((p) => p.cls.detail.isDetail);
    const usedIds = new Set([...deformation, ...stress, ...bc, ...details].map((p) => p.id));
    const other = members.filter((p) => !usedIds.has(p.id) && RESULT_FAMILIES.includes(p.cls.family));

    const mainOf = (list) => list.slice().sort((a, b) => (b.cv?.bgFraction ?? 0) - (a.cv?.bgFraction ?? 0))[0] || null;

    /* A group that only holds geometry or mesh is not a load case — it has no
     * boundary conditions and no results, so it must not get a case block. */
    const reportable = bc.length + deformation.length + stress.length + other.length;
    if (!reportable) return;

    cases.push({
      id,
      label: description ? `${label}: ${description}` : label,
      shortLabel: label,
      description,
      bcText: override.bcText || '',
      bcPhoto: mainOf(bc),
      deformationPhoto: mainOf(deformation),
      stressPhoto: mainOf(stress),
      otherPhotos: other,
      detailPhotos: details.filter((p) => p.cls.family === 'stress' || p.cls.family === 'deformation' || p.cls.family === 'unknown'),
      members,
    });
  });

  return cases;
}

/* ───────────────────────── sentences ───────────────────────── */

/**
 * Every generated sentence goes through here: the numbers it is allowed to use
 * are exactly the ones the caller passed in, so nothing else can appear.
 */
function sentence(text, numbers, unitWords = []) {
  const allowed = new Set();
  for (const n of numbers) {
    if (n == null) continue;
    allowed.add(formatValue(n));
    allowed.add(String(n));
  }
  for (const w of unitWords) if (w != null) allowed.add(String(w));
  return enforceNumericFirewall(text, allowed);
}

export function caseSentences(kase, ctx) {
  const { phrases, partShort, allowable, partLabel } = ctx;
  const dVal = kase.deformationPhoto?.value?.confirmed ? kase.deformationPhoto.value.max : null;
  const dUnit = kase.deformationPhoto?.value?.unit || 'mm';
  const sVal = kase.stressPhoto?.value?.confirmed ? kase.stressPhoto.value.max : null;
  const sUnit = kase.stressPhoto?.value?.unit || 'MPa';

  const deformationText = dVal == null ? phrases.valueMissing : withUnit(dVal, dUnit);
  const stressText = sVal == null ? phrases.valueMissing : withUnit(sVal, sUnit);

  const numbers = [dVal, sVal, allowable];
  const units = [dUnit, sUnit, 'mm', 'MPa'];

  const over = sVal != null && allowable != null && sVal > allowable;
  const under = sVal != null && allowable != null && sVal <= allowable;

  const stressLineTpl = under ? phrases.stressWithin : over ? phrases.stressExceeds
    : (sVal == null ? phrases.valueMissing : phrases.stressWithin);

  const deformLine = sentence(fillTemplate(phrases.deformationLine, { value: deformationText }), numbers, units);
  const stressLine = sentence(fillTemplate(stressLineTpl, { allowable: allowable == null ? phrases.valueMissing : withUnit(allowable, sUnit), value: stressText }), numbers, units);

  const bullets = (phrases.observations || [
    `Total deformation in the ${partLabel} is {deformation}.`,
    `Von-Mises stress in the ${partLabel} {stressVerdict}`,
  ]);

  const stressVerdictTpl = under ? phrases.observationStressWithin : over ? phrases.observationStressExceeds
    : (sVal == null ? `is ${phrases.valueMissing}` : phrases.observationStressWithin);

  const observation = [
    fillTemplate(bullets[0], { partShort: partLabel, deformation: deformationText }),
    fillTemplate(bullets[1], { partShort: partLabel, stressVerdict: fillTemplate(stressVerdictTpl, { allowable: allowable == null ? phrases.valueMissing : withUnit(allowable, sUnit) }) }),
  ].map((t) => sentence(t, numbers, units).text);

  return {
    deformationText, stressText, deformLine: deformLine.text, stressLine: stressLine.text,
    observation, verdict: over ? 'exceeds' : under ? 'within' : 'unknown',
  };
}

/* ───────────────────────── deck assembly ───────────────────────── */

export function buildDeck({ photos, template, meta = {} }) {
  const theme = template.theme || {};
  const phrases = { ...template.phrases, ...(meta.phrases || {}) };
  const m = { ...template.meta, ...meta };
  const slides = [];
  const figureLog = [];
  let figureNumber = 1;

  const active = photos.filter((p) => !p.excluded);
  const partLabel = m.partShort || m.part || 'the part';

  const materials = { columns: template.materials?.columns || [], rows: materialRowsWithAllowable(template.materials, m) };
  const allowable = allowableFromMaterials(template.materials, m);

  const cases = meta.cases ? deriveCases(active, meta) : deriveCases(active, meta);

  const taken = new Set();
  const claim = (photo) => { if (photo) taken.add(photo.id); return photo; };

  /* 1 ─ cover */
  slides.push({
    layout: 'cover', id: 'cover',
    eyebrow: 'FEA REPORT',
    title: fillTemplate(meta.coverTitle || `${m.analysis || 'Static Structural Analysis'} Of {part}`, { part: m.part || '' }),
    fields: [
      ['Report No.', m.reportNo],
      ['Date', m.date],
      ['Client', m.client],
      ['Prepared by', m.author],
    ].filter(([, v]) => v),
    logo: meta.logoPhotoId || null,
  });

  /* 2 ─ 1. Material Properties */
  slides.push({
    layout: 'table', id: 'materials', title: '1. Material Properties',
    table: materials,
    notes: [
      m.unitsLine,
      '',
      m.allowableHeading,
      `${m.allowableFormula || 'σall = Syt / FOS'}      FOS = ${m.fos ?? 1.3}`,
    ].filter(Boolean),
    empty: !materials.rows.length ? 'No material row entered — fill one in so the report can state an allowable stress.' : null,
  });

  /* 3–4 ─ geometry and mesh, from the images themselves */
  for (const section of template.sections) {
    if (section.kind !== 'figures') continue;
    const wanted = section.accepts?.types || [];
    const capacity = section.accepts?.capacity || 2;
    const picked = active
      .filter((p) => !taken.has(p.id) && wanted.includes(p.cls.type))
      .slice(0, capacity);

    slides.push({
      layout: 'figure-row',
      id: section.id,
      title: fillTemplate(section.title, { partShort: partLabel, part: m.part || '' }),
      figures: picked.map((p) => {
        claim(p);
        figureLog.push({ figure: figureNumber, photoId: p.id, name: p.name, slide: section.id });
        figureNumber++;
        return {
          photoId: p.id,
          label: section.labelFromView ? viewLabel(p, p.cls.type) : '',
          line: '',
        };
      }),
      missing: picked.length ? null : `No ${wanted.join(' or ').toLowerCase()} image supplied.`,
    });
  }

  /* 5–7 ─ one block of slides per load case */
  for (const kase of cases) {
    const ctx = { phrases, partLabel, allowable, partShort: partLabel };

    /* boundary conditions */
    if (kase.bcPhoto || kase.bcText || (template.case.intro.requireBcImage && kase.bcPhoto)) {
      if (kase.bcPhoto) claim(kase.bcPhoto);
      slides.push({
        layout: 'figure-text', id: `bc-${kase.id}`,
        title: fillTemplate(template.case.intro.title, { caseLabel: kase.label }),
        photoId: kase.bcPhoto ? kase.bcPhoto.id : null,
        heading: template.case.intro.bcHeading,
        text: kase.bcText || template.case.intro.bcPlaceholder,
        placeholder: !kase.bcText,
        missingImage: kase.bcPhoto ? null : 'No boundary-conditions image for this case.',
      });
    }

    /* results: deformation | von Mises, details as an inset strip on the same slide */
    const lines = caseSentences(kase, ctx);
    const deform = kase.deformationPhoto;
    const stress = kase.stressPhoto;
    if (deform) claim(deform);
    if (stress) claim(stress);

    const figures = [
      { slot: 'deformation', photoId: deform ? deform.id : null, label: template.case.results.slotLabels.deformation, line: lines.deformLine },
      { slot: 'stress', photoId: stress ? stress.id : null, label: template.case.results.slotLabels.stress, line: lines.stressLine },
    ];
    const insets = kase.detailPhotos.slice(0, template.detailRules?.maxInsetsPerSlide ?? 3).map((p, i) => {
      claim(p);
      figureLog.push({ figure: figureNumber, photoId: p.id, name: p.name, slide: `results-${kase.id}`, inset: true });
      figureNumber++;
      return {
        photoId: p.id,
        label: fillTemplate(template.case.results.detailLabel, {
          kind: p.cls.detail.kind === 'section' ? 'Section' : 'Detail',
          letter: String.fromCharCode(65 + i),
          view: p.cls.viewSource === 'filename' ? (p.cls.view || '') : '',
          type: p.cls.type,
        }).replace(/\s*—\s*$/, ''),
      };
    });

    slides.push({
      layout: 'figure-row', id: `results-${kase.id}`,
      title: fillTemplate(template.case.results.title, { caseLabel: kase.shortLabel || kase.label }),
      figures: figures.map((f) => ({
        ...f,
        line: f.photoId ? f.line : fillTemplate(phrases.noResultSupplied, { slot: f.slot }),
        missing: !f.photoId,
      })),
      insets,
      stripLabel: insets.length ? 'Detail views of the above' : null,
    });

    /* observation */
    slides.push({
      layout: 'bullets', id: `observation-${kase.id}`,
      title: fillTemplate(template.case.observation.title, { caseLabel: kase.shortLabel || kase.label }),
      bullets: lines.observation,
      bulletStyle: 'paragraph',
    });
  }

  /* Final summary */
  slides.push({
    layout: 'table', id: 'final', title: 'Final Summary',
    table: buildFinalSummary(cases, { allowable, phrases, partLabel }),
    notes: allowable == null ? ['Allowable stress is not set — enter a material row so the verdict column can be filled in.'] : [],
  });

  /* Appendix: anything not placed yet */
  const rest = active.filter((p) => !taken.has(p.id));
  if (rest.length) {
    slides.push({
      layout: 'grid', id: 'appendix', title: template.sections.find((s) => s.kind === 'appendix')?.title || 'Appendix',
      images: rest.map((p) => ({ photoId: p.id, label: p.name })),
    });
  }

  return { slides, figureLog, allowable, cases, materials };
}

function titleView(view) {
  return String(view).replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "Top" → "Top view", but a view guessed from pixels is not a label. */
function viewLabel(photo, fallbackType) {
  if (photo.cls.viewSource !== 'filename' || !photo.cls.view) return fallbackType;
  const v = photo.cls.view;
  return /^(top|bottom|front|back|side|left|right|rear)$/i.test(v) ? `${titleView(v)} view` : titleView(v);
}

/* ───────────────────────── final summary table ───────────────────────── */

export function buildFinalSummary(cases, { allowable, phrases, partLabel }) {
  const columns = ['Load Case', 'Max. Deformation', 'Max. Von-Mises Stress', 'Allowable Stress'];
  const rows = [];
  const unit = 'mm';
  const stressUnit = 'MPa';

  for (const kase of cases) {
    const d = kase.deformationPhoto?.value?.confirmed ? kase.deformationPhoto.value.max : null;
    const dU = kase.deformationPhoto?.value?.unit || unit;
    const s = kase.stressPhoto?.value?.confirmed ? kase.stressPhoto.value.max : null;
    const sU = kase.stressPhoto?.value?.unit || stressUnit;

    const stressCell = s == null ? '—'
      : allowable != null && s > allowable ? phrases.summaryExceeds
      : fillTemplate(phrases.summaryWithin, { value: withUnit(s, sU) });

    rows.push([
      kase.label,
      d == null ? '—' : withUnit(d, dU),
      stressCell,
      allowable == null ? '—' : withUnit(allowable, stressUnit),
    ]);
  }
  if (!rows.length) rows.push(['—', '—', '—', allowable == null ? '—' : withUnit(allowable, 'MPa')]);
  return { columns, rows };
}

/* ───────────────────────── coverage gaps ───────────────────────── */

export function coverageReport(cases, photos, { allowable } = {}) {
  const gaps = [];
  for (const kase of cases) {
    if (!kase.deformationPhoto) gaps.push({ level: 'warn', text: `${kase.label}: no deformation result — the left half of the results slide will be empty.` });
    if (!kase.stressPhoto) gaps.push({ level: 'warn', text: `${kase.label}: no von Mises stress result — the right half of the results slide will be empty.` });
    if (!kase.bcPhoto) gaps.push({ level: 'info', text: `${kase.label}: no boundary-conditions image found.` });
    if (!kase.bcText) gaps.push({ level: 'info', text: `${kase.label}: boundary-conditions text not written yet — the slide shows placeholder text.` });
    const missingValue = [kase.deformationPhoto, kase.stressPhoto].filter((p) => p && p.value.max == null);
    if (missingValue.length) gaps.push({ level: 'warn', text: `${kase.label}: ${missingValue.length} peak value${missingValue.length > 1 ? 's' : ''} not entered — the value line and the summary row will read "${'value not entered'}".` });
  }
  if (allowable == null) gaps.push({ level: 'bad', text: 'No material row entered, so there is no allowable stress — the stress verdict cannot be stated.' });
  if (!photos.some((p) => p.cls?.type === 'Mesh' && !p.excluded)) gaps.push({ level: 'warn', text: 'No mesh image found — section 3 will be empty.' });
  if (!photos.some((p) => familyOf(p.cls?.type) === 'geometry' && !p.excluded)) gaps.push({ level: 'info', text: 'No geometry image found — section 2 will be empty.' });
  return gaps;
}

export { describeGroup, FAMILY_LABEL };
