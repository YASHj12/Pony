/* Ansys Report Builder — application shell.
 * Intake → measure → classify → group → assemble → review → export.
 */

import { analyzeImageData, detectLegend, dHash, inferKind } from './cv.js';
import { RESULT_TYPES, classifyAll, groupPhotos, findDuplicates, FAMILY_LABEL } from './classify.js';
import { buildDeck, coverageReport } from './report.js';
import { buildPptx } from './pptx.js';

/* ───────────────────────────── state ───────────────────────────── */

const state = {
  photos: [],
  groups: [],
  deck: null,
  gaps: [],
  duplicates: [],
  selected: null,
  template: null,
  settings: {
    meta: { project: '', part: '', client: '', author: '', revision: 'A', date: new Date().toISOString().slice(0, 10), allowable: '', software: 'Ansys Mechanical' },
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
    try {
      const photo = await readPhoto(file);
      state.photos.push(photo);
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
  const ctx = canvas.getContext('2d');
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

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
    value: { max: null, unit: guessUnit(signals, file.name), confirmed: false },
    excluded: false,
  };
}

function guessUnit(signals, name) {
  if (/stress|von|mises|mpa|seqv|pressure/i.test(name)) return 'MPa';
  if (/deform|displacement|mm/i.test(name)) return 'mm';
  if (/temp|thermal|°c/i.test(name)) return '°C';
  if (/freq|hz|modal/i.test(name)) return 'Hz';
  return signals.spectrumBands >= 4 ? 'MPa' : '';
}

function cropLegend(canvas, rect) {
  const sx = Math.max(0, Math.round(rect.x * canvas.width));
  const sy = Math.max(0, Math.round(rect.y * canvas.height));
  const sw = Math.max(4, Math.round(rect.w * canvas.width));
  const sh = Math.max(4, Math.round(rect.h * canvas.height));
  const out = document.createElement('canvas');
  out.width = Math.min(sw, 60);
  out.height = Math.min(sh, 200);
  out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

/* ───────────────────────────── pipeline ───────────────────────────── */

function recompute() {
  applyMetaToTemplate();
  classifyAll(state.photos, {});
  for (const p of state.photos) applyOverride(p);
  state.duplicates = findDuplicates(state.photos);
  state.groups = groupPhotos(state.photos, state.template.detailRules);
  state.deck = buildDeck({ photos: state.photos, template: state.template, meta: { ...state.settings.meta, groups: state.groups } });
  state.gaps = coverageReport(state.groups, state.photos);
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
  if (photo.excluded) photo.cls.excluded = true;
}

function familyKey(type) {
  const map = {
    'Equivalent (von Mises) stress': 'stress', 'Maximum principal stress': 'stress',
    'Minimum principal stress': 'stress', 'Maximum shear stress': 'stress', 'Stress (unspecified)': 'stress',
    'Total deformation': 'deformation', 'Directional deformation': 'deformation',
    'Equivalent elastic strain': 'strain', 'Safety factor': 'factor',
    'Contact pressure': 'contact', 'Contact status': 'contact', 'Reaction force': 'force',
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
  if (!photo.cls.loadCase && ['stress', 'deformation', 'strain', 'factor', 'contact', 'thermal', 'fatigue', 'modal', 'cfd'].includes(photo.cls.family)) reasons.push('no load case');
  const isMain = state.groups.some((g) => g.main.id === photo.id);
  if (isMain && ['stress', 'deformation', 'strain', 'factor', 'contact'].includes(photo.cls.family) && photo.value.max == null) {
    reasons.push('peak value not entered');
  }
  if (photo.value.max != null && !photo.value.confirmed) reasons.push('value not confirmed');
  return reasons;
}

/* ───────────────────────────── rendering ───────────────────────────── */

function renderAll() {
  els.slideMeta.textContent = `${state.deck.slides.length} slides`;
  els.reviewMeta.textContent = reviewQueue().length ? `${reviewQueue().length} need attention` : 'nothing waiting';
  els.footStats.textContent = `${state.photos.filter((p) => !p.excluded).length} images · ${state.groups.length} result groups`;
  els.exportBtn.disabled = !state.photos.some((p) => !p.excluded);
  els.csvBtn.disabled = els.exportBtn.disabled;
  els.clearBtn.disabled = !state.photos.length;
  renderPreview();
  renderGaps();
  renderQueue();
  renderCards();
  paintLoadCaseList();
}

function renderPreview() {
  els.preview.innerHTML = '';
  for (const slide of state.deck.slides) {
    els.preview.append(renderSlide(slide));
  }
}

function renderSlide(slide) {
  const el = document.createElement('article');
  el.className = `slide ${slide.kind}`;
  if (slide.id === state.selectedSlide) el.classList.add('is-target');

  if (slide.kind === 'cover') {
    el.innerHTML = `<div class="s-accent"></div>
      <div class="s-title">${esc(slide.title)}</div>
      ${slide.subtitle ? `<div class="s-sub">${esc(slide.subtitle)}</div>` : ''}
      <div class="s-fields">${(slide.fields || []).map(([k, v]) => `<div><b>${esc(k)}</b>${esc(v)}</div>`).join('')}</div>`;
    return el;
  }

  el.innerHTML = `<div class="s-title">${esc(slide.title)}</div><div class="s-rule"></div>`;

  if (slide.kind === 'bullets') {
    el.innerHTML += `<ul class="s-bullets">${(slide.bullets || []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`;
    return el;
  }

  if (slide.kind === 'table') {
    const t = slide.table || { columns: [], rows: [] };
    el.innerHTML += `<table><thead><tr>${t.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${t.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>
      ${slide.note ? `<div class="s-note">${esc(slide.note)}</div>` : ''}`;
    return el;
  }

  if (slide.kind === 'figures') {
    const imgs = slide.images || [];
    el.innerHTML += `<div class="s-figures ${imgs.length > 1 ? 'two' : ''}">${imgs.map((im) => {
      const p = byId(im.photoId);
      return p ? `<figure><img src="${p.objectUrl}" alt="" /><figcaption>${esc(im.label || '')}</figcaption></figure>` : '';
    }).join('')}</div>`;
    if (slide.bullets && slide.bullets.length) {
      el.innerHTML += `<ul class="s-bullets">${slide.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`;
    }
    return el;
  }

  if (slide.kind === 'results') {
    const main = (slide.images || []).find((i) => i.role === 'main');
    const insets = (slide.images || []).filter((i) => i.role === 'inset');
    const mainP = main ? byId(main.photoId) : null;
    el.innerHTML += `<div class="s-results">
      <div class="main">${mainP ? `<img src="${mainP.objectUrl}" alt="" />` : ''}</div>
      <div class="insets">${insets.map((im) => {
        const p = byId(im.photoId);
        return p ? `<figure><img src="${p.objectUrl}" alt="" /><figcaption>${esc(im.label || '')}</figcaption></figure>` : '';
      }).join('')}</div>
    </div>
    ${slide.caption ? `<div class="s-caption ${slide.captionBlocked && slide.captionBlocked.length ? 'blocked' : ''}">${esc(slide.caption)}</div>` : ''}
    ${slide.issues && slide.issues.length ? `<div class="s-note">${esc(slide.issues.map((i) => i.text).join(' '))}</div>` : ''}`;
    return el;
  }

  if (slide.kind === 'appendix') {
    const imgs = slide.images || [];
    if (!imgs.length) { el.innerHTML += `<div class="s-note">Nothing left over — every image was placed.</div>`; return el; }
    el.innerHTML += `<div class="s-grid">${imgs.map((im) => {
      const p = byId(im.photoId);
      return p ? `<figure><img src="${p.objectUrl}" alt="" /><figcaption>${esc(im.label || '')}</figcaption></figure>` : '';
    }).join('')}</div>`;
    return el;
  }

  return el;
}

function renderGaps() {
  const items = [];
  const queue = reviewQueue();
  if (!state.photos.length) { els.gaps.innerHTML = ''; return; }

  for (const g of state.gaps) {
    items.push(`<div class="gap ${g.level || 'info'}">${esc(g.text)}</div>`);
  }
  if (state.duplicates.length) {
    items.push(`<div class="gap warn">${state.duplicates.length} near-duplicate pair${state.duplicates.length > 1 ? 's' : ''} detected — check you have not placed the same view twice.</div>`);
  }
  const unconfirmed = state.photos.filter((p) => !p.excluded && p.value.max != null && !p.value.confirmed).length;
  if (unconfirmed) {
    items.push(`<div class="gap bad">${unconfirmed} value${unconfirmed > 1 ? 's' : ''} typed but not confirmed — export will not quote ${unconfirmed > 1 ? 'them' : 'it'} until you press Confirm.</div>`);
  }
  if (!queue.length && !items.some((i) => /gap bad/.test(i))) {
    items.unshift('<div class="gap ok">Every image is classified with high confidence and every peak value is confirmed.</div>');
  }
  els.gaps.innerHTML = items.join('');
}

function reviewQueue() {
  const out = [];
  for (const p of state.photos) {
    if (p.excluded) continue;
    const reasons = needsReview(p);
    if (reasons.length) out.push({ photo: p, reasons });
  }
  return out;
}

function renderQueue() {
  const queue = reviewQueue();
  if (!queue.length) { els.queue.innerHTML = ''; return; }
  els.queue.innerHTML = queue.map(({ photo, reasons }) => `
    <div class="item" data-id="${esc(photo.id)}">
      <span class="who">${esc(photo.name)}</span>
      <span class="why">${esc(reasons.join(' · '))}</span>
    </div>`).join('');
  els.queue.querySelectorAll('.item').forEach((node) => {
    node.onclick = () => selectAndScroll(node.dataset.id);
  });
}

function paintLoadCaseList() {
  const cases = [...new Set(state.photos.map((p) => p.cls.loadCase).filter(Boolean))];
  els.loadCases.innerHTML = cases.map((c) => `<option value="${esc(c)}"></option>`).join('');
}

function renderCards() {
  const dupIds = new Set(state.duplicates.flatMap((d) => [d.a, d.b]));
  els.cards.innerHTML = '';
  for (const photo of state.photos) {
    const node = els.cardTpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = photo.id;
    if (photo.id === state.selected) node.classList.add('selected');
    if (photo.excluded) node.classList.add('excluded');

    node.querySelector('.thumb').src = photo.objectUrl;
    node.querySelector('.thumb').onclick = () => { els.lightboxImg.src = photo.objectUrl; els.lightbox.hidden = false; };
    node.querySelector('.name').textContent = photo.name;
    node.querySelector('.tag-kind').textContent = FAMILY_LABEL[photo.cls.family] || photo.cls.type;
    const detailTag = node.querySelector('.tag-detail');
    if (photo.cls.detail.isDetail) {
      detailTag.hidden = false;
      detailTag.textContent = photo.cls.detail.kind === 'section' ? 'cut section' : 'zoomed';
    }
    node.querySelector('.tag-dup').hidden = !dupIds.has(photo.id);
    const legendTag = node.querySelector('.tag-legend');
    legendTag.hidden = !photo.cv.legend.found;

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
    const legendText = node.querySelector('.legendtext');
    legendText.innerHTML = photo.cv.legend.found
      ? `legend found on the ${esc(photo.cv.legend.side)} — read the value off this crop and type it above.<br>
         <span class="${photo.value.confirmed ? 'confirmed' : 'unconfirmed'}">${photo.value.confirmed ? 'value confirmed' : 'not confirmed'}</span>`
      : `no colourbar detected — if it is cropped out of the screenshot, enter the value from Ansys. <span class="${photo.value.confirmed ? 'confirmed' : 'unconfirmed'}">${photo.value.confirmed ? 'value confirmed' : 'not confirmed'}</span>`;

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
      if (['INPUT', 'SELECT', 'BUTTON', 'IMG'].includes(e.target.tagName)) return;
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
  if (node) {
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.focus({ preventScroll: true });
  }
}

/* ───────────────────────────── meta + template ───────────────────────────── */

function applyMetaToTemplate() {
  const m = state.settings.meta;
  state.template.meta = { ...state.template.meta, ...m };
}

function bindMeta() {
  const map = {
    mProject: 'project', mPart: 'part', mClient: 'client', mAuthor: 'author',
    mRevision: 'revision', mDate: 'date', mAllowable: 'allowable', mSoftware: 'software',
  };
  for (const [id, key] of Object.entries(map)) {
    const el = $(id);
    if (!el) continue;
    el.value = state.settings.meta[key] ?? '';
    el.addEventListener('change', () => {
      state.settings.meta[key] = el.value;
      try { localStorage.setItem('fea-report-meta', JSON.stringify(state.settings.meta)); } catch { /* ignore */ }
      if (state.photos.length) recompute();
    });
  }
  try {
    const saved = JSON.parse(localStorage.getItem('fea-report-meta') || 'null');
    if (saved) {
      Object.assign(state.settings.meta, saved);
      for (const [id, key] of Object.entries(map)) if ($(id)) $(id).value = state.settings.meta[key] ?? '';
    }
  } catch { /* ignore */ }
}

async function loadTemplate() {
  const saved = (() => { try { return JSON.parse(localStorage.getItem('fea-report-template') || 'null'); } catch { return null; } })();
  if (saved) { state.template = saved; return; }
  const res = await fetch('/templates/fea-report.json');
  state.template = await res.json();
}

function wireTemplateButtons() {
  els.templateBtn.onclick = () => {
    els.panel.hidden = !els.panel.hidden;
    els.templateBtn.setAttribute('aria-expanded', String(!els.panel.hidden));
  };
  els.templateReset.onclick = async () => {
    try {
      const res = await fetch('/templates/fea-report.json');
      state.template = await res.json();
      localStorage.removeItem('fea-report-template');
      recompute();
      toast('Template reset to the default');
    } catch { toast('Could not reload the default template'); }
  };
  els.templateDownload.onclick = () => {
    const blob = new Blob([JSON.stringify(state.template, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'fea-report-template.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  };
  els.templateUpload.onchange = async () => {
    const file = els.templateUpload.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed.sections) throw new Error('no "sections" array in that file');
      state.template = parsed;
      localStorage.setItem('fea-report-template', JSON.stringify(parsed));
      recompute();
      toast('Template loaded');
    } catch (err) {
      toast(`Template rejected: ${err.message}`);
    }
    els.templateUpload.value = '';
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
    const canvas = drawTo(p.img, 1400);
    const url = canvas.toDataURL('image/jpeg', 0.9);
    media[p.id] = { bytes: base64ToBytes(url.split(',')[1]), ext: 'jpg', width: canvas.width, height: canvas.height };
  }

  els.progressText.textContent = 'Writing the presentation…';
  await new Promise((r) => requestAnimationFrame(r));

  try {
    const { bytes } = buildPptx({
      deck: state.deck,
      media,
      meta: state.settings.meta,
      theme: state.template.theme,
      size: state.template.slideSize,
    });
    const name = `${(state.settings.meta.project || 'FEA report').replace(/[^\w\-. ]+/g, '').trim() || 'FEA report'}-rev${state.settings.meta.revision || 'A'}.pptx`;
    download(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), name);
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
  const rows = [['file', 'result_type', 'load_case', 'component', 'view', 'detail_view', 'confidence', 'peak_value', 'unit', 'value_confirmed', 'slide']];
  const slideOf = (id) => {
    const s = (state.deck.slides || []).find((sl) => (sl.images || []).some((im) => im.photoId === id));
    return s ? s.title : 'appendix';
  };
  for (const p of state.photos) {
    rows.push([
      p.name, p.cls.type, p.cls.loadCase || '', p.cls.component || '', p.cls.view || '',
      p.cls.detail.isDetail ? (p.cls.detail.kind || 'detail') : 'full',
      String(Math.round(p.cls.typeConf * 100)) + '%',
      p.value.max ?? '', p.value.unit || '', p.value.confirmed ? 'yes' : 'no', slideOf(p.id),
    ]);
  }
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = rows.map((r) => r.map(cell).join(',')).join('\r\n');
  download(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }), 'fea-report-index.csv');
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

  els.exportBtn.onclick = exportPptx;
  els.csvBtn.onclick = exportCsv;
  els.clearBtn.onclick = () => {
    for (const p of state.photos) URL.revokeObjectURL(p.objectUrl);
    state.photos = [];
    state.groups = [];
    state.deck = null;
    els.workspace.hidden = true;
    els.preview.innerHTML = '';
    els.cards.innerHTML = '';
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
  const move = (delta) => {
    const next = Math.min(state.photos.length - 1, Math.max(0, idx < 0 ? 0 : idx + delta));
    selectAndScroll(state.photos[next].id);
  };

  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }

  const current = idx >= 0 ? state.photos[idx] : null;
  if (!current) return;
  if (e.key === 'Enter') { e.preventDefault(); if (current.value.max != null) { current.value.confirmed = true; recompute(); } }
  else if (e.key === 'z') { current.override.detail = 'zoom'; recompute(); }
  else if (e.key === 'c') { current.override.detail = 'section'; recompute(); }
  else if (e.key === 'f') { current.override.detail = false; recompute(); }
  else if (e.key === 'x') { current.excluded = !current.excluded; recompute(); }
}

/* ───────────────────────────── boot ───────────────────────────── */

function cacheEls() {
  const ids = ['drop', 'fileInput', 'dropNote', 'progress', 'barFill', 'progressText', 'workspace',
    'preview', 'queue', 'cards', 'gaps', 'slideMeta', 'reviewMeta', 'footStats', 'modeBadge',
    'templateBtn', 'panel', 'exportBtn', 'csvBtn', 'clearBtn', 'templateReset', 'templateDownload',
    'templateUpload', 'toast', 'lightbox', 'lightboxImg', 'cardTpl', 'loadCases'];
  for (const id of ids) els[id] = $(id);
}

async function boot() {
  cacheEls();
  bindMeta();
  wireTemplateButtons();
  wire();
  await loadTemplate();
  applyMetaToTemplate();
  els.modeBadge.textContent = 'on-device · no upload';
  els.modeBadge.classList.add('badge-live');
}
boot();
