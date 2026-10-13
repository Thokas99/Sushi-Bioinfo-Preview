# Project notes for contributors and coding agents

Sushi Bioinfo Preview is a read-only GNOME Sushi plugin for bounded inspection of scientific tables and selected documents. Keep it small, native to GTK, and predictable; do not add analysis features or dependencies without a concrete need.

## Architecture

- `src/` is the editable source. GTK3 plugins target the legacy Sushi `viewers` API; GTK4 plugins target the Sushi 51+ `plugins-1` API.
- `src/*-core.js` contains shared parsing and formatting logic without GTK dependencies.
- `python3 build.py` embeds shared sources into the self-contained, committed files in `dist/`. Rebuild `dist/` after every source change.
- `mime/` registers only the project-specific types. Do not claim full H5AD or Parquet parsing: these formats receive signature checks only.
- `install.sh` and `uninstall.sh` modify user-level Sushi and MIME files. Test them only with temporary home directories.

## Conventions and safety

- Prefer GTK's native widgets, models, scrolling, sorting, and lifecycle. Preserve Sushi keyboard and window behavior.
- Keep reads, decompression, rows, columns, fields, and document extraction bounded. Do not materialize sparse matrices densely or execute document content.
- Treat all preview files as untrusted. Preserve cancellation, parse errors, and size checks; never write to previewed inputs.
- Keep source and generated distribution files consistent. Do not add a framework or dependency for a small helper.
- Examples and fixtures must be synthetic; never add patient or study data.

## Build and checks

Run `npm test` for parser, limits, MIME, build reproducibility, and mocked install/uninstall checks. Run `python3 build.py` and `for file in dist/*.js; do node --check "$file"; done` after source changes. Live GTK rendering still needs a GNOME session.

When a GitNexus index is available, inspect callers and impact before changing a function; confirm `UNKNOWN` results with text search. Run graph change detection before any commit. Do not install or bootstrap GitNexus just for this project.
