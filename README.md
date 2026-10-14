# Sushi Bioinfo Preview

[![CI](https://github.com/Thokas99/Sushi-Bioinfo-Preview/actions/workflows/ci.yml/badge.svg)](https://github.com/Thokas99/Sushi-Bioinfo-Preview/actions/workflows/ci.yml)

**Read-only previews of selected scientific and document files in GNOME Files.** Select a file in Nautilus and press **Space** to inspect it with GNOME Sushi.

> [!TIP]
> Use it for a quick look at a table, genomic records, or document text. Sushi keeps control of the preview window and keyboard shortcuts.

Sushi Bioinfo Preview adds small, native GTK views for file types Sushi does not preview in a useful way by default. It helps answer “what is in this file?” before opening a full editor or analysis tool. It does not edit, validate, or analyze datasets.

## Supported formats

| Files | Preview |
|---|---|
| CSV, TSV | A table with quoted-field support and delimiter detection; the first row is used to infer column names. |
| VCF | Variant fields and optional sample columns as text; genotype values are not interpreted. POS uses 1-based coordinates. |
| BED, bedGraph, narrowPeak, broadPeak | Interval fields; BED start/end coordinates are 0-based and half-open. |
| GFF, GFF3, GTF | The standard nine fields; attributes stay as text. Coordinates are 1-based and inclusive. |
| MTX (Matrix Market) | Declared dimensions and stored entries; sparse matrices are not expanded into dense tables. |
| H5AD | File-signature recognition only. No AnnData metadata is read. |
| Parquet | A table preview of the first stored rows, with bounded footer and selected-page reads. The footer row count is metadata; the full file is not validated and the sample is not representative. |
| DOCX/DOCM, XLSX/XLSM, PPTX/PPTM, ODT/OTT | A bounded text extract. Page layout, charts, and other visual formatting are not reproduced; macros are not run. |
| Markdown | A restricted local preview and source view. |
| HTML, PDF, compressed files, others | Left to Sushi’s built-in preview or fallback. |

> [!IMPORTANT]
> These are previews, not file validators. Large files are read only up to configured limits, so later records may be absent; malformed or truncated data may still produce a plausible-looking partial view. Use format-aware tools to validate or analyze a complete dataset.

## Table interaction

Right-click a cell to copy its retained value, copy the row as TSV, or inspect the value in a small popover. Double-click also opens the inspection popover. With the table focused, **Ctrl+C** copies the selected row as TSV. A field longer than the retained limit is shortened and marked in the inspection view.

The `#` gutter shows each displayed record's position in the sampled data before sorting. Headers and format-skipped comment or metadata lines are not counted; for Matrix Market files it numbers displayed entries. It is not a physical file line number. Sorting affects only loaded rows, keeps equal values in their original order, and sorts inferred numeric columns numerically. Missing values follow GTK's sort direction: last in ascending order and first in descending order.

## Install

With the GNOME Sushi Flatpak (`org.gnome.NautilusPreviewer`) and the host tools `flatpak` and `update-mime-database` installed, run:

```bash
git clone https://github.com/Thokas99/Sushi-Bioinfo-Preview.git
cd Sushi-Bioinfo-Preview
bash install.sh
flatpak kill org.gnome.NautilusPreviewer 2>/dev/null || true
```

The installer uses a user-level installation and backup; it does not require root, Node.js, Python, LibreOffice, or extra Flatpak permissions. It selects the GTK3 plugin route for Sushi 46–50 and GTK4 for Sushi 51+. Tests cover mocked routing for 50.0 and 51.1; loading and rendering need a live GNOME session.

To remove the extension and restore unchanged files from its backup:

```bash
bash uninstall.sh
flatpak kill org.gnome.NautilusPreviewer 2>/dev/null || true
```

## Limits

CSV, TSV, and genomic table previews read a bounded prefix. Parquet requires a seekable file and reads its footer plus selected column pages, with total fetched bytes capped at 16 MiB by default. It shows the first stored rows in file order, up to 10,000 rows, 128 columns, 1,280,000 cells, and 512 characters per field; its row count comes from footer metadata and the rest of the file is not validated. Other table limits apply to the data read. A hard cap of 1,280,000 table cells also applies, so raising the row or column limit can lower the effective row limit. Muted status text and its tooltip identify limits; a preview may omit later rows or a trailing partial record. Inspection and copying use retained values, not text shortened only for display. Sorting applies only to loaded rows. Reads can be cancelled, while parsing and GTK model construction happen on the UI thread; very large previews or remote storage can briefly delay interaction.

<details>
<summary>Optional table limits</summary>

The Sushi Flatpak accepts per-user overrides, clamped at 64 MiB, 25,000 rows, and 256 columns:

```bash
flatpak override --user \
  --env=SUSHI_BIOINFO_MAX_MIB=32 \
  --env=SUSHI_BIOINFO_MAX_ROWS=20000 \
  --env=SUSHI_BIOINFO_MAX_COLUMNS=192 \
  org.gnome.NautilusPreviewer
flatpak kill org.gnome.NautilusPreviewer 2>/dev/null || true
```

Raise limits only when needed; larger previews can use more memory and take longer. Unset an override with `flatpak override --user --unset-env=VARIABLE org.gnome.NautilusPreviewer`.

</details>

## Development

Run `npm ci` to install the pinned build and test dependencies. Edit `src/`; `python3 build.py` regenerates the committed, self-contained plugins in `dist/`. Run the test suite with:

```bash
npm test
```

Tests cover parsing, limits, MIME registration, generated files, and mocked install/uninstall behavior. GTK loading, rendering, scrolling, and keyboard behavior require manual testing in GNOME.

Bundled dependency licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Add small synthetic fixtures for new formats or edge cases. Do not include patient or study data. See [AGENTS.md](AGENTS.md) for the project’s development and safety conventions.

## References

- [GNOME Sushi plugin API](https://github.com/GNOME/sushi/blob/51.0/plugins/Plugins.md)
- Kassis T, Agarwal V, He Y, Patel D, Brueckner AM. *Scientific Agent Skills: A Library of Procedural Knowledge for Research Agents*. 2026. [doi:10.48550/arXiv.2609.00065](https://doi.org/10.48550/arXiv.2609.00065) (documentation method).

## License

[MIT](LICENSE). This independent project is not part of GNOME Sushi.
