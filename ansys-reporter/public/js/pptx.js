/* Ansys Report — PPTX writer.
 *
 * Builds a real .pptx (OOXML) with no dependencies: text, images and tables.
 * Runs in the browser (download straight from the page) and in Node (tests).
 *
 * Layout is driven by the deck model from report.js, so changing the template
 * changes the deck, and this file stays the same.
 */

import { zipSync } from './zip.js';

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_RT = 'http://schemas.openxmlformats.org/package/2006/relationships';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

const EMU_PER_INCH = 914400;
const hex = (c, fallback = '14171C') => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? String(c).slice(1) : fallback);

/* ───────────────────────── small XML builders ───────────────────────── */

function runProps({ sz = 1400, b = false, i = false, color = '14171C', font = 'Calibri' }) {
  return `<a:rPr lang="en-US" sz="${sz}"${b ? ' b="1"' : ''}${i ? ' i="1"' : ''} dirty="0">` +
    `<a:solidFill><a:srgbClr val="${hex(color)}"/></a:solidFill>` +
    `<a:latin typeface="${esc(font)}"/><a:cs typeface="${esc(font)}"/></a:rPr>`;
}

function paragraph(text, opts = {}) {
  const bullet = opts.bullet
    ? `<a:buFont typeface="Arial"/><a:buChar char="${esc(opts.bulletChar || '•')}"/>`
    : '<a:buNone/>';
  const pPr = `<a:pPr${opts.align ? ` algn="${opts.align}"` : ''}${opts.bullet ? ` marL="200025" indent="-200025"` : ''}>` +
    `${opts.spaceBefore ? `<a:spcBef><a:spcPts val="${opts.spaceBefore}"/></a:spcBef>` : ''}${bullet}</a:pPr>`;
  const lines = String(text ?? '').split('\n');
  return lines.map((line, idx) =>
    `<a:p>${idx === 0 ? pPr : pPr}<a:r>${runProps(opts)}<a:t>${esc(line)}</a:t></a:r></a:p>`
  ).join('');
}

function textBox({ id, x, y, w, h, paras, anchor = 't', font }) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="TextBox ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>` +
    paras.map((p) => paragraph(p.text, { font, ...p })).join('') +
    `</p:txBody></p:sp>`;
}

function picture({ id, rId, x, y, w, h, name }) {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${esc(name || `Picture ${id}`)}"/>` +
    `<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln w="6350"><a:solidFill><a:srgbClr val="D5D8DE"/></a:solidFill></a:ln></p:spPr></p:pic>`;
}

function tableShape({ id, x, y, w, h, table, font, headerFill = 'F0F1F4', border = 'D5D8DE' }) {
  const cols = table.columns || [];
  const rows = table.rows || [];
  if (!cols.length) return '';
  const colW = Math.floor(w / cols.length);
  const rowH = Math.max(228600, Math.min(457200, Math.floor(h / Math.max(1, rows.length + 1))));

  const grid = cols.map((_, i) => `<a:gridCol w="${i === cols.length - 1 ? w - colW * (cols.length - 1) : colW}"/>`).join('');

  const cell = (text, header) => {
    const fill = header ? headerFill : 'FFFFFF';
    return `<a:tc><a:txBody><a:bodyPr lIns="45720" rIns="45720" tIns="22860" bIns="22860" anchor="ctr"/><a:lstStyle/>` +
      `<a:p><a:pPr algn="l"/><a:r>${runProps({ sz: header ? 1000 : 1000, b: header, color: header ? '3C4452' : '14171C', font })}<a:t>${esc(text)}</a:t></a:r></a:p>` +
      `</a:txBody><a:tcPr marL="45720" marR="45720" marT="22860" marB="22860"><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` +
      `<a:lnB w="6350"><a:solidFill><a:srgbClr val="${border}"/></a:solidFill></a:lnB></a:tcPr></a:tc>`;
  };

  const trs = [`<a:tr h="${rowH}">${cols.map((c) => cell(c, true)).join('')}</a:tr>`]
    .concat(rows.map((r) => `<a:tr h="${rowH}">${cols.map((_, i) => cell(r[i] ?? '', false)).join('')}</a:tr>`))
    .join('');

  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/>` +
    `<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
    `<a:tbl><a:tblPr firstRow="0" bandRow="0"/><a:tblGrid>${grid}</a:tblGrid>${trs}</a:tbl>` +
    `</a:graphicData></a:graphic></p:graphicFrame>`;
}

/* ───────────────────────── geometry ───────────────────────── */

const W = 12192000, H = 6858000;
const M = 457200;                       // margin
const TITLE_H = 640080;
const CONTENT_TOP = M + TITLE_H + 91440;
const CONTENT_BOTTOM = H - M;
const CONTENT_W = W - 2 * M;
const CONTENT_H = CONTENT_BOTTOM - CONTENT_TOP;

function fitContain(box, ratio) {
  const boxRatio = box.w / box.h;
  let w, h;
  if (ratio > boxRatio) { w = box.w; h = Math.round(box.w / ratio); }
  else { h = box.h; w = Math.round(box.h * ratio); }
  return { x: Math.round(box.x + (box.w - w) / 2), y: Math.round(box.y + (box.h - h) / 2), w, h };
}

/* ───────────────────────── slide builders ───────────────────────── */

/* Attach the media entry AND keep the photo id: relFor() looks media up by id,
   and the id is not part of the media record itself. */
function resolveImages(slide, images) {
  return (slide.images || [])
    .map((im) => (images[im.photoId] ? { ...im, photo: { ...images[im.photoId], id: im.photoId } } : null))
    .filter(Boolean);
}

function slideBody(slide, ctx) {
  const { images, font, color, accent, theme: th } = ctx;
  const titleColor = th.title || color;
  const panelColor = th.panel || 'F2F5F8';
  const shapes = [];
  let id = 2;
  const nextId = () => ++id;
  const sizes = {
    title: th.titleSize || 2500,
    heading: th.headingSize || 1400,
    body: th.bodySize || 1100,
    caption: th.captionSize || 1000,
  };

  /* ── cover ─────────────────────────────────────────── */
  if (slide.layout === 'cover') {
    shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${nextId()}" name="Accent"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${M}" y="${Math.round(H * 0.30)}"/><a:ext cx="1371600" cy="45720"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${hex(accent)}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>` +
      `<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`);
    shapes.push(textBox({ id: nextId(), x: M, y: Math.round(H * 0.33), w: CONTENT_W, h: 400000,
      paras: [{ text: slide.eyebrow || '', sz: 1800, b: true, color: titleColor, font }] }));
    shapes.push(textBox({ id: nextId(), x: M, y: Math.round(H * 0.41), w: Math.round(CONTENT_W * 0.82), h: 1100000,
      paras: [{ text: slide.title || '', sz: sizes.title, b: true, color: titleColor, font }] }));
    const fields = slide.fields || [];
    if (fields.length) {
      shapes.push(textBox({
        id: nextId(), x: M, y: Math.round(H * 0.62), w: Math.round(CONTENT_W * 0.6), h: 1400000,
        paras: fields.flatMap(([k, v]) => ([
          { text: String(v), sz: sizes.body + 100, color, font, spaceBefore: 600 },
          { text: k, sz: 800, b: true, color: th.muted || '5A6472', font },
        ])),
      }));
    }
    if (slide.logo && images[slide.logo]) {
      const p = { ...images[slide.logo], id: slide.logo };
      const box = { x: W - M - 2286000, y: M, w: 2286000, h: 1371600 };
      const r = fitContain(box, p.width / p.height);
      shapes.push(picture({ id: nextId(), rId: ctx.relFor(p.id), x: r.x, y: r.y, w: r.w, h: r.h, name: 'Logo' }));
    }
    return shapes;
  }

  /* ── standard title bar ────────────────────────────── */
  shapes.push(textBox({ id: nextId(), x: M, y: M - 45720, w: CONTENT_W, h: TITLE_H, paras: [{ text: slide.title || '', sz: sizes.title, b: true, color: titleColor, font }], anchor: 'b' }));
  shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${nextId()}" name="Rule"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${M}" y="${M + TITLE_H - 45720}"/><a:ext cx="${CONTENT_W}" cy="12700"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${hex(accent)}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`);

  /* ── bullets (observations) ────────────────────────── */
  if (slide.layout === 'bullets') {
    const paras = (slide.bullets || []).map((b, i) => (
      slide.bulletStyle === 'paragraph'
        ? { text: b, sz: sizes.body + 200, color, font, spaceBefore: i ? 1200 : 0 }
        : { text: b, sz: sizes.body + 100, bullet: true, color, font, spaceBefore: i ? 600 : 0 }
    ));
    shapes.push(textBox({ id: nextId(), x: M + 45720, y: CONTENT_TOP + 228600, w: CONTENT_W - 91440, h: CONTENT_H - 457200, paras }));
    return shapes;
  }

  /* ── table (+ notes) ───────────────────────────────── */
  if (slide.layout === 'table') {
    const rows = slide.table?.rows?.length || 1;
    const tableH = Math.min(CONTENT_H * (slide.notes?.length ? 0.62 : 0.95), 274638 * (rows + 1) + 137160);
    shapes.push(tableShape({
      id: nextId(), x: M, y: CONTENT_TOP, w: CONTENT_W, h: tableH,
      table: slide.table, font, headerFill: panelColor, border: 'D5D8DE',
    }));
    const notes = (slide.notes || []).filter(Boolean);
    if (notes.length) {
      shapes.push(textBox({
        id: nextId(), x: M, y: CONTENT_TOP + tableH + 182880, w: CONTENT_W, h: CONTENT_H - tableH - 228600,
        paras: notes.map((n, i) => ({ text: n, sz: sizes.body, b: i === notes.length - 1 || i === notes.length - 3, color, font, spaceBefore: i ? 700 : 0 })),
      }));
    }
    if (slide.empty) {
      shapes.push(textBox({ id: nextId(), x: M, y: CONTENT_TOP + tableH + 182880, w: CONTENT_W, h: 300000,
        paras: [{ text: slide.empty, sz: sizes.caption, i: true, color: th.muted || '5A6472', font }] }));
    }
    return shapes;
  }

  /* ── figure row: label above, value line below, details as a strip ── */
  if (slide.layout === 'figure-row') {
    const figs = (slide.figures || []).map((f) => ({ ...f, photo: f.photoId ? images[f.photoId] : null }));
    const insets = (slide.insets || []).map((f) => ({ ...f, photo: f.photoId ? images[f.photoId] : null })).filter((f) => f.photo);
    const n = Math.max(1, figs.length);
    const gap = 228600;
    const each = Math.floor((CONTENT_W - gap * (n - 1)) / n);
    const labelH = 240000;
    const lineH = figs.some((f) => f.line) ? 300000 : 0;
    const stripH = insets.length ? Math.round(CONTENT_H * 0.3) : 0;
    const mainH = CONTENT_H - stripH - (stripH ? 137160 : 0);
    const imgH = mainH - labelH - lineH;

    figs.forEach((f, i) => {
      const x = M + i * (each + gap);
      if (f.label) {
        shapes.push(textBox({ id: nextId(), x, y: CONTENT_TOP, w: each, h: labelH,
          paras: [{ text: f.label, sz: sizes.caption + 100, b: true, color: titleColor, font }] }));
      }
      if (f.photo) {
        const box = { x, y: CONTENT_TOP + labelH, w: each, h: Math.max(300000, imgH) };
        const r = fitContain(box, f.photo.width / f.photo.height);
        shapes.push(picture({ id: nextId(), rId: ctx.relFor(f.photoId), x: r.x, y: r.y, w: r.w, h: r.h, name: f.label || 'Result' }));
      } else {
        shapes.push(textBox({
          id: nextId(), x, y: CONTENT_TOP + labelH, w: each, h: Math.max(300000, imgH),
          paras: [{ text: f.line || 'image missing', sz: sizes.body, i: true, color: th.muted || '5A6472', font }],
          anchor: 'ctr',
        }));
      }
      if (f.line && f.photo) {
        shapes.push(textBox({ id: nextId(), x, y: CONTENT_TOP + labelH + imgH + 45720, w: each, h: lineH,
          paras: [{ text: f.line, sz: sizes.caption, color, font }] }));
      }
    });

    if (insets.length) {
      const k = insets.length;
      const eachInset = Math.floor((CONTENT_W - gap * (k - 1)) / k);
      const y0 = CONTENT_TOP + mainH + 137160;
      if (slide.stripLabel) {
        shapes.push(textBox({ id: nextId(), x: M, y: y0 - 91440, w: CONTENT_W, h: 200000,
          paras: [{ text: slide.stripLabel, sz: 800, b: true, color: th.muted || '5A6472', font }] }));
      }
      insets.forEach((f, i) => {
        const x = M + i * (eachInset + gap);
        const box = { x, y: y0 + 100000, w: eachInset, h: Math.max(300000, stripH - 320000) };
        const r = fitContain(box, f.photo.width / f.photo.height);
        shapes.push(picture({ id: nextId(), rId: ctx.relFor(f.photoId), x: r.x, y: r.y, w: r.w, h: r.h, name: f.label || 'Detail' }));
        shapes.push(textBox({ id: nextId(), x, y: y0 + stripH - 180000, w: eachInset, h: 180000,
          paras: [{ text: f.label || '', sz: 800, color: th.muted || '5A6472', font }] }));
      });
    }
    return shapes;
  }

  /* ── figure + text (boundary conditions) ───────────── */
  if (slide.layout === 'figure-text') {
    const imgW = Math.round(CONTENT_W * (slide.photoId ? 0.6 : 0));
    if (slide.photoId && images[slide.photoId]) {
      const p = images[slide.photoId];
      const r = fitContain({ x: M, y: CONTENT_TOP, w: imgW, h: CONTENT_H }, p.width / p.height);
      shapes.push(picture({ id: nextId(), rId: ctx.relFor(slide.photoId), x: r.x, y: r.y, w: r.w, h: r.h, name: 'Boundary conditions' }));
    } else if (slide.missingImage) {
      shapes.push(textBox({ id: nextId(), x: M, y: CONTENT_TOP, w: Math.round(CONTENT_W * 0.6), h: 300000,
        paras: [{ text: slide.missingImage, sz: sizes.body, i: true, color: th.muted || '5A6472', font }] }));
    }
    const tx = slide.photoId ? M + imgW + 274320 : M;
    const tw = W - M - tx;
    shapes.push(textBox({ id: nextId(), x: tx, y: CONTENT_TOP, w: tw, h: 300000,
      paras: [{ text: slide.heading || '', sz: sizes.heading + 200, b: true, color: titleColor, font }] }));
    shapes.push(textBox({
      id: nextId(), x: tx, y: CONTENT_TOP + 320000, w: tw, h: CONTENT_H - 320000,
      paras: [{ text: slide.text || '', sz: sizes.body + 100, i: !!slide.placeholder, color: slide.placeholder ? (th.muted || '5A6472') : color, font }],
    }));
    return shapes;
  }

  /* ── grid (appendix) ───────────────────────────────── */
  if (slide.layout === 'grid') {
    const imgs = (slide.images || []).map((im) => ({ ...im, photo: images[im.photoId] })).filter((im) => im.photo);
    if (!imgs.length) {
      shapes.push(textBox({ id: nextId(), x: M, y: CONTENT_TOP, w: CONTENT_W, h: 300000,
        paras: [{ text: 'All supplied images were placed in the report.', sz: sizes.body, i: true, color: th.muted || '5A6472', font }] }));
      return shapes;
    }
    const cols = 3;
    const rowsN = Math.ceil(imgs.length / cols);
    const gap = 182880;
    const cw = Math.floor((CONTENT_W - gap * (cols - 1)) / cols);
    const ch = Math.floor((CONTENT_H - gap * (rowsN - 1)) / rowsN);
    imgs.forEach((im, i) => {
      const cx = M + (i % cols) * (cw + gap);
      const cy = CONTENT_TOP + Math.floor(i / cols) * (ch + gap);
      const r = fitContain({ x: cx, y: cy, w: cw, h: ch - 219456 }, im.photo.width / im.photo.height);
      shapes.push(picture({ id: nextId(), rId: ctx.relFor(im.photoId), x: r.x, y: r.y, w: r.w, h: r.h, name: im.label || 'Appendix' }));
      shapes.push(textBox({ id: nextId(), x: cx, y: cy + ch - 219456, w: cw, h: 200000,
        paras: [{ text: im.label || '', sz: 800, color: th.muted || '5A6472', font }] }));
    });
    return shapes;
  }

  return shapes;
}

/* ───────────────────────── package parts ───────────────────────── */

function contentTypes(slideCount, mediaExts) {
  const exts = new Set(mediaExts);
  return XML_HEAD +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    ([...exts].map((e) => `<Default Extension="${e}" ContentType="image/${e === 'jpg' ? 'jpeg' : e}"/>`).join('')) +
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
    Array.from({ length: slideCount }, (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('') +
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `</Types>`;
}

function rootRels() {
  return XML_HEAD +
    `<Relationships xmlns="${PKG_RT}">` +
    `<Relationship Id="rId1" Type="${RT}/officeDocument" Target="ppt/presentation.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
    `</Relationships>`;
}

function coreProps(meta = {}) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return XML_HEAD +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
    `xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${esc(meta.project || 'FEA Report')}</dc:title>` +
    `<dc:creator>${esc(meta.author || 'Ansys Report')}</dc:creator>` +
    `<cp:lastModifiedBy>${esc(meta.author || 'Ansys Report')}</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
    `</cp:coreProperties>`;
}

function presentation(slideCount, size = { w: W, h: H }) {
  const ids = Array.from({ length: slideCount }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${2 + i}"/>`).join('');
  return XML_HEAD +
    `<p:presentation xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}" saveSubsetFonts="1">` +
    `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    `<p:sldIdLst>${ids}</p:sldIdLst>` +
    `<p:sldSz cx="${size.w}" cy="${size.h}"/>` +
    `<p:notesSz cx="6858000" cy="9144000"/>` +
    `</p:presentation>`;
}

function presentationRels(slideCount) {
  const slides = Array.from({ length: slideCount }, (_, i) =>
    `<Relationship Id="rId${2 + i}" Type="${RT}/slide" Target="slides/slide${i + 1}.xml"/>`).join('');
  return XML_HEAD +
    `<Relationships xmlns="${PKG_RT}">` +
    `<Relationship Id="rId1" Type="${RT}/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
    slides +
    `<Relationship Id="rId${2 + slideCount}" Type="${RT}/theme" Target="theme/theme1.xml"/>` +
    `</Relationships>`;
}

function slideMaster() {
  const spTree = `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>`;
  return XML_HEAD +
    `<p:sldMaster xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}">` +
    `<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>${spTree}</p:cSld>` +
    `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
    `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
    `<p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="2400" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>` +
    `<p:bodyStyle><a:lvl1pPr><a:defRPr sz="1400"><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:bodyStyle>` +
    `<p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:otherStyle></p:txStyles>` +
    `</p:sldMaster>`;
}

function slideMasterRels() {
  return XML_HEAD + `<Relationships xmlns="${PKG_RT}">` +
    `<Relationship Id="rId1" Type="${RT}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
    `<Relationship Id="rId2" Type="${RT}/theme" Target="../theme/theme1.xml"/>` +
    `</Relationships>`;
}

function slideLayout() {
  const spTree = `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>`;
  return XML_HEAD +
    `<p:sldLayout xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}" type="blank" preserve="1">` +
    `<p:cSld name="Blank">${spTree}</p:cSld>` +
    `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

function slideLayoutRels() {
  return XML_HEAD + `<Relationships xmlns="${PKG_RT}">` +
    `<Relationship Id="rId1" Type="${RT}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
    `</Relationships>`;
}

function theme(font) {
  return XML_HEAD +
    `<a:theme xmlns:a="${A}" name="AnsysReport"><a:themeElements>` +
    `<a:clrScheme name="AnsysReport">` +
    `<a:dk1><a:srgbClr val="14171C"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>` +
    `<a:dk2><a:srgbClr val="3C4452"/></a:dk2><a:lt2><a:srgbClr val="F4F5F7"/></a:lt2>` +
    `<a:accent1><a:srgbClr val="B4232A"/></a:accent1><a:accent2><a:srgbClr val="1F6FB2"/></a:accent2>` +
    `<a:accent3><a:srgbClr val="2E7D5B"/></a:accent3><a:accent4><a:srgbClr val="C98A16"/></a:accent4>` +
    `<a:accent5><a:srgbClr val="6C5CE7"/></a:accent5><a:accent6><a:srgbClr val="8E44AD"/></a:accent6>` +
    `<a:hlink><a:srgbClr val="1F6FB2"/></a:hlink><a:folHlink><a:srgbClr val="6C5CE7"/></a:folHlink>` +
    `</a:clrScheme>` +
    `<a:fontScheme name="AnsysReport">` +
    `<a:majorFont><a:latin typeface="${esc(font)}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
    `<a:minorFont><a:latin typeface="${esc(font)}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>` +
    `</a:fontScheme>` +
    `<a:fmtScheme name="AnsysReport">` +
    `<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>` +
    `<a:lnStyleLst>` +
    `<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>` +
    `<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>` +
    `<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>` +
    `</a:lnStyleLst>` +
    `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
    `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>` +
    `</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

/* ───────────────────────── public entry point ───────────────────────── */

/**
 * @param {object} args
 *   deck  — { slides: [...] } from report.js
 *   media — Map/object: photoId → { bytes: Uint8Array, ext: 'jpg'|'png', width, height }
 *   meta  — cover metadata
 *   theme — { font, text, accent, background }
 * @returns {{ bytes: Uint8Array, slideCount: number, mediaCount: number }}
 */
export function buildPptx({ deck, media, meta = {}, theme: themeIn = {}, size = { w: W, h: H } }) {
  const slides = deck.slides || [];
  const font = themeIn.font || 'Calibri';
  const color = themeIn.text || '#14171C';
  const accent = themeIn.accent || '#B4232A';

  const mediaList = [];
  const mediaIndex = new Map();
  const mediaExts = new Set();

  const imagesForSlide = {};
  const slideParts = [];
  const slideRels = [];

  slides.forEach((slide, i) => {
    const used = [];
    const rels = [];
    let relCounter = 1;
    const relMap = new Map();

    // Self-registering: a picture may appear on several slides, and the slide
    // that uses a photo is not always the first one to mention it (appendix).
    const relFor = (photoId) => {
      const info = media[photoId];
      if (!info) return null;
      if (!mediaIndex.has(photoId)) {
        mediaIndex.set(photoId, mediaList.length);
        mediaList.push({ id: photoId, bytes: info.bytes, ext: info.ext || 'jpg' });
        mediaExts.add(info.ext || 'jpg');
      }
      if (!relMap.has(photoId)) {
        const mediaIdx = mediaIndex.get(photoId);
        const rId = `rId${++relCounter}`;
        relMap.set(photoId, rId);
        rels.push(`<Relationship Id="${rId}" Type="${RT}/image" Target="../media/image${mediaIdx + 1}.${info.ext}"/>`);
      }
      return relMap.get(photoId);
    };

    const shapes = slideBody(slide, { images: media, font, color, accent, theme: themeIn, relFor });

    imagesForSlide[i] = used;
    slideParts.push(XML_HEAD +
      `<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}">` +
      `<p:cSld><p:spTree>` +
      `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
      shapes.join('') +
      `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);

    slideRels.push(XML_HEAD + `<Relationships xmlns="${PKG_RT}">` +
      `<Relationship Id="rId1" Type="${RT}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
      rels.join('') + `</Relationships>`);
  });

  const parts = [
    { name: '[Content_Types].xml', data: contentTypes(slides.length, mediaExts) },
    { name: '_rels/.rels', data: rootRels() },
    { name: 'docProps/core.xml', data: coreProps(meta) },
    { name: 'ppt/presentation.xml', data: presentation(slides.length, size) },
    { name: 'ppt/_rels/presentation.xml.rels', data: presentationRels(slides.length) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: slideMaster() },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: slideMasterRels() },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: slideLayout() },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: slideLayoutRels() },
    { name: 'ppt/theme/theme1.xml', data: theme(font) },
  ];

  slideParts.forEach((xml, i) => {
    parts.push({ name: `ppt/slides/slide${i + 1}.xml`, data: xml });
    parts.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: slideRels[i] });
  });

  mediaList.forEach((m, i) => {
    parts.push({ name: `ppt/media/image${i + 1}.${m.ext}`, data: m.bytes });
  });

  return { bytes: zipSync(parts), slideCount: slides.length, mediaCount: mediaList.length };
}
