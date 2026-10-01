/* Pipeline tests against the real company template.
 *   node test/pipeline.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as fx from './fixtures.mjs';
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

function photo(name, img) {
  const signals = cv.analyzeImageData(img.data, img.width, img.height);
  signals.legend = cv.detectLegend(img.data, img.width, img.height);
  return { id: name, name, cv: signals, kind: cv.inferKind(signals), hash: cv.dHash(img.data, img.width, img.height) };
}

/* ── the drop: what an engineer would actually export for two load cases ── */
const photos = [
  photo('bracket_geometry_top.png', fx.geometryImage),
  photo('bracket_geometry_iso.png', fx.geometryImage),
  photo('LC1_mesh_fine.png', fx.meshImage),
  photo('LC1_boundary_conditions.png', fx.meshImage),
  photo('LC1_total_deformation_iso.png', fx.contourFull),
  photo('LC1_vonMises_bracket_iso.png', fx.contourFull),
  photo('LC1_vonMises_bracket_zoom.png', fx.contourZoomed),
  photo('LC2_boundary_conditions.png', fx.meshImage),
  photo('LC2_total_deformation_iso.png', fx.contourFull),
  photo('LC2_vonMises_bracket_iso.png', fx.contourFull),
  photo('LC2_cut_section_stress.png', fx.contourFull),
  photo('mesh_convergence_graph.png', fx.graphImage),
];

section('CV: raw signals');
check('legend image: colourbar detected', cv.detectLegend(fx.legendImage.data, fx.W, fx.H).found);
check('contour plot: rainbow spectrum present', photos[4].cv.spectrumBands >= 4, `bands=${photos[4].cv.spectrumBands}`);
check('mesh image: no colour, dense line work', photos[2].cv.colorfulness < 8 && photos[2].cv.lineDensity > 0.08);
check('zoom fills the frame, full view does not',
  photos[6].cv.bgFraction < 0.06 && photos[5].cv.bgFraction > 0.3,
  `${photos[6].cv.bgFraction} vs ${photos[5].cv.bgFraction}`);

section('Filename parsing');
const p1 = classify.parseFilename('LC2_vonMises_bracket_iso.png');
check('load case, type, view and component', p1.loadCase === 'LC2' && p1.type === 'Equivalent (von Mises) stress' && p1.view === 'isometric' && p1.component === 'Bracket',
  JSON.stringify(p1));
check('cut section from the name', classify.parseFilename('LC2_cut_section_stress.png').detail.kind === 'section');
check('total deformation from the name', classify.parseFilename('LC1_total_deformation_iso.png').type === 'Total deformation');
check('boundary conditions from the name', classify.parseFilename('LC1_boundary_conditions.png').type === 'Boundary conditions');
check('a bare screenshot invents nothing',
  (() => { const f = classify.parseFilename('Screenshot 2026-10-01 141322.png'); return !f.type && !f.component && !f.loadCase; })());
check('image(14).png invents nothing',
  (() => { const f = classify.parseFilename('image(14).png'); return !f.type && !f.component; })());

classify.classifyAll(photos);
check('von Mises typed and cased', photos[5].cls.type === 'Equivalent (von Mises) stress' && photos[5].cls.loadCase === 'LC1');
check('zoom view is a detail', photos[6].cls.detail.isDetail && photos[6].cls.detail.kind === 'zoom');
check('cut section is a detail', photos[10].cls.detail.isDetail && photos[10].cls.detail.kind === 'section');
check('full view is not a detail', !photos[5].cls.detail.isDetail);
check('BC image typed', photos[3].cls.type === 'Boundary conditions');

/* values a human typed and confirmed */
photos[4].value = { max: 3, unit: 'mm', confirmed: true };            // LC1 deformation
photos[5].value = { max: 74.2, unit: 'MPa', confirmed: true };        // LC1 stress
photos[8].value = { max: 2.42, unit: 'mm', confirmed: true };         // LC2 deformation
photos[9].value = { max: 300, unit: 'MPa', confirmed: true };         // LC2 stress

section('Allowable stress — matches the sample reports');
check('213 / 1.3 → 163, as in sample.pptx', report.computeAllowable(213, 1.3) === 163, String(report.computeAllowable(213, 1.3)));
check('380 / 1.3 → 292, as in 6203_KCP_MLD.pptx', report.computeAllowable(380, 1.3) === 292, String(report.computeAllowable(380, 1.3)));

const materials = {
  columns: template.materials.columns,
  rows: [['IS 2062', 'Gate', '191400', '0.3', '7.8E-9', '213', '']],
};
const meta = {
  reportNo: 'MWI/FEA/ACK-6179/01', date: '4th Sept 2026', client: 'SILVERTONE',
  part: 'Guillotine Gate & Frame', partShort: 'GG', analysis: 'Static Structural Analysis',
  fos: 1.3, allowableRounding: 'floor',
  cases: {
    LC1: { description: 'Gate Fully Closed (Self Weight + Pressure)', bcText: 'A) Roller contact area is fixed. B) Design pressure 621.47 mmWC applied. C) Self weight considered.' },
    LC2: { description: 'Gate Partially Closed (Self Weight + Pressure)', bcText: 'A) Roller contact is fixed. B) Design pressure applied. C) Self weight considered.' },
  },
};

const tpl = { ...template, materials: { ...template.materials, rows: materials.rows } };
const deck = report.buildDeck({ photos, template: tpl, meta });
const titles = deck.slides.map((s) => s.title || s.eyebrow);
console.log(`    slides: ${deck.slides.length}`);
for (const t of titles) console.log(`      · ${t}`);

section('Deck structure — the sample order');
check('cover is first, labelled FEA REPORT', deck.slides[0].layout === 'cover' && deck.slides[0].eyebrow === 'FEA REPORT');
check('cover title reads "Static Structural Analysis Of …"', /Static Structural Analysis Of Gui/.test(deck.slides[0].title), deck.slides[0].title);
check('cover carries report no, date and client',
  JSON.stringify(deck.slides[0].fields).includes('ACK-6179') && JSON.stringify(deck.slides[0].fields).includes('SILVERTONE'));
check('section 1 is Material Properties', titles[1] === '1. Material Properties', titles[1]);
check('section 2 is "<part> Geometry"', titles[2] === '2. GG Geometry', titles[2]);
check('section 3 is "<part> Mesh"', titles[3] === '3. GG Mesh', titles[3]);
check('case 1 boundary-conditions slide', /^Case 1: Gate Fully Closed/.test(titles[4] || ''), titles[4]);
check('case 1 results slide uses the short case label', titles[5] === 'Case 1: Results', titles[5]);
check('case 1 observation slide', /Observation & Summary$/.test(titles[6] || ''), titles[6]);
check('case 2 present after case 1', /^Case 2:/.test(titles[7] || ''), titles[7]);
check('final summary comes after the cases', titles.indexOf('Final Summary') > titles.findIndex((t) => /Observation/.test(t || '')));
check('the image that fits no slot goes to the appendix',
  deck.slides[deck.slides.length - 1].layout === 'grid' && deck.slides[deck.slides.length - 1].images.some((i) => i.photoId === 'mesh_convergence_graph.png'),
  JSON.stringify(deck.slides[deck.slides.length - 1]));

section('Results slide: the layout the report actually uses');
const results1 = deck.slides.find((s) => s.id === 'results-LC1');
check('two slots: deformation left, von Mises right',
  results1.figures[0].slot === 'deformation' && results1.figures[1].slot === 'stress',
  JSON.stringify(results1.figures.map((f) => f.slot)));
check('slot labels are the house labels',
  results1.figures[0].label === 'Total deformation' && results1.figures[1].label === 'Von-mises stress');
check('deformation value line reads "Maximum Total Deformation – 3 mm"',
  results1.figures[0].line === 'Maximum Total Deformation – 3 mm', results1.figures[0].line);
check('stress line states the allowable', /within the material's allowable limit of 163 MPa\./.test(results1.figures[1].line), results1.figures[1].line);

section('Zoom and cut-section views land on the same slide as their parent');
check('LC1 zoom is an inset on the LC1 results slide',
  deck.slides.find((s) => s.id === 'results-LC1').insets.some((i) => i.photoId === 'LC1_vonMises_bracket_zoom.png'),
  JSON.stringify(deck.slides.find((s) => s.id === 'results-LC1').insets));
check('LC2 cut section is an inset on the LC2 results slide',
  deck.slides.find((s) => s.id === 'results-LC2').insets.some((i) => i.photoId === 'LC2_cut_section_stress.png'));
check('the inset is labelled as a section, not a generic detail',
  /^Section A/.test(deck.slides.find((s) => s.id === 'results-LC2').insets[0].label),
  deck.slides.find((s) => s.id === 'results-LC2').insets[0].label);
check('no detail view got a slide of its own',
  !deck.slides.some((s) => (s.figures || []).some((f) => f.photoId === 'LC1_vonMises_bracket_zoom.png')));
check('detail views are recorded in the figure log',
  deck.figureLog.some((f) => f.photoId === 'LC1_vonMises_bracket_zoom.png'));

section('Verdict logic — within vs exceeds');
check('74.2 MPa against 163 MPa reads as within', /is within/.test(results1.figures[1].line));
const results2 = deck.slides.find((s) => s.id === 'results-LC2');
check('300 MPa against 163 MPa reads as exceeding', /exceeds the material's allowable limit of 163 MPa\./.test(results2.figures[1].line), results2.figures[1].line);
check('observation bullet 1 states the deformation', /Total deformation in the GG is 3 mm\./.test(deck.slides.find((s) => s.id === 'observation-LC1').bullets[0]),
  deck.slides.find((s) => s.id === 'observation-LC1').bullets[0]);
check('observation bullet 2 states the verdict', /material's allowable stress limit of 163 MPa\./.test(deck.slides.find((s) => s.id === 'observation-LC2').bullets[1]),
  deck.slides.find((s) => s.id === 'observation-LC2').bullets[1]);

section('Final summary table — the four sample columns');
const final = deck.slides.find((s) => s.id === 'final');
check('columns are the sample columns',
  JSON.stringify(final.table.columns) === JSON.stringify(['Load Case', 'Max. Deformation', 'Max. Von-Mises Stress', 'Allowable Stress']),
  JSON.stringify(final.table.columns));
check('a passing case prints its stress', final.table.rows[0][2] === '74.2 MPa', JSON.stringify(final.table.rows[0]));
check('a failing case prints "Exceeding Limit"', final.table.rows[1][2] === 'Exceeding Limit', JSON.stringify(final.table.rows[1]));
check('deformation cells carry units', final.table.rows[0][1] === '3 mm' && final.table.rows[1][1] === '2.42 mm');
check('allowable column repeats the material allowable', final.table.rows[0][3] === '163 MPa');

section('Numeric firewall');
const fw = report.enforceNumericFirewall('Peak 187.4 MPa at 12 nodes', new Set(['187.4']));
check('confirmed numbers survive', fw.text.includes('187.4'));
check('unconfirmed numbers are replaced and reported', fw.text.includes('—') && fw.blocked.includes('12'), fw.text);
const injected = report.enforceNumericFirewall('Peak stress 999 MPa', new Set(['187.4']));
check('a fabricated peak is blocked', injected.blocked.includes('999'));

/* A value the engineer typed but never confirmed must not reach the report. */
const unconfirmed = photos.map((p) => ({ ...p, cls: { ...p.cls }, value: { ...p.value } }));
const target = unconfirmed.find((p) => p.name === 'LC1_vonMises_bracket_iso.png');
target.value = { max: 88.8, unit: 'MPa', confirmed: false };
const deckU = report.buildDeck({ photos: unconfirmed, template: tpl, meta });
const lineU = deckU.slides.find((s) => s.id === 'results-LC1').figures[1].line;
check('an unconfirmed value is never quoted', !/88\.8/.test(lineU), lineU);
check('the report says the value is missing instead', /not entered/i.test(lineU), lineU);
check('the summary row shows a dash for it',
  deckU.slides.find((s) => s.id === 'final').table.rows[0][2] === '—',
  JSON.stringify(deckU.slides.find((s) => s.id === 'final').table.rows[0]));

section('Gaps the app should warn about');
const thin = [photo('LC1_vonMises_bracket_iso.png', fx.contourFull)];
classify.classifyAll(thin);
thin[0].value = { max: 90, unit: 'MPa', confirmed: true };
const thinDeck = report.buildDeck({ photos: thin, template: tpl, meta: { ...meta, cases: {} } });
const gaps = report.coverageReport(thinDeck.cases, thin, { allowable: thinDeck.allowable });
check('warns that a deformation result is missing', gaps.some((g) => /no deformation result/i.test(g.text)), JSON.stringify(gaps.map((g) => g.text)));
check('warns that boundary-conditions text is not written', gaps.some((g) => /boundary-conditions text not written/i.test(g.text)));
check('warns that no mesh image exists', gaps.some((g) => /No mesh image/.test(g.text)));
check('the missing slot is stated on the slide, not left blank',
  /no deformation result supplied/.test(thinDeck.slides.find((s) => s.id === 'results-LC1').figures[0].line),
  thinDeck.slides.find((s) => s.id === 'results-LC1').figures[0].line);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
