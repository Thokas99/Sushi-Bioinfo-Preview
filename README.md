# Sushi Bioinfo Preview

[![CI](https://github.com/Thokas99/Sushi-Bioinfo-Preview/actions/workflows/ci.yml/badge.svg)](https://github.com/Thokas99/Sushi-Bioinfo-Preview/actions/workflows/ci.yml)

Read-only, bounded previews of scientific tables, genomic files, Markdown, and selected office documents in GNOME Files (Nautilus). Select a file and press **Space** to preview it with GNOME Sushi.

## Overview

Nautilus asks Sushi to preview the selected file. Sushi identifies its MIME type and loads the matching project plugin. The plugin reads a limited prefix or selected document parts, then presents the extracted content in native GTK widgets. The preview does not edit the file or perform scientific analysis.

The project is for quick inspection: check a table's columns, glance at variant or interval records, or read text from a document before opening it in a full editor. It is not a spreadsheet editor, a dataset validator, or a replacement for LibreOffice, Scanpy, Seurat, or format-specific command-line tools.

## Features

- Native GTK tables with sortable columns, continuous vertical scrolling, and horizontal scrolling when needed.
- Quote-aware CSV/TSV parsing, including escaped quotes and multiline fields.
- Format-aware views for VCF, BED-family intervals, GFF/GTF annotations, and Matrix Market files.
- Bounded text extraction for selected Office Open XML and OpenDocument files.
- A restricted, local Markdown preview with a source view; HTML remains with Sushi's normal handler.
- Asynchronous, cancellable file reads and limits on bytes, rows, columns, and extracted document content.
- Sorting is limited to rows already loaded into the preview; it does not scan the source file again.

## Supported formats

| Format | Preview | Limits and interpretation |
|---|---|---|
| CSV, TSV | Table with delimiter detection and quoted-field parsing | Uses a bounded file prefix; multiline quoted values are supported. Headers are inferred from the first row. No formulas, editing, or whole-file validation. |
| VCF | Header and variant fields, including sample columns when present | Metadata lines are skipped; sample/genotype fields are displayed as text, not interpreted. POS is 1-based. Only the loaded prefix is inspected. |
| BED, bedGraph, narrowPeak, broadPeak | Positional interval fields | BED start/end convention is 0-based, half-open. Additional columns are displayed as generic text; records are not schema-validated. |
| GFF, GFF3, GTF | The nine standard fields | Attributes remain text and are not expanded. Coordinates are 1-based inclusive. Sequence data after `##FASTA` is skipped; unexpected extra fields may appear under generic column names. |
| MTX (Matrix Market) | Recognized coordinate or array entries and declared dimensions | Supports recognized integer, real, complex, and coordinate-pattern banners. Coordinate indices are 1-based. Counts and values are not fully validated; symmetry is not expanded and sparse entries are not made dense. |
| H5AD | HDF5 signature recognition; GTK4 shows file size when recognized | Checks only the HDF5 signature at byte zero. It does not read AnnData dimensions, observations, variables, or layers. |
| Parquet | Leading-signature recognition; GTK4 shows file size when recognized | Checks only leading `PAR1`. It does not read the footer, schema, row groups, or row count. |
| DOCX, DOCM, XLSX, XLSM, PPTX, PPTM, ODT, OTT | Bounded text extraction in a GTK text view | XLSX/XLSM reads `sheet1.xml`, up to 80 rows and 16 stored cells per row; cell coordinates and formulas are not reconstructed. PPTX/PPTM reads up to 3 slides. Word/OpenDocument text is capped at 240 displayed blocks. Layout, images, charts, and equations are not reproduced; macros are not executed. ZIP CRC values are not checked. |
| Markdown (`.md`, `.markdown`, `.mdown`) | Restricted local rendering with a source view | Supports common Markdown constructs, not the full CommonMark/GFM specifications. Links do not navigate; scripts and network resources are disabled. |
| HTML, PDF, compressed files, other formats | Not handled by this extension | Sushi's built-in renderer or fallback decides the preview. For example, `.vcf.gz` is not parsed as a VCF table by this extension. |

H5AD and Parquet support is signature recognition only, not scientific metadata or table parsing. These previews and the genomic tables are not file validators: malformed, ragged, or truncated input can produce partial or misleading displays. Use format-aware software to validate or analyze the complete file.

## Installation

The installer targets an existing user-accessible GNOME Sushi Flatpak (`org.gnome.NautilusPreviewer`). It installs plugins in the Flatpak's per-user data directory and registers project-specific MIME types in the host and Flatpak user MIME databases. Root access, Python, Node.js, LibreOffice, and extra Flatpak permissions are not required for installation or preview.

```bash
git clone https://github.com/Thokas99/Sushi-Bioinfo-Preview.git
cd Sushi-Bioinfo-Preview
bash install.sh
flatpak kill org.gnome.NautilusPreviewer 2>/dev/null || true
```

The installer requires `flatpak` and `update-mime-database` from `shared-mime-info`. It routes Sushi 46–50 to the legacy GTK3 `viewers` directory and Sushi 51 or later to the GTK4 `plugins-1` directory. Automated tests exercise this routing with mocked Sushi 50.0 and 51.1 versions; they do not prove that the plugin renders correctly in a live Sushi session. Other Sushi versions have not been tested here.

Host MIME data follows `XDG_DATA_HOME` when set, otherwise `~/.local/share`. The uninstaller restores saved files when installed copies are still unchanged and preserves files changed after installation:

```bash
bash uninstall.sh
flatpak kill org.gnome.NautilusPreviewer 2>/dev/null || true
```

Backups are stored under `~/.var/app/org.gnome.NautilusPreviewer/data/sushi/bioinfo-preview-backup/`. When upgrading from the older optional v7 host bridge, installation removes its known helper and revokes that bridge's specific Flatpak permission. Uninstall does not re-grant the deprecated permission.

## Usage

In Nautilus, select a supported file and press **Space**. Use column headers to sort the rows currently loaded. Sushi manages the preview window and its keyboard shortcuts.

Synthetic examples in [`examples/`](examples/) can be used to try CSV, TSV, VCF, BED, GFF3, and MTX previews. They contain no real biological observations.

## Performance and limits

Table previews default to a **16 MiB file prefix, 10,000 data rows, 128 columns, and 512 characters per parsed field**. Displayed table cells are shortened to 180 characters. Markdown reads up to 256 KiB. Office archives are limited to 12 MiB; each selected XML member is limited to 512 KiB, with a 1.5 MiB cumulative expanded-XML budget. H5AD and Parquet recognition reads at most 64 bytes.

The table is built from the beginning of the file, not a random sample of the complete dataset. Later records and columns may be absent, and sorting applies only to the loaded rows. Reads are asynchronous and cancellable, but parsing and GTK model construction run on the UI thread. Table models retain the parsed rows in memory, so their memory use can exceed the bytes read, especially for wide files or raised limits. Very large previews or remote storage such as SSHFS may briefly delay interaction.

For the Sushi Flatpak, these per-user environment variables can raise the table caps. Values are clamped at 64 MiB, 25,000 rows, and 256 columns:

```bash
flatpak override --user \
  --env=SUSHI_BIOINFO_MAX_MIB=32 \
  --env=SUSHI_BIOINFO_MAX_ROWS=20000 \
  --env=SUSHI_BIOINFO_MAX_COLUMNS=192 \
  org.gnome.NautilusPreviewer
flatpak kill org.gnome.NautilusPreviewer 2>/dev/null || true
```

Unset the variables to restore the defaults:

```bash
flatpak override --user --unset-env=SUSHI_BIOINFO_MAX_MIB org.gnome.NautilusPreviewer
flatpak override --user --unset-env=SUSHI_BIOINFO_MAX_ROWS org.gnome.NautilusPreviewer
flatpak override --user --unset-env=SUSHI_BIOINFO_MAX_COLUMNS org.gnome.NautilusPreviewer
```

Raising limits can increase preview time and memory use. Sorting does not extend the read limit or trigger a full-file scan.

## Development

There are no npm package dependencies. Python 3 builds the committed, self-contained plugins from `src/` into `dist/`; installation uses `dist/` directly. The test suite requires Node.js, Python 3, Bash, and `shared-mime-info`.

```bash
npm test
python3 build.py
for file in dist/*.js; do node --check "$file"; done
```

`npm test` runs parser and limit tests, Office/Markdown extraction checks, MIME registration checks, mocked installer/uninstaller tests, JavaScript syntax checks, and build-reproducibility checks. The shell tests use temporary directories and do not change the user's Sushi configuration. GTK rendering, plugin loading, and keyboard behavior require manual testing in a GNOME session.

Main directories:

- `src/` — GTK3 and GTK4 plugins plus shared parsers and document extractors.
- `dist/` — generated plugin files installed by `install.sh`; regenerate after changing source.
- `mime/` — project-specific MIME definitions.
- `examples/` — synthetic files for manual preview checks.
- `tests/` — deterministic parser, resource-limit, build, MIME, and shell tests.

## Contributing

Keep changes focused, preserve bounded reads and native GTK behavior, and avoid new dependencies unless they solve a concrete problem. Add small synthetic fixtures for parser changes, run `npm test`, and never include real patient or study data. See [`AGENTS.md`](AGENTS.md) for project-specific development and safety conventions.

## References

- [GNOME Sushi 51 plugin API](https://github.com/GNOME/sushi/blob/51.0/plugins/Plugins.md)
- GTK [`ColumnView`](https://docs.gtk.org/gtk4/class.ColumnView.html) and [`SortListModel`](https://docs.gtk.org/gtk4/class.SortListModel.html) documentation
- Kassis T, Agarwal V, He Y, Patel D, Brueckner AM. *Scientific Agent Skills: A Library of Procedural Knowledge for Research Agents*. arXiv:2609.00065 (2026). [DOI](https://doi.org/10.48550/arXiv.2609.00065). (Documentation methodology.)

## License

[MIT](LICENSE). Sushi Bioinfo Preview is an independent third-party project and is not part of GNOME Sushi.
