/* Ansys Report — classification.
 *
 * Three evidence sources, in order of trust:
 *   1. the filename   — deterministic, free, and usually right when the team
 *                       has any naming convention at all
 *   2. the pixels     — cv.js signals, used to confirm or override
 *   3. a vision model — only when a key is configured, only for what is left
 *
 * Every field carries its confidence and its source, because the review screen
 * has to tell a human *why* it decided something.
 */

import { inferKind, inferDetail } from './cv.js';

export const RESULT_TYPES = [
  'Equivalent (von Mises) stress', 'Maximum principal stress', 'Minimum principal stress',
  'Maximum shear stress', 'Stress (unspecified)',
  'Total deformation', 'Directional deformation', 'Equivalent elastic strain',
  'Safety factor', 'Contact pressure', 'Contact status', 'Reaction force',
  'Temperature', 'Total heat flux', 'Thermal gradient',
  'Fatigue life', 'Damage', 'Modal shape', 'Frequency',
  'Velocity', 'Pressure (fluid)', 'Turbulence', 'Volume fraction', 'Energy',
  'Mesh', 'Boundary conditions', 'Loads', 'Geometry', 'Model',
  'Graph', 'Table', 'Unclassified',
];

const FAMILY_OF = {
  'Equivalent (von Mises) stress': 'stress', 'Maximum principal stress': 'stress',
  'Minimum principal stress': 'stress', 'Maximum shear stress': 'stress', 'Stress (unspecified)': 'stress',
  'Total deformation': 'deformation', 'Directional deformation': 'deformation',
  'Equivalent elastic strain': 'strain',
  'Safety factor': 'factor', 'Contact pressure': 'contact', 'Contact status': 'contact',
  'Reaction force': 'force', 'Temperature': 'thermal', 'Total heat flux': 'thermal', 'Thermal gradient': 'thermal',
  'Fatigue life': 'fatigue', 'Damage': 'fatigue', 'Modal shape': 'modal', 'Frequency': 'modal',
  'Velocity': 'cfd', 'Pressure (fluid)': 'cfd', 'Turbulence': 'cfd', 'Volume fraction': 'cfd', 'Energy': 'cfd',
  Mesh: 'mesh', 'Boundary conditions': 'bc', Loads: 'bc',
  Geometry: 'geometry', Model: 'geometry', Graph: 'graph', Table: 'table', Unclassified: 'unknown',
};

export const familyOf = (type) => FAMILY_OF[type] || 'unknown';

export const FAMILY_LABEL = {
  stress: 'Stress', deformation: 'Deformation', strain: 'Strain', factor: 'Safety factor',
  contact: 'Contact', force: 'Reaction force', thermal: 'Thermal', fatigue: 'Fatigue',
  modal: 'Modal', cfd: 'Fluid', mesh: 'Mesh', bc: 'Boundary conditions / loads',
  geometry: 'Geometry / model', graph: 'Graphs', table: 'Tables', unknown: 'Unclassified',
};

/* ───────────────────────── filename rules ───────────────────────── */

const TYPE_RULES = [
  [/\b(von[\s_-]?mises|vm[\s_-]?stress|equivalent[\s_-]?stress|equiv[\s_-]?stress|eqv[\s_-]?stress|seqv)\b/i, 'Equivalent (von Mises) stress'],
  [/\b(max(imum)?[\s_-]?principal|principal[\s_-]?max|prin[\s_-]?max|p1)\b/i, 'Maximum principal stress'],
  [/\b(min(imum)?[\s_-]?principal|principal[\s_-]?min|prin[\s_-]?min|p3)\b/i, 'Minimum principal stress'],
  [/\b(max(imum)?[\s_-]?(shear|tresca)|tresca|sxz|sxy)\b/i, 'Maximum shear stress'],
  [/\b(stress|sigma|sxx|syy|szz|seq|s1|s2|s3)\b/i, 'Stress (unspecified)'],
  [/\b(total[\s_-]?deform(ation)?|tdeform|usum|u[\s_-]?total|magnitude)\b/i, 'Total deformation'],
  [/\b(directional[\s_-]?deform(ation)?|deform(ation)?|displacement|disp|deflection)\b/i, 'Directional deformation'],
  [/\b(total[\s_-]?strain|equivalent[\s_-]?strain|eqv[\s_-]?strain|epe?l|strain)\b/i, 'Equivalent elastic strain'],
  [/\b(safety[\s_-]?factor|factor[\s_-]?of[\s_-]?safety|fos|safety|\bsf\b)\b/i, 'Safety factor'],
  [/\b(contact[\s_-]?(pressure|status|tool)?|contact)\b/i, 'Contact pressure'],
  [/\b(heat[\s_-]?flux|thermal[\s_-]?flux|flux)\b/i, 'Total heat flux'],
  [/\b(thermal[\s_-]?gradient|temperature[\s_-]?gradient)\b/i, 'Thermal gradient'],
  [/\b(temp(erature)?|thermal)\b/i, 'Temperature'],
  [/\b(fatigue|life|cycles|damage)\b/i, 'Fatigue life'],
  [/\b(modal|mode[\s_-]?shape|mode\b|eigen|natural[\s_-]?freq|frequency|freq|hz)\b/i, 'Modal shape'],
  [/\b(velocity|vel|streamline|speed)\b/i, 'Velocity'],
  [/\b(turbulence|k[\s_-]?epsilon|k[\s_-]?omega|viscosity)\b/i, 'Turbulence'],
  [/\b(volume[\s_-]?fraction|void[\s_-]?fraction)\b/i, 'Volume fraction'],
  [/\b(contact[\s_-]?pressure)\b/i, 'Contact pressure'],
  [/\b(pressure)\b/i, 'Pressure (fluid)'],
  [/\b(reaction|force[\s_-]?reaction|rf)\b/i, 'Reaction force'],
  [/\b(graph|chart|curve|convergence|history|versus)\b/i, 'Graph'],
  [/\b(mesh(ing)?|elements?|nodes?|refinement|refined|skewness|quality|jacobian|aspect[\s_-]?ratio)\b/i, 'Mesh'],
  [/\b(boundary[\s_-]?conditions?|bc|constraints?|supports?|fixed[\s_-]?support|restraint|remote[\s_-]?point)\b/i, 'Boundary conditions'],
  [/\b(loads?|forces?|applied|pressure[\s_-]?load)\b/i, 'Loads'],
  [/\b(geometry|geom|cad|solid|assembly|part|design|model)\b/i, 'Geometry'],
];

const VIEW_RULES = [
  [/\b(iso(metric)?)\b/i, 'isometric'],
  [/\b(front)\b/i, 'front'],
  [/\b(back|rear)\b/i, 'back'],
  [/\b(top|plan)\b/i, 'top'],
  [/\b(bottom|underside)\b/i, 'bottom'],
  [/\b(left|right|side)\b/i, 'side'],
  [/\b(exploded)\b/i, 'exploded'],
  [/\b(wireframe|hidden[\s_-]?line|line[\s_-]?display)\b/i, 'wireframe'],
  [/\b(full|assembly|overall|complete|global)\b/i, 'full'],
];

const LOAD_CASE_NAMED = [
  'torsion', 'bending', 'tension', 'compression', 'shear', 'burst', 'pressure', 'thermal',
  'modal', 'impact', 'crash', 'drop', 'vibration', 'fatigue', 'buckling', 'operating',
  'ultimate', 'proof', 'service', 'static', 'seismic', 'braking', 'cornering', 'bump',
];

const NOISE = new Set([
  'screenshot', 'screen', 'shot', 'capture', 'image', 'img', 'photo', 'pic', 'picture', 'snip',
  'ansys', 'workbench', 'mechanical', 'fluent', 'static', 'structural', 'result', 'results',
  'final', 'copy', 'new', 'old', 'edit', 'edited', 'export', 'exported', 'v1', 'v2', 'v3',
  'png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff', 'the', 'and', 'with', 'of',
]);

/* Words that belong to a result type, a view or a load case — never to a part name. */
const COMPONENT_STOPWORDS = new Set([
  'von', 'mises', 'principal', 'shear', 'equivalent', 'equiv', 'total', 'max', 'maximum',
  'min', 'minimum', 'stress', 'stresses', 'deformation', 'deform', 'displacement', 'strain',
  'safety', 'factor', 'contact', 'pressure', 'temperature', 'temp', 'thermal', 'heat', 'flux',
  'modal', 'mode', 'frequency', 'freq', 'eigen', 'natural', 'velocity', 'turbulence',
  'fatigue', 'life', 'damage', 'cycles', 'mesh', 'meshfine', 'element', 'elements', 'nodes',
  'boundary', 'conditions', 'condition', 'load', 'loads', 'applied', 'reaction', 'force',
  'forces', 'geometry', 'geom', 'cad', 'solid', 'assembly', 'design', 'model', 'graph',
  'chart', 'curve', 'convergence', 'iso', 'isometric', 'front', 'back', 'rear', 'top',
  'bottom', 'side', 'left', 'right', 'exploded', 'section', 'sect', 'cut', 'slice', 'half',
  'zoom', 'zoomed', 'detail', 'detailed', 'closeup', 'local', 'enlarged', 'magnified',
  'inset', 'full', 'overall', 'complete', 'global', 'result', 'results', 'projection',
]);

const stripExt = (n) => n.replace(/\.[a-z0-9]{2,5}$/i, '');
const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** Everything that can be learned from the name alone. */
export function parseFilename(name) {
  const base = stripExt(name);

  /* Normalise before matching: underscores and camelCase are separators, not
   * word characters, otherwise \b fails on names like LC2_vonMises_bracket. */
  const norm = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const words = norm.split(' ').filter(Boolean);

  let type = null, typeConf = 0;
  for (const [re, t] of TYPE_RULES) {
    if (re.test(norm)) { type = t; typeConf = 0.85; break; }
  }

  let loadCase = null, loadCaseConf = 0;
  const lcNum = norm.match(/\b(?:lc|ls|load|case|step|scenario)\s*(?:case|step)?\s*(\d{1,2})\b/);
  if (lcNum) {
    loadCase = `LC${lcNum[1]}`;
    loadCaseConf = 0.9;
  } else {
    for (const w of LOAD_CASE_NAMED) {
      if (words.includes(w)) { loadCase = titleCase(w); loadCaseConf = 0.6; break; }
    }
  }

  let view = null;
  for (const [re, v] of VIEW_RULES) if (re.test(norm)) { view = v; break; }

  const detailHit = matchDetailWord(norm);

  const componentWords = words.filter((w) => {
    if (NOISE.has(w) || COMPONENT_STOPWORDS.has(w)) return false;
    if (/^\d+$/.test(w)) return false;
    if (/^l[cs]?\d+$/.test(w)) return false;
    if (w.length < 2) return false;
    if (TYPE_RULES.some(([re]) => re.test(w))) return false;
    if (VIEW_RULES.some(([re]) => re.test(w))) return false;
    if (LOAD_CASE_NAMED.includes(w)) return false;
    return true;
  });

  return {
    type, typeConf,
    loadCase, loadCaseConf,
    view,
    detail: detailHit,
    component: componentWords.length ? titleCase(componentWords.join(' ')) : null,
    componentConf: componentWords.length ? 0.55 : 0,
    words,
  };
}

function matchDetailWord(lower) {
  const zoom = /\b(zoom(ed)?|detail(ed)?|close\s*up|local|enlarged|magnified|inset|scaled view|callout)\b/i;
  const section = /\b(section|sect|cut\s*(away|view|section)?|slice|half\s*(section|model|cut)?|cross section|clipped|clipping)\b/i;
  if (section.test(lower)) return { isDetail: true, kind: 'section', conf: 0.9, source: 'filename' };
  if (zoom.test(lower)) return { isDetail: true, kind: 'zoom', conf: 0.9, source: 'filename' };
  return { isDetail: false, kind: null, conf: 0, source: null };
}

/* ───────────────────────── per-photo classification ───────────────────────── */

/**
 * @param {object} photo {name, cv}
 * @param {object} [model] optional vision-model opinion {type, loadCase, component, view, detail, conf}
 * @param {object[]} siblingCv  cv signals of photos in the same provisional group
 */
export function classifyPhoto(photo, model = null, siblingCv = []) {
  const name = parseFilename(photo.name);
  const cv = photo.cv || {};
  const kind = photo.kind || inferKind(cv);

  /* — result type — */
  let type = name.type, typeConf = name.typeConf, typeSource = name.typeConf ? 'filename' : null;
  if (model?.type && (!type || model.conf > 0.8)) { type = model.type; typeConf = model.conf ?? 0.85; typeSource = 'vision model'; }
  if (!type) {
    if (kind.kind === 'mesh') { type = 'Mesh'; typeConf = kind.conf; typeSource = 'pixels'; }
    else if (kind.kind === 'geometry') { type = 'Geometry'; typeConf = kind.conf; typeSource = 'pixels'; }
    else if (kind.kind === 'graph') { type = 'Graph'; typeConf = kind.conf; typeSource = 'pixels'; }
    else if (kind.kind === 'contour') { type = 'Unclassified'; typeConf = 0.35; typeSource = 'pixels (contour plot, quantity not readable without the legend text)'; }
    else { type = 'Unclassified'; typeConf = 0.2; typeSource = null; }
  }

  /* — load case — */
  let loadCase = name.loadCase, loadCaseConf = name.loadCaseConf, loadCaseSource = name.loadCaseConf ? 'filename' : null;
  if (model?.loadCase && !loadCase) { loadCase = model.loadCase; loadCaseConf = 0.7; loadCaseSource = 'vision model'; }

  /* — component — */
  let component = name.component, componentConf = name.componentConf, componentSource = name.componentConf ? 'filename' : null;
  if (model?.component && componentConf < 0.6) { component = model.component; componentConf = 0.7; componentSource = 'vision model'; }

  /* — view — */
  let view = name.view, viewSource = name.view ? 'filename' : null;
  if (model?.view && !view) { view = model.view; viewSource = 'vision model'; }
  if (!view && cv.bgFraction != null) {
    if (cv.bgFraction < 0.08) { view = 'filled frame'; viewSource = 'pixels'; }
    else if (cv.bgFraction > 0.45) { view = 'full view'; viewSource = 'pixels'; }
  }

  /* — detail view (zoom / cut section) — */
  const pixelDetail = inferDetail(cv, siblingCv);
  let detail = name.detail.conf ? name.detail : pixelDetail.isDetail ? { ...pixelDetail, source: 'pixels' } : { isDetail: false, kind: null, conf: 0, source: null, reasons: [] };
  if (model?.detail?.isDetail) {
    detail = {
      isDetail: true,
      kind: model.detail.kind || 'zoom',
      conf: 0.85,
      source: 'vision model',
      reasons: [...(detail.reasons || []), model.detail.reason || 'identified by the vision model'],
    };
  } else if (name.detail.conf && pixelDetail.isDetail) {
    detail = { ...detail, conf: Math.min(0.98, detail.conf + 0.05), reasons: [...(detail.reasons || []), ...pixelDetail.reasons] };
  }

  const confidences = {
    type: round2(typeConf),
    loadCase: round2(loadCaseConf),
    component: round2(componentConf),
    view: view ? (viewSource === 'filename' ? 0.8 : 0.5) : 0,
    detail: round2(detail.conf || 0),
  };

  const needsReview = Object.entries(confidences)
    .filter(([, c]) => c > 0 && c < 0.7)
    .map(([k]) => k);
  if (!confidences.type) needsReview.push('type');
  if (!confidences.loadCase && /stress|deformation|strain|factor|contact|thermal|fatigue|modal|cfd/.test(FAMILY_OF[type] || '')) {
    needsReview.push('loadCase');
  }

  const overall = round2(
    (confidences.type * 0.45 + confidences.loadCase * 0.25 + confidences.detail * 0.2 + confidences.component * 0.1)
  );

  return {
    type,
    family: familyOf(type),
    typeConf: confidences.type,
    typeSource,
    loadCase, loadCaseConf: confidences.loadCase, loadCaseSource,
    component, componentConf: confidences.component, componentSource,
    view, viewSource,
    detail,
    kind: kind.kind,
    kindWhy: kind.why,
    confidences,
    needsReview,
    overall,
    ok: confidences.type >= 0.7,
  };
}

const round2 = (n) => Math.round((n || 0) * 100) / 100;

/* ───────────────────────── the two-pass classifier ───────────────────────── */

export const groupKeyOf = (p) => [p.cls.loadCase || '—', p.cls.family, p.cls.component || ''].join('|');

/**
 * Pass 1 classifies each photo on its own. Pass 2 reclassifies with the other
 * photos in its provisional group visible, because "is this a detail view?" is
 * a *relative* question: a frame-filling plot is only a zoom next to the same
 * plot with background around it.
 */
export function classifyAll(photos, models = {}) {
  for (const p of photos) p.cls = classifyPhoto(p, models[p.id] || null, []);

  const buckets = new Map();
  for (const p of photos) {
    const key = groupKeyOf(p);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  }

  for (const p of photos) {
    const siblings = (buckets.get(groupKeyOf(p)) || []).filter((s) => s !== p).map((s) => s.cv);
    p.cls = classifyPhoto(p, models[p.id] || null, siblings);
  }
  return photos;
}

/* ───────────────────────── grouping (parent ⇄ detail) ───────────────────────── */

/**
 * The heart of the "put the zoom and the cut section on the same page as the
 * full model" requirement.
 *
 * A group is one result of one kind on one component under one load case.
 * Inside a group the *full* view becomes the parent and every detail view
 * becomes an inset on the parent's slide. If a group has details but no full
 * view, that is reported as a gap rather than silently promoted.
 */
export function groupPhotos(photos, rules = {}) {
  const maxInsets = rules.maxInsetsPerSlide ?? 3;
  const byKey = new Map();

  for (const p of photos) {
    if (p.excluded) continue;
    const key = [p.cls.loadCase || '—', p.cls.family, p.cls.component || ''].join('|');
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(p);
  }

  const groups = [];
  for (const [key, members] of byKey) {
    const full = members.filter((m) => !m.cls.detail.isDetail);
    const details = members.filter((m) => m.cls.detail.isDetail);
    const byFullness = (a, b) => (b.cv?.bgFraction ?? 0) - (a.cv?.bgFraction ?? 0);

    full.sort(byFullness);
    details.sort(byFullness);

    const main = full[0] || details[0] || members[0];
    const insets = (full[0] ? details : details.slice(1)).slice(0, maxInsets);
    const overflow = (full[0] ? details : details.slice(1)).slice(maxInsets);
    const secondary = full.slice(1, 2);        // a second full view (iso + front, say)

    const issues = [];
    if (!full.length) {
      issues.push({
        level: 'warn',
        text: `No full view for ${describeGroup(main)} — only a ${main.cls.detail.kind || 'detail'} view was supplied. Add the full model view or confirm this is intended.`,
      });
    }
    if (details.length > maxInsets) {
      issues.push({ level: 'info', text: `${details.length} detail views, only ${maxInsets} fit on the slide; ${overflow.length} moved to the appendix.` });
    }

    groups.push({
      key,
      loadCase: main.cls.loadCase,
      family: main.cls.family,
      component: main.cls.component,
      main,
      secondary,
      insets,
      overflow,
      extras: [...secondary, ...overflow],
      issues,
      members,
    });
  }

  groups.sort((a, b) => String(a.loadCase).localeCompare(String(b.loadCase), undefined, { numeric: true })
    || String(a.family).localeCompare(String(b.family)));

  return groups;
}

export function describeGroup(p) {
  const parts = [p.cls.type];
  if (p.cls.loadCase) parts.push(p.cls.loadCase);
  if (p.cls.component) parts.push(p.cls.component);
  return parts.join(' · ');
}

/** Mark near-identical images (same view re-exported, or a duplicate paste). */
export function findDuplicates(photos, threshold = 6) {
  const pairs = [];
  for (let i = 0; i < photos.length; i++) {
    for (let j = i + 1; j < photos.length; j++) {
      const a = photos[i], b = photos[j];
      if (!a.hash || !b.hash) continue;
      let d = 0;
      for (let k = 0; k < a.hash.length; k++) {
        let x = parseInt(a.hash[k], 16) ^ parseInt(b.hash[k], 16);
        while (x) { d += x & 1; x >>= 1; }
      }
      if (d <= threshold) pairs.push({ a: a.id, b: b.id, distance: d });
    }
  }
  return pairs;
}
