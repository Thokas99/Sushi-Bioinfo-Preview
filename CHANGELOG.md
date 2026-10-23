# Changelog

Notable changes to Sushi Bioinfo Preview are documented here. This changelog follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.2.1] - 2026-10-23

### Added

- Keep horizontal and vertical table scrollbars visible and draggable for navigating loaded columns and rows.

### Changed

- Raise the default table preview budget to 64 MiB, 25,000 rows, and 256 columns while retaining the 1.28-million-cell cap.
- Leave plain .txt files to Sushi's default preview and focus custom table routing on CSV/TSV and scientific text formats.
- Use Node 24 compatible GitHub Actions and pin CI to Ubuntu 24.04.

### Removed

- Remove Parquet preview and Office document extraction; unsupported documents stay with Sushi.

## [0.2.0] - 2026-10-14

### Added

- Preview Parquet files as bounded tables using footer metadata and selected column pages.
- Copy a cell or row and inspect a cell's retained value from the table.

### Changed

- Read the first stored Parquet rows and report the footer row count as metadata; the preview does not validate the complete file or represent the full dataset.
- Sort inferred numeric columns numerically, preserve source order for equal values, and keep the `#` gutter tied to sampled-record order before sorting.

### Fixed

- Support Parquet codec decoding in GJS runtimes without the browser `btoa` function.

[Unreleased]: https://github.com/Thokas99/Sushi-Bioinfo-Preview/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/Thokas99/Sushi-Bioinfo-Preview/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Thokas99/Sushi-Bioinfo-Preview/compare/v0.1.0...v0.2.0
