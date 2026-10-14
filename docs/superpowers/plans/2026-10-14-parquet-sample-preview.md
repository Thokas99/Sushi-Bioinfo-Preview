# Parquet Sample Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a bounded, read-only preview of the first stored rows of valid Parquet files in the existing GTK3 and GTK4 tables.

**Architecture:** Bundle pinned Hyparquet and its codec pack into the existing self-contained plugins. A shared async core validates compact-Thrift footer and page structures before handing bounded ranges to Hyparquet, then formats one selected top-level column at a time. Each GTK loader supplies a seekable, cancellable GIO byte-range reader and reuses the existing table model.

**Tech Stack:** GJS, GTK3/GTK4, GIO, Hyparquet 1.28.1, hyparquet-compressors 1.1.1, esbuild, hyparquet-writer 0.16.12 for synthetic fixtures, Node.js tests, Python build script.

**Spec:** `docs/superpowers/specs/2026-10-14-parquet-sample-preview-design.md`

## Global Constraints

- Read only Parquet files; never write to preview inputs.
- Read footer and required column pages through a seekable range reader; no whole-file fallback.
- Preview first 10,000 rows and at most 128 top-level columns.
- Cap footer bytes, cumulative fetched bytes, one uncompressed page, and retained display text at `LIMITS.bytes` (16 MiB).
- Cap page value counts at `LIMITS.cells` (1,280,000); compact-Thrift containers at 100,000 entries and 64 levels.
- Preserve 512-character fields, 10,000-row, 128-column, and 1,280,000-cell limits.
- Use existing GTK table UI; keep H5AD behavior unchanged.
- Report metadata row count as metadata-reported; identify rows as the first stored records, not random or representative, and do not imply whole-file validation.
- Keep runtime plugins self-contained and offline; preserve third-party license notices.

## Review Focus

- Footer length or compact-Thrift container count claims a huge allocation: reject before the metadata parser sees it; covered by `rejects an oversized footer and list count`.
- Deeply nested metadata or a page header exceeds the depth/size limit: reject with a preview error; covered by `rejects deep metadata and oversized page headers`.
- Page declares more than `LIMITS.cells` values: reject before Hyparquet allocates decoded arrays; covered by `rejects excessive page values before decode`.
- A GIO source cannot seek or a requested range is outside the file: show an unsupported/error message without fetching the entire file; covered by GTK reader smoke cases.
- Cancellation during range I/O: release the stream/cache and do not render stale rows; covered by GTK reader smoke cases.

---

### Task 1: Add bounded Parquet core and bundled parser

**Files:**
- Create: `src/parquet-core.js`
- Modify: `package.json`, `package-lock.json`, `build.py`, `tests/run.sh`, `.github/workflows/ci.yml`
- Create: `tests/parquet.test.mjs`
- Create: `THIRD_PARTY_NOTICES.md`
- Modify: `tests/fixtures/` only if binary fixtures are needed; generated fixtures must contain synthetic values.

**Interfaces:**
- Consumes: `LIMITS` from `src/table-core.js`; Hyparquet exports `parquetMetadata`, `parquetSchema`, and `parquetRead`; codec pack `compressors`.
- Produces: `export async function parquetPreview({size, readRange, isCancelled})` returning the existing table shape (`kind`, `headers`, `rows`, `notes`, limit flags). It reads and validates footer ranges, selects top-level columns and row groups for the first `LIMITS.tableRows`, pre-validates page headers/value counts, and decodes/formats columns sequentially.

- [x] Add pinned runtime and build dependencies; add pinned `hyparquet-writer` only for synthetic tests.
- [x] Write synthetic tests for exact header/row order, metadata count, uncompressed/Snappy/ZSTD values, nested bounded text, row/column/cell/field/text caps, cancellation, invalid footer, and malicious footer/page lengths/counts.
- [x] Implement bounded compact-Thrift validation and `parquetPreview` in `src/parquet-core.js`; reject before parser allocations or decompression when any cap is exceeded.
- [x] Bundle the core and its dependencies into both generated table plugins from `build.py`, retaining upstream license comments/notices.
- [x] Run `node --test tests/parquet.test.mjs`; all cases pass.

### Task 2: Connect seekable GIO readers to both table plugins

**Files:**
- Modify: `src/table-50.template.js`
- Modify: `src/table-51.js`
- Modify: `tests/gtk-smoke-50.js`, `tests/gtk-smoke-51.mjs` only for reader/cancellation cases.

**Interfaces:**
- Consumes: `parquetPreview` from Task 1; each plugin's existing `Gio.Cancellable`, `markReady`/`_readyNow`, `_renderTable`, and `_message` paths.
- Produces: GTK3 callback-based and GTK4 promise-based range readers that check file bounds, `can_seek()`, cancellation, and the cumulative byte cap; Parquet results pass through the existing table renderer.

- [x] Add GTK3 and GTK4 success-path smoke cases for synthetic Parquet previews; core tests cover malformed ranges and cancellation.
- [x] Add the smallest GIO range adapters and dispatch only `.parquet` to `parquetPreview`; retain H5AD signature-only behavior.
- [x] Set the existing hint and tooltip to describe the bounded read and first stored rows with metadata-reported count.
- [x] Run GTK smoke tests in CI; local execution was skipped because GJS and Xvfb are unavailable.

### Task 3: Update docs, generated plugins, and release checks

**Files:**
- Modify: `README.md`
- Regenerate: `dist/bioinfo-table-50.js`, `dist/bioinfo-table-51.js`
- Modify: `tests/formats.test.mjs`, `tests/build.test.sh`, and license notices as required by the bundle.

- [x] Update the supported-format and limits text to describe the first-record sample and reported metadata count.
- [x] Regenerate committed `dist/` files with `python3 build.py`.
- [x] Run `npm test`, `python3 build.py`, and `node --check` on generated plugins; GTK smoke tests are configured as required in CI.
- [x] Run GitNexus `detect_changes` with `scope: all`; reviewed the eight affected flows and they follow the intended table load, render, ready, error, and copy paths.
- [x] Commit the implementation and push the requested GitHub update.
