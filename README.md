# Sushi Bioinfo Preview

[![CI](https://github.com/Thokas99/Sushi-Bioinfo-Preview/actions/workflows/ci.yml/badge.svg)](https://github.com/Thokas99/Sushi-Bioinfo-Preview/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/Thokas99/Sushi-Bioinfo-Preview)](https://github.com/Thokas99/Sushi-Bioinfo-Preview/releases/latest)
[![MIT license](https://img.shields.io/github/license/Thokas99/Sushi-Bioinfo-Preview)](LICENSE)

Press **Space** in GNOME Files for a quick, read-only peek at data Sushi does not show as a useful table. No edits, no analysis, no lab coat required.

## What it previews

| File | Preview |
|---|---|
| CSV, TSV | Guessed delimiter, sortable table, first row as column names. |
| VCF | Variant fields and sample columns; genotypes stay uninterpreted. |
| BED, bedGraph, narrowPeak, broadPeak | Genomic intervals. BED uses 0-based, end-exclusive coordinates. |
| GFF, GFF3, GTF | Nine annotation fields; coordinates are 1-based and inclusive. |
| MTX (Matrix Market) | Stored entries and dimensions; sparse matrices stay sparse. |
| Markdown | Local rendered preview and source view. |

Plain `.txt`, Office files, PDF, HTML, and other formats stay with Sushi's default preview. We don't unzip a document just to peek inside.

## Table tricks

- Click a header to sort; ties keep their original order.
- Right-click or double-click a cell to inspect it. Right-click also copies a cell or row.
- **Ctrl+C** copies the selected row as TSV.
- Columns size to headers and sample values; native scrollbars move through rows and columns.
- The `#` gutter tracks sampled record order, not file line numbers.

## Sensible limits

Tables read at most **64 MiB** and show up to **25,000 rows**, **256 columns**, **1.28 million cells**, and **512 characters per field**; wide tables automatically show fewer rows. Genomic previews stop at **5,000 rows**. Markdown reads at most **256 KiB**. Table truncation is reported, and reads can be cancelled. The very largest previews may briefly make Sushi think hard.

To lower the limits in the Sushi Flatpak, set `SUSHI_BIOINFO_MAX_MIB`, `SUSHI_BIOINFO_MAX_ROWS`, or `SUSHI_BIOINFO_MAX_COLUMNS`. Values cannot raise the built-in caps:

```bash
flatpak override --user \
  --env=SUSHI_BIOINFO_MAX_MIB=32 \
  --env=SUSHI_BIOINFO_MAX_ROWS=20000 \
  --env=SUSHI_BIOINFO_MAX_COLUMNS=192 \
  org.gnome.NautilusPreviewer
flatpak kill org.gnome.NautilusPreviewer 2>/dev/null || true
```

## Install

You need the GNOME Sushi Flatpak, `flatpak`, and `update-mime-database` (from `shared-mime-info`). No root access or extra runtime packages:

```bash
git clone --branch main --depth 1 https://github.com/Thokas99/Sushi-Bioinfo-Preview.git
cd Sushi-Bioinfo-Preview
bash install.sh
flatpak kill org.gnome.NautilusPreviewer 2>/dev/null || true
```

The installer uses GTK3 for Sushi 46–50 and GTK4 for 51+. It saves user-level backups. To remove the preview and restore prior files that have not changed since installation:

```bash
bash uninstall.sh
flatpak kill org.gnome.NautilusPreviewer 2>/dev/null || true
```

## Hack on it

Edit `src/`, rebuild `dist/`, then run `npm test`:

```bash
python3 build.py
npm test
```

Fixtures are synthetic. Patient data stays out of the repo.

## License

[MIT](LICENSE). Independent project; not part of GNOME Sushi.
