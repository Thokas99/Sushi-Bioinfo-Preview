#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
command -v update-mime-database >/dev/null || {
  echo 'shared-mime-info (update-mime-database) is required for MIME tests' >&2
  exit 1
}
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/data/mime/packages"
cp "$ROOT/mime/sushi-bioinfo-preview.xml" "$tmp/data/mime/packages/"
XDG_DATA_HOME="$tmp/data" update-mime-database "$tmp/data/mime" >/dev/null
globs="$tmp/data/mime/globs2"
for pattern in '*.vcf' '*.bed' '*.mtx' '*.gff3' '*.gtf' '*.h5ad' '*.parquet' '*.md'; do
  grep -Fq ":$pattern" "$globs" || { echo "Missing MIME glob: $pattern" >&2; exit 1; }
done
if grep -Eq ':\*\.(html|htm|gz|bgz|bgzf|zip)$' "$globs"; then
  echo 'MIME file must not override Sushi HTML or archive handling' >&2
  exit 1
fi
echo 'MIME XML compiled and expected file registrations confirmed.'
