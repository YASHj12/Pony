/* End-to-end against the real template: screenshots → deck → .pptx → validated.
 *   node test/pptx.test.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import * as fx from './fixtures.mjs';
import * as cv from '../public/js/cv.js';
import * as classify from '../public/js/classify.js';
import * as report from '../public/js/report.js';
import { buildPptx } from '../public/js/pptx.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'out');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'sample-report.pptx');

const template = JSON.parse(readFileSync(path.join(here, '..', 'templates', 'fea-report.json'), 'utf8'));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};

function photo(name, img) {
  const signals = cv.analyzeImageData(img.data, img.width, img.height);
  signals.legend = cv.detectLegend(img.data, img.width, img.height);
  return { id: name, name, cv: signals, kind: cv.inferKind(signals), hash: cv.dHash(img.data, img.width, img.height) };
}

/* A drop that looks like the real thing: two cases, one passing, one failing. */
const photos = [
  photo('GG_geometry_top.png', fx.geometryImage),
  photo('GG_geometry_iso.png', fx.geometryImage),
  photo('LC1_mesh_fine.png', fx.meshImage),
  photo('LC1_boundary_conditions.png', fx.meshImage),
  photo('LC1_total_deformation.png', fx.contourFull),
  photo('LC1_vonMises_iso.png', fx.contourFull),
  photo('LC1_vonMises_zoom.png', fx.contourZoomed),
  photo('LC2_boundary_conditions.png', fx.meshImage),
  photo('LC2_total_deformation.png', fx.contourFull),
  photo('LC2_vonMises_iso.png', fx.contourFull),
  photo('LC2_cut_section.png', fx.contourFull),
];
classify.classifyAll(photos);
photos[4].value = { max: 3, unit: 'mm', confirmed: true };
photos[5].value = { max: 74.2, unit: 'MPa', confirmed: true };
photos[8].value = { max: 4, unit: 'mm', confirmed: true };
photos[9].value = { max: 196, unit: 'MPa', confirmed: true };

const tpl = {
  ...template,
  materials: { ...template.materials, rows: [['IS 2062', 'Gate', '191400', '0.3', '7.8E-9', '213', '']] },
};

const deck = report.buildDeck({
  photos, template: tpl,
  meta: {
    reportNo: 'MWI/FEA/ACK-6179/01', date: '4th Sept 2026', client: 'SILVERTONE',
    part: 'Guillotine Gate & Frame', partShort: 'GG',
    analysis: 'Static Structural Analysis', fos: 1.3, allowableRounding: 'floor',
    cases: {
      LC1: { description: 'Gate Fully Closed (Self Weight + Pressure)', bcText: 'A) Roller contact area is fixed. B) Design pressure 621.47 mmWC applied which is 0.00609 MPa. C) Self weight considered.' },
      LC2: { description: 'Gate Partially Closed (Self Weight + Pressure)', bcText: 'A) Roller contact is fixed. B) Design pressure 621.47 mmWC applied. C) Self weight considered.' },
    },
  },
});

console.log(`deck: ${deck.slides.length} slides, allowable ${deck.allowable} MPa`);
for (const s of deck.slides) console.log(`   ${String(s.layout).padEnd(11)} ${s.title || ''}`);

const media = {};
for (const p of photos) {
  media[p.id] = { bytes: fx.pngBytes(200, 150), ext: 'png', width: 200, height: 150 };
}

const { bytes, slideCount, mediaCount } = buildPptx({
  deck, media,
  meta: { project: `FEA Report — ${tpl.meta.part}`, author: 'MWA FEA' },
  theme: template.theme,
  size: template.slideSize,
});
writeFileSync(outFile, bytes);

console.log('\nGenerated file');
check('pptx written', bytes.length > 0);
check('ZIP signature present', bytes[0] === 0x50 && bytes[1] === 0x4b);
check('every deck slide became a slide', slideCount === deck.slides.length, `${slideCount} vs ${deck.slides.length}`);
check('media deduplicated', mediaCount === photos.length, String(mediaCount));
check('slide count matches the sample decks (11)', slideCount === 11, String(slideCount));

console.log('\npython3 structural validation');
let validatorOutput = '';
let validatorCode = 0;
try {
  validatorOutput = execFileSync('python3', [path.join(here, 'verify_pptx.py'), outFile], { encoding: 'utf8' });
} catch (err) {
  validatorCode = err.status ?? 1;
  validatorOutput = (err.stdout || '') + (err.stderr || '');
}
process.stdout.write(validatorOutput.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n'));
check('validator ran clean', validatorCode === 0, validatorOutput);
check('no failing checks reported', !/FAIL:/.test(validatorOutput), validatorOutput);

console.log('\nContent inside the generated slides');
const dump = execFileSync('python3', [path.join(here, 'dump_pptx.py'), outFile], { encoding: 'utf8' });
process.stdout.write(dump.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n'));

check('cover carries FEA REPORT and the report number', /FEA REPORT/.test(dump) && /ACK-6179/.test(dump));
check('material table row made it into the deck', /IS 2062/.test(dump) && /163/.test(dump));
check('results slides carry the house labels', /Total deformation/.test(dump) && /Von-mises stress/.test(dump));
check('the deformation value line is present', /Maximum Total Deformation/.test(dump));
check('the stress verdict sentence is present', /allowable limit of 163 MPa/.test(dump));
check('detail insets are on the results slides', /Section A|Detail A/.test(dump));
check('final summary table present with the verdict', /Exceeding Limit/.test(dump));
check('boundary conditions text present', /Roller contact area is fixed/.test(dump));

const pictureTotal = [...dump.matchAll(/PICS (\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
check('all 11 images placed', pictureTotal >= 11, String(pictureTotal));

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`file: ${outFile}`);
process.exit(fail ? 1 : 0);
