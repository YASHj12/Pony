/* Pipeline tests: CV signals → classification → grouping → deck → captions.
 *   node test/pipeline.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as fx from './fixtures.mjs';

/* The browser modules are plain ESM (public/js/package.json sets type:module),
   so Node can import the very same files the page loads. */
import * as cv from '../public/js/cv.js';
import * as classify from '../public/js/classify.js';
import * as report from '../public/js/report.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const template = JSON.parse(readFileSync(path.join(here, '..', 'templates', 'fea-report.json'), 'utf8'));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

/* ── build photo records from the synthetic images ───────────────── */
function photo(name, img) {
  const cvSignals = cv.analyzeImageData(img.data, img.width, img.height);
  cvSignals.legend = cv.detectLegend(img.data, img.width, img.height);
  return { id: name, name, cv: cvSignals, kind: cv.inferKind(cvSignals), hash: cv.dHash(img.data, img.width, img.height) };
}

const pFull = photo('LC1_vonMises_bracket_iso.png', fx.contourFull);
const pZoom = photo('LC1_vonMises_bracket_zoom.png', fx.contourZoomed);
const pMesh = photo('LC1_mesh_fine.png', fx.meshImage);
const pGeom = photo('bracket_geometry_iso.png', fx.geometryImage);
const pGraph = photo('mesh_convergence_graph.png', fx.graphImage);
const pLegend = photo('legend_test.png', fx.legendImage);

section('CV: raw signals');
check('legend image: colourbar detected', pLegend.cv.legend.found, JSON.stringify(pLegend.cv.legend));
check('legend image: colourbar found on an edge', ['left', 'right', 'left-inner', 'right-inner'].includes(pLegend.cv.legend.side), pLegend.cv.legend.side);
check('contour plot: full rainbow spectrum present', pFull.cv.spectrumBands >= 4, `bands=${pFull.cv.spectrumBands}`);
check('contour plot: has a legend', pFull.cv.legend.found, JSON.stringify(pFull.cv.legend));
check('mesh image: no colour', pMesh.cv.colorfulness < 8, `colorfulness=${pMesh.cv.colorfulness}`);
check('mesh image: dense thin line work', pMesh.cv.lineDensity > 0.08, `lineDensity=${pMesh.cv.lineDensity}`);
check('zoom: fills the frame (little background)', pZoom.cv.bgFraction < 0.06, `bgFraction=${pZoom.cv.bgFraction}`);
check('full view: plenty of background', pFull.cv.bgFraction > 0.3, `bgFraction=${pFull.cv.bgFraction}`);

section('CV: kind inference');
check('contour plot recognised', pFull.kind.kind === 'contour', pFull.kind.kind);
check('mesh recognised', pMesh.kind.kind === 'mesh', pMesh.kind.kind);
check('geometry recognised', pGeom.kind.kind === 'geometry', pGeom.kind.kind);
check('graph recognised', pGraph.kind.kind === 'graph', pGraph.kind.kind);

section('Detail view detection (zoom / cut section)');
check('frame-filling plot is not a detail on its own', cv.inferDetail(pZoom.cv, []).isDetail === false,
  'conservative by design: a lone image is never called a zoom');
check('frame-filling plot IS a detail next to its full view',
  cv.inferDetail(pZoom.cv, [pFull.cv.bgFraction]).isDetail === true,
  JSON.stringify(cv.inferDetail(pZoom.cv, [pFull.cv.bgFraction])));
check('full view is never flagged as a detail', cv.inferDetail(pFull.cv, [pZoom.cv.bgFraction]).isDetail === false);

section('Filename parsing');
const f1 = classify.parseFilename('LC2_vonMises_bracket_iso.png');
check('reads the load case', f1.loadCase === 'LC2', f1.loadCase);
check('reads the result type', f1.type === 'Equivalent (von Mises) stress', f1.type);
check('reads the view', f1.view === 'isometric', f1.view);
check('reads the component', f1.component === 'Bracket', f1.component);

const f2 = classify.parseFilename('cut section LC2.png');
check('cut section detected from the name', f2.detail.isDetail && f2.detail.kind === 'section', JSON.stringify(f2.detail));
check('cut section still reads its load case', f2.loadCase === 'LC2', f2.loadCase);

const f3 = classify.parseFilename('bracket total deformation iso.png');
check('total deformation recognised', f3.type === 'Total deformation', f3.type);

const f4 = classify.parseFilename('Screenshot 2026-10-01 141322.png');
check('a bare screenshot yields no type', f4.type === null, String(f4.type));
check('a bare screenshot yields no component', f4.component === null, String(f4.component));

const f5 = classify.parseFilename('image(14).png');
check('image(14) yields nothing invented', f5.type === null && f5.component === null && f5.loadCase === null);

const f6 = classify.parseFilename('fatigue_life_bracket.png');
check('fatigue recognised', f6.type === 'Fatigue life', f6.type);

const f7 = classify.parseFilename('modal_frequency_mode3.png');
check('modal recognised', f7.type === 'Modal shape', f7.type);

/* ── the full pipeline ───────────────────────────────────────────── */
section('Classification (two passes)');
const photos = [pFull, pZoom, pMesh, pGeom, pGraph].map((p) => ({ ...p }));
classify.classifyAll(photos);

const full = photos.find((p) => p.name === pFull.name);
const zoom = photos.find((p) => p.name === pZoom.name);
const mesh = photos.find((p) => p.name === pMesh.name);
const geom = photos.find((p) => p.name === pGeom.name);

check('lc1 stress typed from filename', full.cls.type === 'Equivalent (von Mises) stress', full.cls.type);
check('lc1 stress tied to LC1', full.cls.loadCase === 'LC1', full.cls.loadCase);
check('zoom named view flagged as a detail', zoom.cls.detail.isDetail === true, JSON.stringify(zoom.cls.detail));
check('zoom detail kind is "zoom"', zoom.cls.detail.kind === 'zoom', zoom.cls.detail.kind);
check('full view is not a detail', full.cls.detail.isDetail === false);
check('mesh typed from filename', mesh.cls.type === 'Mesh', mesh.cls.type);
check('geometry typed from filename', geom.cls.type === 'Geometry', geom.cls.type);
check('every photo exposes confidence + review flags',
  photos.every((p) => p.cls.confidences && Array.isArray(p.cls.needsReview)), 'shape');

section('Grouping: details ride with their parent');
const groups = classify.groupPhotos(photos);
const stressGroup = groups.find((g) => g.family === 'stress');
check('one stress group exists', !!stressGroup);
check('the full view is the parent', stressGroup.main.name === pFull.name, stressGroup.main.name);
check('the zoom became an inset on the parent', stressGroup.insets.some((i) => i.name === pZoom.name),
  JSON.stringify(stressGroup.insets.map((i) => i.name)));
check('no "missing full view" warning when a full view exists',
  !stressGroup.issues.some((i) => /No full view/.test(i.text)), JSON.stringify(stressGroup.issues));

const zoomOnly = [{ ...pZoom, id: 'z', name: 'LC3_cut_section.png' }];
classify.classifyAll(zoomOnly);
const gz = classify.groupPhotos(zoomOnly);
check('a group with only a section view raises a gap', gz[0].issues.some((i) => /No full view/.test(i.text)),
  JSON.stringify(gz[0].issues));
check('the section-only group still gets a slide', gz[0].main.id === 'z');

const dupPhotos = [photo('LC1_vonMises_a.png', fx.contourFull), photo('LC1_vonMises_b.png', fx.contourFull)];
const dups = classify.findDuplicates(dupPhotos);
check('duplicate images are detected', dups.length === 1, JSON.stringify(dups));

section('Deck assembly');
const deck = report.buildDeck({
  photos: photos.map((p) => ({ ...p, value: p.cls.family === 'stress' ? { max: 187.4, unit: 'MPa', confirmed: true } : undefined })),
  template,
  meta: { project: 'Bracket FEA', part: 'Bracket rev C', author: 'A. Engineer', allowable: 250, groups },
});
const titles = deck.slides.map((s) => s.title);
check('cover slide built', deck.slides[0].kind === 'cover');
check('all template sections present',
  ['Model & Geometry', 'Mesh', 'Material Properties', 'Results Summary'].every((t) => titles.includes(t)),
  JSON.stringify(titles));
const resultSlide = deck.slides.find((s) => s.kind === 'results' && /LC1/.test(s.title));
check('a results slide exists for LC1', !!resultSlide, JSON.stringify(titles));
check('the detail inset is on the same slide as the full view',
  resultSlide.images.some((i) => i.role === 'main') && resultSlide.images.some((i) => i.role === 'inset'),
  JSON.stringify(resultSlide.images.map((i) => [i.role, i.label || ''])));
check('mesh image placed on the mesh slide',
  deck.slides.find((s) => s.title === 'Mesh').images.length === 1);
check('geometry image placed on the geometry slide',
  deck.slides.find((s) => s.title === 'Model & Geometry').images.length === 1);

section('Numeric firewall');
const fw = report.enforceNumericFirewall('Peak 187.4 MPa at 12 nodes, factor 1.33', new Set(['187.4']));
check('confirmed numbers survive', fw.text.includes('187.4'));
check('invented numbers are replaced', fw.text.includes('—') && !fw.text.includes('12 '), fw.text);
check('blocked numbers are reported', fw.blocked.includes('12') && fw.blocked.includes('1.33'), JSON.stringify(fw.blocked));
const injected = report.enforceNumericFirewall('Peak stress 999 MPa observed', new Set(['187.4']));
check('a fabricated peak in generated prose is blocked', injected.blocked.includes('999'), injected.text);

const cap = report.groupCaption(
  { main: { value: { max: 187.4, unit: 'MPa', confirmed: true }, cls: { type: 'Equivalent (von Mises) stress', view: 'isometric' } }, loadCase: 'LC1', component: 'Bracket', insets: [] },
  template.captions, 7, new Set(['187.4']),
);
check('caption carries the verified peak', cap.text.includes('187.4') && cap.text.includes('MPa'), cap.text);
check('caption names the type and load case', /Equivalent/.test(cap.text) && /LC1/.test(cap.text), cap.text);
check('caption invents no other number', cap.blocked.length === 0, JSON.stringify(cap.blocked));

const unverified = report.groupCaption(
  { main: { value: undefined, cls: { type: 'Total deformation', view: '' } }, loadCase: 'LC1', component: null, insets: [] },
  template.captions, 8, new Set(),
);
check('a missing value is stated, not invented',
  /not entered/i.test(unverified.text) && !/[\d]/.test(unverified.text.replace(/LC\d+/g, '')),
  unverified.text);

section('Summary table: pass/fail only from confirmed inputs');
const groupsWithValues = groups.map((g) => ({ ...g, main: { ...g.main, value: { max: 187.4, unit: 'MPa', confirmed: true } } }));
const t1 = report.buildSummaryTable(groupsWithValues, { allowable: 250 });
const row = t1.rows.find((r) => r[1] === 'Equivalent (von Mises) stress');
check('FoS computed from peak and allowable', row && row[5] === '1.33', JSON.stringify(row));
check('verdict states PASS with margin', row && /PASS/.test(row[6]), JSON.stringify(row));
const t2 = report.buildSummaryTable(groupsWithValues, {});
const row2 = t2.rows.find((r) => r[1] === 'Equivalent (von Mises) stress');
check('no allowable means no verdict', row2 && row2[5] === '—' && row2[6] === '—', JSON.stringify(row2));

section('Coverage gaps');
const gaps = report.coverageReport(groups, photos);
check('flags that there is no safety-factor plot', gaps.some((g) => /safety-factor/i.test(g.text)), JSON.stringify(gaps.map((g) => g.text)));
check('mesh present, so no mesh warning', !gaps.some((g) => /No mesh image/.test(g.text)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
