# Changelog

Notable changes to Sushi Bioinfo Preview are documented here. This changelog follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.2.0] - 2026-10-14

### Added

- Preview Parquet files as bounded tables using footer metadata and selected column pages.
- Copy a cell or row and inspect a cell's retained value from the table.

### Changed

- Read the first stored Parquet rows and report the footer row count as metadata; the preview does not validate the complete file or represent the full dataset.
- Sort inferred numeric columns numerically, preserve source order for equal values, and keep the `#` gutter tied to sampled-record order before sorting.

### Fixed

- Support Parquet codec decoding in GJS runtimes without the browser `btoa` function.

[Unreleased]: https://github.com/Thokas99/Sushi-Bioinfo-Preview/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Thokas99/Sushi-Bioinfo-Preview/compare/v0.1.0...v0.2.0
