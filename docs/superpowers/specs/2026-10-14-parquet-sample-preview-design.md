# Parquet sample preview design

**Date:** 2026-10-14  
**Status:** Implemented; the required GitHub CI GTK smoke checks pass.

## Goal

Opening a valid `.parquet` file in Sushi should show a small, read-only table of its first records using the existing GTK table. The preview is descriptive: it must not imply that the complete file was read, validated, or that the first records are representative of the dataset.

## Design

Use pinned, MIT-licensed Hyparquet and its codec pack as vendored build inputs, bundled into the existing self-contained GTK3 and GTK4 table plugins. They add no runtime install or network access. The codec pack covers Parquet's standard compression codecs; Hyparquet exposes row- and column-bounded reads and an asynchronous byte-range interface. The official format stores metadata after the column data, so the current 64-byte prefix check cannot produce rows. [Hyparquet reader](https://github.com/hyparam/hyparquet), [codec pack](https://github.com/hyparam/hyparquet-compressors), [Parquet file format](https://parquet.apache.org/docs/file-format/).

The GTK loaders provide a GIO-backed asynchronous range reader for the existing local file. It validates offsets and requested lengths, checks whether the stream supports seeking, and reads only the footer and pages required for the sample. A non-seekable source gets a clear unsupported-preview message; it must not fall back to reading the entire file. The shared format layer reads the schema, then decodes selected top-level columns sequentially to avoid holding every column's decoded page at once. It requests the first 10,000 rows and at most 128 columns and adapts the result to the table model already used by CSV and genomic formats. Scalar values become text; nested values use a bounded textual representation.

Every trust boundary remains bounded before allocation: cap footer bytes, cumulative fetched bytes, an individual uncompressed page, and retained UTF-8 display text at the existing 16 MiB `LIMITS.bytes`; cap page value counts at `LIMITS.cells`; cap recursive metadata parsing at 100,000 container entries and 64 levels; and enforce the existing 10,000-row, 128-column, 512-character-field, and 1,280,000-cell limits. Reject malformed or over-limit footer/page structures with a short preview error. Do not silently skip data or claim a successful complete preview after a decoding error. Keep both plugin routes asynchronous and release retained buffers on cancellation or cleanup. Cancellation is checked at I/O boundaries and before rendering; one synchronous page decode may finish before cancellation is observed.

The existing table hint and tooltip carry the scope: these are the first records in stored order, up to the preview limits; any reported total comes from file metadata; this is not whole-file validation or a representative/random sample. No new controls or layout are added. H5AD behavior remains unchanged.

## Test and acceptance criteria

- Add small synthetic fixtures covering uncompressed, Snappy, and ZSTD values, plus a nested value represented as bounded text.
- Assert exact headers and first-row values, deterministic source order, metadata-reported row count, row/column/field/cell caps, cancellation, bad signatures/footer lengths, and oversized metadata containers/page sizes/value counts rejected before large allocation.
- Run the existing test suite, reproducible build checks, `node --check` on generated plugins, and GTK3/GTK4 smoke tests. Test install/uninstall only with temporary home directories.
- Update the supported-format table and preview limits so they describe sampling and its evidence limits, not full validation.
- Verify generated `dist/` files match sources and retain notices for all vendored code.

## Out of scope

No Parquet querying, filtering, pagination, schema browser, new table controls, changes to H5AD, or edits to input files. This preview does not certify Parquet conformance and does not claim that a bounded sample describes the full dataset.

## Implementation risk to resolve

Hyparquet allocates decoded page buffers using page-header sizes. The integration must guard declared page sizes and value counts before those allocations, and tests must demonstrate rejection of malicious sizes. If the pinned reader cannot be bounded at that point without a broad fork, stop and revise this design before shipping.
