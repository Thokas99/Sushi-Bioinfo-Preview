#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

python3 build.py
bash -n install.sh uninstall.sh tests/*.sh
node tests/limits.test.mjs
node tests/layout.test.mjs
node tests/no-filter.test.mjs
node tests/core.test.mjs
node tests/formats.test.mjs
node --test tests/parquet.test.mjs
node tests/table-budget.test.mjs
node tests/documents.test.mjs
node tests/office.test.mjs
node tests/office-style.test.mjs
bash tests/install.test.sh
bash tests/mime.test.sh
bash tests/build.test.sh
for file in dist/*.js; do node --check "$file"; done
bash tests/gtk-smoke.test.sh
