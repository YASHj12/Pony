/* End-to-end: images → deck → .pptx, then validate the package with python3.
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
const outFile = path.join(outDir, 'test-report.pptx');

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

/* a realistic drop: geometry, mesh, two load cases, each with a detail view */
const photos = [
  photo('bracket_geometry_iso.png', fx.geometryImage),
  photo('LC1_mesh_fine.png', fx.meshImage),
  photo('LC1_vonMises_bracket_iso.png', fx.contourFull),
  photo('LC1_vonMises_bracket_zoom.png', fx.contourZoomed),
  photo('LC2_vonMises_bracket_iso.png', fx.contourFull),
  photo('LC2_cut_section.png', fx.contourFull),
];
classify.classifyAll(photos);
photos[2].value = { max: 187.4, unit: 'MPa', confirmed: true };
photos[4].value = { max: 231.8, unit: 'MPa', confirmed: true };

const groups = classify.groupPhotos(photos);

console.log('building deck + pptx…');
const deck = report.buildDeck({
  photos, template,
  meta: {
    project: 'Bracket Assembly — Static Structural',
    part: 'Bracket rev C', client: 'Internal', author: 'FEA Team', revision: 'B',
    allowable: 250, date: '2026-10-01', groups,
  },
});

const media = {};
for (const p of photos) {
  media[p.id] = { bytes: fx.pngBytes(160, 120), ext: 'png', width: 160, height: 120 };
}

const { bytes, slideCount, mediaCount } = buildPptx({
  deck, media,
  meta: { project: 'Bracket Assembly', author: 'FEA Team' },
  theme: template.theme,
});
writeFileSync(outFile, bytes);

console.log('\nGenerated file');
check('pptx written', bytes.length > 0);
check('file has the ZIP signature', bytes[0] === 0x50 && bytes[1] === 0x4b, `got ${bytes[0]},${bytes[1]}`);
check('every deck slide became a slide', slideCount === deck.slides.length, `${slideCount} vs ${deck.slides.length}`);
check('media deduplicated to the number of images used', mediaCount === photos.length, String(mediaCount));
check('file size is plausible', bytes.length > 20000, `${(bytes.length / 1024).toFixed(0)} KB`);

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

console.log('\nContent spot checks');
const relText = (() => {
  // re-open the zip with python for a couple of assertions about content
  const script = `
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
slides = [n for n in z.namelist() if n.startswith('ppt/slides/slide') and n.endswith('.xml')]
print('SLIDES', len(slides))
print('IMAGES', len([n for n in z.namelist() if n.startswith('ppt/media/')]))
for name in sorted(slides):
    xml = z.read(name).decode('utf8')
    print(name, 'TEXT_SAMPLES', xml.count('a:t'), 'PICS', xml.count('<p:pic>'), 'TABLES', xml.count('a:tbl>'))
`;
  return execFileSync('python3', ['-c', script, outFile], { encoding: 'utf8' });
})();
console.log(relText.split('\n').filter(Boolean).map((l) => `  ${l}`).join('\n'));

const pictureTotal = [...relText.matchAll(/PICS (\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
const textTotal = [...relText.matchAll(/TEXT_SAMPLES (\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
check('pictures were placed in the deck', pictureTotal >= photos.length, String(pictureTotal));
check('text was written (titles, captions, tables)', textTotal > 40, String(textTotal));
check('the summary table exists', /TABLES [1-9]/.test(relText), relText);

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`file: ${outFile}`);
process.exit(fail ? 1 : 0);
