#!/usr/bin/env python3
"""Create self-contained Sushi GTK3 and GTK4 viewers from shared JS cores."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'dist'
OUT.mkdir(exist_ok=True)

def embed(name):
    source = (ROOT / 'src' / name).read_text()
    if name == 'format-core.js':
        source = source.replace("import {LIMITS} from './table-core.js';\n", '')
    return source.replace('export const', 'const').replace('export function', 'function')

cores = {'CORE': embed('table-core.js'), 'FORMAT': embed('format-core.js'),
         'DOC': embed('document-core.js')}
for target in ('table', 'document'):
    for version in (50, 51):
        name = f'{target}-{version}'
        file = ROOT / 'src' / (f'{name}.template.js' if version == 50 else f'{name}.js')
        source = file.read_text()
        markers = ('CORE', 'FORMAT') if target == 'table' else ('DOC',)
        for marker in markers:
            placeholder = f'/* EMBED_{marker}_HERE */'
            assert source.count(placeholder) == 1, (file, placeholder)
            source = source.replace(placeholder, cores[marker])
        (OUT / f'bioinfo-{target}-{version}.js').write_text(source)
print('Built four self-contained Sushi viewers.')
