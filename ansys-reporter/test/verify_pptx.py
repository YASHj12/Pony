#!/usr/bin/env python3
"""Structural validator for a generated .pptx (stdlib only).

Checks, in the order PowerPoint would:
  1. the file is a readable ZIP and no entry is corrupt
  2. every XML part is well-formed
  3. the parts a presentation needs are all present
  4. every part is declared in [Content_Types].xml
  5. every relationship target exists, and every slide references a layout
  6. every image referenced by a slide exists in the package
  7. every slide is listed in presentation.xml

Exit code 0 = valid, 1 = problem (problems are printed).
"""
import sys
import zipfile
import posixpath
import xml.etree.ElementTree as ET

CT = '{http://schemas.openxmlformats.org/package/2006/content-types}'
PR = '{http://schemas.openxmlformats.org/package/2006/relationships}'
REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

errors = []
warnings = []


def fail(msg):
    errors.append(msg)


def main(path):
    try:
        zf = zipfile.ZipFile(path)
    except Exception as e:                                   # noqa: BLE001
        print(f'FATAL: not a zip: {e}')
        return 1

    bad = zf.testzip()
    if bad:
        fail(f'corrupt zip entry: {bad}')

    names = set(zf.namelist())

    # 2. XML well-formedness
    trees = {}
    for name in sorted(names):
        if name.endswith('.xml') or name.endswith('.rels'):
            try:
                trees[name] = ET.fromstring(zf.read(name))
            except ET.ParseError as e:
                fail(f'XML parse error in {name}: {e}')

    # 3. required parts
    required = [
        '[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml',
        'ppt/_rels/presentation.xml.rels', 'ppt/slideMasters/slideMaster1.xml',
        'ppt/slideMasters/_rels/slideMaster1.xml.rels',
        'ppt/slideLayouts/slideLayout1.xml',
        'ppt/slideLayouts/_rels/slideLayout1.xml.rels', 'ppt/theme/theme1.xml',
    ]
    for part in required:
        if part not in names:
            fail(f'missing required part: {part}')

    if errors:
        report()
        return 1

    # 4. content types cover every part
    ct = trees['[Content_Types].xml']
    defaults = {d.get('Extension').lower(): d.get('ContentType') for d in ct.findall(f'{CT}Default')}
    overrides = {o.get('PartName'): o.get('ContentType') for o in ct.findall(f'{CT}Override')}
    for name in sorted(names):
        if name == '[Content_Types].xml' or name.endswith('/'):
            continue
        ext = name.rsplit('.', 1)[-1].lower()
        if f'/{name}' in overrides:
            continue
        if ext in defaults:
            continue
        fail(f'part not covered by [Content_Types].xml: {name}')

    # 5. relationship targets resolve
    rel_files = [n for n in names if n.endswith('.rels')]
    for relname in sorted(rel_files):
        base = posixpath.dirname(posixpath.dirname(relname))
        root = trees[relname]
        for rel in root.findall(f'{PR}Relationship'):
            target = rel.get('Target')
            if rel.get('TargetMode') == 'External' or not target:
                continue
            resolved = posixpath.normpath(posixpath.join(base, target))
            if resolved not in names:
                fail(f'{relname}: relationship target missing -> {resolved}')

    # 6. slides ↔ layout, images
    slides = sorted(n for n in names if n.startswith('ppt/slides/slide') and n.endswith('.xml'))
    for slide in slides:
        relname = f'ppt/slides/_rels/{posixpath.basename(slide)}.rels'
        if relname not in names:
            fail(f'{slide} has no relationships part')
            continue
        rels = {r.get('Id'): r for r in trees[relname].findall(f'{PR}Relationship')}
        types = [r.get('Type') for r in rels.values()]
        if not any(t.endswith('/slideLayout') for t in types):
            fail(f'{slide}: no slideLayout relationship')
        root = trees[slide]
        for blip in root.iter('{http://schemas.openxmlformats.org/drawingml/2006/main}blip'):
            rid = blip.get(f'{{{REL_NS}}}embed')
            if rid not in rels:
                fail(f'{slide}: image relationship {rid} not declared')
            elif not rels[rid].get('Type').endswith('/image'):
                fail(f'{slide}: {rid} is not an image relationship')

    # 7. presentation lists every slide
    pres = trees['ppt/presentation.xml']
    ns_p = '{http://schemas.openxmlformats.org/presentationml/2006/main}'
    listed = {sld.get(f'{{{REL_NS}}}id') for sld in pres.iter(f'{ns_p}sldId')}
    pres_rels = {r.get('Id'): r.get('Target') for r in trees['ppt/_rels/presentation.xml.rels'].findall(f'{PR}Relationship')}
    for rid in listed:
        if rid not in pres_rels:
            fail(f'presentation.xml references {rid}, not found in its rels')
            continue
        target = 'ppt/' + posixpath.normpath(pres_rels[rid])
        if target not in names:
            fail(f'presentation.xml -> {target} missing')
    if len(listed) != len(slides):
        warnings.append(f'{len(slides)} slide parts but {len(listed)} listed in presentation.xml')

    # extra: an image part that nothing references is wasted space
    referenced = set()
    for relname in rel_files:
        base = posixpath.dirname(posixpath.dirname(relname))
        for rel in trees[relname].findall(f'{PR}Relationship'):
            if (rel.get('Target') or '').startswith('../media/') or '/media/' in (rel.get('Target') or ''):
                referenced.add(posixpath.normpath(posixpath.join(base, rel.get('Target'))))
    unused = [n for n in names if n.startswith('ppt/media/') and n not in referenced]
    for u in unused:
        warnings.append(f'unreferenced media part: {u}')

    report()
    return 1 if errors else 0


def report():
    for w in warnings:
        print(f'WARN: {w}')
    for e in errors:
        print(f'FAIL: {e}')
    if not errors:
        print('OK: pptx structure valid')


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
