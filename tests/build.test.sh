#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
expected='bioinfo-document-50.js bioinfo-document-51.js bioinfo-office-50.js bioinfo-office-51.js bioinfo-table-50.js bioinfo-table-51.js'
actual="$(cd "$ROOT/dist" && printf '%s ' bioinfo-*.js)"
actual="${actual% }"
[[ "$actual" == "$expected" ]] || { echo "Unexpected distribution files: $actual" >&2; exit 1; }
(cd "$ROOT" && sha256sum dist/*.js) > "$tmp/before"
python3 "$ROOT/build.py" >/dev/null
(cd "$ROOT" && sha256sum dist/*.js) > "$tmp/after"
cmp "$tmp/before" "$tmp/after"
echo 'Generated distribution is reproducible.'
