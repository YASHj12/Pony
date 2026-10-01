/* Ansys Report Builder — application shell.
 * intake → measure → classify → case grouping → deck → review → export
 */

import { analyzeImageData, detectLegend, dHash, inferKind } from './cv.js';
import { RESULT_TYPES, classifyAll, FAMILY_LABEL, groupPhotos } from './classify.js';
import { buildDeck, coverageReport, computeAllowable } from './report.js';
import { buildPptx } from './pptx.js';

/* ───────────────────────────── state ───────────────────────────── */

const STORE_META = 'fea-report-meta-v2';
const STORE_TPL = 'fea-report-template-v2';

const state = {
  photos: [],
  deck: null,
  gaps: [],
  selected: null,
  template: null,
  settings: {
    meta: {
      reportNo: '', date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
      client: '', author: '', part: '', partShort: '', analysis: 'Static Structural Analysis',
      fos: 1.3, allowableRounding: 'floor',
    },
    materialsRows: [],
    cases: {},          // caseId → { description, bcText }
  },
};

const els = {};
const $ = (id) => document.getElementById(id);

/* ───────────────────────────── helpers ───────────────────────────── */

function toast(msg, ms = 2400) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { els.toast.hidden = true; }, ms);
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const byId = (id) => state.photos.find((p) => p.id === id);

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not decode this image'));
    img.src = url;
  });
}

function drawTo(img, maxSize) {
  const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function saveSettings() {
  try {
    localStorage.setItem(STORE_META, JSON.stringify({
      meta: state.settings.meta,
      materialsRows: state.settings.materialsRows,
      cases: state.settings.cases,
    }));
  } catch { /* private mode */ }
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_META) || 'null');
    if (saved) {
      Object.assign(state.settings.meta, saved.meta || {});
      state.settings.materialsRows = saved.materialsRows || [];
      state.settings.cases = saved.cases || {};
    }
  } catch { /* ignore */ }
}

/* ───────────────────────────── intake ───────────────────────────── */

const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif|tif?f)$/i;

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/') || IMAGE_RE.test(f.name));
  if (!files.length) { toast('No images in that drop'); return; }

  els.workspace.hidden = false;
  els.progress.hidden = false;

  let done = 0;
  for (const file of files) {
    els.progressText.textContent = `Reading ${file.name} (${done + 1}/${files.length})`;
    els.barFill.style.width = `${Math.round((done / files.length) * 100)}%`;
    await new Promise((r) => requestAnimationFrame(r));
    try {
      state.photos.push(await readPhoto(file));
    } catch (err) {
      console.warn('skipped', file.name, err);
      toast(`Skipped ${file.name}: ${err.message}`);
    }
    done++;
  }
  els.barFill.style.width = '100%';
  els.progress.hidden = true;
  recompute();
}

async function readPhoto(file) {
  const objectUrl = URL.createObjectURL(file);
  const img = await loadImage(objectUrl);
  const canvas = drawTo(img, 480);
  const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);

  const signals = analyzeImageData(data, width, height);
  signals.legend = detectLegend(data, width, height);

  return {
    id: `${file.name}::${file.size}::${state.photos.length}`,
    name: file.name,
    file, img, objectUrl,
    cv: signals,
    kind: inferKind(signals),
    hash: dHash(data, width, height),
    legendCrop: signals.legend.found ? cropLegend(canvas, signals.legend.rect) : null,
    cls: null,
    override: {},
    value: { max: null, unit: guessUnit(file.name), confirmed: false },
    excluded: false,
  };
}

function guessUnit(name) {
  if (/stress|von|mises|mpa|seqv|pressure/i.test(name)) return 'MPa';
  if (/deform|displacement/i.test(name)) return 'mm';
  if (/temp|thermal/i.test(name)) return '°C';
  if (/freq|hz|modal/i.test(name)) return 'Hz';
  return '';
}

function cropLegend(canvas, rect) {
  const sx = Math.max(0, Math.round(rect.x * canvas.width));
  const sy = Math.max(0, Math.round(rect.y * canvas.height));
  const sw = Math.max(4, Math.round(rect.w * canvas.width));
  const sh = Math.max(4, Math.round(rect.h * canvas.height));
  const out = document.createElement('canvas');
  out.width = Math.min(sw, 54);
  out.height = Math.min(sh, 190);
  out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

/* ───────────────────────────── pipeline ───────────────────────────── */

function recompute() {
  if (!state.template) return;
  state.template.materials.rows = state.settings.materialsRows;
  const meta = { ...state.settings.meta, cases: state.settings.cases };

  classifyAll(state.photos, {});
  for (const p of state.photos) applyOverride(p);

  state.deck = buildDeck({ photos: state.photos, template: state.template, meta });
  state.gaps = coverageReport(state.deck.cases, state.photos, { allowable: state.deck.allowable });

  renderAll();
}

function applyOverride(photo) {
  const o = photo.override;
  if (o.type) { photo.cls.type = o.type; photo.cls.family = familyKey(o.type); photo.cls.typeConf = 1; photo.cls.typeSource = 'you'; }
  if (o.loadCase !== undefined) { photo.cls.loadCase = o.loadCase || null; photo.cls.loadCaseConf = 1; photo.cls.loadCaseSource = 'you'; }
  if (o.component !== undefined) { photo.cls.component = o.component || null; photo.cls.componentConf = 1; photo.cls.componentSource = 'you'; }
  if (o.detail !== undefined) {
    photo.cls.detail = o.detail
      ? { isDetail: true, kind: o.detail, conf: 1, source: 'you', reasons: ['set by you'] }
      : { isDetail: false, kind: null, conf: 1, source: 'you', reasons: ['set by you'] };
  }
  photo.cls.excluded = photo.excluded;
}

function familyKey(type) {
  const map = {
    'Equivalent (von Mises) stress': 'stress', 'Maximum principal stress': 'stress', 'Minimum principal stress': 'stress',
    'Maximum shear stress': 'stress', 'Stress (unspecified)': 'stress',
    'Total deformation': 'deformation', 'Directional deformation': 'deformation', 'Equivalent elastic strain': 'strain',
    'Safety factor': 'factor', 'Contact pressure': 'contact', 'Contact status': 'contact', 'Reaction force': 'force',
    Temperature: 'thermal', 'Total heat flux': 'thermal', 'Thermal gradient': 'thermal',
    'Fatigue life': 'fatigue', Damage: 'fatigue', 'Modal shape': 'modal', Frequency: 'modal',
    Velocity: 'cfd', 'Pressure (fluid)': 'cfd', Turbulence: 'cfd', 'Volume fraction': 'cfd',
    Mesh: 'mesh', 'Boundary conditions': 'bc', Loads: 'bc', Geometry: 'geometry', Model: 'geometry',
    Graph: 'graph', Table: 'table', Unclassified: 'unknown',
  };
  return map[type] || 'unknown';
}

function needsReview(photo) {
  const reasons = [];
  if (photo.excluded) return reasons;
  if (photo.cls.typeConf < 0.7 || photo.cls.type === 'Unclassified') reasons.push('result type unclear');
  if (!photo.cls.loadCase && ['stress', 'deformation', 'strain', 'factor', 'contact', 'bc'].includes(photo.cls.family)) reasons.push('no load case');
  const inResults = ['stress', 'deformation'].includes(photo.cls.family) && !photo.cls.detail.isDetail;
  if (inResults && photo.value.max == null) reasons.push('peak value not entered');
  else if (photo.value.max != null && !photo.value.confirmed) reasons.push('value not confirmed');
  return reasons;
}

/* ───────────────────────────── rendering ───────────────────────────── */

function renderAll() {
  if (!state.deck) return;
  els.slideMeta.textContent = `${state.deck.slides.length} slides`;
  const queue = reviewQueue();
  els.reviewMeta.textContent = queue.length ? `${queue.length} need attention` : 'nothing waiting';
  els.footStats.textContent = `${state.photos.filter((p) => !p.excluded).length} images · ${state.deck.cases.length} cases · allowable ${state.deck.allowable ?? '—'} MPa`;
  els.exportBtn.disabled = !state.photos.some((p) => !p.excluded);
  els.csvBtn.disabled = els.exportBtn.disabled;
  els.clearBtn.disabled = !state.photos.length;
  els.allowableHint.textContent = state.deck.allowable == null
    ? 'Allowable stress not set — enter a material row with a yield stress and the report can state a verdict.'
    : `Allowable stress in the report: ${state.deck.allowable} MPa  (yield ÷ FOS, ${state.settings.meta.allowableRounding}).`;
  renderPreview();
  renderGaps();
  renderCaseEditor();
  renderCards();
  paintLoadCaseList();
}

function renderPreview() {
  els.preview.innerHTML = '';
  for (const slide of state.deck.slides) els.preview.append(renderSlide(slide));
}

function figCell(fig, className = 'figcell') {
  const p = fig.photoId ? byId(fig.photoId) : null;
  return `<div class="${className}">
    ${fig.label ? `<div class="figlabel">${esc(fig.label)}</div>` : ''}
    ${p ? `<img src="${p.objectUrl}" alt="" />` : `<div class="figmissing">${esc(fig.line || 'image missing')}</div>`}
    ${fig.line && p ? `<div class="figline">${esc(fig.line)}</div>` : ''}
  </div>`;
}

function renderSlide(slide) {
  const el = document.createElement('article');
  el.className = `slide layout-${slide.layout}`;

  if (slide.layout === 'cover') {
    el.innerHTML = `<div class="s-accent"></div>
      <div class="s-eyebrow">${esc(slide.eyebrow || '')}</div>
      <div class="s-title">${esc(slide.title)}</div>
      <div class="s-fields">${(slide.fields || []).map(([k, v]) => `<div><b>${esc(k)}</b>${esc(v)}</div>`).join('')}</div>`;
    return el;
  }

  el.innerHTML = `<div class="s-title">${esc(slide.title || '')}</div><div class="s-rule"></div>`;

  if (slide.layout === 'bullets') {
    el.innerHTML += `<div class="s-obs">${(slide.bullets || []).map((b) => `<p>${esc(b)}</p>`).join('')}</div>`;
    return el;
  }

  if (slide.layout === 'table') {
    const t = slide.table || { columns: [], rows: [] };
    el.innerHTML += `<table><thead><tr>${t.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${t.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>
      ${(slide.notes || []).length || slide.empty ? `<div class="s-notes">${(slide.notes || []).map((n, i) => `<p class="${/σall|Allowable Von/.test(n) ? 'strong' : ''}">${esc(n)}</p>`).join('')}${slide.empty ? `<p>${esc(slide.empty)}</p>` : ''}</div>` : ''}`;
    return el;
  }

  if (slide.layout === 'figure-row') {
    el.innerHTML += `<div class="s-figrow">${(slide.figures || []).map((f) => figCell(f)).join('')}</div>`;
    if ((slide.insets || []).length) {
      el.innerHTML += `${slide.stripLabel ? `<div class="s-striplabel">${esc(slide.stripLabel)}</div>` : ''}
        <div class="s-insets">${slide.insets.map((i) => {
          const p = byId(i.photoId);
          return `<figure>${p ? `<img src="${p.objectUrl}" alt="" />` : ''}<figcaption>${esc(i.label || '')}</figcaption></figure>`;
        }).join('')}</div>`;
    }
    if (slide.missing) el.innerHTML += `<div class="s-missing">${esc(slide.missing)}</div>`;
    return el;
  }

  if (slide.layout === 'figure-text') {
    const p = slide.photoId ? byId(slide.photoId) : null;
    el.innerHTML += `<div class="s-figtext">
      <div class="imgcol">${p ? `<img src="${p.objectUrl}" alt="" />` : `<div class="figmissing">${esc(slide.missingImage || 'no image')}</div>`}</div>
      <div class="txtcol">
        <div class="bchead">${esc(slide.heading || '')}</div>
        <p class="${slide.placeholder ? 'placeholder' : ''}">${esc(slide.text || '')}</p>
      </div>
    </div>`;
    return el;
  }

  if (slide.layout === 'grid') {
    el.innerHTML += `<div class="s-grid">${(slide.images || []).map((im) => {
      const p = byId(im.photoId);
      return `<figure>${p ? `<img src="${p.objectUrl}" alt="" />` : ''}<figcaption>${esc(im.label || '')}</figcaption></figure>`;
    }).join('')}</div>`;
    return el;
  }

  return el;
}

function renderGaps() {
  if (!state.photos.length) { els.gaps.innerHTML = ''; return; }
  const items = state.gaps.map((g) => `<div class="gap ${g.level}">${esc(g.text)}</div>`);
  if (!items.length) items.push('<div class="gap ok">Nothing missing — every case has its results, values and text.</div>');
  els.gaps.innerHTML = items.join('');
}

function reviewQueue() {
  return state.photos
    .filter((p) => !p.excluded)
    .map((p) => ({ photo: p, reasons: needsReview(p) }))
    .filter((x) => x.reasons.length);
}

function renderCaseEditor() {
  const cases = state.deck?.cases || [];
  if (!cases.length) { els.caseEditor.innerHTML = ''; return; }
  els.caseEditor.innerHTML = `<div class="case-editor"><h3>Cases</h3>${cases.map((c) => {
    const settings = state.settings.cases[c.id] || {};
    const stress = c.stressPhoto?.value?.confirmed ? c.stressPhoto.value.max : null;
    const allow = state.deck.allowable;
    const verdict = stress == null || allow == null ? null : (stress > allow ? 'exceeds' : 'within');
    const count = c.members.length;
    return `<div class="case-card" data-case="${esc(c.id)}">
      <div class="case-head">
        <span class="case-chip">${esc(c.id)}</span>
        <span class="case-count">${count} image${count === 1 ? '' : 's'}${c.deformationPhoto ? ' · deformation' : ''}${c.stressPhoto ? ' · stress' : ''}${c.bcPhoto ? ' · BC' : ''}${c.detailPhotos.length ? ` · ${c.detailPhotos.length} detail` : ''}</span>
        ${verdict ? `<span class="case-verdict ${verdict === 'within' ? 'ok' : 'bad'}">${verdict === 'within' ? 'within allowable' : 'exceeds allowable'}</span>` : ''}
      </div>
      <label>Case description</label>
      <input type="text" class="case-desc" value="${esc(settings.description || '')}" placeholder="Gate Fully Closed (Self Weight + Pressure)" />
      <label>Boundary conditions text</label>
      <textarea class="case-bc" placeholder="A) Roller contact area is fixed. B) Design pressure 621.47 mmWC applied which is 0.00609 MPa. C) Self weight considered.">${esc(settings.bcText || '')}</textarea>
    </div>`;
  }).join('')}</div>`;

  els.caseEditor.querySelectorAll('.case-card').forEach((card) => {
    const id = card.dataset.case;
    const desc = card.querySelector('.case-desc');
    const bc = card.querySelector('.case-bc');
    desc.onchange = () => {
      state.settings.cases[id] = { ...(state.settings.cases[id] || {}), description: desc.value.trim() };
      saveSettings(); recompute();
    };
    bc.onchange = () => {
      state.settings.cases[id] = { ...(state.settings.cases[id] || {}), bcText: bc.value.trim() };
      saveSettings(); recompute();
    };
  });
}

function paintLoadCaseList() {
  const cases = [...new Set(state.photos.map((p) => p.cls.loadCase).filter(Boolean))];
  els.loadCases.innerHTML = cases.map((c) => `<option value="${esc(c)}"></option>`).join('');
}

function renderCards() {
  els.cards.innerHTML = '';
  for (const photo of state.photos) {
    const node = els.cardTpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = photo.id;
    if (photo.id === state.selected) node.classList.add('selected');
    if (photo.excluded) node.classList.add('excluded');

    node.querySelector('.thumb').src = photo.objectUrl;
    node.querySelector('.thumb').onclick = () => { els.lightboxImg.src = photo.objectUrl; els.lightbox.hidden = false; };
    node.querySelector('.name').textContent = photo.name;

    const family = FAMILY_LABEL[photo.cls.family] || photo.cls.type;
    node.querySelector('.tag-kind').textContent = family;
    const detailTag = node.querySelector('.tag-detail');
    if (photo.cls.detail.isDetail) {
      detailTag.hidden = false;
      detailTag.textContent = photo.cls.detail.kind === 'section' ? 'cut section' : 'zoomed';
    }
    node.querySelector('.tag-legend').hidden = !photo.cv.legend.found;

    const typeSel = node.querySelector('.f-type');
    typeSel.innerHTML = RESULT_TYPES.map((t) => `<option${t === photo.cls.type ? ' selected' : ''}>${esc(t)}</option>`).join('');
    typeSel.onchange = () => { photo.override.type = typeSel.value; recompute(); };

    const loadInput = node.querySelector('.f-load');
    loadInput.value = photo.cls.loadCase || '';
    loadInput.onchange = () => { photo.override.loadCase = loadInput.value.trim(); recompute(); };

    const compInput = node.querySelector('.f-comp');
    compInput.value = photo.cls.component || '';
    compInput.onchange = () => { photo.override.component = compInput.value.trim(); recompute(); };

    const valueInput = node.querySelector('.f-value');
    valueInput.value = photo.value.max ?? '';
    const unitSel = node.querySelector('.f-unit');
    unitSel.value = photo.value.unit || '';
    const setValue = () => {
      const n = valueInput.value === '' ? null : Number(valueInput.value);
      photo.value.max = Number.isFinite(n) ? n : null;
      photo.value.unit = unitSel.value;
      if (photo.value.max == null) photo.value.confirmed = false;
      recompute();
    };
    valueInput.onchange = setValue;
    unitSel.onchange = setValue;

    const crop = node.querySelector('.legendcrop');
    if (photo.legendCrop) { crop.src = photo.legendCrop; crop.hidden = false; }
    node.querySelector('.legendtext').innerHTML = photo.cv.legend.found
      ? `legend on the ${esc(photo.cv.legend.side)} — read the peak off this crop and type it above. <span class="${photo.value.confirmed ? 'confirmed' : 'unconfirmed'}">${photo.value.confirmed ? 'confirmed' : 'not confirmed'}</span>`
      : `no colourbar detected in this screenshot. <span class="${photo.value.confirmed ? 'confirmed' : 'unconfirmed'}">${photo.value.confirmed ? 'confirmed' : 'not confirmed'}</span>`;

    node.querySelector('.why').textContent = [
      `${photo.cls.typeSource || 'unclassified'} · ${Math.round(photo.cls.typeConf * 100)}%`,
      photo.cls.detail.reasons && photo.cls.detail.reasons.length ? photo.cls.detail.reasons[0] : null,
      photo.kind && photo.kind.why ? photo.kind.why : null,
    ].filter(Boolean).join(' — ');

    node.querySelector('.act-confirm').onclick = () => {
      if (photo.value.max == null) { toast('Type the peak value first'); return; }
      photo.value.confirmed = true;
      recompute();
      toast(`Confirmed ${photo.value.max} ${photo.value.unit}`);
    };
    node.querySelector('.act-detail').onclick = () => { photo.override.detail = 'zoom'; recompute(); };
    node.querySelector('.act-section').onclick = () => { photo.override.detail = 'section'; recompute(); };
    node.querySelector('.act-full').onclick = () => { photo.override.detail = false; recompute(); };
    node.querySelector('.act-exclude').onclick = () => { photo.excluded = !photo.excluded; recompute(); };
    node.querySelector('.remove').onclick = () => {
      state.photos = state.photos.filter((p) => p.id !== photo.id);
      URL.revokeObjectURL(photo.objectUrl);
      recompute();
    };
    node.onclick = (e) => {
      if (['INPUT', 'SELECT', 'BUTTON', 'IMG', 'TEXTAREA'].includes(e.target.tagName)) return;
      state.selected = photo.id;
      renderCards();
    };

    els.cards.append(node);
  }
}

function selectAndScroll(id) {
  state.selected = id;
  renderCards();
  const node = els.cards.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (node) { node.scrollIntoView({ behavior: 'smooth', block: 'center' }); node.focus({ preventScroll: true }); }
}

/* ───────────────────────────── panel: meta + materials ───────────────────────────── */

const META_FIELDS = [
  ['mReportNo', 'reportNo'], ['mDate', 'date'], ['mClient', 'client'], ['mAuthor', 'author'],
  ['mPart', 'part'], ['mPartShort', 'partShort'], ['mAnalysis', 'analysis'],
  ['mFos', 'fos'], ['mRounding', 'allowableRounding'],
];

function bindMeta() {
  for (const [id, key] of META_FIELDS) {
    const el = $(id);
    if (!el) continue;
    el.value = state.settings.meta[key] ?? '';
    el.addEventListener('change', () => {
      state.settings.meta[key] = key === 'fos' ? Number(el.value) || 1 : el.value;
      saveSettings();
      renderMaterials();
      if (state.photos.length) recompute();
    });
  }
}

function renderMaterials() {
  const cols = state.template.materials.columns;
  const rows = state.settings.materialsRows;
  if (!rows.length && !state.template.materials.rows.length) rows.push(new Array(cols.length).fill(''));
  const allowableIdx = cols.findIndex((c) => /allowable/i.test(c));
  const yieldIdx = cols.findIndex((c) => /yield/i.test(c));

  els.materialsTable.innerHTML = `<thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}<th></th></tr></thead>
    <tbody>${rows.map((row, r) => `<tr>${cols.map((c, ci) => {
      if (ci === allowableIdx) {
        const computed = computeAllowable(row[yieldIdx], state.settings.meta.fos, state.settings.meta.allowableRounding);
        return `<td class="computed"><input type="text" value="${computed == null ? '' : computed}" disabled /></td>`;
      }
      return `<td><input type="text" data-r="${r}" data-c="${ci}" value="${esc(row[ci] ?? '')}" placeholder="${ci === 0 ? 'IS 2062' : ci === 1 ? 'Gate' : ''}" /></td>`;
    }).join('')}<td><button class="icon del" data-del="${r}" title="Remove row">✕</button></td></tr>`).join('')}</tbody>`;

  els.materialsTable.querySelectorAll('input[data-r]').forEach((input) => {
    input.onchange = () => {
      state.settings.materialsRows[Number(input.dataset.r)][Number(input.dataset.c)] = input.value;
      saveSettings();
      if (state.photos.length) recompute(); else { renderMaterials(); }
    };
  });
  els.materialsTable.querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = () => {
      state.settings.materialsRows.splice(Number(btn.dataset.del), 1);
      saveSettings();
      if (state.photos.length) recompute(); else renderMaterials();
    };
  });
}

/* ───────────────────────────── template ───────────────────────────── */

async function loadTemplate() {
  const saved = (() => { try { return JSON.parse(localStorage.getItem(STORE_TPL) || 'null'); } catch { return null; } })();
  if (saved?.sections) { state.template = saved; return; }
  const res = await fetch('/templates/fea-report.json');
  state.template = await res.json();
}

function wireTemplateButtons() {
  els.panelBtn.onclick = () => {
    els.panel.hidden = !els.panel.hidden;
    els.panelBtn.setAttribute('aria-expanded', String(!els.panel.hidden));
  };
  els.templateReset.onclick = async () => {
    try {
      state.template = await (await fetch('/templates/fea-report.json')).json();
      localStorage.removeItem(STORE_TPL);
      recompute(); renderMaterials();
      toast('Template reset to the sample-matched default');
    } catch { toast('Could not reload the default template'); }
  };
  els.templateDownload.onclick = () => {
    download(new Blob([JSON.stringify(state.template, null, 2)], { type: 'application/json' }), 'fea-report-template.json');
  };
  els.templateUpload.onchange = async () => {
    const file = els.templateUpload.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed.sections || !parsed.materials) throw new Error('needs "sections" and "materials"');
      state.template = parsed;
      localStorage.setItem(STORE_TPL, JSON.stringify(parsed));
      recompute(); renderMaterials();
      toast('Template loaded');
    } catch (err) { toast(`Template rejected: ${err.message}`); }
    els.templateUpload.value = '';
  };
  els.legacyBtn.onclick = () => {
    if (!state.template.phrasesLegacy) { toast('This template has no legacy phrases'); return; }
    state.template = { ...state.template, phrases: { ...state.template.phrasesLegacy } };
    delete state.template.phrases.note;
    localStorage.setItem(STORE_TPL, JSON.stringify(state.template));
    recompute();
    toast('Switched to the older sample wording');
  };
}

/* ───────────────────────────── export ───────────────────────────── */

async function exportPptx() {
  if (!state.photos.length) return;
  els.progress.hidden = false;
  const media = {};
  const active = state.photos.filter((p) => !p.excluded);

  for (let i = 0; i < active.length; i++) {
    const p = active[i];
    els.progressText.textContent = `Encoding ${p.name} (${i + 1}/${active.length})`;
    els.barFill.style.width = `${Math.round((i / active.length) * 100)}%`;
    await new Promise((r) => requestAnimationFrame(r));
    const canvas = drawTo(p.img, 1500);
    const url = canvas.toDataURL('image/jpeg', 0.92);
    media[p.id] = { bytes: base64ToBytes(url.split(',')[1]), ext: 'jpg', width: canvas.width, height: canvas.height };
  }

  els.progressText.textContent = 'Writing the presentation…';
  await new Promise((r) => requestAnimationFrame(r));
  try {
    const { bytes } = buildPptx({
      deck: state.deck, media,
      meta: { project: state.settings.meta.part || 'FEA Report', author: state.settings.meta.author },
      theme: state.template.theme,
      size: state.template.slideSize,
    });
    const base = (state.settings.meta.reportNo || state.settings.meta.part || 'FEA report').replace(/[^\w\-. ]+/g, '-').trim();
    download(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), `${base || 'FEA-report'}.pptx`);
    toast(`Exported ${state.deck.slides.length} slides`);
  } catch (err) {
    console.error(err);
    toast(`Export failed: ${err.message}`);
  } finally {
    els.progress.hidden = true;
    els.barFill.style.width = '100%';
  }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportCsv() {
  const rows = [['file', 'result_type', 'load_case', 'component', 'view', 'detail_view', 'confidence', 'peak_value', 'unit', 'confirmed', 'slide']];
  const slideOf = (id) => {
    const s = (state.deck?.slides || []).find((sl) => (sl.figures || []).some((f) => f.photoId === id)
      || (sl.insets || []).some((f) => f.photoId === id) || (sl.images || []).some((f) => f.photoId === id) || sl.photoId === id);
    return s ? s.title : 'not placed';
  };
  for (const p of state.photos) {
    rows.push([
      p.name, p.cls.type, p.cls.loadCase || '', p.cls.component || '', p.cls.view || '',
      p.cls.detail.isDetail ? (p.cls.detail.kind || 'detail') : 'full',
      `${Math.round(p.cls.typeConf * 100)}%`,
      p.value.max ?? '', p.value.unit || '', p.value.confirmed ? 'yes' : 'no', slideOf(p.id),
    ]);
  }
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  download(new Blob(['\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }), 'fea-report-index.csv');
  toast('Index exported');
}

/* ───────────────────────────── wiring ───────────────────────────── */

function wire() {
  els.drop.onclick = () => els.fileInput.click();
  els.drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); } };
  els.fileInput.onchange = () => { addFiles(els.fileInput.files); els.fileInput.value = ''; };
  for (const ev of ['dragenter', 'dragover']) els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add('dragover'); });
  for (const ev of ['dragleave', 'drop']) els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.remove('dragover'); });
  els.drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  window.addEventListener('paste', (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (files.length) addFiles(files);
  });

  els.addMaterial.onclick = () => {
    state.settings.materialsRows.push(new Array(state.template.materials.columns.length).fill(''));
    saveSettings(); renderMaterials();
  };

  els.exportBtn.onclick = exportPptx;
  els.csvBtn.onclick = exportCsv;
  els.clearBtn.onclick = () => {
    for (const p of state.photos) URL.revokeObjectURL(p.objectUrl);
    state.photos = [];
    els.workspace.hidden = true;
    els.preview.innerHTML = '';
    els.cards.innerHTML = '';
    els.caseEditor.innerHTML = '';
    renderAll();
  };
  els.lightbox.onclick = () => { els.lightbox.hidden = true; els.lightboxImg.src = ''; };
  window.addEventListener('keydown', onKey);
}

function onKey(e) {
  if (e.key === 'Escape') { els.lightbox.hidden = true; return; }
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'select', 'textarea'].includes(tag)) return;
  if (!state.photos.length) return;

  const idx = state.selected ? state.photos.findIndex((p) => p.id === state.selected) : -1;
  const move = (d) => {
    const next = Math.min(state.photos.length - 1, Math.max(0, idx < 0 ? 0 : idx + d));
    selectAndScroll(state.photos[next].id);
  };
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
  if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }

  const current = idx >= 0 ? state.photos[idx] : null;
  if (!current) return;
  if (e.key === 'Enter') { e.preventDefault(); if (current.value.max != null) { current.value.confirmed = true; recompute(); toast(`Confirmed ${current.value.max} ${current.value.unit}`); } }
  else if (e.key === 'z') { current.override.detail = 'zoom'; recompute(); }
  else if (e.key === 'c') { current.override.detail = 'section'; recompute(); }
  else if (e.key === 'f') { current.override.detail = false; recompute(); }
  else if (e.key === 'x') { current.excluded = !current.excluded; recompute(); }
}

/* ───────────────────────────── boot ───────────────────────────── */

function cacheEls() {
  const ids = ['drop', 'fileInput', 'dropNote', 'progress', 'barFill', 'progressText', 'workspace',
    'preview', 'cards', 'gaps', 'slideMeta', 'reviewMeta', 'footStats', 'modeBadge',
    'panelBtn', 'panel', 'exportBtn', 'csvBtn', 'clearBtn', 'templateReset', 'templateDownload',
    'templateUpload', 'legacyBtn', 'toast', 'lightbox', 'lightboxImg', 'cardTpl', 'loadCases',
    'materialsTable', 'addMaterial', 'allowableHint', 'caseEditor'];
  for (const id of ids) els[id] = $(id);
}

async function boot() {
  cacheEls();
  loadSettings();
  await loadTemplate();
  bindMeta();
  wireTemplateButtons();
  wire();
  renderMaterials();
  els.modeBadge.textContent = 'on-device · no upload';
  els.modeBadge.classList.add('badge-live');
}
boot();
