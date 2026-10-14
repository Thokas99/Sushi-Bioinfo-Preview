#!/usr/bin/env python3
"""Create self-contained Sushi GTK3 and GTK4 viewers from shared JS cores."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'dist'
OUT.mkdir(exist_ok=True)

def embed(name):
    source = (ROOT / 'src' / name).read_text()
    if name == 'format-core.js':
        source = source.replace("import {LIMITS} from './table-core.js';\n", '')
    return source.replace('export const', 'const').replace('export function', 'function')

cores = {'CORE': embed('table-core.js'), 'FORMAT': embed('format-core.js'),
         'DOC': embed('document-core.js'),
         'OFFICE': embed('office-core.js') + '\n' + (ROOT / 'src/office-style.js').read_text()}
esbuild = ROOT / 'node_modules/.bin/esbuild'
if not esbuild.is_file():
    raise SystemExit('Install the pinned JavaScript dependencies with npm ci before building.')
with tempfile.TemporaryDirectory() as tmp:
    bundle = Path(tmp) / 'parquet-core.js'
    subprocess.run([str(esbuild), str(ROOT / 'src/parquet-core.js'), '--bundle',
                    '--platform=browser', '--format=iife', '--global-name=ParquetSupport',
                    '--target=es2022', '--legal-comments=none', f'--outfile={bundle}'],
                   cwd=ROOT, check=True)
    notice = (ROOT / 'THIRD_PARTY_NOTICES.md').read_text().replace('*/', '* /')
    cores['PARQUET'] = f'/*\n{notice}\n*/\n{bundle.read_text()}'
for target in ('table', 'document', 'office'):
    for version in (50, 51):
        name = f'{target}-{version}'
        file = ROOT / 'src' / (f'{name}.template.js' if version == 50 else f'{name}.js')
        source = file.read_text()
        markers = ('CORE', 'FORMAT', 'PARQUET') if target == 'table' else (('DOC',) if target == 'document' else ('OFFICE',))
        for marker in markers:
            placeholder = f'/* EMBED_{marker}_HERE */'
            assert source.count(placeholder) == 1, (file, placeholder)
            source = source.replace(placeholder, cores[marker])
        (OUT / f'bioinfo-{target}-{version}.js').write_text(source)
print('Built six self-contained Sushi viewers.')
