/* Ansys Report — computer-vision core.
 *
 * Pure functions over raw RGBA pixels: no DOM, no network, no dependencies,
 * so the same code runs in the browser (live preview) and in Node (tests).
 *
 * Everything here answers one question: "what can be measured about this
 * screenshot without an AI model?" The classifier layers filename rules and
 * (optionally) a vision model on top of these signals.
 */

/* ───────────────────────── colour helpers ───────────────────────── */

export function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max / 255 };
}

const HUE_BANDS = [
  ['red', (h) => h >= 345 || h < 15],
  ['yellow', (h) => h >= 45 && h < 75],
  ['green', (h) => h >= 75 && h < 165],
  ['cyan', (h) => h >= 165 && h < 195],
  ['blue', (h) => h >= 195 && h < 265],
  ['magenta', (h) => h >= 265 && h < 345],
];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round = (v, d = 3) => Number(v.toFixed(d));

/* ───────────────────────── per-pixel pass ───────────────────────── */

/**
 * @param {Uint8ClampedArray} data RGBA
 * @param {number} width
 * @param {number} height
 * @returns {object} raw signals
 */
export function analyzeImageData(data, width, height) {
  const px = width * height;
  const luma = new Float32Array(px);
  const grey = new Uint8Array(px);       // 1 = pixel is (near) achromatic
  const hue = new Float32Array(px);      // degrees, 0 for grey pixels
  const sat = new Float32Array(px);
  let sum = 0, sumSq = 0, satSum = 0, colorfulCount = 0;

  const bandCounts = Object.create(null);
  for (const [name] of HUE_BANDS) bandCounts[name] = 0;
  const quant = new Map();               // 4-bit colour buckets
  const quantColorful = new Map();

  for (let i = 0, p = 0; i < px; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luma[i] = y;
    sum += y; sumSq += y * y;

    const { h, s, v } = rgbToHsv(r, g, b);
    sat[i] = s;
    satSum += s;
    grey[i] = s < 0.12 ? 1 : 0;

    const isColorful = s > 0.25 && v > 0.15;
    if (isColorful) {
      colorfulCount++;
      hue[i] = h;
      for (const [name, test] of HUE_BANDS) if (test(h)) { bandCounts[name]++; break; }
    } else {
      hue[i] = -1;
    }

    const qk = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    quant.set(qk, (quant.get(qk) || 0) + 1);
    if (isColorful) quantColorful.set(qk, (quantColorful.get(qk) || 0) + 1);
  }

  const mean = sum / px;
  const lumaStd = Math.sqrt(Math.max(0, sumSq / px - mean * mean));

  /* hue spectrum coverage — an Ansys contour legend spans blue→red */
  const colorFrac = colorfulCount / px;
  let bandsCovered = 0;
  const hueBands = {};
  for (const [name] of HUE_BANDS) {
    const frac = colorfulCount ? bandCounts[name] / colorfulCount : 0;
    hueBands[name] = round(frac, 3);
    if (frac >= 0.015) bandsCovered++;
  }

  /* how many distinct flat colours — discrete contour bands vs smooth shading */
  let bands = 0;
  for (const n of quantColorful.values()) if (n >= colorfulCount * 0.004) bands++;
  if (bands > 40) bands = 40;

  /* edges / line work */
  let edgeSum = 0, linePixels = 0, edgeCount = 0, lapSum = 0, lapSumSq = 0, lapN = 0;
  const ORIENT_BINS = 18;
  const orientHist = new Float64Array(ORIENT_BINS);
  let strongGrad = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx = luma[i + 1] - luma[i - 1];
      const gy = luma[i + width] - luma[i - width];
      const mag = Math.abs(gx) + Math.abs(gy);
      edgeSum += mag;
      if (mag > 60) {
        edgeCount++;
        const ang = Math.atan2(gy, gx); // -π..π
        const bin = Math.floor(((ang + Math.PI) / (2 * Math.PI)) * ORIENT_BINS) % ORIENT_BINS;
        orientHist[bin]++; strongGrad++;
      }
      // thin dark line over a brighter surround (wireframe / element edges)
      if (luma[i] < 120) {
        const bright = (luma[i - 1] > luma[i] + 55 ? 1 : 0) + (luma[i + 1] > luma[i] + 55 ? 1 : 0) +
                       (luma[i - width] > luma[i] + 55 ? 1 : 0) + (luma[i + width] > luma[i] + 55 ? 1 : 0);
        if (bright >= 2) linePixels++;
      }
      const lap = 4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - width] - luma[i + width];
      lapSum += lap; lapSumSq += lap * lap; lapN++;
    }
  }

  const inner = (width - 2) * (height - 2) || 1;
  const edgeDensity = round(edgeSum / inner / 255, 4);
  const lineDensity = round(linePixels / inner, 4);
  const sharpness = lapN ? Math.round(Math.sqrt(Math.max(0, lapSumSq / lapN - (lapSum / lapN) ** 2))) : 0;

  /* orientation coherence: a single dominant direction ⇒ hatching or a flat section plane */
  let orientationCoherence = 0;
  if (strongGrad > 50) {
    let top = 0;
    for (const v of orientHist) if (v > top) top = v;
    orientationCoherence = round(top / strongGrad, 3);
  }

  /* background estimate from the four corners, then coverage / frame fill */
  const bg = estimateBackground(data, width, height);
  let bgPixels = 0, borderPixels = 0, borderNonBg = 0;

  for (let i = 0, p = 0; i < px; i++, p += 4) {
    if (colourDistance(data[p], data[p + 1], data[p + 2], bg) < 45) bgPixels++;
  }
  const ring = Math.max(2, Math.round(Math.min(width, height) * 0.02));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= ring && x < width - ring && y >= ring && y < height - ring) continue;
      borderPixels++;
      const p = (y * width + x) * 4;
      if (colourDistance(data[p], data[p + 1], data[p + 2], bg) > 60) borderNonBg++;
    }
  }

  /* window chrome: a long uniform band across the top, or a uniformly dark frame */
  let darkFrame = 0, framePixels = 0;
  const bandRows = Math.max(2, Math.round(height * 0.06));
  let ribbonUniform = 0;
  for (let y = 0; y < bandRows; y++) {
    let rowVar = 0;
    for (let x = 0; x < width; x++) rowVar += Math.abs(luma[y * width + x] - luma[y * width + Math.min(width - 1, x + 1)]);
    if (rowVar / width < 1.5) ribbonUniform++;
  }
  const ribbonScore = round(ribbonUniform / bandRows, 2);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const onFrame = x < width * 0.04 || x > width * 0.96 || y < height * 0.04 || y > height * 0.96;
      if (!onFrame) continue;
      framePixels++;
      const i = y * width + x;
      if (luma[i] < 45 && sat[i] < 0.25) darkFrame++;
    }
  }

  let distinctColours = 0;
  for (const n of quant.values()) if (n >= px * 0.004) distinctColours++;

  return {
    width, height,
    megapixels: round((width * height) / 1e6, 2),
    aspect: round(width / height),
    orientation: width > height * 1.05 ? 'landscape' : height > width * 1.05 ? 'portrait' : 'square',
    brightness: Math.round(mean),
    contrast: Math.round(lumaStd),
    saturation: round(satSum / px),
    colorfulness: round(colorFrac * 100, 1),      // % of pixels that carry colour
    greyRatio: round(grey.reduce((a, b) => a + b, 0) / px),
    sharpness,
    edgeDensity,
    lineDensity,
    orientationCoherence,
    bandCount: bands,
    distinctColours,
    hueBands,
    spectrumBands: bandsCovered,
    bgFraction: round(bgPixels / px),
    borderFill: borderPixels ? round(borderNonBg / borderPixels) : 0,
    backgroundIsLight: Math.round(0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b) > 140,
    cornerColor: toHex(bg),
    darkFrameRatio: framePixels ? round(darkFrame / framePixels) : 0,
    ribbonScore,
    chrome: chromeVerdict(darkFrame / (framePixels || 1), ribbonScore),
  };
}

function chromeVerdict(darkRatio, ribbonScore) {
  if (darkRatio > 0.35) return { present: true, kind: 'dark-ui', why: 'dark application frame around the plot' };
  if (ribbonScore > 0.7) return { present: true, kind: 'light-ui', why: 'uniform light band across the top, looks like an application ribbon' };
  return { present: false, kind: null, why: '' };
}

function estimateBackground(data, width, height) {
  /* The canvas colour, not the legend colour. A corner sitting on a colourbar
   * or on the model is not uniform, so pick the corner with the lowest
   * luminance variance — in an Ansys screenshot that is the empty background. */
  const s = Math.max(2, Math.round(Math.min(width, height) * 0.04));
  const corners = [[0, 0], [width - s, 0], [0, height - s], [width - s, height - s]];
  let best = null;
  for (const [px0, py0] of corners) {
    let r = 0, g = 0, b = 0, n = 0, sum = 0, sumSq = 0;
    for (let y = py0; y < py0 + s; y++) {
      for (let x = px0; x < px0 + s; x++) {
        const p = (y * width + x) * 4;
        r += data[p]; g += data[p + 1]; b += data[p + 2];
        const lum = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
        sum += lum; sumSq += lum * lum; n++;
      }
    }
    if (!n) continue;
    const variance = Math.max(0, sumSq / n - (sum / n) ** 2);
    if (!best || variance < best.variance) best = { variance, r: r / n, g: g / n, b: b / n };
  }
  return best || { r: 255, g: 255, b: 255 };
}

const colourDistance = (r, g, b, bg) => Math.abs(r - bg.r) + Math.abs(g - bg.g) + Math.abs(b - bg.b);
const toHex = (c) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/* ───────────────────────── legend / colourbar detection ───────────────────────── */

/**
 * A legend is a long thin strip of continuously varying hue that is constant
 * across its short axis and spans a large hue range along its long axis.
 * Returns a normalised rect so the UI can crop it for a human to read.
 */
export function detectLegend(data, width, height) {
  const candidates = [];

  const stripW = Math.max(3, Math.round(width * 0.035));
  const vStrips = [
    { x0: 0, x1: stripW, side: 'left' },
    { x0: width - stripW, x1: width, side: 'right' },
    { x0: Math.round(width * 0.02), x1: Math.round(width * 0.02) + stripW, side: 'left-inner' },
    { x0: Math.round(width * 0.95) - stripW, x1: Math.round(width * 0.95), side: 'right-inner' },
  ];
  for (const c of vStrips) {
    candidates.push({ ...c, orientation: 'vertical', rect: { x: c.x0 / width, y: 0, w: stripW / width, h: 1 } });
  }

  const stripH = Math.max(3, Math.round(height * 0.035));
  const hStrips = [
    { y0: 0, y1: stripH, side: 'top' },
    { y0: height - stripH, y1: height, side: 'bottom' },
  ];
  for (const c of hStrips) {
    candidates.push({ ...c, orientation: 'horizontal', rect: { x: 0, y: c.y0 / height, w: 1, h: stripH / height } });
  }

  let best = null;
  for (const cand of candidates) {
    const score = scoreStrip(data, width, height, cand);
    if (!best || score.score > best.score) best = { ...cand, ...score };
  }

  if (!best || best.score < 0.55) return { found: false, score: best ? best.score : 0, rect: null, orientation: null, side: null };
  return {
    found: true,
    score: round(best.score, 2),
    rect: best.rect,
    orientation: best.orientation,
    side: best.side,
    colourRange: best.colourRange,
  };
}

function scoreStrip(data, width, height, cand) {
  const vertical = cand.orientation === 'vertical';
  const len = vertical ? height : width;
  const thickness = vertical ? cand.x1 - cand.x0 : cand.y1 - cand.y0;

  const hues = [];
  let colorfulRows = 0, crossVariance = 0, samples = 0;

  for (let t = 0; t < len; t++) {
    let r = 0, g = 0, b = 0, n = 0;
    const crossHues = [];
    for (let s = 0; s < thickness; s++) {
      const x = vertical ? cand.x0 + s : t;
      const y = vertical ? t : cand.y0 + s;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const p = (y * width + x) * 4;
      const { h, s: sa, v } = rgbToHsv(data[p], data[p + 1], data[p + 2]);
      r += data[p]; g += data[p + 1]; b += data[p + 2]; n++;
      if (sa > 0.25 && v > 0.15) crossHues.push(h);
    }
    if (!n) continue;
    const { h: hr, s: sr, v: vr } = rgbToHsv(r / n, g / n, b / n);
    if (sr > 0.25 && vr > 0.15) { hues.push(hr); colorfulRows++; }
    if (crossHues.length > 1) {
      let m = crossHues.reduce((a, b2) => a + b2, 0) / crossHues.length;
      let sd = Math.sqrt(crossHues.reduce((a, b2) => a + (b2 - m) ** 2, 0) / crossHues.length);
      crossVariance += sd;
      samples++;
    }
  }

  const coverage = colorfulRows / len;
  const meanCross = samples ? crossVariance / samples : 999;

  // hue span along the strip, measured through the circular mean of a sliding window
  let span = 0;
  if (hues.length > 8) {
    const sorted = [...hues].sort((a, b) => a - b);
    span = sorted[sorted.length - 1] - sorted[0];
    if (span < 180) {
      // the wrap-around case: blue at one end, red at the other
      const wrapped = 360 - span;
      // pick whichever interpretation yields a smoother progression
      span = smootherProgression(hues) > 0.6 ? Math.max(span, 200) : Math.max(span, wrapped > 200 ? 200 : span);
    }
  }

  const solidity = meanCross < 22 ? 1 : meanCross < 40 ? 0.5 : 0;
  const rangeScore = clamp(span / 240, 0, 1);
  const coverageScore = clamp((coverage - 0.35) / 0.5, 0, 1);
  const score = 0.45 * solidity + 0.3 * coverageScore + 0.25 * rangeScore;

  return { score, colourRange: Math.round(span), coverage: round(coverage, 2), crossHueStd: Math.round(meanCross) };
}

/** how monotonic is the hue progression along the strip (0–1) */
function smootherProgression(hues) {
  if (hues.length < 8) return 0;
  let inc = 0, dec = 0;
  for (let i = 1; i < hues.length; i++) {
    const d = hues[i] - hues[i - 1];
    const wrapped = d > 180 ? d - 360 : d < -180 ? d + 360 : d;
    if (wrapped > 0) inc++; else if (wrapped < 0) dec++;
  }
  const n = hues.length - 1;
  return Math.max(inc, dec) / n;
}

/* ───────────────────────── duplicate detection ───────────────────────── */

/** 64-bit difference hash, hex encoded. Same view re-exported → same/near hash. */
export function dHash(data, width, height) {
  const gw = 9, gh = 8;
  const cells = new Float64Array(gw * gh);
  const counts = new Float64Array(gw * gh);
  for (let y = 0; y < height; y++) {
    const cy = Math.min(gh - 1, Math.floor((y / height) * gh));
    for (let x = 0; x < width; x++) {
      const cx = Math.min(gw - 1, Math.floor((x / width) * gw));
      const p = (y * width + x) * 4;
      cells[cy * gw + cx] += 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
      counts[cy * gw + cx]++;
    }
  }
  let bits = '';
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw - 1; x++) {
      const a = cells[y * gw + x] / (counts[y * gw + x] || 1);
      const b = cells[y * gw + x + 1] / (counts[y * gw + x + 1] || 1);
      bits += a > b ? '1' : '0';
    }
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function hammingDistance(hexA, hexB) {
  if (!hexA || !hexB || hexA.length !== hexB.length) return 64;
  let d = 0;
  for (let i = 0; i < hexA.length; i++) {
    let x = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/* ───────────────────────── classification signals ───────────────────────── */

/**
 * Reduce the raw signals to the handful of judgements the classifier uses.
 * Deliberately conservative: says "unknown" rather than guessing a result type,
 * because a wrong result type in an FEA report is a correctness problem, not a
 * cosmetic one.
 */
export function inferKind(cv) {
  const { spectrumBands, colorfulness, bgFraction, lineDensity, edgeDensity, orientationCoherence, bandCount, brightness, contrast } = cv;

  if (spectrumBands >= 4 && colorfulness > 6) {
    return { kind: 'contour', conf: clamp(0.5 + spectrumBands * 0.07, 0, 0.9), why: `${spectrumBands}-band colour spectrum, ${bandCount} discrete bands` };
  }
  if (lineDensity > 0.09 && colorfulness < 8 && edgeDensity > 0.05) {
    return { kind: 'mesh', conf: lineDensity > 0.14 ? 0.8 : 0.62, why: `${(lineDensity * 100).toFixed(1)}% thin line pixels with no colour — element edges` };
  }
  /* A graph is a sparse coloured line on a big empty plot area; a CAD shot has
   * no colour at all, which is what separates the two. */
  if (bgFraction > 0.45 && colorfulness >= 0.3 && colorfulness < 20 && lineDensity < 0.08) {
    return { kind: 'graph', conf: 0.55, why: `large empty plot area with ${colorfulness}% coloured line pixels` };
  }
  if (colorfulness < 0.5 && edgeDensity < 0.06 && bgFraction > 0.3) {
    return { kind: 'geometry', conf: 0.6, why: 'smooth achromatic shaded surface, low edge density' };
  }
  if (bgFraction > 0.4 && colorfulness < 6 && orientationCoherence > 0.3) {
    return { kind: 'sketch', conf: 0.4, why: 'achromatic with a dominant line direction — boundary conditions or an annotated view' };
  }
  if (brightness < 60) return { kind: 'dark', conf: 0.3, why: 'mostly dark frame — dark theme or a cropped plot' };
  if (contrast < 18) return { kind: 'blank', conf: 0.35, why: 'almost no contrast — blank or near-uniform image' };
  return { kind: 'unknown', conf: 0.2, why: 'no strong signature' };
}

/**
 * Is this a detail view (zoomed in or cut open) rather than the full model?
 * Filename evidence is handled by the classifier; this is the pixel evidence.
 */
export function inferDetail(cv, siblingBgFractions = []) {
  const reasons = [];
  let score = 0;

  if (cv.orientationCoherence > 0.45 && cv.lineDensity > 0.05) {
    score += 0.35;
    reasons.push(`dominant edge direction (${cv.orientationCoherence}) with dense line work — looks like a section cut or hatch`);
  }
  if (cv.bgFraction < 0.06) {
    score += 0.25;
    reasons.push(`the model fills the frame (${(cv.bgFraction * 100).toFixed(1)}% background) — a zoomed-in view`);
  }
  if (siblingBgFractions.length) {
    const median = [...siblingBgFractions].sort((a, b) => a - b)[Math.floor(siblingBgFractions.length / 2)];
    if (median > 0.25 && cv.bgFraction < median * 0.4) {
      score += 0.3;
      reasons.push(`far less background than its own group (${(cv.bgFraction * 100).toFixed(1)}% vs ${(median * 100).toFixed(1)}%) — a detail of that view`);
    }
  }

  return {
    isDetail: score >= 0.3,
    kind: score >= 0.3 ? (reasons.some((r) => /section|hatch/i.test(r)) ? 'section' : 'zoom') : null,
    score: round(Math.min(score, 1), 2),
    reasons,
  };
}
