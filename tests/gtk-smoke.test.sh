#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v gjs >/dev/null || ! command -v xvfb-run >/dev/null; then
  if [[ "${SUSHI_GTK_SMOKE_REQUIRED:-0}" == 1 ]]; then
    echo 'GTK smoke checks require gjs and xvfb-run.' >&2
    exit 1
  fi
  echo 'Skipped GTK smoke checks (gjs or xvfb-run is unavailable).'
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
printf 'gene,value\nTP53,1\nMYC,2\n' > "$tmp/input.csv"

sed -e 's/const Renderer = imports.ui.renderer;/const Renderer = {Renderer: {}};/' \
    -e 's/Implements: \[Renderer\.Renderer\]/Implements: []/' \
    "$ROOT/dist/bioinfo-table-50.js" > "$tmp/table50_smoke.js"
xvfb-run -a gjs "$ROOT/tests/gtk-smoke-50.js" "$tmp" "$tmp/input.csv"

sed -e "s|import {Renderer, ResizePolicy} from 'resource://org/gnome/NautilusPreviewer/plugin-api-1.js';|const Renderer = {}; const ResizePolicy = {NAT_SIZE: 0};|" \
    -e "s|from 'gi://Gtk';|from 'gi://Gtk?version=4.0';|" \
    -e 's/Implements: \[Renderer\]/Implements: []/' \
    "$ROOT/dist/bioinfo-table-51.js" > "$tmp/table51_smoke.mjs"
xvfb-run -a gjs --module "$ROOT/tests/gtk-smoke-51.mjs" "$tmp/table51_smoke.mjs" "$tmp/input.csv"
