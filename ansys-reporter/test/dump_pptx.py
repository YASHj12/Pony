#!/usr/bin/env python3
"""Dump the text, picture and table content of each slide, for test assertions."""
import re
import sys
import zipfile


def main(path):
    z = zipfile.ZipFile(path)
    slides = sorted(
        [n for n in z.namelist() if re.match(r'ppt/slides/slide\d+\.xml$', n)],
        key=lambda n: int(re.search(r'(\d+)', n.split('/')[-1]).group(1)),
    )
    for name in slides:
        xml = z.read(name).decode('utf8')
        texts = re.findall(r'<a:t>([^<]*)</a:t>', xml)
        print('SLIDE', name.split('/')[-1])
        print('  PICS', xml.count('<p:pic>'), 'TABLES', xml.count('<a:tbl>'), 'TEXTS', len(texts))
        print('  TEXT', ' | '.join(texts[:18]))


if __name__ == '__main__':
    main(sys.argv[1])
