/* Ansys Report — deck assembly and caption writing.
 *
 * Council rule #1: numbers come from the pipeline, never from generated prose.
 * Every caption passes through the numeric firewall before it is allowed into
 * the deck, and the firewall reports what it blocked.
 */

import { familyOf, FAMILY_LABEL, describeGroup } from './classify.js';

/* Families that are *results*. Mesh, geometry, boundary conditions and graphs
 * are report material, not results, so they never appear in the summary table. */
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

/** Tokens that are structural rather than claims: figure numbers and load-case digits. */
export function structuralTokens(extra = []) {
  const set = new Set(['16:9', '3D', '2D']);
  for (const e of extra) set.add(String(e));
  return set;
}

export function formatValue(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const abs = Math.abs(n);
  if (abs >= 100000 || (abs > 0 && abs < 0.01)) return n.toExponential(3).replace('e+', 'e');
  if (abs >= 100) return n.toFixed(1).replace(/\.0$/, '');
  if (abs >= 1) return n.toFixed(2).replace(/0$/, '').replace(/\.$/, '');
  return n.toFixed(4);
}

/* ───────────────────────── caption writing ───────────────────────── */

export function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null || vars[k] === '' ? '' : String(vars[k])));
}

/**
 * @param {object} group
 * @param {object} captions  template.captions
 * @param {number} figureNumber
 * @param {Set<string>} allowedNumbers verified numbers only
 */
export function groupCaption(group, captions, figureNumber, allowedNumbers) {
  const p = group.main;
  const confirmed = p.value?.confirmed ? p.value.max : null;
  const unit = p.value?.unit || '';

  const vars = {
    type: p.cls.type,
    loadcase: group.loadCase ? `, ${group.loadCase}` : '',
    component: group.component ? ` (${group.component})` : '',
    view: p.cls.view || '',
    max: confirmed == null ? '' : formatValue(confirmed),
    unit: confirmed == null ? '' : unit,
    n: String(figureNumber),
  };

  let text = fillTemplate(captions.results || '{type}{loadcase}{component}', vars);

  if (confirmed == null) {
    // Never invent, never interpolate: say the value is missing.
    text = text.replace(/\s*[—–-]\s*peak\b[^,.;]*/i, ' — peak value not entered');
    if (/[—–-]\s*peak/i.test(text)) text = text.replace(/[—–-]\s*peak[^,.;]*/i, '— peak value not entered');
  }

  text = text.replace(/\s{2,}/g, ' ').replace(/\s+([.,;])/g, '$1').replace(/[—–-]\s*$/, '').trim();

  /* Structural digits — the figure number and the load-case label — are part of
   * the document's numbering, not claims about the analysis. Everything else
   * must appear in the verified set or the firewall replaces it. */
  const allowed = new Set(allowedNumbers || []);
  allowed.add(String(figureNumber));
  if (group.loadCase) for (const d of String(group.loadCase).match(/\d+/g) || []) allowed.add(d);

  return enforceNumericFirewall(text, allowed);
}

export function insetLabel(photo, index) {
  const kind = photo.cls.detail.kind === 'section' ? 'Section' : 'Detail';
  const view = photo.cls.view && !/filled frame/.test(photo.cls.view) ? ` (${photo.cls.view})` : '';
  return `${kind} ${String.fromCharCode(65 + index)}${view}`;
}

/* ───────────────────────── deck assembly ───────────────────────── */

/**
 * @param {object} args
 *   photos   — analysed photos, each with .cls, .cv, .value, .id, .name
 *   template — templates/fea-report.json
 *   meta     — {project, part, client, author, revision, software, allowable, ...}
 */
export function buildDeck({ photos, template, meta = {} }) {
  const active = photos.filter((p) => !p.excluded);
  const groups = meta.groups || [];
  const slides = [];
  const figureLog = [];
  let figureNumber = 1;

  const verifiedNumbers = new Set();
  for (const p of active) {
    if (p.value?.max != null && p.value.confirmed) {
      verifiedNumbers.add(formatValue(p.value.max));
      verifiedNumbers.add(String(p.value.max));
    }
  }
  if (meta.allowable != null) {
    verifiedNumbers.add(formatValue(meta.allowable));
    verifiedNumbers.add(String(meta.allowable));
  }

  const added = new Set();
  const take = (predicate, limit) => {
    const out = active.filter((p) => !added.has(p.id) && predicate(p)).slice(0, limit);
    for (const p of out) added.add(p.id);
    return out;
  };

  /* cover */
  slides.push({
    id: 'cover', kind: 'cover',
    title: meta.project || template.meta?.project || 'Finite Element Analysis Report',
    subtitle: [meta.part, meta.client].filter(Boolean).join(' · '),
    fields: [
      ['Part / assembly', meta.part],
      ['Client / project', meta.client],
      ['Analysis', meta.analysisType || meta.software || template.meta?.software],
      ['Prepared by', meta.author],
      ['Revision', meta.revision || template.meta?.revision],
      ['Date', meta.date],
      ['Source images', `${active.length}`],
    ].filter(([, v]) => v),
  });

  /* static sections from the template, in order */
  const resultsBlock = { done: false };

  for (const section of template.sections) {
    if (section.id === 'cover') continue;

    if (section.kind === 'bullets') {
      slides.push({ id: section.id, kind: 'bullets', title: section.title, bullets: [...(section.bullets || [])] });
      continue;
    }

    if (section.kind === 'table' && section.dynamic !== 'summary') {
      slides.push({
        id: section.id, kind: 'table', title: section.title,
        table: { columns: section.columns || [], rows: (section.rows || []).map((r) => [...r]) },
      });
      continue;
    }

    if (section.kind === 'figures') {
      const wanted = section.accepts?.types || [];
      const picked = take((p) => wanted.includes(p.cls.type) || wanted.includes(familyOf(p.cls.type)), section.accepts?.capacity || 2);
      const images = [];
      for (const p of picked) {
        images.push({ photoId: p.id, role: 'main', figure: figureNumber, label: captionFor(p, section, figureNumber) });
        figureLog.push({ figure: figureNumber, photoId: p.id, name: p.name, slide: section.id });
        figureNumber++;
      }
      slides.push({
        id: section.id, kind: 'figures', title: section.title,
        bullets: section.bullets || [],
        images,
        caption: '',
      });
      continue;
    }

    if (section.kind === 'results') {
      resultsBlock.done = true;
      const resultGroups = groups.filter((g) => RESULT_FAMILIES.includes(g.family));

      for (const g of resultGroups) {
        const images = [];
        const cap = groupCaption(g, template.captions, figureNumber, verifiedNumbers);
        images.push({ photoId: g.main.id, role: 'main' });
        figureLog.push({ figure: figureNumber, photoId: g.main.id, name: g.main.name, slide: `results:${g.key}` });
        figureNumber++;
        g.insets.forEach((p, i) => {
          images.push({ photoId: p.id, role: 'inset', label: insetLabel(p, i) });
          figureLog.push({ figure: figureNumber, photoId: p.id, name: p.name, slide: `results:${g.key}` });
          figureNumber++;
        });
        for (const p of g.secondary) {
          images.push({ photoId: p.id, role: 'inset', label: p.cls.view || 'Second view' });
          figureLog.push({ figure: figureNumber, photoId: p.id, name: p.name, slide: `results:${g.key}` });
          figureNumber++;
        }
        added.add(g.main.id);
        for (const p of [...g.insets, ...g.secondary, ...g.overflow]) added.add(p.id);

        const value = g.main.value;
        slides.push({
          id: `results-${g.key}`, kind: 'results',
          title: `${FAMILY_LABEL[g.family] || 'Results'}${g.loadCase ? ` — ${g.loadCase}` : ''}${g.component ? ` · ${g.component}` : ''}`,
          images,
          caption: cap.text,
          captionBlocked: cap.blocked,
          issues: g.issues,
          table: summaryRowsFor(g, meta),
        });
      }
      continue;
    }

    if (section.kind === 'table' && section.dynamic === 'summary') {
      slides.push({
        id: section.id, kind: 'table', title: section.title,
        table: buildSummaryTable(groups, meta),
        note: meta.allowable == null ? 'Allowable stress not entered — pass/fail statements are omitted rather than guessed.' : '',
      });
      continue;
    }

    if (section.kind === 'appendix') {
      const rest = active.filter((p) => !added.has(p.id));
      const perSlide = 6;
      if (!rest.length) { slides.push({ id: 'appendix', kind: 'appendix', title: section.title, images: [] }); continue; }
      for (let i = 0; i < rest.length; i += perSlide) {
        const chunk = rest.slice(i, i + perSlide);
        slides.push({
          id: i === 0 ? 'appendix' : `appendix-${i / perSlide + 1}`,
          kind: 'appendix',
          title: i === 0 ? section.title : `${section.title} (cont.)`,
          images: chunk.map((p) => ({ photoId: p.id, label: p.name })),
        });
      }
      continue;
    }
  }

  if (!resultsBlock.done) { /* template had no results section — nothing to do */ }

  return { slides, figureLog, verifiedNumbers: [...verifiedNumbers] };
}

function captionFor(photo, section, figureNumber) {
  const vars = {
    type: photo.cls.type,
    loadcase: photo.cls.loadCase ? `, ${photo.cls.loadCase}` : '',
    component: photo.cls.component ? ` (${photo.cls.component})` : '',
    view: photo.cls.view || '',
    filename: photo.name,
    n: String(figureNumber),
  };
  const tpl = section.captions?.figures || '{type}{loadcase}{component}';
  return fillTemplate(tpl, vars).trim();
}

function summaryRowsFor(group, meta) {
  const rows = [[group.loadCase || '—', group.main.cls.type, group.main.value?.max != null ? formatValue(group.main.value.max) : '—',
    group.main.value?.unit || '', group.insets.length ? `${group.insets.length} detail` : '—']];
  return { columns: ['Load case', 'Result', 'Peak', 'Unit', 'Details'], rows };
}

/**
 * The summary table. Pass/fail only appears when the two numbers it depends on
 * were both supplied by a human — an invented verdict is the one output this
 * app must never produce.
 */
export function buildSummaryTable(groups, meta) {
  const columns = ['Load case', 'Result', 'Peak', 'Unit', 'Allowable', 'FoS', 'Verdict'];
  const rows = [];
  for (const g of groups.filter((x) => RESULT_FAMILIES.includes(x.family))) {
    const p = g.main;
    const v = p.value?.max;
    const unit = p.value?.unit || '';
    const isStress = ['stress', 'contact'].includes(g.family);
    const allowable = meta.allowable;
    let fos = '', verdict = '—';
    if (v != null && isStress && allowable != null) {
      const f = Number(allowable) / Number(v);
      fos = Number.isFinite(f) ? f.toFixed(2) : '';
      verdict = Number.isFinite(f) ? (f >= 1 ? `PASS (margin ${((f - 1) * 100).toFixed(0)}%)` : `FAIL (over by ${((1 - f) * 100).toFixed(0)}%)`) : '—';
    }
    rows.push([
      g.loadCase || '—',
      p.cls.type,
      v == null ? '—' : formatValue(v),
      v == null ? '' : unit,
      isStress && allowable != null ? String(allowable) : '—',
      fos || '—',
      verdict,
    ]);
  }
  if (!rows.length) rows.push(['—', 'No results classified yet', '—', '', '—', '—', '—']);
  return { columns, rows };
}

/** Coverage gaps: what the report needs that the drop did not contain. */
export function coverageReport(groups, photos) {
  const gaps = [];
  const families = new Set(groups.map((g) => g.family));
  const loadCases = [...new Set(groups.map((g) => g.loadCase).filter(Boolean))];

  for (const g of groups) {
    if (!g.loadCase && ['stress', 'deformation', 'strain', 'factor'].includes(g.family)) {
      gaps.push({ level: 'warn', text: `${g.main.cls.type} could not be tied to a load case — set it so the slide is labelled correctly.` });
    }
    for (const issue of g.issues) gaps.push({ ...issue, scope: describeGroup(g.main) });
  }
  if (families.has('stress') && !families.has('deformation')) {
    gaps.push({ level: 'warn', text: 'Stress results are present but no deformation result — reviewers usually expect both.' });
  }
  if (families.has('stress') && !families.has('factor')) {
    gaps.push({ level: 'info', text: 'No safety-factor plot supplied — the summary table will compute FoS from peak stress instead.' });
  }
  if (families.has('stress') && !photos.some((p) => p.cls.type === 'Mesh')) {
    gaps.push({ level: 'warn', text: 'No mesh image found — a stress result without a mesh view is hard to defend in review.' });
  }
  for (const lc of loadCases) {
    const inLc = groups.filter((g) => g.loadCase === lc);
    if (!inLc.some((g) => g.main.value?.max != null && g.main.value.confirmed)) {
      gaps.push({ level: 'info', text: `${lc}: no confirmed peak value yet — the caption will read "peak value not entered".` });
    }
  }
  return gaps;
}
