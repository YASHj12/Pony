/* Photo Desk — front end.
 * One pipeline per photo: decode → measure → (classify) → write → render.
 */

import {
  DEFAULT_CATEGORIES, DEFAULT_TONES, measureImageData, analyzeOffline, normalizeResult,
} from './analyze.js';

/* ────────────────────────────── state ────────────────────────────── */

const STORE_KEY = 'photo-desk-settings-v1';
const ALL_TONES = ['Scroll-stopper', 'Short & punchy', 'Funny', 'Professional', 'Question', 'Story', 'How-to', 'Bold claim'];

const DEFAULTS = {
  provider: 'auto', apiKey: '', model: '', goal: '',
  categories: DEFAULT_CATEGORIES.join(', '),
  count: 5, tones: [...DEFAULT_TONES],
  clip: false, clipModel: 'Xenova/clip-vit-base-patch32',
};

let settings = { ...DEFAULTS, ...readStore() };
let serverStatus = { envProvider: null, providers: [], tones: DEFAULT_TONES };
let clip = { classifier: null, model: null, loading: false, failed: false };
let queue = [];
let processing = false;
let cancelled = false;
const photos = [];

function readStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { return {}; }
}
function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

/* ────────────────────────────── dom ────────────────────────────── */

const $ = (sel) => document.querySelector(sel);
const els = {
  drop: $('#drop'), fileInput: $('#fileInput'), dropNote: $('#dropNote'),
  settings: $('#settings'), settingsBtn: $('#settingsBtn'),
  provider: $('#provider'), apiKey: $('#apiKey'), model: $('#model'), goal: $('#goal'),
  categories: $('#categories'), count: $('#count'), tones: $('#tones'),
  clipToggle: $('#clipToggle'), clipNote: $('#clipNote'), clipControls: $('#clipControls'),
  clipModel: $('#clipModel'), clipLoadBtn: $('#clipLoadBtn'), clipStatus: $('#clipStatus'),
  modeBadge: $('#modeBadge'), exportBtn: $('#exportBtn'), clearBtn: $('#clearBtn'),
  progressWrap: $('#progressWrap'), progressBar: $('#progressBar'), progressText: $('#progressText'), cancelBtn: $('#cancelBtn'),
  results: $('#results'), grid: $('#grid'), summary: $('#summary'), empty: $('#empty'),
  footStats: $('#footStats'), toast: $('#toast'), lightbox: $('#lightbox'), lightboxImg: $('#lightboxImg'),
  cardTpl: $('#cardTpl'), revealKey: $('#revealKey'),
};

/* ────────────────────────────── helpers ────────────────────────────── */

function toast(msg, ms = 2200) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { els.toast.hidden = true; }, ms);
}

async function copy(text, note = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.append(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast(note);
}

const categoryList = () => settings.categories.split(',').map((s) => s.trim()).filter(Boolean);
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ────────────────────────────── settings ui ────────────────────────────── */

function paintSettings() {
  els.provider.value = settings.provider;
  els.apiKey.value = settings.apiKey;
  els.model.value = settings.model;
  els.goal.value = settings.goal;
  els.categories.value = settings.categories;
  els.count.value = settings.count;
  els.clipToggle.checked = settings.clip;
  els.clipModel.value = settings.clipModel;
  els.clipControls.hidden = !settings.clip;
  paintTones();
  paintClipStatus();
}

function paintTones() {
  els.tones.innerHTML = '';
  for (const tone of ALL_TONES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip-toggle';
    b.textContent = tone;
    b.setAttribute('aria-pressed', String(settings.tones.includes(tone)));
    b.onclick = () => {
      settings.tones = settings.tones.includes(tone)
        ? settings.tones.filter((t) => t !== tone)
        : [...settings.tones, tone];
      if (!settings.tones.length) settings.tones = [tone];
      saveStore(); paintTones();
    };
    els.tones.append(b);
  }
}

function currentMode() {
  const chosen = settings.provider !== 'auto'
    ? serverStatus.providers.find((p) => p.id === settings.provider)
    : null;
  if (settings.apiKey) {
    const meta = chosen || serverStatus.providers.find((p) => p.id === serverStatus.envProvider?.id);
    return { kind: 'api', provider: meta?.id || (settings.provider === 'auto' ? 'gemini' : settings.provider), label: meta?.label || 'API', model: settings.model || '' };
  }
  if (serverStatus.envProvider) {
    return { kind: 'api', provider: serverStatus.envProvider.id, label: serverStatus.envProvider.label, model: settings.model || serverStatus.envProvider.model };
  }
  return { kind: 'offline', label: settings.clip ? 'On-device + CLIP' : 'On-device' };
}

function paintMode() {
  const mode = currentMode();
  if (mode.kind === 'api') {
    els.modeBadge.textContent = `Smart mode · ${mode.label}${mode.model ? ` (${mode.model})` : ''}`;
    els.modeBadge.className = 'badge badge-live';
    els.dropNote.textContent = `Smart mode: each photo is sent to ${mode.label} through your own server.`;
  } else {
    els.modeBadge.textContent = settings.clip ? 'On-device mode · CLIP' : 'On-device mode';
    els.modeBadge.className = 'badge badge-muted';
    els.dropNote.textContent = 'On-device mode: nothing leaves this browser. Add a vision key for richer writing.';
  }
}

/* ────────────────────────────── on-device CLIP ────────────────────────────── */

const BUILTIN_LABELS = [
  { label: 'A person', prompt: 'a photo of a person' },
  { label: 'Food', prompt: 'a photo of food or a drink' },
  { label: 'Product', prompt: 'a product photo on a plain background' },
  { label: 'Pet', prompt: 'a photo of a pet or animal' },
  { label: 'Landscape', prompt: 'a landscape or nature scene' },
  { label: 'Beach', prompt: 'a photo of a beach or sea' },
  { label: 'City', prompt: 'a city street or buildings' },
  { label: 'Interior', prompt: 'a room inside a building' },
  { label: 'Vehicle', prompt: 'a car, bike or vehicle' },
  { label: 'Document', prompt: 'a screenshot, receipt, document or page of text' },
  { label: 'Artwork', prompt: 'a drawing, painting or illustration' },
  { label: 'Event', prompt: 'a photo of a party, wedding or gathering' },
  { label: 'Blurry photo', prompt: 'a blurry or out-of-focus photo' },
  { label: 'Nice background', prompt: 'a nice background or wallpaper texture' },
];

const clipLabels = () => {
  const seen = new Set();
  const list = [];
  for (const c of categoryList()) {
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ label: c, prompt: `a photo of a ${c}` });
  }
  for (const b of BUILTIN_LABELS) {
    if (seen.has(b.label.toLowerCase())) continue;
    seen.add(b.label.toLowerCase());
    list.push(b);
  }
  return list;
};

async function loadClip() {
  if (clip.classifier || clip.loading) return clip.classifier;
  clip.loading = true;
  clip.failed = false;
  els.clipStatus.textContent = 'loading library…';
  try {
    let mod = null;
    for (const url of [
      'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6',
      'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/+esm',
    ]) {
      try { mod = await import(/* webpackIgnore: true */ url); break; } catch { /* try next */ }
    }
    if (!mod) throw new Error('could not load the on-device model library (are you offline?)');

    mod.env.allowLocalModels = false;
    mod.env.useBrowserCache = true;

    const seen = new Map();
    clip.classifier = await mod.pipeline('zero-shot-image-classification', settings.clipModel, {
      dtype: 'int8',
      device: 'wasm',
      progress_callback: (p) => {
        if (p.status === 'progress' && p.file) {
          seen.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
          let loaded = 0, total = 0;
          for (const v of seen.values()) { loaded += v.loaded; total += v.total; }
          const pct = total ? Math.round((loaded / total) * 100) : 0;
          els.clipStatus.textContent = `downloading ${p.file} — ${pct}%`;
        }
      },
    });
    clip.model = settings.clipModel;
    els.clipStatus.textContent = 'ready ✓';
    toast('On-device classifier ready');
    return clip.classifier;
  } catch (err) {
    clip.failed = true;
    clip.classifier = null;
    els.clipStatus.textContent = `failed: ${err.message}`;
    toast('Could not load the on-device model — falling back to measurements');
    return null;
  } finally {
    clip.loading = false;
  }
}

function paintClipStatus() {
  if (clip.classifier) els.clipStatus.textContent = 'ready ✓';
  else if (clip.loading) els.clipStatus.textContent = 'loading…';
  else if (clip.failed) els.clipStatus.textContent = 'failed — check the browser console';
  else els.clipStatus.textContent = '';
}

async function classifyWithClip(canvas) {
  if (!settings.clip) return null;
  const classifier = clip.classifier || (await loadClip());
  if (!classifier) return null;
  const labels = clipLabels();
  const out = await classifier(canvas, labels.map((l) => l.prompt), { hypothesis_template: '{}', top_k: 3 });
  const list = Array.isArray(out) ? out : [out];
  const top = list[0];
  const display = (prompt) => labels.find((l) => l.prompt === prompt)?.label || prompt;
  return {
    label: display(top.label),
    score: top.score,
    alternatives: list.slice(1).map((o) => ({ label: display(o.label), score: o.score })),
  };
}

/* ────────────────────────────── image handling ────────────────────────────── */

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not decode this image (HEIC files only open in Safari)'));
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

/* ────────────────────────────── analysis ────────────────────────────── */

async function analyzePhoto(photo) {
  const mode = currentMode();
  const canvas = drawTo(photo.img, 512);
  const ctx = canvas.getContext('2d');
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  photo.metrics = measureImageData(data, width, height);

  const tones = settings.tones.length ? settings.tones : DEFAULT_TONES;
  const count = Math.max(1, Math.min(8, Number(settings.count) || 5));

  if (mode.kind === 'api') {
    const big = drawTo(photo.img, 1024).toDataURL('image/jpeg', 0.85);
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: big,
        categories: categoryList(),
        tones, count,
        goal: settings.goal || undefined,
        provider: settings.provider !== 'auto' ? settings.provider : undefined,
        apiKey: settings.apiKey || undefined,
        model: settings.model || undefined,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 409) {                       // no key after all — degrade quietly
      toast('No API key configured — used on-device analysis');
      return analyzePhotoOffline(photo, tones, count);
    }
    if (!res.ok) throw new Error(json.error || `request failed (${res.status})`);
    return normalizeResult(json.result, { metrics: photo.metrics, tones, count });
  }

  return analyzePhotoOffline(photo, tones, count);
}

async function analyzePhotoOffline(photo, tones, count) {
  let labels = null;
  try { labels = await classifyWithClip(photo.thumbCanvas); }
  catch (err) { console.warn('CLIP failed, continuing without it', err); }
  return analyzeOffline({
    metrics: photo.metrics,
    categories: categoryList(),
    tones, count,
    clip: labels,
  });
}

/* ────────────────────────────── queue ────────────────────────────── */

function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
  if (!files.length) { toast('No images in that drop'); return; }
  cancelled = false;
  for (const file of files) {
    const photo = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file, name: file.name, status: 'queued', result: null, error: null,
      objectUrl: URL.createObjectURL(file),
    };
    photos.push(photo);
    queue.push(photo);
    renderCard(photo);
  }
  els.empty.hidden = true;
  els.results.hidden = false;
  paintToolbar();
  runQueue();
}

async function runQueue() {
  if (processing) return;
  processing = true;
  while (queue.length && !cancelled) {
    const photo = queue.shift();
    const total = photos.length;
    const done = photos.filter((p) => p.status === 'done').length;
    els.progressWrap.hidden = false;
    els.progressText.textContent = `Analyzing ${photo.name} — ${done}/${total}`;
    els.progressBar.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;

    photo.status = 'working';
    renderCard(photo);
    try {
      photo.img = await loadImage(photo.objectUrl);
      photo.thumbCanvas = drawTo(photo.img, 512);
      photo.result = await analyzePhoto(photo);
      photo.status = 'done';
    } catch (err) {
      photo.status = 'error';
      photo.error = err.message || String(err);
    }
    renderCard(photo);
    paintSummary();
  }
  processing = false;
  els.progressWrap.hidden = queue.length === 0;
  if (cancelled) els.progressText.textContent = 'Stopped.';
  else els.progressBar.style.width = '100%';
  paintToolbar();
  paintSummary();
}

/* ────────────────────────────── rendering ────────────────────────────── */

function scoreClass(score) {
  if (score == null) return '';
  return score >= 75 ? 's-good' : score >= 50 ? 's-warn' : 's-bad';
}

function renderCard(photo) {
  let node = photo.el;
  if (!node) {
    node = els.cardTpl.content.firstElementChild.cloneNode(true);
    photo.el = node;
    node.querySelector('.card-remove').onclick = () => removePhoto(photo);
    node.querySelector('.thumb').onclick = () => {
      els.lightboxImg.src = photo.objectUrl;
      els.lightbox.hidden = false;
    };
    node.querySelector('.act-redo').onclick = () => {
      photo.status = 'queued';
      renderCard(photo);
      queue.push(photo);
      runQueue();
    };
    node.querySelector('.act-copy').onclick = () => copy(photoToText(photo), 'Card copied');
    node.querySelector('.act-more').onclick = () => {
      const d = node.querySelector('details');
      d.open = true;
      d.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
  }
  node.dataset.id = photo.id;
  node.querySelector('.thumb').src = photo.objectUrl;
  node.querySelector('.card-title').textContent = photo.name;

  const tags = node.querySelector('.card-tags');
  const score = node.querySelector('.chip-score');
  const source = node.querySelector('.chip-source');
  const list = node.querySelector('.headlines');
  const details = node.querySelector('.details-body');
  const actions = node.querySelector('.card-actions');

  if (photo.status === 'queued' || photo.status === 'working') {
    score.hidden = source.hidden = true;
    tags.innerHTML = '';
    list.innerHTML = `<li class="empty"><span class="spinner"></span> ${photo.status === 'queued' ? 'Waiting…' : 'Analyzing…'}</li>`;
    details.innerHTML = '';
    actions.hidden = true;
    node.classList.remove('failed');
    return;
  }
  actions.hidden = false;

  if (photo.status === 'error') {
    node.classList.add('failed');
    score.hidden = source.hidden = true;
    tags.innerHTML = '';
    list.innerHTML = `<li class="empty">Could not analyze</li>`;
    details.innerHTML = `<p class="issue">${escapeHtml(photo.error)}</p>`;
    return;
  }

  const r = photo.result;
  node.classList.remove('failed');
  score.hidden = source.hidden = false;
  score.textContent = r.review.score != null ? `${r.review.score}/100` : 'Analyzed';
  score.className = `chip chip-score ${scoreClass(r.review.score)}`;
  source.textContent = r.offline ? r.source : 'Vision model';

  tags.innerHTML = [r.category, ...(r.tags || []).slice(0, 4)]
    .map((t) => `<span class="chip-toggle">${escapeHtml(t)}</span>`).join('');

  list.innerHTML = (r.headlines || []).map((h) => `
    <li data-copy="${escapeHtml(h.text)}" title="Click to copy">
      <span class="tone">${escapeHtml(h.tone)}</span><span>${escapeHtml(h.text)}</span>
    </li>`).join('') || '<li class="empty">No headlines</li>';
  list.querySelectorAll('li[data-copy]').forEach((li) => {
    li.onclick = () => {
      copy(li.dataset.copy, 'Headline copied');
      li.classList.add('copied');
      setTimeout(() => li.classList.remove('copied'), 700);
    };
  });

  const m = r.metrics || {};
  details.innerHTML = `
    <div><h4>Subject</h4><div>${escapeHtml(r.subject || r.category)} <span class="muted small">(${r.confidence}% confidence)</span></div></div>
    ${r.caption ? `<div><h4>Caption</h4><div class="quote">${escapeHtml(r.caption)}</div></div>` : ''}
    ${r.hashtags && r.hashtags.length ? `<div><h4>Hashtags</h4><div>${escapeHtml(r.hashtags.join(' '))}</div></div>` : ''}
    ${r.alt_text ? `<div><h4>Alt text</h4><div class="quote">${escapeHtml(r.alt_text)}</div></div>` : ''}
    ${r.review.summary ? `<div><h4>Verdict</h4><div>${escapeHtml(r.review.summary)}</div></div>` : ''}
    ${r.review.issues && r.review.issues.length ? `<div><h4>Issues</h4><ul>${r.review.issues.map((i) => `<li class="issue">${escapeHtml(i)}</li>`).join('')}</ul></div>` : ''}
    ${r.review.tips && r.review.tips.length ? `<div><h4>Improvements</h4><ul>${r.review.tips.map((i) => `<li class="tip">${escapeHtml(i)}</li>`).join('')}</ul></div>` : ''}
    ${r.flags && r.flags.length ? `<div><h4>Watch out</h4>${r.flags.map((f) => `<div class="flag">${escapeHtml(f)}</div>`).join('')}</div>` : ''}
    ${m.width ? `<div><h4>Measurements</h4>
      <div class="metric-grid">
        <div class="metric"><b>${m.megapixels}MP</b><span>${m.width}×${m.height}</span></div>
        <div class="metric"><b>${m.sharpness}</b><span>sharpness</span></div>
        <div class="metric"><b>${m.brightness}</b><span>brightness</span></div>
        <div class="metric"><b>${m.contrast}</b><span>contrast</span></div>
        <div class="metric"><b>${Math.round(m.saturation * 100)}%</b><span>saturation</span></div>
        <div class="metric"><b>${m.colorfulness}</b><span>colorfulness</span></div>
      </div></div>
      <div><h4>Dominant colours</h4><div class="swatches">${(m.dominantColors || []).map((c) => `<span class="swatch" style="background:${c}" title="${c}"></span>`).join('')}</div></div>` : ''}
  `;
}

function removePhoto(photo) {
  const i = photos.findIndex((p) => p.id === photo.id);
  if (i >= 0) photos.splice(i, 1);
  queue = queue.filter((p) => p.id !== photo.id);
  URL.revokeObjectURL(photo.objectUrl);
  if (photo.el) photo.el.remove();
  if (!photos.length) { els.results.hidden = true; els.empty.hidden = false; }
  paintToolbar();
  paintSummary();
}

function paintToolbar() {
  els.exportBtn.disabled = !photos.some((p) => p.status === 'done');
  els.clearBtn.disabled = !photos.length;
}

function paintSummary() {
  const done = photos.filter((p) => p.status === 'done');
  const scores = done.map((p) => p.result.review.score).filter((n) => Number.isFinite(n));
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  const cats = {};
  for (const p of done) cats[p.result.category] = (cats[p.result.category] || 0) + 1;
  const top = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 4);

  els.summary.innerHTML = `
    <span><strong>${photos.length}</strong> photo${photos.length === 1 ? '' : 's'}</span>
    <span><strong>${done.length}</strong> analyzed</span>
    ${avg != null ? `<span>average quality <strong>${avg}/100</strong></span>` : ''}
    ${top.length ? `<span>${top.map(([c, n]) => `${escapeHtml(c)} ×${n}`).join(' · ')}</span>` : ''}
    <span>mode: <strong>${escapeHtml(currentMode().label)}</strong></span>`;
  els.footStats.textContent = done.length ? `${done.length} analyzed on this page` : '';
}

/* ────────────────────────────── export ────────────────────────────── */

function photoToText(photo) {
  const r = photo.result;
  if (!r) return photo.name;
  return [
    `FILE: ${photo.name}`,
    `CATEGORY: ${r.category} (${r.confidence}%)`,
    `SUBJECT: ${r.subject}`,
    r.review.score != null ? `QUALITY: ${r.review.score}/100 — ${r.review.summary}` : '',
    '',
    'HEADLINES:',
    ...r.headlines.map((h) => `  [${h.tone}] ${h.text}`),
    '',
    `CAPTION: ${r.caption}`,
    `ALT TEXT: ${r.alt_text}`,
    r.hashtags && r.hashtags.length ? `HASHTAGS: ${r.hashtags.join(' ')}` : '',
    r.review.issues && r.review.issues.length ? `ISSUES:\n${r.review.issues.map((i) => `  - ${i}`).join('\n')}` : '',
    r.review.tips && r.review.tips.length ? `IMPROVEMENTS:\n${r.review.tips.map((i) => `  - ${i}`).join('\n')}` : '',
    r.flags && r.flags.length ? `FLAGS:\n${r.flags.map((i) => `  - ${i}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

function exportCsv() {
  const done = photos.filter((p) => p.status === 'done');
  if (!done.length) return;
  const maxHead = Math.max(...done.map((p) => p.result.headlines.length));
  const header = ['file', 'category', 'confidence', 'quality_score', 'subject',
    ...Array.from({ length: maxHead }, (_, i) => `headline_${i + 1}`),
    'caption', 'alt_text', 'hashtags', 'tags', 'issues', 'improvements', 'flags'];

  const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  const rows = done.map((p) => {
    const r = p.result;
    const heads = Array.from({ length: maxHead }, (_, i) => (r.headlines[i] ? `${r.headlines[i].tone}: ${r.headlines[i].text}` : ''));
    return [p.name, r.category, r.confidence, r.review.score == null ? '' : r.review.score, r.subject, ...heads,
      r.caption, r.alt_text, (r.hashtags || []).join(' '), (r.tags || []).join(' '),
      (r.review.issues || []).join(' | '), (r.review.tips || []).join(' | '), (r.flags || []).join(' | ')]
      .map(cell).join(',');
  });

  const csv = [header.map(cell).join(','), ...rows].join('\r\n');
  const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `photo-desk-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`Exported ${done.length} rows`);
}

/* ────────────────────────────── wiring ────────────────────────────── */

els.drop.onclick = () => els.fileInput.click();
els.drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); } };
els.fileInput.onchange = () => { addFiles(els.fileInput.files); els.fileInput.value = ''; };

for (const ev of ['dragenter', 'dragover']) {
  els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add('dragover'); });
}
for (const ev of ['dragleave', 'drop']) {
  els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.remove('dragover'); });
}
els.drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

window.addEventListener('paste', (e) => {
  const files = [...((e.clipboardData && e.clipboardData.files) || [])];
  if (files.length) addFiles(files);
});

els.settingsBtn.onclick = () => {
  els.settings.hidden = !els.settings.hidden;
  els.settingsBtn.setAttribute('aria-expanded', String(!els.settings.hidden));
};
els.revealKey.onclick = () => {
  els.apiKey.type = els.apiKey.type === 'password' ? 'text' : 'password';
};

function bindField(el, key, transform) {
  el.addEventListener('change', () => {
    settings[key] = transform ? transform(el.value) : el.value;
    saveStore();
    paintMode();
    if (key === 'clip') {
      els.clipControls.hidden = !settings.clip;
      if (settings.clip && !clip.classifier && !clip.loading) loadClip();
    }
  });
}
bindField(els.provider, 'provider');
bindField(els.apiKey, 'apiKey', (v) => v.trim());
bindField(els.model, 'model', (v) => v.trim());
bindField(els.goal, 'goal', (v) => v.trim());
bindField(els.categories, 'categories');
bindField(els.count, 'count', (v) => Math.max(1, Math.min(8, Number(v) || 5)));
bindField(els.clipToggle, 'clip', (v) => !!v);
bindField(els.clipModel, 'clipModel');

els.clipLoadBtn.onclick = () => loadClip();
els.exportBtn.onclick = exportCsv;
els.cancelBtn.onclick = () => { cancelled = true; queue = []; els.progressWrap.hidden = true; };
els.clearBtn.onclick = () => {
  for (const p of photos) { URL.revokeObjectURL(p.objectUrl); if (p.el) p.el.remove(); }
  photos.length = 0;
  queue = [];
  els.results.hidden = true;
  els.empty.hidden = false;
  paintToolbar();
  paintSummary();
};
els.lightbox.onclick = () => { els.lightbox.hidden = true; els.lightboxImg.src = ''; };
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') els.lightbox.hidden = true; });

/* ────────────────────────────── boot ────────────────────────────── */

paintSettings();
paintMode();
paintSummary();

fetch('/api/status')
  .then((r) => r.json())
  .then((s) => {
    serverStatus = s;
    paintMode();
    if (settings.clip && !clip.classifier) loadClip();
  })
  .catch(() => paintMode());
