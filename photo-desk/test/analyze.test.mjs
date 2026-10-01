/* Runs the pure analysis engine under Node with synthetic images.
 *   node test/analyze.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'public', 'js', 'analyze.js'), 'utf8');

// Load the browser ES module as-is (it has no DOM dependencies).
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const {
  measureImageData, gradeMetrics, describeVibe, guessScene, analyzeOffline, normalizeResult,
  writeHeadlines, buildHashtags,
} = mod;

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}
function section(title) { console.log(`\n${title}`); }

/* ── synthetic images ─────────────────────────────────────────────── */
function makeImage(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

const W = 256, H = 256;

const vivid = makeImage(W, H, (x, y) => (Math.floor(x / 8) % 2 === Math.floor(y / 8) % 2 ? [240, 60, 30] : [20, 90, 220]));
const dark = makeImage(W, H, () => [12, 12, 16]);
const blown = makeImage(W, H, () => [255, 254, 250]);
const document_ = makeImage(W, H, (x, y) => (y % 16 < 3 ? [10, 10, 10] : [252, 252, 250]));
const green = makeImage(W, H, (x, y) => [40 + (x % 20), 170 + (y % 30), 60]);
const smooth = makeImage(W, H, (x) => {
  const v = Math.round((x / W) * 6) + 120;
  return [v, v, v];
});

section('measureImageData');
const m = {
  vivid: measureImageData(vivid.data, W, H),
  dark: measureImageData(dark.data, W, H),
  blown: measureImageData(blown.data, W, H),
  doc: measureImageData(document_.data, W, H),
  green: measureImageData(green.data, W, H),
  smooth: measureImageData(smooth.data, W, H),
};

check('reports dimensions', m.vivid.width === 256 && m.vivid.height === 256);
check('bright image reads as bright', m.blown.brightness > 230, `got ${m.blown.brightness}`);
check('dark image reads as dark', m.dark.brightness < 25, `got ${m.dark.brightness}`);
check('vivid image is saturated', m.vivid.saturation > 0.5, `got ${m.vivid.saturation}`);
check('greyscale image has no saturation', m.smooth.saturation < 0.02, `got ${m.smooth.saturation}`);
check('sharp checkerboard scores sharper than a flat image', m.vivid.sharpness > m.smooth.sharpness);
check('smooth gradient is flagged as soft', m.smooth.sharpness < 30, `got ${m.smooth.sharpness}`);
check('document has a high white ratio', m.doc.whiteRatio > 0.7, `got ${m.doc.whiteRatio}`);
check('green image reads green', m.green.greenness > 0.15, `got ${m.green.greenness}`);
check('dominant colours are hex swatches', /^#[0-9a-f]{6}$/i.test(m.vivid.dominantColors[0]), m.vivid.dominantColors[0]);
check('colourfulness separates vivid from grey', m.vivid.colorfulness > m.smooth.colorfulness * 4);

section('gradeMetrics');
const gDoc = gradeMetrics(m.doc);
const gDark = gradeMetrics(m.dark);
check('dark photo loses points', gDark.score < 70, `got ${gDark.score}`);
check('dark photo lists an exposure issue', gDark.issues.some((i) => /dark|underexpos/i.test(i)), JSON.stringify(gDark.issues));
check('document triggers a privacy flag', gDoc.flags.some((f) => /document|screenshot|private/i.test(f)), JSON.stringify(gDoc.flags));
check('scores stay inside 0–100', [gDoc, gDark].every((g) => g.score >= 0 && g.score <= 100));

section('vibes & scene guess');
check('bright image described as bright/airy', /bright|airy/i.test(describeVibe(m.blown).phrase), describeVibe(m.blown).phrase);
check('dark image described as moody', /moody|dark/i.test(describeVibe(m.dark).phrase), describeVibe(m.dark).phrase);
check('document guessed as document', /document|screenshot/i.test(guessScene(m.doc).label), guessScene(m.doc).label);
check('green image guessed as outdoor', /outdoor|nature/i.test(guessScene(m.green).label), guessScene(m.green).label);

section('writing');
const heads = writeHeadlines({ subject: 'coffee cup', metrics: m.vivid, vibe: describeVibe(m.vivid), tones: ['Funny', 'Professional', 'Question'], count: 3 });
check('one headline per requested tone', heads.length === 3);
check('headlines mention the subject', heads.every((h) => /coffee/i.test(h.text)), JSON.stringify(heads));
check('headlines are unique', new Set(heads.map((h) => h.text)).size === heads.length);
check('hashtags are clean', buildHashtags({ category: 'food', vibe: describeVibe(m.vivid), scene: guessScene(m.vivid), metrics: m.vivid }).every((t) => /^#[a-z0-9]{3,}$/.test(t)));

section('analyzeOffline (full result)');
const offline = analyzeOffline({ metrics: m.green, categories: ['nature', 'person'], tones: ['Funny', 'Story'], count: 2 });
check('has every field the UI reads', ['category', 'subject', 'confidence', 'tags', 'headlines', 'caption', 'alt_text', 'hashtags', 'review', 'flags', 'metrics'].every((k) => k in offline));
check('marked as offline', offline.offline === true);
check('review has score, issues, tips', typeof offline.review.score === 'number' && Array.isArray(offline.review.issues) && Array.isArray(offline.review.tips));
check('caption is a real sentence', offline.caption.length > 25 && offline.caption.endsWith('.'));

section('analyzeOffline with a CLIP label');
const withClip = analyzeOffline({ metrics: m.vivid, categories: ['food'], tones: ['Funny'], count: 1, clip: { label: 'Pizza', score: 0.82 } });
check('uses the model label as the category', withClip.category === 'Pizza', withClip.category);
check('raises confidence from the model score', withClip.confidence === 82, String(withClip.confidence));
check('source names the on-device model', /model/i.test(withClip.source));

section('normalizeResult (API path)');
const api = normalizeResult({
  category: 'food', subject: 'A flat white on a wooden table', confidence: 91,
  tags: ['coffee', 'latte'], headlines: [{ tone: 'Funny', text: 'Caffeine with a view' }],
  caption: 'Morning fuel.', alt_text: 'A flat white.', hashtags: ['#coffee'],
  review: { score: 84, summary: 'Crisp and well lit.', issues: ['Slightly tight crop'], tips: ['Give it more headroom'] },
  flags: ['Readable logo'],
}, { metrics: m.vivid, tones: ['Funny', 'Professional'], count: 2 });
check('keeps model category', api.category === 'food');
check('keeps provided headline', api.headlines[0].text === 'Caffeine with a view');
check('pads missing tones', api.headlines.length === 2, String(api.headlines.length));
check('carries metrics through', api.metrics === m.vivid);
check('not marked offline', api.offline === false);

section('normalizeResult (messy model output)');
const messy = normalizeResult({ category: '', headlines: ['plain string headline', { tone: 5, text: 'second' }], confidence: '70', review: null });
check('handles string headlines', messy.headlines[0].text === 'plain string headline');
check('coerces numeric confidence', messy.confidence === 70);
check('survives a null review', messy.review.issues.length === 0 && messy.review.summary === '');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
