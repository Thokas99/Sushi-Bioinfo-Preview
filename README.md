# Sushi Bioinfo Preview

[![CI](https://github.com/Thokas99/Sushi-Bioinfo-Preview/actions/workflows/ci.yml/badge.svg)](https://github.com/Thokas99/Sushi-Bioinfo-Preview/actions/workflows/ci.yml)

Open a file in GNOME Files, press **Space**, and take a look. This adds read-only previews for text and scientific files Sushi does not show as useful tables. It does not edit or analyze your data. Your spreadsheet can keep its lab coat on.

## What it previews

| Files | What you see |
|---|---|
| CSV, TSV | A sortable table. The first row supplies column names. |
| VCF | Variant fields and sample columns as text. Genotypes are not interpreted; POS coordinates start at 1. |
| BED, bedGraph, narrowPeak, broadPeak | Interval fields. BED starts at 0; ends are exclusive. |
| GFF, GFF3, GTF | The standard nine fields. Attributes stay as text; coordinates start at 1 and include the end. |
| MTX (Matrix Market) | Stored entries and declared dimensions. Sparse matrices stay sparse. |
| Markdown | A local rendered preview and source view. |

Plain .txt, HTML, PDF, binary, compressed, and other files are left to Sushi's default preview. No document extraction gymnastics.

## Using the table

- Click a column header to sort. Equal values keep their original order.
- Right-click a cell to copy it, copy its row as TSV, or inspect the value. Double-click also inspects.
- Press **Ctrl+C** to copy the selected row as TSV.
- Drag the scrollbars to move through loaded rows and columns.

The `#` column counts sampled records before sorting; it is not a file line number. Sorting changes the view, not the source data.

## Limits

Text previews read up to 64 MiB. CSV and TSV tables show at most 25,000 rows, 256 columns, 1,280,000 cells, and 512 characters per field. Wide tables get fewer rows to stay within the cell budget. Genomic text previews show at most 5,000 rows. Larger files get a useful peek, not a full audit; later records may be missing. Use the right tools to validate or analyze a complete dataset.

You can lower the preview budgets for Sushi’s Flatpak with `SUSHI_BIOINFO_MAX_MIB`, `SUSHI_BIOINFO_MAX_ROWS`, and `SUSHI_BIOINFO_MAX_COLUMNS`. They cannot exceed the limits above. For example:

```bash
flatpak override --user \
  --env=SUSHI_BIOINFO_MAX_MIB=32 \
  --env=SUSHI_BIOINFO_MAX_ROWS=20000 \
  --env=SUSHI_BIOINFO_MAX_COLUMNS=192 \
  org.gnome.NautilusPreviewer
flatpak kill org.gnome.NautilusPreviewer 2>/dev/null || true
```

Reads can be cancelled. Parsing and table setup run on the UI thread, so the very largest previews can briefly make Sushi think hard.

## Install

Install the current `main` branch. You need the GNOME Sushi Flatpak, `flatpak`, and `update-mime-database`:

```bash
git clone --branch main --depth 1 https://github.com/Thokas99/Sushi-Bioinfo-Preview.git
cd Sushi-Bioinfo-Preview
bash install.sh
flatpak kill org.gnome.NautilusPreviewer 2>/dev/null || true
```

The installer changes only user-level Sushi and MIME files and keeps backups. It needs no root access or runtime dependencies. It selects the GTK3 route for Sushi 46–50 and GTK4 for Sushi 51+.

To uninstall and restore files that have not changed since installation:

```bash
bash uninstall.sh
flatpak kill org.gnome.NautilusPreviewer 2>/dev/null || true
```

## Development

Edit `src/`. Run `python3 build.py` to regenerate the committed plugins in `dist/`, then `npm test`. The build has no JavaScript dependencies. GTK smoke checks need `gjs` and `xvfb-run`; real Sushi rendering needs a GNOME session.

Use synthetic fixtures only. Never add patient or study data.

## Reference

Kassis T, Agarwal V, He Y, Patel D, Brueckner AM. *Scientific Agent Skills: A Library of Procedural Knowledge for Research Agents*. 2026. [doi:10.48550/arXiv.2609.00065](https://doi.org/10.48550/arXiv.2609.00065).

## License

[MIT](LICENSE). This independent project is not part of GNOME Sushi.
