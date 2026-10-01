/* Photo Desk — offline analysis engine.
 * Pure functions: no DOM, no network. Reads raw pixels, returns the same
 * result shape the vision-API path returns, so the UI has one code path.
 */

export const DEFAULT_CATEGORIES = [
  'person', 'food', 'product', 'pet', 'nature', 'travel', 'beach',
  'city', 'screenshot', 'document', 'art', 'event',
];

export const DEFAULT_TONES = ['Scroll-stopper', 'Short & punchy', 'Funny', 'Professional', 'Question'];

/* ------------------------------------------------------------------ *
 * Measurement
 * ------------------------------------------------------------------ */

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** data: RGBA Uint8ClampedArray (already downscaled by the caller). */
export function measureImageData(data, width, height) {
  const px = width * height;
  const luma = new Float32Array(px);
  let sum = 0, sumSq = 0, satSum = 0, skin = 0, white = 0, black = 0;
  let rs = 0, gs = 0, bs = 0;
  let rg = 0, yb = 0, rgSq = 0, ybSq = 0, rgYb = 0;
  const buckets = new Map();

  for (let i = 0, p = 0; i < px; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luma[i] = y;
    sum += y; sumSq += y * y;

    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    satSum += max === 0 ? 0 : (max - min) / max;
    rs += r; gs += g; bs += b;

    // Hasler-Süsstrunk colorfulness
    const rgv = r - g, ybv = 0.5 * (r + g) - b;
    rg += rgv; yb += ybv; rgSq += rgv * rgv; ybSq += ybv * ybv; rgYb += rgv * ybv;

    if (max > 235 && max - min < 25) white++;
    if (max < 40) black++;
    if (r > 95 && g > 40 && b > 20 && max - min > 15 && Math.abs(r - g) > 15 && r > g && r > b) skin++;

    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = { n: 0, r: 0, g: 0, b: 0 }));
    bucket.n++; bucket.r += r; bucket.g += g; bucket.b += b;
  }

  const mean = sum / px;
  const contrast = Math.sqrt(Math.max(0, sumSq / px - mean * mean));
  const cMean = rg / px, cMean2 = yb / px;
  const colorfulness = Math.sqrt(
    Math.sqrt(rgSq / px - cMean * cMean) ** 2 + Math.sqrt(ybSq / px - cMean2 * cMean2) ** 2
  ) + 0.3 * Math.sqrt(cMean * cMean + cMean2 * cMean2);

  // Laplacian variance on the luma grid = classic blur detector.
  let lapSum = 0, lapSumSq = 0, lapN = 0, edges = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = 4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - width] - luma[i + width];
      lapSum += lap; lapSumSq += lap * lap; lapN++;
      const gx = luma[i + 1] - luma[i - 1];
      const gy = luma[i + width] - luma[i - width];
      if (Math.abs(gx) + Math.abs(gy) > 60) edges++;
    }
  }
  const sharpness = lapN ? Math.sqrt(Math.max(0, lapSumSq / lapN - (lapSum / lapN) ** 2)) : 0;

  const dominant = [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 12)
    .map((b) => ({
      n: b.n,
      hex: rgbToHex(b.r / b.n, b.g / b.n, b.b / b.n),
      r: b.r / b.n, g: b.g / b.n, b: b.b / b.n,
    }));

  const deduped = [];
  for (const c of dominant) {
    if (deduped.every((d) => colorDistance(d, c) > 40)) deduped.push(c);
    if (deduped.length === 5) break;
  }

  const rsMean = rs / px, gsMean = gs / px, bsMean = bs / px;
  const total = rsMean + gsMean + bsMean || 1;

  return {
    width, height,
    megapixels: round((width * height) / 1e6, 2),
    aspect: round(width / height, 3),
    orientation: width > height * 1.05 ? 'landscape' : height > width * 1.05 ? 'portrait' : 'square',
    brightness: Math.round(mean),
    contrast: Math.round(contrast),
    saturation: round(satSum / px, 3),
    colorfulness: Math.round(colorfulness),
    sharpness: Math.round(sharpness),
    edgeDensity: round(edges / (lapN || 1), 3),
    skinRatio: round(skin / px, 3),
    whiteRatio: round(white / px, 3),
    blackRatio: round(black / px, 3),
    warmth: round((rsMean - bsMean) / (total / 3), 3),
    greenness: round((gsMean - (rsMean + bsMean) / 2) / (total / 3), 3),
    dominantColors: deduped.map((c) => c.hex),
  };
}

function colorDistance(a, b) {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}
function rgbToHex(r, g, b) {
  const h = (n) => Math.round(n).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
const round = (n, d = 0) => Number(n.toFixed(d));

/* ------------------------------------------------------------------ *
 * Judgement: what is wrong with this photo, and how to fix it
 * ------------------------------------------------------------------ */

export function gradeMetrics(m) {
  const issues = [];
  const tips = [];

  if (m.sharpness < 30) {
    issues.push('Soft or blurry — the details are not crisp');
    tips.push('Hold steadier, tap to focus on the subject, or shoot in brighter light');
  } else if (m.sharpness < 90) {
    tips.push('Reasonably sharp; a tripod or burst mode would make it crisper');
  }
  if (m.brightness < 60) {
    issues.push('Underexposed — the photo is quite dark');
    tips.push('Lift shadows in edit or shoot closer to a window');
  } else if (m.brightness > 205) {
    issues.push('Overexposed — highlights are blown out');
    tips.push('Drop exposure by a stop, or move out of direct light');
  }
  if (m.contrast < 28) {
    issues.push('Flat and low-contrast — it will look dull in a feed');
    tips.push('Add contrast, or wait for directional light');
  }
  if (m.saturation < 0.1 && m.whiteRatio < 0.4) {
    issues.push('Almost no color — reads as washed out');
    tips.push('A touch of saturation or a warmer white balance would help');
  }
  if (m.megapixels < 0.9) {
    issues.push(`Low resolution (${m.megapixels}MP) — printing or cropping will show pixels`);
    tips.push('Export from the original file if you have it');
  }
  if (m.aspect > 2.2 || m.aspect < 0.45) {
    issues.push(`Extreme ${m.orientation} crop (${m.aspect}:1)`);
    tips.push('Check how it sits in a square or 4:5 feed crop');
  }
  if (m.edgeDensity > 0.3) {
    issues.push('Very busy frame — lots of competing detail');
    tips.push('Crop tighter on one subject so the eye knows where to go');
  }

  const flags = [];
  if (m.skinRatio > 0.12) flags.push(`Possible person or face in frame (${Math.round(m.skinRatio * 100)}% skin tones — check before posting publicly)`);
  if (m.whiteRatio > 0.45 && m.saturation < 0.15) flags.push('Looks like a document, screenshot or white background — check for private text');
  if (m.whiteRatio > 0.3 && m.edgeDensity > 0.2) flags.push('Text-like content detected — verify nothing sensitive is readable');

  let score = 100;
  score -= Math.min(30, Math.max(0, (30 - m.sharpness) * 0.6));
  score -= Math.abs(m.brightness - 135) * 0.18;
  score -= Math.max(0, (28 - m.contrast) * 0.5);
  score -= Math.max(0, 0.9 - m.megapixels) * 8;
  score -= m.edgeDensity > 0.3 ? 5 : 0;
  score = Math.max(5, Math.min(100, Math.round(score)));

  return { score, issues, tips, flags };
}

/* ------------------------------------------------------------------ *
 * Vibes: the language layer the offline mode can honestly support
 * ------------------------------------------------------------------ */

export function describeVibe(m) {
  const words = [];
  const tags = [];

  if (m.brightness >= 185) { words.push('bright and airy'); tags.push('bright'); }
  else if (m.brightness <= 70) { words.push('dark and moody'); tags.push('moody'); }
  if (m.saturation >= 0.5) { words.push('vivid and punchy'); tags.push('vivid'); }
  else if (m.saturation <= 0.16) { words.push('muted and minimal'); tags.push('minimal'); }
  if (m.warmth >= 0.12) { words.push('warm and golden'); tags.push('warmtones'); }
  else if (m.warmth <= -0.12) { words.push('cool and blue-toned'); tags.push('cooltones'); }
  if (m.greenness >= 0.08) { words.push('outdoorsy and green'); tags.push('nature'); }
  if (m.contrast >= 70) { words.push('high-contrast'); tags.push('contrast'); }
  if (m.sharpness >= 140) tags.push('sharp');
  tags.push(m.orientation === 'portrait' ? 'portrait' : m.orientation === 'landscape' ? 'landscape' : 'square');

  if (!words.length) words.push('clean and neutral');
  return {
    phrase: words.join(', '),
    tags,
    short: tags.slice(0, 3).map((t) => `#${t}`).join(' '),
  };
}

const KNOWN_SCENES = [
  { test: (m) => m.whiteRatio > 0.45 && m.saturation < 0.15, label: 'document or screenshot', tags: ['document'] },
  { test: (m) => m.skinRatio > 0.15, label: 'portrait or person', tags: ['people'] },
  { test: (m) => m.greenness > 0.1 && m.brightness > 90, label: 'outdoor nature', tags: ['outdoors'] },
  { test: (m) => m.warmth > 0.15 && m.brightness > 150, label: 'golden-hour scene', tags: ['goldenhour'] },
  { test: (m) => m.saturation > 0.45 && m.edgeDensity > 0.15, label: 'colorful product or food shot', tags: ['product'] },
  { test: (m) => m.brightness < 70, label: 'low-light scene', tags: ['lowlight'] },
];

export function guessScene(m) {
  return KNOWN_SCENES.find((s) => s.test(m)) || { label: 'general photo', tags: [] };
}

/* ------------------------------------------------------------------ *
 * Writing: headlines, caption, alt text
 * ------------------------------------------------------------------ */

const TITLE = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

const HEADLINE_TEMPLATES = {
  'Scroll-stopper': (t, v) => `${TITLE(t)} season — and this frame is the whole ${v.word}`,
  'Short & punchy': (t, v) => `${TITLE(t)}. ${TITLE(v.word)}. Done.`,
  'Funny': (t, v) => `Nobody warned me a ${t} could go this hard ${v.emoji}`,
  'Professional': (t, v) => `A ${v.adj} look at ${t}: composition notes and what works`,
  'Question': (t) => `Is this the most ${'underrated'} ${t} you will see today?`,
  'Story': (t, v) => `The ${v.adj} ${t} that almost did not make the cut`,
  'How-to': (t, v) => `How to shoot a ${t} like this: light, angle, ${v.word}`,
  'Bold claim': (t) => `The only ${t} shot worth studying this week`,
};

function vibeWords(m, vibe) {
  const emoji = m.brightness > 175 ? '🌞' : m.greenness > 0.08 ? '🌿' : m.warmth > 0.12 ? '🔥' : m.brightness < 70 ? '🌙' : '✨';
  return {
    emoji,
    word: m.brightness > 175 ? 'light' : m.warmth > 0.12 ? 'glow' : m.brightness < 70 ? 'mood' : 'energy',
    adj: vibe.phrase.split(',')[0].trim(),
  };
}

export function writeHeadlines({ subject, metrics, vibe, tones, count = 5 }) {
  const t = (subject || 'photo').toLowerCase().replace(/^(a|an|the)\s+/, '');
  const v = vibeWords(metrics, vibe);
  const out = [];
  for (const tone of tones) {
    const fn = HEADLINE_TEMPLATES[tone];
    if (!fn) continue;
    out.push({ tone, text: fn(t, v) });
    if (out.length >= count) break;
  }
  while (out.length < count) {
    const tone = `Angle ${out.length + 1}`;
    out.push({ tone, text: `${TITLE(t)} — ${vibe.phrase}` });
  }
  return out;
}

export function writeCaption({ subject, vibe, metrics, category }) {
  const bits = [
    `${TITLE(subject || category || 'Photo')}.`,
    `Shot ${metrics.orientation}, ${metrics.brightness >= 175 ? 'bright' : metrics.brightness <= 70 ? 'low' : 'even'} light,`,
    `${vibe.phrase}.`,
  ];
  return bits.join(' ');
}

export function writeAltText({ subject, vibe, metrics, tags = [] }) {
  const colors = tags.slice(0, 2).join(' and ');
  return `${TITLE(subject || 'Photo')} — ${vibe.phrase} ${metrics.orientation} image${colors ? `, ${colors}` : ''}.`;
}

export function buildHashtags({ category, vibe, scene, metrics }) {
  const base = [category, ...(scene.tags || []), ...vibe.tags, metrics.orientation]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ''));
  return [...new Set(base)].filter((s) => s && s.length > 2).slice(0, 8).map((s) => `#${s}`);
}

/* ------------------------------------------------------------------ *
 * The offline pipeline: same output shape as the API path
 * ------------------------------------------------------------------ */

export function analyzeOffline({ metrics, categories = [], tones = DEFAULT_TONES, count = 5, clip = null }) {
  const vibe = describeVibe(metrics);
  const scene = guessScene(metrics);
  const grade = gradeMetrics(metrics);

  let category, subject, confidence, source;
  if (clip && clip.label) {
    category = clip.label;
    subject = clip.label;
    confidence = Math.round(clamp01(clip.score) * 100);
    source = 'on-device model';
  } else {
    category = categories[0] || 'photo';
    subject = scene.label;
    confidence = 35;
    source = 'colour and sharpness heuristics';
  }

  const tags = [...new Set([category, ...scene.tags, ...vibe.tags])].slice(0, 8);

  return {
    category: TITLE(String(category)),
    subject: TITLE(String(subject)),
    confidence,
    source,
    tags,
    headlines: writeHeadlines({ subject, metrics, vibe, tones, count }),
    caption: writeCaption({ subject, vibe, metrics, category }),
    alt_text: writeAltText({ subject, vibe, metrics, tags: scene.tags }),
    hashtags: buildHashtags({ category, vibe, scene, metrics }),
    review: {
      score: grade.score,
      summary: `Quality ${grade.score}/100 — ${vibe.phrase}; ${metrics.megapixels}MP ${metrics.orientation}.`,
      issues: grade.issues,
      tips: grade.tips,
    },
    flags: grade.flags,
    metrics,
    offline: true,
  };
}

/** Normalises whatever a vision model returned into the shape the UI expects. */
export function normalizeResult(raw, { metrics = null, tones = DEFAULT_TONES, count = 5 } = {}) {
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);
  let headlines = Array.isArray(raw.headlines) ? raw.headlines : [];
  headlines = headlines
    .map((h) => (typeof h === 'string' ? { tone: 'Headline', text: h } : { tone: String(h.tone || 'Headline'), text: String(h.text || h.headline || '') }))
    .filter((h) => h.text.trim())
    .slice(0, count);
  while (headlines.length < Math.min(count, tones.length)) {
    headlines.push({ tone: tones[headlines.length], text: raw.subject ? `${raw.subject}` : 'Untitled' });
  }
  return {
    category: String(raw.category || 'Unclassified'),
    subject: String(raw.subject || raw.description || ''),
    confidence: Number.isFinite(+raw.confidence) ? Math.round(+raw.confidence) : 80,
    source: String(raw.source || 'vision model'),
    tags: arr(raw.tags).slice(0, 10),
    headlines,
    caption: String(raw.caption || ''),
    alt_text: String(raw.alt_text || raw.altText || ''),
    hashtags: arr(raw.hashtags),
    review: {
      score: Number.isFinite(+raw?.review?.score) ? Math.round(+raw.review.score) : null,
      summary: String(raw?.review?.summary || ''),
      issues: arr(raw?.review?.issues),
      tips: arr(raw?.review?.tips),
    },
    flags: arr(raw.flags),
    metrics,
    offline: false,
  };
}
