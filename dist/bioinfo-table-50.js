/* Sushi Bioinfo Preview — native GTK3 tree table. SPDX-License-Identifier: MIT */
const {Gdk, Gio, GLib, GObject, Gtk, Pango} = imports.gi;
const ByteArray = imports.byteArray;
const Renderer = imports.ui.renderer;
/* SPDX-License-Identifier: MIT
 * Portable bounded CSV/TSV parsing and sampled-row sorting (no GTK/GJS dependencies).
 * Keep this ES module readable: the legacy GTK3 installer embeds it without `export`.
 */
// The GTK4 table is virtualized, so it can show more sampled rows without
// creating one widget per cell. Never scan an entire arbitrary-sized file.
// Optional Flatpak overrides are clamped to conservative absolute ceilings.
function previewLimit(name, defaultValue, minimum, maximum) {
    const raw = typeof GLib !== 'undefined' && typeof GLib.getenv === 'function'
        ? GLib.getenv(name) : null;
    if (!raw || !/^\d+$/.test(raw)) return defaultValue;
    return Math.max(minimum, Math.min(maximum, Number(raw)));
}

const MAX_TABLE_CELLS = 10000 * 128;
const requestedRows = previewLimit('SUSHI_BIOINFO_MAX_ROWS', 10000, 100, 25000);
const columns = previewLimit('SUSHI_BIOINFO_MAX_COLUMNS', 128, 8, 256);
const tableRows = Math.min(requestedRows, Math.floor(MAX_TABLE_CELLS / columns));

const LIMITS = Object.freeze({
    bytes: previewLimit('SUSHI_BIOINFO_MAX_MIB', 16, 1, 64) * 1024 * 1024,
    rows: requestedRows,
    tableRows,
    columns,
    cells: MAX_TABLE_CELLS,
    tableCellLimitActive: tableRows < requestedRows,
    fieldChars: 512,
});

function parseDelimited(text, separator, options = {}) {
    const rowLimit = options.maxRows ?? LIMITS.rows + 1;
    const colLimit = options.maxColumns ?? LIMITS.columns;
    const keepPartial = options.keepPartial ?? false;
    const fieldChars = options.fieldChars ?? LIMITS.fieldChars;
    const rows = [];
    const widths = [];
    let row = [];
    let field = '';
    let fullCols = 0;
    let inQuotes = false;
    let clippedColumns = false;
    let clippedFields = false;
    const clippedFieldColumns = new Map();
    let fieldClipped = false;
    let hitRowLimit = false;
    let startOfField = true;

    const append = ch => {
        if (field.length < fieldChars)
            field += ch;
        else {
            clippedFields = true;
            if (!fieldClipped && fullCols < colLimit) {
                const columns = clippedFieldColumns.get(rows.length) ?? [];
                columns.push(fullCols);
                clippedFieldColumns.set(rows.length, columns);
            }
            fieldClipped = true;
        }
    };
    const flushField = () => {
        if (fullCols < colLimit) row.push(field);
        else clippedColumns = true;
        fullCols++;
        field = '';
        fieldClipped = false;
        startOfField = true;
    };
    const flushRow = () => {
        flushField();
        rows.push(row);
        widths.push(fullCols);
        row = [];
        fullCols = 0;
    };

    let i = 0;
    if (text.charCodeAt(0) === 0xFEFF) i++;
    for (; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
            if (inQuotes && text[i + 1] === '"') {
                append('"');
                i++;
            } else if (inQuotes) {
                inQuotes = false;
            } else if (startOfField) {
                inQuotes = true;
                startOfField = false;
            } else {
                append(ch);
            }
        } else if (ch === separator && !inQuotes) {
            flushField();
        } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            flushRow();
            if (rows.length >= rowLimit) {
                hitRowLimit = i < text.length - 1;
                break;
            }
        } else {
            append(ch);
            startOfField = false;
        }
    }
    const unfinished = fullCols > 0 || field.length > 0 || !startOfField;
    if (unfinished && rows.length < rowLimit && keepPartial && !inQuotes) flushRow();
    return {
        rows, widths, clippedColumns, clippedFields, clippedFieldColumns, hitRowLimit,
        droppedPartial: unfinished && !keepPartial,
        unterminatedQuote: inQuotes,
    };
}

function detectSeparator(text, extension = '') {
    const candidates = ['\t', ',', ';', '|'];
    let best = '\t';
    let bestScore = -Infinity;
    const hinted = /\.(csv)$/i.test(extension) ? ',' : /\.(tsv|tab|bed)$/i.test(extension) ? '\t' : null;
    for (const sep of candidates) {
        const result = parseDelimited(text, sep, {maxRows: 30, maxColumns: 80, keepPartial: true, fieldChars: 64});
        const widths = result.widths;
        if (!widths.length) continue;
        const count = new Map();
        for (const n of widths) count.set(n, (count.get(n) ?? 0) + 1);
        const [modalWidth, modalCount] = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
        const consistency = modalCount / widths.length;
        const score = (modalWidth > 1 ? 12 : -12) + 10 * consistency + Math.min(modalWidth, 30) * 0.05
            - (result.clippedColumns ? 2 : 0) + (sep === hinted ? 2 : 0);
        if (score > bestScore) {
            bestScore = score;
            best = sep;
        }
    }
    return best;
}

function prepareTable(text, separator, hasHeader = true, partialByteRead = false) {
    const parsed = parseDelimited(text, separator, {
        maxRows: LIMITS.tableRows + (hasHeader ? 2 : 1),
        maxColumns: LIMITS.columns,
        keepPartial: !partialByteRead,
    });
    const all = parsed.rows;
    const originalHeaders = hasHeader ? (all.shift() ?? []) : [];
    const parsedRowCount = all.length;
    if (all.length > LIMITS.tableRows) all.length = LIMITS.tableRows;
    const rows = all;
    let cols = originalHeaders.length;
    for (const row of rows) cols = Math.max(cols, row.length);
    cols = Math.min(LIMITS.columns, cols);
    const used = new Set();
    const headers = Array.from({length: cols}, (_, i) => {
        const raw = hasHeader ? (originalHeaders[i] ?? '').trim() : '';
        const base = raw || `Column ${i + 1}`;
        let name = base;
        let count = 2;
        while (used.has(name)) name = `${base} (${count++})`;
        used.add(name);
        return name;
    });
    const truncatedFields = new Map();
    rows.forEach((_, index) => {
        const columns = parsed.clippedFieldColumns.get(index + (hasHeader ? 1 : 0));
        if (columns) truncatedFields.set(index, columns);
    });
    const truncatedHeader = hasHeader && (parsed.clippedFieldColumns.get(0)?.length ?? 0) > 0;
    const expectedWidth = parsed.widths[0];
    const sampledWidths = parsed.widths.slice(hasHeader ? 1 : 0,
        (hasHeader ? 1 : 0) + rows.length);
    const raggedRows = expectedWidth === undefined ? 0
        : sampledWidths.filter(width => width !== expectedWidth).length;
    return {
        headers, rows, separator, hasHeader,
        truncatedRows: parsed.hitRowLimit || parsedRowCount > LIMITS.tableRows,
        truncatedBytes: partialByteRead,
        clippedFields: truncatedHeader || truncatedFields.size > 0,
        truncatedHeader,
        truncatedFields,
        clippedColumns: parsed.clippedColumns,
        incompleteRecord: partialByteRead && parsed.droppedPartial,
        raggedRows,
        cellLimited: LIMITS.tableCellLimitActive &&
            (parsed.hitRowLimit || parsedRowCount > LIMITS.tableRows),
        quoteWarning: parsed.unterminatedQuote && !partialByteRead,
    };
}

function isMissing(v) {
    if (v === undefined || v === null) return true;
    const s = v.trim();
    return s === '' || s === '.' || /^(NA|N\/A|NULL|NONE|NAN)$/i.test(s);
}

function numericValue(v) {
    if (isMissing(v)) return null;
    const x = v.trim();
    if (!/^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(x)) return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
}

function compareCells(left, right, type, descending = false) {
    const aMissing = isMissing(left), bMissing = isMissing(right);
    if (aMissing && bMissing) return 0;
    if (aMissing) return descending ? -1 : 1;
    if (bMissing) return descending ? 1 : -1;
    let diff;
    if (type === 'number') {
        const x = left.trim(), y = right.trim();
        if (/^[+-]?\d+$/.test(x) && /^[+-]?\d+$/.test(y)) {
            const a = Number(x), b = Number(y);
            if (Number.isSafeInteger(a) && Number.isSafeInteger(b))
                diff = a < b ? -1 : a > b ? 1 : 0;
            else {
                const exactA = BigInt(x), exactB = BigInt(y);
                diff = exactA < exactB ? -1 : exactA > exactB ? 1 : 0;
            }
        } else {
            // shortcut: decimal comparison uses JS Number precision, upgrade if exact decimal ordering is required.
            const a = numericValue(x), b = numericValue(y);
            diff = a === null ? (b === null ? x.localeCompare(y) : 1)
                : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0;
        }
    } else diff = left.localeCompare(right, undefined, {numeric: true});
    return descending ? -diff : diff;
}

function guessTypes(rows, count, headers = []) {
    return Array.from({length: count}, (_, col) => {
        const header = headers[col] ?? '';
        if (/^(?:#?chrom(?:osome)?|chr|seqid|gene|sample|cell|barcode|accession|name|id|contig)$/i.test(header) ||
            /_(?:id|name|barcode|accession)$/i.test(header))
            return 'text';
        let present = 0;
        let numeric = 0;
        for (const row of rows.slice(0, 500)) {
            const value = row[col];
            if (isMissing(value)) continue;
            present++;
            if (numericValue(value) !== null) numeric++;
        }
        return present && numeric / present >= 0.9 ? 'number' : 'text';
    });
}

function sortRows(rows, sortColumn, descending, types) {
    const sorted = rows.map((cells, originalIndex) => ({cells, originalIndex}));
    if (sortColumn !== null && sortColumn >= 0)
        sorted.sort((a, b) => compareCells(a.cells[sortColumn] ?? '', b.cells[sortColumn] ?? '',
            types[sortColumn], descending));
    return sorted;
}

/** Suggest legible pixel widths from bounded sample data, without creating GTK widgets.
 * Columns are allowed to expand to use spare preview width.
 */
function columnWidthHints(headers, rows, types = []) {
    return headers.map((header, col) => {
        const numeric = types[col] === 'number';
        let longest = Math.min(numeric ? 28 : 32, String(header).length);
        // Scan no more than 64 sample rows; do not infer widths from entire files.
        for (const row of rows.slice(0, 64)) {
            const length = String(row[col] ?? '').replace(/[\r\n\t]/g, ' ').length;
            longest = Math.max(longest, Math.min(length, numeric ? 20 : 32));
        }
        const minimum = numeric ? 64 : 88;
        const maximum = numeric ? 220 : 280;
        return Math.max(minimum, Math.min(maximum, Math.round(longest * 7.2 + 24)));
    });
}

function rowToTsv(cells) {
    return cells.map(value => {
        const text = String(value ?? '');
        return /[\t"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join('\t');
}

function cellValueStatus(table, row, column) {
    if (table.truncatedFields?.get(row)?.includes(column))
        return `Field truncated to ${LIMITS.fieldChars} characters by the preview.`;
    if (table.incompleteRecord)
        return 'The file prefix ended inside a record; the trailing partial record was omitted.';
    return 'Complete field retained within the sampled input.';
}

function previewStatus(table) {
    const messages = [];
    if (table.truncatedBytes) messages.push('Read only a bounded file prefix.');
    if (table.incompleteRecord) messages.push('A trailing partial record was omitted.');
    if (table.truncatedRows) messages.push(`${table.rows.length} rows shown from the file prefix; more rows may be present.`);
    if (table.cellLimited) messages.push('The row limit was lowered to keep the table within the total cell limit.');
    if (table.clippedColumns) messages.push(`Only the first ${LIMITS.columns} columns are shown.`);
    if (table.raggedRows) messages.push(table.raggedRows === 1
        ? '1 sampled data row has a different field count.'
        : `${table.raggedRows} sampled data rows have a different field count.`);
    if (table.truncatedHeader) messages.push('One or more header fields were truncated.');
    if (table.clippedFields) messages.push(`One or more fields are limited to ${LIMITS.fieldChars} characters.`);
    if (table.quoteWarning) messages.push('An unterminated quoted field prevented the final record from being parsed.');
    if (table.truncatedFields?.size) messages.push('Double-click a cell to inspect its retained value and truncation status.');
    return {label: messages.length ? 'Preview limited' : '', tooltip: messages.join('\n')};
}


/* SPDX-License-Identifier: MIT
 * Sushi Bioinfo Preview: bounded, dependency-free genomics format parsing.
 * This module never opens files: callers supply a small head buffer.
 */
function formatFromName(name) {
    const n = name.toLowerCase();
    if (/\.(h5ad)$/.test(n)) return 'h5ad';
    if (/\.(parquet)$/.test(n)) return 'parquet';
    if (/\.(vcf)$/.test(n)) return 'vcf';
    if (/\.(bed|bedgraph|narrowpeak|broadpeak)$/.test(n)) return 'bed';
    if (/\.(mtx)$/.test(n)) return 'mtx';
    if (/\.(gff|gff3|gtf)$/.test(n)) return 'gff';
    return 'table';
}

function binaryPreview(name, bytes, totalSize) {
    const format = formatFromName(name);
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const isHDF5 = data.length >= 8 && [137,72,68,70,13,10,26,10].every((n, i) => data[i] === n);
    const isParquet = data.length >= 4 && [80,65,82,49].every((n, i) => data[i] === n);
    const recognized = format === 'h5ad' ? isHDF5 : format === 'parquet' && isParquet;
    const kind = format === 'h5ad' ? 'AnnData / HDF5' : 'Apache Parquet';
    return {
        kind, recognized, totalSize,
        message: recognized
            ? (format === 'h5ad'
                ? 'HDF5 magic bytes found at offset 0. AnnData dimensions, obs/var columns and layers are not inspected.'
                : 'Parquet leading magic bytes found. Schema, row groups, footer and row count are not inspected.')
            : `No ${format === 'h5ad' ? 'HDF5' : 'Parquet'} magic bytes found at file start. Extension may not match file contents.`,
    };
}

function splitLines(text, partial) {
    // Avoid text.split() over a large buffer: a BED/MTX file with millions
    // of tiny lines could otherwise create millions of JS strings at once.
    // Read at most one small header allowance beyond the requested data rows.
    const maxLines = LIMITS.rows + 8192;
    const lines = [];
    let cursor = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
    let incompleteRecord = false;
    while (cursor < text.length && lines.length < maxLines) {
        const lf = text.indexOf('\n', cursor);
        const cr = text.indexOf('\r', cursor);
        let end;
        if (lf === -1) end = cr;
        else if (cr === -1) end = lf;
        else end = Math.min(lf, cr);
        if (end === -1) {
            if (!partial) lines.push(text.slice(cursor));
            else incompleteRecord = cursor < text.length;
            cursor = text.length;
            break;
        }
        lines.push(text.slice(cursor, end));
        cursor = end + (text[end] === '\r' && text[end + 1] === '\n' ? 2 : 1);
    }
    return {lines, incompleteRecord, lineLimit: cursor < text.length};
}

function cleanRows(lines, skip, maxRows) {
    return lines.filter(s => s.trim() && !skip(s)).slice(0, maxRows);
}

function trimDelimited(line, cols, clippedFields = null, rowIndex = 0) {
    // Extract only the columns we display; never split a huge row into
    // arbitrarily many temporary strings.
    const cells = [];
    let pos = 0;
    while (cells.length < cols) {
        const next = line.indexOf('\t', pos);
        const end = next === -1 ? line.length : next;
        if (end - pos > LIMITS.fieldChars && clippedFields) {
            const columns = clippedFields.get(rowIndex) ?? [];
            columns.push(cells.length);
            clippedFields.set(rowIndex, columns);
        }
        cells.push(line.slice(pos, Math.min(end, pos + LIMITS.fieldChars)));
        if (next === -1) break;
        pos = next + 1;
    }
    return cells;
}

function exceedsColumns(line, max) {
    let cursor = 0;
    for (let i = 0; i < max; i++) {
        const next = line.indexOf('\t', cursor);
        if (next === -1) return false;
        cursor = next + 1;
    }
    return true;
}

function trimWhitespace(line, columns, clippedFields = null, rowIndex = 0) {
    const cells = [];
    let cursor = 0;
    while (cells.length < columns) {
        while (cursor < line.length && /\s/.test(line[cursor])) cursor++;
        if (cursor === line.length) break;
        let end = cursor;
        while (end < line.length && !/\s/.test(line[end])) end++;
        if (end - cursor > LIMITS.fieldChars && clippedFields) {
            const clipped = clippedFields.get(rowIndex) ?? [];
            clipped.push(cells.length);
            clippedFields.set(rowIndex, clipped);
        }
        cells.push(line.slice(cursor, Math.min(end, cursor + LIMITS.fieldChars)));
        cursor = end;
    }
    while (cursor < line.length && /\s/.test(line[cursor])) cursor++;
    return {cells, extra: cursor < line.length};
}

function result(kind, headers, lines, columns, notes, incompleteRecord = false, lineLimit = false, partial = false) {
    const rows = [];
    const truncatedFields = new Map();
    for (let index = 0; index < Math.min(lines.length, LIMITS.tableRows); index++)
        rows.push(trimDelimited(lines[index], columns, truncatedFields, index));
    let nc = kind === 'BED intervals' ? 3 : headers.length;
    for (const row of rows) nc = Math.max(nc, row.length);
    nc = Math.min(LIMITS.columns, nc);
    const names = Array.from({length: nc}, (_, i) => headers[i] || `Column ${i + 1}`);
    return {kind, headers: names, rows, notes, truncatedFields,
        clippedFields: truncatedFields.size > 0, truncatedHeader: false,
        incompleteRecord, truncatedBytes: partial || lineLimit,
        truncatedRows: lines.length > LIMITS.tableRows || lineLimit,
        rowLimit: lines.length > LIMITS.tableRows || lineLimit,
        cellLimited: LIMITS.tableCellLimitActive && lines.length > LIMITS.tableRows,
        colLimit: headers.length > LIMITS.columns || lines.some(line => exceedsColumns(line, LIMITS.columns))};
}

function genomicPreview(name, text, partial) {
    const kind = formatFromName(name);
    const split = splitLines(text, partial);
    const {lines, incompleteRecord, lineLimit} = split;
    if (kind === 'vcf') {
        const meta = lines.filter(line => line.startsWith('##'));
        const headerLine = lines.find(line => line.startsWith('#CHROM\t'));
        const headerClips = new Map();
        const headers = headerLine ? trimDelimited(headerLine.slice(1), LIMITS.columns + 1, headerClips) :
            ['CHROM','POS','ID','REF','ALT','QUAL','FILTER','INFO','FORMAT'];
        const records = cleanRows(lines, x => x.startsWith('#'), LIMITS.tableRows + 1);
        const samples = Math.max(0, headers.length - 9);
        const preview = result('VCF variants', headers, records, LIMITS.columns,
            ['POS uses 1-based coordinates', 'INFO/FORMAT displayed as text; no genotype interpretation',
                `${samples} sample columns in header`, `${meta.length} header metadata lines in sample`],
            incompleteRecord, lineLimit, partial);
        preview.truncatedHeader = headerClips.has(0);
        preview.clippedFields ||= preview.truncatedHeader;
        return preview;
    }
    if (kind === 'bed') {
        const headers = ['chrom','chromStart','chromEnd','name','score','strand',
            'thickStart','thickEnd','itemRgb','blockCount','blockSizes','blockStarts'];
        const records = cleanRows(lines, x => /^(#|track\b|browser\b)/i.test(x), LIMITS.tableRows + 1);
        return result('BED intervals', headers, records, LIMITS.columns,
            ['BED starts are 0-based; ends are exclusive', 'Columns are positional; additional columns are generic'],
            incompleteRecord, lineLimit, partial);
    }
    if (kind === 'gff') {
        const headers = ['seqid','source','type','start','end','score','strand','phase','attributes'];
        const fastaStart = lines.findIndex(x => x.startsWith('##FASTA'));
        const annotationLines = fastaStart >= 0 ? lines.slice(0, fastaStart) : lines;
        const records = cleanRows(annotationLines, x => x.startsWith('#'), LIMITS.tableRows + 1);
        return result('GFF / GTF features', headers, records, LIMITS.columns,
            ['GFF/GTF starts and ends are 1-based inclusive', 'Attributes are not expanded'],
            incompleteRecord, lineLimit, partial);
    }
    if (kind === 'mtx') {
        const mark = lines.find(x => /^%%MatrixMarket\s/i.test(x));
        const content = cleanRows(lines, x => x.startsWith('%'), LIMITS.rows + 2);
        const banner = /^%%MatrixMarket\s+matrix\s+(coordinate|array)\s+(integer|real|complex|pattern)\s+(general|symmetric|hermitian|skew-symmetric)\s*$/i.exec(mark ?? '');
        const storage = banner?.[1].toLowerCase();
        const field = banner?.[2].toLowerCase();
        if (!banner || (storage === 'array' && field === 'pattern')) {
            const raw = content.slice(0, LIMITS.rows);
            const clippedRows = new Map();
            raw.forEach((line, index) => { if (line.length > LIMITS.fieldChars) clippedRows.set(index, [0]); });
            return {kind: 'Matrix Market text', headers: ['line'], rows: raw.map(line => [line.slice(0, LIMITS.fieldChars)]),
                notes: ['Unsupported or invalid Matrix Market banner; non-comment lines are shown as text',
                    (mark ?? 'No MatrixMarket banner found').slice(0, 140)],
                rowLimit: content.length > LIMITS.rows, truncatedRows: content.length > LIMITS.rows || lineLimit,
                truncatedBytes: partial || lineLimit, incompleteRecord,
                truncatedFields: clippedRows, clippedFields: clippedRows.size > 0,
                truncatedHeader: false, colLimit: false};
        }
        const dimensionCount = storage === 'coordinate' ? 3 : 2;
        const dimensionRow = trimWhitespace(content[0] ?? '', dimensionCount + 1);
        const dimensions = dimensionRow.cells;
        const isCoordinate = storage === 'coordinate';
        const isArray = storage === 'array';
        const entries = content.slice(1, LIMITS.rows + 2);
        const validDimensions = dimensions.length === dimensionCount && !dimensionRow.extra &&
            dimensions.every(x => /^\d+$/.test(x));
        const matrixInfo = isCoordinate && validDimensions
            ? `matrix ${dimensions[0]} × ${dimensions[1]}, ${dimensions[2]} declared entries`
            : isArray && validDimensions
                ? `array ${dimensions[0]} × ${dimensions[1]}` : 'dimensions unavailable';
        const headers = isCoordinate
            ? (field === 'pattern' ? ['row','column']
                : field === 'complex' ? ['row','column','real','imaginary'] : ['row','column','value'])
            : field === 'complex' ? ['real','imaginary'] : ['value'];
        // MTX uses whitespace, not TSV; do not use the generic delimited parser.
        const rows = [];
        const truncatedFields = new Map();
        let malformed = 0;
        entries.slice(0, LIMITS.rows).forEach((line, index) => {
            const row = trimWhitespace(line, headers.length, truncatedFields, index);
            rows.push(row.cells);
            if (row.cells.length !== headers.length || row.extra) malformed++;
        });
        const notes = [matrixInfo, isCoordinate
            ? 'Coordinate indices are 1-based; entries are not expanded into a dense matrix'
            : 'Dense array values are shown in storage order; symmetry is not expanded',
            (mark ?? 'No MatrixMarket banner found').slice(0, 140)];
        if (malformed) notes.push(`${malformed} sampled entries have unexpected field counts; extra fields are omitted`);
        return {kind: isArray ? 'Matrix Market array' : 'Matrix Market coordinates', headers,
            rows, notes,
            rowLimit: entries.length > LIMITS.rows || lineLimit,
            truncatedRows: entries.length > LIMITS.rows || lineLimit,
            truncatedBytes: partial || lineLimit, incompleteRecord,
            truncatedFields, clippedFields: truncatedFields.size > 0,
            truncatedHeader: false, colLimit: false};
    }
    return null;
}

/*
# Third-party notices

The table plugins bundle code from these MIT-licensed packages:

- [hyparquet 1.28.1](https://github.com/hyparam/hyparquet) — Hyperparam
- [hyparquet-compressors 1.1.1](https://github.com/hyparam/hyparquet-compressors) — Hyperparam
- [hysnappy 1.0.0](https://github.com/hyparam/hysnappy) — Hyperparam
- [fzstd 0.1.1](https://github.com/101arrowz/fzstd) — Copyright (c) 2020 Arjun Barrett

The first three upstream `LICENSE` files contain the same MIT permission and warranty text. Their full text is included below once. The `fzstd` license follows separately.

## MIT license for hyparquet, hyparquet-compressors, and hysnappy

The MIT License (MIT)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## MIT license for fzstd

MIT License

Copyright (c) 2020 Arjun Barrett

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

*/
var ParquetSupport = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/parquet-core.js
  var parquet_core_exports = {};
  __export(parquet_core_exports, {
    parquetPreview: () => parquetPreview,
    validateCompactProtocol: () => validateCompactProtocol,
    validatePageChunk: () => validatePageChunk,
    validateSchemaElements: () => validateSchemaElements
  });

  // node_modules/hyparquet/src/constants.js
  var ParquetTypes = [
    "BOOLEAN",
    "INT32",
    "INT64",
    "INT96",
    // deprecated
    "FLOAT",
    "DOUBLE",
    "BYTE_ARRAY",
    "FIXED_LEN_BYTE_ARRAY"
  ];
  var Encodings = [
    "PLAIN",
    "GROUP_VAR_INT",
    // deprecated
    "PLAIN_DICTIONARY",
    "RLE",
    "BIT_PACKED",
    // deprecated
    "DELTA_BINARY_PACKED",
    "DELTA_LENGTH_BYTE_ARRAY",
    "DELTA_BYTE_ARRAY",
    "RLE_DICTIONARY",
    "BYTE_STREAM_SPLIT"
  ];
  var FieldRepetitionTypes = [
    "REQUIRED",
    "OPTIONAL",
    "REPEATED"
  ];
  var ConvertedTypes = [
    "UTF8",
    "MAP",
    "MAP_KEY_VALUE",
    "LIST",
    "ENUM",
    "DECIMAL",
    "DATE",
    "TIME_MILLIS",
    "TIME_MICROS",
    "TIMESTAMP_MILLIS",
    "TIMESTAMP_MICROS",
    "UINT_8",
    "UINT_16",
    "UINT_32",
    "UINT_64",
    "INT_8",
    "INT_16",
    "INT_32",
    "INT_64",
    "JSON",
    "BSON",
    "INTERVAL"
  ];
  var CompressionCodecs = [
    "UNCOMPRESSED",
    "SNAPPY",
    "GZIP",
    "LZO",
    "BROTLI",
    "LZ4",
    "ZSTD",
    "LZ4_RAW"
  ];
  var PageTypes = [
    "DATA_PAGE",
    "INDEX_PAGE",
    "DICTIONARY_PAGE",
    "DATA_PAGE_V2"
  ];
  var BoundaryOrders = [
    "UNORDERED",
    "ASCENDING",
    "DESCENDING"
  ];
  var EdgeInterpolationAlgorithms = [
    "SPHERICAL",
    "VINCENTY",
    "THOMAS",
    "ANDOYER",
    "KARNEY"
  ];

  // node_modules/hyparquet/src/wkb.js
  function wkbToGeojson(reader) {
    const flags = getFlags(reader);
    if (flags.type === 1) {
      return { type: "Point", coordinates: readPosition(reader, flags) };
    } else if (flags.type === 2) {
      return { type: "LineString", coordinates: readLine(reader, flags) };
    } else if (flags.type === 3) {
      return { type: "Polygon", coordinates: readPolygon(reader, flags) };
    } else if (flags.type === 4) {
      const points = [];
      for (let i = 0; i < flags.count; i++) {
        points.push(readPosition(reader, getFlags(reader)));
      }
      return { type: "MultiPoint", coordinates: points };
    } else if (flags.type === 5) {
      const lines = [];
      for (let i = 0; i < flags.count; i++) {
        lines.push(readLine(reader, getFlags(reader)));
      }
      return { type: "MultiLineString", coordinates: lines };
    } else if (flags.type === 6) {
      const polygons = [];
      for (let i = 0; i < flags.count; i++) {
        polygons.push(readPolygon(reader, getFlags(reader)));
      }
      return { type: "MultiPolygon", coordinates: polygons };
    } else if (flags.type === 7) {
      const geometries = [];
      for (let i = 0; i < flags.count; i++) {
        geometries.push(wkbToGeojson(reader));
      }
      return { type: "GeometryCollection", geometries };
    } else {
      throw new Error(`Unsupported geometry type: ${flags.type}`);
    }
  }
  function getFlags(reader) {
    const { view } = reader;
    const littleEndian = view.getUint8(reader.offset++) === 1;
    const rawType = view.getUint32(reader.offset, littleEndian);
    reader.offset += 4;
    const type = rawType % 1e3;
    const flags = Math.floor(rawType / 1e3);
    let count = 0;
    if (type > 1 && type <= 7) {
      count = view.getUint32(reader.offset, littleEndian);
      reader.offset += 4;
    }
    let dim = 2;
    if (flags) dim++;
    if (flags === 3) dim++;
    return { littleEndian, type, dim, count };
  }
  function readPosition(reader, flags) {
    const points = [];
    for (let i = 0; i < flags.dim; i++) {
      const coord = reader.view.getFloat64(reader.offset, flags.littleEndian);
      reader.offset += 8;
      points.push(coord);
    }
    return points;
  }
  function readLine(reader, flags) {
    const points = [];
    for (let i = 0; i < flags.count; i++) {
      points.push(readPosition(reader, flags));
    }
    return points;
  }
  function readPolygon(reader, flags) {
    const { view } = reader;
    const rings = [];
    for (let r = 0; r < flags.count; r++) {
      const count = view.getUint32(reader.offset, flags.littleEndian);
      reader.offset += 4;
      rings.push(readLine(reader, { ...flags, count }));
    }
    return rings;
  }

  // node_modules/hyparquet/src/convert.js
  var decoder = new TextDecoder();
  var DEFAULT_PARSERS = {
    timestampFromMilliseconds(millis) {
      return new Date(Number(millis));
    },
    timestampFromMicroseconds(micros) {
      return new Date(Number(micros / 1000n));
    },
    timestampFromNanoseconds(nanos) {
      return new Date(Number(nanos / 1000000n));
    },
    dateFromDays(days) {
      return new Date(days * 864e5);
    },
    stringFromBytes(bytes) {
      return bytes && decoder.decode(bytes);
    },
    jsonFromBytes(bytes) {
      return bytes && JSON.parse(decoder.decode(bytes));
    },
    geometryFromBytes(bytes) {
      return bytes && wkbToGeojson({ view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: 0 });
    },
    geographyFromBytes(bytes) {
      return bytes && wkbToGeojson({ view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: 0 });
    },
    uuidFromBytes(bytes) {
      if (!bytes) return void 0;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20, 32);
    }
  };
  function convertWithDictionary(data, dictionary2, encoding, columnDecoder) {
    if (dictionary2 && encoding.endsWith("_DICTIONARY")) {
      let output = data;
      if (data instanceof Uint8Array && !(dictionary2 instanceof Uint8Array)) {
        output = new dictionary2.constructor(data.length);
      }
      for (let i = 0; i < data.length; i++) {
        output[i] = dictionary2[data[i]];
      }
      return output;
    } else {
      return convert(data, columnDecoder);
    }
  }
  function convert(data, columnDecoder) {
    const { element, parsers, utf8 = true, schemaPath } = columnDecoder;
    const { type, converted_type: ctype, logical_type: ltype } = element;
    const nullable = element.repetition_type !== "REQUIRED";
    const isVariant = schemaPath?.some((s) => s.element.logical_type?.type === "VARIANT");
    if (isVariant && type === "BYTE_ARRAY" && ctype !== "UTF8" && ltype?.type !== "STRING") {
      return data;
    }
    if (ctype === "DECIMAL") {
      const scale = element.scale || 0;
      const factor = 10 ** -scale;
      const arr = new Array(data.length);
      for (let i = 0; i < arr.length; i++) {
        if (data[i] instanceof Uint8Array) {
          arr[i] = parseDecimal(data[i]) * factor;
        } else {
          arr[i] = Number(data[i]) * factor;
        }
      }
      return arr;
    }
    if (!ctype && type === "INT96") {
      return Array.from(data).map((v) => parsers.timestampFromNanoseconds(parseInt96Nanos(v)));
    }
    if (ctype === "DATE") {
      return Array.from(data).map((v) => parsers.dateFromDays(v));
    }
    if (ctype === "TIMESTAMP_MILLIS") {
      return Array.from(data).map((v) => parsers.timestampFromMilliseconds(v));
    }
    if (ctype === "TIMESTAMP_MICROS") {
      return Array.from(data).map((v) => parsers.timestampFromMicroseconds(v));
    }
    if (ctype === "JSON") {
      return data.map((v) => parsers.jsonFromBytes(v));
    }
    if (ctype === "BSON") {
      throw new Error("parquet bson not supported");
    }
    if (ctype === "INTERVAL") {
      throw new Error("parquet interval not supported");
    }
    if (ltype?.type === "GEOMETRY") {
      return data.map((v) => parsers.geometryFromBytes(v));
    }
    if (ltype?.type === "GEOGRAPHY") {
      return data.map((v) => parsers.geographyFromBytes(v));
    }
    if (ltype?.type === "UUID") {
      return data.map((v) => parsers.uuidFromBytes(v));
    }
    if (ctype === "UTF8" || ltype?.type === "STRING" || utf8 && type === "BYTE_ARRAY") {
      return data.map((v) => parsers.stringFromBytes(v));
    }
    if (ctype === "UINT_64" || ltype?.type === "INTEGER" && ltype.bitWidth === 64 && !ltype.isSigned) {
      if (data instanceof BigInt64Array) return new BigUint64Array(data.buffer, data.byteOffset, data.length);
      const arr = nullable ? new Array(data.length) : new BigUint64Array(data.length);
      for (let i = 0; i < arr.length; i++) arr[i] = data[i];
      return arr;
    }
    if (ctype === "UINT_32" || ltype?.type === "INTEGER" && ltype.bitWidth === 32 && !ltype.isSigned) {
      if (data instanceof Int32Array) return new Uint32Array(data.buffer, data.byteOffset, data.length);
      const arr = nullable ? new Array(data.length) : new Uint32Array(data.length);
      for (let i = 0; i < arr.length; i++) {
        arr[i] = data[i] < 0 ? 4294967296 + data[i] : data[i];
      }
      return arr;
    }
    if (ltype?.type === "FLOAT16") {
      return Array.from(data).map(parseFloat16);
    }
    if (ltype?.type === "TIMESTAMP") {
      const { unit } = ltype;
      let parser = parsers.timestampFromMilliseconds;
      if (unit === "MICROS") parser = parsers.timestampFromMicroseconds;
      if (unit === "NANOS") parser = parsers.timestampFromNanoseconds;
      const arr = new Array(data.length);
      for (let i = 0; i < arr.length; i++) {
        arr[i] = parser(data[i]);
      }
      return arr;
    }
    return data;
  }
  function parseDecimal(bytes) {
    if (!bytes.length) return 0;
    let value = 0n;
    for (const byte of bytes) {
      value = value * 256n + BigInt(byte);
    }
    const bits2 = bytes.length * 8;
    if (value >= 2n ** BigInt(bits2 - 1)) {
      value -= 2n ** BigInt(bits2);
    }
    return Number(value);
  }
  function parseInt96Nanos(value) {
    const days = (value >> 64n) - 2440588n;
    const nano = value & 0xffffffffffffffffn;
    return days * 86400000000000n + nano;
  }
  function parseFloat16(bytes) {
    if (!bytes) return void 0;
    const int16 = bytes[1] << 8 | bytes[0];
    const sign = int16 >> 15 ? -1 : 1;
    const exp = int16 >> 10 & 31;
    const frac = int16 & 1023;
    if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
    if (exp === 31) return frac ? NaN : sign * Infinity;
    return sign * 2 ** (exp - 15) * (1 + frac / 1024);
  }

  // node_modules/hyparquet/src/schema.js
  function schemaTree(schema, rootIndex, path) {
    const element = schema[rootIndex];
    const children = [];
    let count = 1;
    if (element.num_children) {
      while (children.length < element.num_children) {
        const childElement = schema[rootIndex + count];
        const child = schemaTree(schema, rootIndex + count, [...path, childElement.name]);
        count += child.count;
        children.push(child);
      }
    }
    return { count, element, children, path };
  }
  function getSchemaPath(schema, name) {
    let tree = schemaTree(schema, 0, []);
    const path = [tree];
    for (const part of name) {
      const child = tree.children.find((child2) => child2.element.name === part);
      if (!child) throw new Error(`parquet schema element not found: ${name}`);
      path.push(child);
      tree = child;
    }
    return path;
  }
  function getPhysicalColumns(schemaTree2) {
    const columns2 = [];
    function traverse(node) {
      if (node.children.length) {
        for (const child of node.children) {
          traverse(child);
        }
      } else {
        columns2.push(node.path.join("."));
      }
    }
    traverse(schemaTree2);
    return columns2;
  }
  function getMaxRepetitionLevel(schemaPath) {
    let maxLevel = 0;
    for (const { element } of schemaPath) {
      if (element.repetition_type === "REPEATED") {
        maxLevel++;
      }
    }
    return maxLevel;
  }
  function getMaxDefinitionLevel(schemaPath) {
    let maxLevel = 0;
    for (const { element } of schemaPath.slice(1)) {
      if (element.repetition_type !== "REQUIRED") {
        maxLevel++;
      }
    }
    return maxLevel;
  }
  function isListLike(schema) {
    if (!schema) return false;
    if (schema.element.converted_type !== "LIST") return false;
    if (schema.children.length > 1) return false;
    const firstChild = schema.children[0];
    if (firstChild.children.length > 1) return false;
    if (firstChild.element.repetition_type !== "REPEATED") return false;
    return true;
  }
  function isMapLike(schema) {
    if (!schema) return false;
    if (schema.element.converted_type !== "MAP") return false;
    if (schema.children.length > 1) return false;
    const firstChild = schema.children[0];
    if (firstChild.children.length !== 2) return false;
    if (firstChild.element.repetition_type !== "REPEATED") return false;
    const keyChild = firstChild.children.find((child) => child.element.name === "key");
    if (keyChild?.element.repetition_type === "REPEATED") return false;
    const valueChild = firstChild.children.find((child) => child.element.name === "value");
    if (valueChild?.element.repetition_type === "REPEATED") return false;
    return true;
  }
  function isFlatColumn(schemaPath) {
    if (schemaPath.length !== 2) return false;
    const [, column] = schemaPath;
    if (column.element.repetition_type === "REPEATED") return false;
    if (column.children.length) return false;
    return true;
  }

  // node_modules/hyparquet/src/thrift.js
  var STOP = 0;
  var TRUE = 1;
  var FALSE = 2;
  var BYTE = 3;
  var I16 = 4;
  var I32 = 5;
  var I64 = 6;
  var DOUBLE = 7;
  var BINARY = 8;
  var LIST = 9;
  var STRUCT = 12;
  function deserializeTCompactProtocol(reader) {
    const value = {};
    let fid = 0;
    while (reader.offset < reader.view.byteLength) {
      const byte = reader.view.getUint8(reader.offset++);
      const type = byte & 15;
      if (type === STOP) break;
      const delta = byte >> 4;
      fid = delta ? fid + delta : readZigZag(reader);
      value[`field_${fid}`] = readElement(reader, type);
    }
    return value;
  }
  function readElement(reader, type) {
    switch (type) {
      case TRUE:
        return true;
      case FALSE:
        return false;
      case BYTE:
        return reader.view.getInt8(reader.offset++);
      case I16:
      case I32:
        return readZigZag(reader);
      case I64:
        return readZigZagBigInt(reader);
      case DOUBLE: {
        const value = reader.view.getFloat64(reader.offset, true);
        reader.offset += 8;
        return value;
      }
      case BINARY: {
        const stringLength = readVarInt(reader);
        const strBytes = new Uint8Array(reader.view.buffer, reader.view.byteOffset + reader.offset, stringLength);
        reader.offset += stringLength;
        return strBytes;
      }
      case LIST: {
        const byte = reader.view.getUint8(reader.offset++);
        const elemType = byte & 15;
        let listSize = byte >> 4;
        if (listSize === 15) {
          listSize = readVarInt(reader);
        }
        const boolType = elemType === TRUE || elemType === FALSE;
        const values = new Array(listSize);
        for (let i = 0; i < listSize; i++) {
          values[i] = boolType ? readElement(reader, BYTE) === 1 : readElement(reader, elemType);
        }
        return values;
      }
      case STRUCT:
        return deserializeTCompactProtocol(reader);
      default:
        throw new Error(`thrift unhandled type: ${type}`);
    }
  }
  function readVarInt(reader) {
    let result = 0;
    let shift = 0;
    while (true) {
      const byte = reader.view.getUint8(reader.offset++);
      result |= (byte & 127) << shift;
      if (!(byte & 128)) {
        return result;
      }
      shift += 7;
    }
  }
  function readVarBigInt(reader) {
    let result = 0n;
    let shift = 0n;
    while (true) {
      const byte = reader.view.getUint8(reader.offset++);
      result |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) {
        return result;
      }
      shift += 7n;
    }
  }
  function readZigZag(reader) {
    const zigzag = readVarInt(reader);
    return zigzag >>> 1 ^ -(zigzag & 1);
  }
  function readZigZagBigInt(reader) {
    const zigzag = readVarBigInt(reader);
    return zigzag >> 1n ^ -(zigzag & 1n);
  }

  // node_modules/hyparquet/src/geoparquet.js
  function markGeoColumns(schema, key_value_metadata) {
    const columns2 = /* @__PURE__ */ new Map();
    const geo = key_value_metadata?.find(({ key }) => key === "geo")?.value;
    const decodedColumns = (geo && JSON.parse(geo)?.columns) ?? {};
    for (const [name, column] of Object.entries(decodedColumns)) {
      if (column.encoding !== "WKB") continue;
      const type = column.edges === "spherical" ? "GEOGRAPHY" : "GEOMETRY";
      const id = column.crs?.id ?? column.crs?.ids?.[0];
      const crs = id ? `${id.authority}:${id.code.toString()}` : void 0;
      columns2.set(name, { type, crs });
    }
    for (let i = 1; i < schema.length; i++) {
      const { logical_type, name, num_children, type } = schema[i];
      if (num_children) {
        i += num_children;
        continue;
      }
      if (type === "BYTE_ARRAY" && !logical_type) {
        schema[i].logical_type = columns2.get(name);
      }
    }
  }

  // node_modules/hyparquet/src/metadata.js
  var defaultInitialFetchSize = 1 << 19;
  var decoder2 = new TextDecoder();
  function decode(value) {
    return value && decoder2.decode(value);
  }
  async function parquetMetadataAsync(asyncBuffer, { parsers, initialFetchSize = defaultInitialFetchSize, geoparquet = true } = {}) {
    if (!asyncBuffer || !(asyncBuffer.byteLength >= 0)) throw new Error("parquet expected AsyncBuffer");
    const footerOffset = Math.max(0, asyncBuffer.byteLength - initialFetchSize);
    const footerBuffer = await asyncBuffer.slice(footerOffset, asyncBuffer.byteLength);
    const footerView = new DataView(footerBuffer);
    if (footerView.getUint32(footerBuffer.byteLength - 4, true) !== 827474256) {
      throw new Error("parquet file invalid (footer != PAR1)");
    }
    const metadataLength = footerView.getUint32(footerBuffer.byteLength - 8, true);
    if (metadataLength > asyncBuffer.byteLength - 8) {
      throw new Error(`parquet metadata length ${metadataLength} exceeds available buffer ${asyncBuffer.byteLength - 8}`);
    }
    if (metadataLength + 8 > initialFetchSize) {
      const metadataOffset = asyncBuffer.byteLength - metadataLength - 8;
      const metadataBuffer = await asyncBuffer.slice(metadataOffset, footerOffset);
      const combinedBuffer = new ArrayBuffer(metadataLength + 8);
      const combinedView = new Uint8Array(combinedBuffer);
      combinedView.set(new Uint8Array(metadataBuffer));
      combinedView.set(new Uint8Array(footerBuffer), footerOffset - metadataOffset);
      return parquetMetadata(combinedBuffer, { parsers, geoparquet });
    } else {
      return parquetMetadata(footerBuffer, { parsers, geoparquet });
    }
  }
  function parquetMetadata(arrayBuffer, { parsers, geoparquet = true } = {}) {
    if (!(arrayBuffer instanceof ArrayBuffer)) throw new Error("parquet expected ArrayBuffer");
    const view = new DataView(arrayBuffer);
    parsers = { ...DEFAULT_PARSERS, ...parsers };
    if (view.byteLength < 8) {
      throw new Error("parquet file is too short");
    }
    if (view.getUint32(view.byteLength - 4, true) !== 827474256) {
      throw new Error("parquet file invalid (footer != PAR1)");
    }
    const metadataLengthOffset = view.byteLength - 8;
    const metadataLength = view.getUint32(metadataLengthOffset, true);
    if (metadataLength > view.byteLength - 8) {
      throw new Error(`parquet metadata length ${metadataLength} exceeds available buffer ${view.byteLength - 8}`);
    }
    const metadataOffset = metadataLengthOffset - metadataLength;
    const reader = { view, offset: metadataOffset };
    const metadata = deserializeTCompactProtocol(reader);
    const version = metadata.field_1;
    const schema = metadata.field_2.map((field) => ({
      type: ParquetTypes[field.field_1],
      type_length: field.field_2,
      repetition_type: FieldRepetitionTypes[field.field_3],
      name: decode(field.field_4),
      num_children: field.field_5,
      converted_type: ConvertedTypes[field.field_6],
      scale: field.field_7,
      precision: field.field_8,
      field_id: field.field_9,
      logical_type: logicalType(field.field_10)
    }));
    const columnSchema = schema.filter((e) => e.type);
    const num_rows = metadata.field_3;
    const row_groups = metadata.field_4.map((rowGroup) => ({
      columns: rowGroup.field_1.map((column, columnIndex) => ({
        file_path: decode(column.field_1),
        file_offset: column.field_2,
        meta_data: column.field_3 && {
          type: ParquetTypes[column.field_3.field_1],
          encodings: column.field_3.field_2?.map((e) => Encodings[e]),
          path_in_schema: column.field_3.field_3.map(decode),
          codec: CompressionCodecs[column.field_3.field_4],
          num_values: column.field_3.field_5,
          total_uncompressed_size: column.field_3.field_6,
          total_compressed_size: column.field_3.field_7,
          key_value_metadata: column.field_3.field_8?.map((kv) => ({
            key: decode(kv.field_1),
            value: decode(kv.field_2)
          })),
          data_page_offset: column.field_3.field_9,
          index_page_offset: column.field_3.field_10,
          dictionary_page_offset: column.field_3.field_11,
          statistics: convertStats(column.field_3.field_12, columnSchema[columnIndex], parsers),
          encoding_stats: column.field_3.field_13?.map((encodingStat) => ({
            page_type: PageTypes[encodingStat.field_1],
            encoding: Encodings[encodingStat.field_2],
            count: encodingStat.field_3
          })),
          bloom_filter_offset: column.field_3.field_14,
          bloom_filter_length: column.field_3.field_15,
          size_statistics: column.field_3.field_16 && {
            unencoded_byte_array_data_bytes: column.field_3.field_16.field_1,
            repetition_level_histogram: column.field_3.field_16.field_2,
            definition_level_histogram: column.field_3.field_16.field_3
          },
          geospatial_statistics: column.field_3.field_17 && {
            bbox: column.field_3.field_17.field_1 && {
              xmin: column.field_3.field_17.field_1.field_1,
              xmax: column.field_3.field_17.field_1.field_2,
              ymin: column.field_3.field_17.field_1.field_3,
              ymax: column.field_3.field_17.field_1.field_4,
              zmin: column.field_3.field_17.field_1.field_5,
              zmax: column.field_3.field_17.field_1.field_6,
              mmin: column.field_3.field_17.field_1.field_7,
              mmax: column.field_3.field_17.field_1.field_8
            },
            geospatial_types: column.field_3.field_17.field_2
          }
        },
        offset_index_offset: column.field_4,
        offset_index_length: column.field_5,
        column_index_offset: column.field_6,
        column_index_length: column.field_7,
        crypto_metadata: column.field_8,
        encrypted_column_metadata: column.field_9
      })),
      total_byte_size: rowGroup.field_2,
      num_rows: rowGroup.field_3,
      sorting_columns: rowGroup.field_4?.map((sortingColumn) => ({
        column_idx: sortingColumn.field_1,
        descending: sortingColumn.field_2,
        nulls_first: sortingColumn.field_3
      })),
      file_offset: rowGroup.field_5,
      total_compressed_size: rowGroup.field_6,
      ordinal: rowGroup.field_7
    }));
    const key_value_metadata = metadata.field_5?.map((kv) => ({
      key: decode(kv.field_1),
      value: decode(kv.field_2)
    }));
    const created_by = decode(metadata.field_6);
    if (geoparquet) {
      markGeoColumns(schema, key_value_metadata);
    }
    return {
      version,
      schema,
      num_rows,
      row_groups,
      key_value_metadata,
      created_by,
      metadata_length: metadataLength
    };
  }
  function parquetSchema({ schema }) {
    return getSchemaPath(schema, [])[0];
  }
  function logicalType(logicalType2) {
    if (logicalType2?.field_1) return { type: "STRING" };
    if (logicalType2?.field_2) return { type: "MAP" };
    if (logicalType2?.field_3) return { type: "LIST" };
    if (logicalType2?.field_4) return { type: "ENUM" };
    if (logicalType2?.field_5) return {
      type: "DECIMAL",
      scale: logicalType2.field_5.field_1,
      precision: logicalType2.field_5.field_2
    };
    if (logicalType2?.field_6) return { type: "DATE" };
    if (logicalType2?.field_7) return {
      type: "TIME",
      isAdjustedToUTC: logicalType2.field_7.field_1,
      unit: timeUnit(logicalType2.field_7.field_2)
    };
    if (logicalType2?.field_8) return {
      type: "TIMESTAMP",
      isAdjustedToUTC: logicalType2.field_8.field_1,
      unit: timeUnit(logicalType2.field_8.field_2)
    };
    if (logicalType2?.field_10) return {
      type: "INTEGER",
      bitWidth: logicalType2.field_10.field_1,
      isSigned: logicalType2.field_10.field_2
    };
    if (logicalType2?.field_11) return { type: "NULL" };
    if (logicalType2?.field_12) return { type: "JSON" };
    if (logicalType2?.field_13) return { type: "BSON" };
    if (logicalType2?.field_14) return { type: "UUID" };
    if (logicalType2?.field_15) return { type: "FLOAT16" };
    if (logicalType2?.field_16) return {
      type: "VARIANT",
      specification_version: logicalType2.field_16.field_1
    };
    if (logicalType2?.field_17) return {
      type: "GEOMETRY",
      crs: decode(logicalType2.field_17.field_1)
    };
    if (logicalType2?.field_18) return {
      type: "GEOGRAPHY",
      crs: decode(logicalType2.field_18.field_1),
      algorithm: EdgeInterpolationAlgorithms[logicalType2.field_18.field_2]
    };
    return logicalType2;
  }
  function timeUnit(unit) {
    if (unit.field_1) return "MILLIS";
    if (unit.field_2) return "MICROS";
    if (unit.field_3) return "NANOS";
    throw new Error("parquet time unit required");
  }
  function convertStats(stats, schema, parsers) {
    return stats && {
      max: convertMetadata(stats.field_1, schema, parsers),
      min: convertMetadata(stats.field_2, schema, parsers),
      null_count: stats.field_3,
      distinct_count: stats.field_4,
      max_value: convertMetadata(stats.field_5, schema, parsers),
      min_value: convertMetadata(stats.field_6, schema, parsers),
      is_max_value_exact: stats.field_7,
      is_min_value_exact: stats.field_8
    };
  }
  function convertMetadata(value, schema, parsers) {
    const { type, converted_type, logical_type } = schema;
    if (value === void 0) return value;
    if (type === "BOOLEAN") return value[0] === 1;
    if (type === "BYTE_ARRAY") return parsers.stringFromBytes(value);
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    if (type === "FLOAT" && view.byteLength === 4) return view.getFloat32(0, true);
    if (type === "DOUBLE" && view.byteLength === 8) return view.getFloat64(0, true);
    if (type === "INT32" && converted_type === "DECIMAL" && view.byteLength === 4) {
      return view.getInt32(0, true) * 10 ** -(schema.scale || 0);
    }
    if (type === "INT64" && converted_type === "DECIMAL" && view.byteLength === 8) {
      return Number(view.getBigInt64(0, true)) * 10 ** -(schema.scale || 0);
    }
    if (type === "INT32" && converted_type === "DATE") return parsers.dateFromDays(view.getInt32(0, true));
    if (type === "INT64" && converted_type === "TIMESTAMP_MILLIS") return parsers.timestampFromMilliseconds(view.getBigInt64(0, true));
    if (type === "INT64" && converted_type === "TIMESTAMP_MICROS") return parsers.timestampFromMicroseconds(view.getBigInt64(0, true));
    if (type === "INT64" && logical_type?.type === "TIMESTAMP" && logical_type?.unit === "NANOS") return parsers.timestampFromNanoseconds(view.getBigInt64(0, true));
    if (type === "INT64" && logical_type?.type === "TIMESTAMP" && logical_type?.unit === "MICROS") return parsers.timestampFromMicroseconds(view.getBigInt64(0, true));
    if (type === "INT64" && logical_type?.type === "TIMESTAMP") return parsers.timestampFromMilliseconds(view.getBigInt64(0, true));
    const unsigned = converted_type?.startsWith("UINT_") || logical_type?.type === "INTEGER" && !logical_type.isSigned;
    if (type === "INT32" && unsigned && view.byteLength === 4) return view.getUint32(0, true);
    if (type === "INT64" && unsigned && view.byteLength === 8) return view.getBigUint64(0, true);
    if (type === "INT32" && view.byteLength === 4) return view.getInt32(0, true);
    if (type === "INT64" && view.byteLength === 8) return view.getBigInt64(0, true);
    if (converted_type === "DECIMAL") return parseDecimal(value) * 10 ** -(schema.scale || 0);
    if (logical_type?.type === "FLOAT16") return parseFloat16(value);
    if (logical_type?.type === "UUID") return parsers.uuidFromBytes(value);
    if (type === "FIXED_LEN_BYTE_ARRAY") return value;
    return value;
  }

  // node_modules/hyparquet/src/indexes.js
  function readColumnIndex(reader, schema, parsers = void 0) {
    parsers = { ...DEFAULT_PARSERS, ...parsers };
    const thrift = deserializeTCompactProtocol(reader);
    return {
      null_pages: thrift.field_1,
      min_values: thrift.field_2.map((m) => convertMetadata(m, schema, parsers)),
      max_values: thrift.field_3.map((m) => convertMetadata(m, schema, parsers)),
      boundary_order: BoundaryOrders[thrift.field_4],
      null_counts: thrift.field_5,
      repetition_level_histograms: thrift.field_6,
      definition_level_histograms: thrift.field_7
    };
  }
  function readOffsetIndex(reader) {
    const thrift = deserializeTCompactProtocol(reader);
    return {
      // @ts-ignore
      page_locations: thrift.field_1.map((loc) => ({
        offset: loc.field_1,
        compressed_page_size: loc.field_2,
        first_row_index: loc.field_3
      })),
      unencoded_byte_array_data_bytes: thrift.field_2
    };
  }

  // node_modules/hyparquet/src/xxhash.js
  var MASK = 0xffffffffffffffffn;
  var PRIME1 = 0x9e3779b185ebca87n;
  var PRIME2 = 0xc2b2ae3d27d4eb4fn;
  var PRIME3 = 0x165667b19e3779f9n;
  var PRIME4 = 0x85ebca77c2b2ae63n;
  var PRIME5 = 0x27d4eb2f165667c5n;
  function rotl64(x, r) {
    return (x << r | x >> 64n - r) & MASK;
  }
  function round(acc, val) {
    acc = acc + val * PRIME2 & MASK;
    acc = rotl64(acc, 31n);
    return acc * PRIME1 & MASK;
  }
  function mergeRound(acc, val) {
    acc ^= round(0n, val);
    return acc * PRIME1 + PRIME4 & MASK;
  }
  function xxhash64(input, seed = 0n) {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const len = input.byteLength;
    let offset = 0;
    let h64;
    if (len >= 32) {
      let v1 = seed + PRIME1 + PRIME2 & MASK;
      let v2 = seed + PRIME2 & MASK;
      let v3 = seed;
      let v4 = seed - PRIME1 & MASK;
      while (offset + 32 <= len) {
        v1 = round(v1, view.getBigUint64(offset, true));
        offset += 8;
        v2 = round(v2, view.getBigUint64(offset, true));
        offset += 8;
        v3 = round(v3, view.getBigUint64(offset, true));
        offset += 8;
        v4 = round(v4, view.getBigUint64(offset, true));
        offset += 8;
      }
      h64 = rotl64(v1, 1n) + rotl64(v2, 7n) + rotl64(v3, 12n) + rotl64(v4, 18n) & MASK;
      h64 = mergeRound(h64, v1);
      h64 = mergeRound(h64, v2);
      h64 = mergeRound(h64, v3);
      h64 = mergeRound(h64, v4);
    } else {
      h64 = seed + PRIME5 & MASK;
    }
    h64 = h64 + BigInt(len) & MASK;
    while (offset + 8 <= len) {
      h64 ^= round(0n, view.getBigUint64(offset, true));
      h64 = rotl64(h64, 27n) * PRIME1 + PRIME4 & MASK;
      offset += 8;
    }
    if (offset + 4 <= len) {
      h64 ^= BigInt(view.getUint32(offset, true)) * PRIME1 & MASK;
      h64 = rotl64(h64, 23n) * PRIME2 + PRIME3 & MASK;
      offset += 4;
    }
    while (offset < len) {
      h64 ^= BigInt(view.getUint8(offset)) * PRIME5 & MASK;
      h64 = rotl64(h64, 11n) * PRIME1 & MASK;
      offset += 1;
    }
    h64 ^= h64 >> 33n;
    h64 = h64 * PRIME2 & MASK;
    h64 ^= h64 >> 29n;
    h64 = h64 * PRIME3 & MASK;
    h64 ^= h64 >> 32n;
    return h64;
  }

  // node_modules/hyparquet/src/bloom.js
  var textEncoder = new TextEncoder();
  var SALT = new Uint32Array([
    1203114875,
    1150766481,
    2284105051,
    2729912477,
    1884591559,
    770785867,
    2667333959,
    1550580529
  ]);
  function blockIndex(hash, numBlocks) {
    return Number((hash >> 32n) * BigInt(numBlocks) >> 32n);
  }
  function blockMask(hash) {
    const m = new Uint32Array(8);
    const low = Number(hash & 0xffffffffn) | 0;
    for (let i = 0; i < 8; i++) {
      m[i] = 1 << (Math.imul(low, SALT[i]) >>> 27);
    }
    return m;
  }
  function sbbfContains(blocks, hash) {
    const offset = blockIndex(hash, blocks.length >> 3) << 3;
    const m = blockMask(hash);
    for (let i = 0; i < 8; i++) {
      if ((blocks[offset + i] & m[i]) === 0) return false;
    }
    return true;
  }
  function readBloomFilter(reader) {
    const header = deserializeTCompactProtocol(reader);
    const numBytes = header.field_1;
    if (typeof numBytes !== "number" || numBytes <= 0 || numBytes % 32 !== 0) return void 0;
    if (!header.field_2?.field_1) return void 0;
    if (!header.field_3?.field_1) return void 0;
    if (!header.field_4?.field_1) return void 0;
    const { view, offset } = reader;
    if (offset + numBytes > view.byteLength) {
      throw new Error(`parquet bloom filter truncated: need ${numBytes} bytes, have ${view.byteLength - offset}`);
    }
    const blocks = new Uint32Array(numBytes >> 2);
    for (let i = 0; i < blocks.length; i++) {
      blocks[i] = view.getUint32(offset + i * 4, true);
    }
    reader.offset = offset + numBytes;
    return { numBytes, blocks };
  }
  function hashParquetValue(value, element) {
    if (value === null || value === void 0) return void 0;
    const { type, converted_type, logical_type } = element;
    if (type === "BOOLEAN") {
      if (typeof value !== "boolean") return void 0;
      return xxhash64(new Uint8Array([value ? 1 : 0]));
    }
    if (type === "FLOAT") {
      if (typeof value !== "number") return void 0;
      const buf = new ArrayBuffer(4);
      new DataView(buf).setFloat32(0, value, true);
      return xxhash64(new Uint8Array(buf));
    }
    if (type === "DOUBLE") {
      if (typeof value !== "number") return void 0;
      const buf = new ArrayBuffer(8);
      new DataView(buf).setFloat64(0, value, true);
      return xxhash64(new Uint8Array(buf));
    }
    if (type === "INT32") {
      if (converted_type === "DATE" || converted_type === "DECIMAL" || converted_type === "TIME_MILLIS") return void 0;
      if (logical_type?.type === "DATE" || logical_type?.type === "TIME" || logical_type?.type === "DECIMAL") return void 0;
      if (typeof value !== "number" || !Number.isInteger(value)) return void 0;
      const buf = new ArrayBuffer(4);
      new DataView(buf).setInt32(0, value | 0, true);
      return xxhash64(new Uint8Array(buf));
    }
    if (type === "INT64") {
      if (converted_type === "TIMESTAMP_MILLIS" || converted_type === "TIMESTAMP_MICROS") return void 0;
      if (converted_type === "TIME_MICROS" || converted_type === "DECIMAL") return void 0;
      if (logical_type?.type === "TIMESTAMP" || logical_type?.type === "TIME" || logical_type?.type === "DECIMAL") return void 0;
      let bigValue;
      if (typeof value === "bigint") bigValue = value;
      else if (typeof value === "number" && Number.isSafeInteger(value)) bigValue = BigInt(value);
      else return void 0;
      const buf = new ArrayBuffer(8);
      new DataView(buf).setBigUint64(0, BigInt.asUintN(64, bigValue), true);
      return xxhash64(new Uint8Array(buf));
    }
    if (type === "BYTE_ARRAY") {
      if (converted_type === "JSON" || converted_type === "BSON" || converted_type === "DECIMAL") return void 0;
      if (logical_type?.type === "JSON" || logical_type?.type === "BSON" || logical_type?.type === "VARIANT") return void 0;
      if (logical_type?.type === "GEOMETRY" || logical_type?.type === "GEOGRAPHY") return void 0;
      if (typeof value === "string") return xxhash64(textEncoder.encode(value));
      if (value instanceof Uint8Array) return xxhash64(value);
      return void 0;
    }
    if (type === "FIXED_LEN_BYTE_ARRAY") {
      if (converted_type === "DECIMAL" || converted_type === "INTERVAL") return void 0;
      if (logical_type?.type === "DECIMAL" || logical_type?.type === "UUID" || logical_type?.type === "FLOAT16") return void 0;
      if (logical_type?.type === "GEOMETRY" || logical_type?.type === "GEOGRAPHY") return void 0;
      if (value instanceof Uint8Array) return xxhash64(value);
      return void 0;
    }
    return void 0;
  }
  function bloomEligibleColumns(filter) {
    const out = /* @__PURE__ */ new Set();
    walkBloomEligible(filter, out);
    return out;
  }
  function walkBloomEligible(filter, out) {
    if (!filter) return;
    if ("$and" in filter && Array.isArray(filter.$and)) {
      for (const sub of filter.$and) walkBloomEligible(sub, out);
      return;
    }
    if ("$or" in filter && Array.isArray(filter.$or)) {
      for (const sub of filter.$or) walkBloomEligible(sub, out);
      return;
    }
    if ("$nor" in filter) return;
    for (const [field, condition] of Object.entries(filter)) {
      if (field.startsWith("$")) continue;
      if (typeof condition === "object" && condition !== null && !Array.isArray(condition)) {
        if ("$eq" in condition || "$in" in condition) out.add(field);
      } else {
        out.add(field);
      }
    }
  }

  // node_modules/hyparquet/src/utils.js
  function concat(aaa, bbb) {
    const chunk = 1e4;
    for (let i = 0; i < bbb.length; i += chunk) {
      aaa.push(...bbb.slice(i, i + chunk));
    }
  }
  function equals(a, b, strict = true) {
    if (strict ? a === b : a == b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    if (a instanceof Uint8Array && b instanceof Uint8Array) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    }
    if (a instanceof Date || b instanceof Date) {
      return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!equals(a[i], b[i], strict)) return false;
      }
      return true;
    }
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    for (const k of aKeys) {
      if (!equals(a[k], b[k], strict)) return false;
    }
    return true;
  }
  function flatten(chunks) {
    if (!chunks) return [];
    if (chunks.length === 1) return chunks[0];
    const output = [];
    for (const chunk of chunks) {
      concat(output, chunk);
    }
    return output;
  }

  // node_modules/hyparquet/src/filter.js
  var encoder = new TextEncoder();
  function pathsNeededForFilter(filter) {
    if (!filter) return [];
    const paths = [];
    if ("$and" in filter && Array.isArray(filter.$and)) {
      paths.push(...filter.$and.flatMap(pathsNeededForFilter));
    } else if ("$or" in filter && Array.isArray(filter.$or)) {
      paths.push(...filter.$or.flatMap(pathsNeededForFilter));
    } else if ("$nor" in filter && Array.isArray(filter.$nor)) {
      paths.push(...filter.$nor.flatMap(pathsNeededForFilter));
    } else {
      paths.push(...Object.keys(filter));
    }
    return [...new Set(paths)];
  }
  function columnsNeededForFilter(filter) {
    return [...new Set(pathsNeededForFilter(filter).map((path) => path.split(".")[0]))];
  }
  function matchFilter(record, filter, strict = true) {
    if ("$and" in filter && Array.isArray(filter.$and)) {
      return filter.$and.every((subQuery) => matchFilter(record, subQuery, strict));
    }
    if ("$or" in filter && Array.isArray(filter.$or)) {
      return filter.$or.some((subQuery) => matchFilter(record, subQuery, strict));
    }
    if ("$nor" in filter && Array.isArray(filter.$nor)) {
      return !filter.$nor.some((subQuery) => matchFilter(record, subQuery, strict));
    }
    return Object.entries(filter).every(([field, condition]) => {
      const value = resolve(record, field);
      if (typeof condition !== "object" || condition === null || Array.isArray(condition)) {
        return equals(value, condition, strict);
      }
      return Object.entries(condition || {}).every(([operator, target]) => {
        if (operator === "$gt") return value > target;
        if (operator === "$gte") return value >= target;
        if (operator === "$lt") return value < target;
        if (operator === "$lte") return value <= target;
        if (operator === "$eq") return equals(value, target, strict);
        if (operator === "$ne") return !equals(value, target, strict);
        if (operator === "$in") return Array.isArray(target) && matchesIn(value, target, strict);
        if (operator === "$nin") return Array.isArray(target) && !matchesIn(value, target, strict);
        if (operator === "$not") return !matchFilter({ [field]: value }, { [field]: target }, strict);
        return true;
      });
    });
  }
  function matchesIn(value, targets, strict) {
    return targets.some((target) => equals(value, target, strict) || Array.isArray(value) && value.some((element) => equals(element, target, strict)));
  }
  function canSkipRowGroup({ rowGroup, physicalColumns, filter, strict = true, bloomFilters, schemaElements }) {
    if (!filter) return false;
    if ("$and" in filter && Array.isArray(filter.$and)) {
      return filter.$and.some((subFilter) => canSkipRowGroup({ rowGroup, physicalColumns, filter: subFilter, strict, bloomFilters, schemaElements }));
    }
    if ("$or" in filter && Array.isArray(filter.$or)) {
      return filter.$or.every((subFilter) => canSkipRowGroup({ rowGroup, physicalColumns, filter: subFilter, strict, bloomFilters, schemaElements }));
    }
    if ("$nor" in filter && Array.isArray(filter.$nor)) {
      return false;
    }
    for (const [field, condition] of Object.entries(filter)) {
      const columnIndex = physicalColumns.indexOf(field);
      if (columnIndex === -1) continue;
      const stats = rowGroup.columns[columnIndex].meta_data?.statistics;
      const { min, max, min_value, max_value, null_count: nullCount } = stats || {};
      const minVal = min_value !== void 0 ? min_value : min;
      const maxVal = max_value !== void 0 ? max_value : max;
      const haveStats = minVal !== void 0 && maxVal !== void 0;
      const bloom = bloomFilters?.[field];
      const element = schemaElements?.[field];
      const matchingNulls = matchFilter({ value: null }, { value: condition }, strict) && (nullCount === void 0 || nullCount > 0);
      if (haveStats && !matchingNulls && canSkipStats(condition, minVal, maxVal, strict, element)) {
        return true;
      }
      for (const [operator, target] of Object.entries(condition || {})) {
        if (bloom && element) {
          if (operator === "$eq") {
            const hash = hashParquetValue(target, element);
            if (hash !== void 0 && !sbbfContains(bloom.blocks, hash)) return true;
          }
          if (operator === "$in" && Array.isArray(target) && target.length > 0) {
            let allAbsent = true;
            for (const v of target) {
              const h = hashParquetValue(v, element);
              if (h === void 0 || sbbfContains(bloom.blocks, h)) {
                allAbsent = false;
                break;
              }
            }
            if (allAbsent) return true;
          }
        }
      }
    }
    return false;
  }
  function canSkipStats(condition, minVal, maxVal, strict, element) {
    if (minVal === void 0 || maxVal === void 0) return false;
    const mayContainNaN = element?.type === "FLOAT" || element?.type === "DOUBLE" || element?.logical_type?.type === "FLOAT16";
    for (const [operator, target] of Object.entries(condition || {})) {
      const minComparison = compareParquetValues(minVal, target, strict, element);
      const maxComparison = compareParquetValues(maxVal, target, strict, element);
      const binaryBounds = minVal instanceof Uint8Array || maxVal instanceof Uint8Array;
      const relationalBoundsAreSafe = !binaryBounds && (element?.type !== "BYTE_ARRAY" || typeof target === "string" && [...target].every((character) => character.charCodeAt(0) <= 127));
      if (operator === "$gt" && relationalBoundsAreSafe && maxComparison !== void 0 && maxComparison <= 0) return true;
      if (operator === "$gte" && relationalBoundsAreSafe && maxComparison !== void 0 && maxComparison < 0) return true;
      if (operator === "$lt" && relationalBoundsAreSafe && minComparison !== void 0 && minComparison >= 0) return true;
      if (operator === "$lte" && relationalBoundsAreSafe && minComparison !== void 0 && minComparison > 0) return true;
      if (operator === "$eq") {
        const targetMinComparison = compareParquetValues(target, minVal, strict, element);
        const targetMaxComparison = compareParquetValues(target, maxVal, strict, element);
        if (targetMinComparison !== void 0 && targetMinComparison < 0 || targetMaxComparison !== void 0 && targetMaxComparison > 0) return true;
      }
      if (operator === "$ne" && !mayContainNaN && equals(minVal, maxVal, strict) && equals(minVal, target, strict)) return true;
      if (operator === "$in" && Array.isArray(target) && target.every((value) => {
        const valueMinComparison = compareParquetValues(value, minVal, strict, element);
        const valueMaxComparison = compareParquetValues(value, maxVal, strict, element);
        return valueMinComparison !== void 0 && valueMinComparison < 0 || valueMaxComparison !== void 0 && valueMaxComparison > 0;
      })) return true;
      if (operator === "$nin" && !mayContainNaN && Array.isArray(target) && equals(minVal, maxVal, strict) && target.some((value) => equals(minVal, value, strict))) return true;
    }
    return false;
  }
  function compareParquetValues(a, b, strict, element) {
    if (element?.type === "BYTE_ARRAY") {
      if (typeof a !== "string" || typeof b !== "string") return void 0;
      return compareBytes(encoder.encode(a), encoder.encode(b));
    }
    if (a instanceof Uint8Array || b instanceof Uint8Array) {
      if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return void 0;
      return compareBytes(a, b);
    }
    if (a < b) return -1;
    if (a > b) return 1;
    if (equals(a, b, strict)) return 0;
    return void 0;
  }
  function compareBytes(a, b) {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    if (a.length < b.length) return -1;
    if (a.length > b.length) return 1;
    return 0;
  }
  function matchesNull(condition, strict) {
    return matchFilter({ value: null }, { value: condition }, strict);
  }
  function filterPageRanges(filter, columnPages, groupRows, strict = true) {
    if (!filter) return void 0;
    if ("$and" in filter && Array.isArray(filter.$and)) {
      let ranges;
      for (const subFilter of filter.$and) {
        ranges = intersectRanges(ranges, filterPageRanges(subFilter, columnPages, groupRows, strict));
      }
      return ranges;
    }
    if ("$or" in filter && Array.isArray(filter.$or)) {
      let ranges = [];
      for (const subFilter of filter.$or) {
        const subRanges = filterPageRanges(subFilter, columnPages, groupRows, strict);
        if (!subRanges) return void 0;
        ranges = unionRanges(ranges, subRanges);
      }
      return ranges;
    }
    if ("$nor" in filter && Array.isArray(filter.$nor)) {
      return void 0;
    }
    let result;
    for (const [field, condition] of Object.entries(filter)) {
      const pages = columnPages[field];
      if (!pages) continue;
      const nullCanMatch = matchesNull(condition, strict);
      const keep = [];
      for (let i = 0; i < pages.pageStarts.length; i++) {
        const start = pages.pageStarts[i];
        const end = i + 1 < pages.pageStarts.length ? pages.pageStarts[i + 1] : groupRows;
        const nullCount = pages.nullCounts?.[i];
        const matchingNulls = nullCanMatch && (nullCount === void 0 || nullCount > 0);
        const skip = !pages.nullPages[i] && !matchingNulls && canSkipStats(condition, pages.minValues[i], pages.maxValues[i], strict, pages.element);
        if (!skip) {
          const last = keep[keep.length - 1];
          if (last && last[1] === start) last[1] = end;
          else keep.push([start, end]);
        }
      }
      result = intersectRanges(result, keep);
    }
    return result;
  }
  function intersectRanges(a, b) {
    if (!a) return b;
    if (!b) return a;
    const out = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      const start = Math.max(a[i][0], b[j][0]);
      const end = Math.min(a[i][1], b[j][1]);
      if (start < end) out.push([start, end]);
      if (a[i][1] < b[j][1]) i++;
      else j++;
    }
    return out;
  }
  function unionRanges(a, b) {
    const out = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      const next = j >= b.length || i < a.length && a[i][0] <= b[j][0] ? a[i++] : b[j++];
      const last = out[out.length - 1];
      if (last && next[0] <= last[1]) last[1] = Math.max(last[1], next[1]);
      else out.push([next[0], next[1]]);
    }
    return out;
  }
  function resolve(record, path) {
    let value = record;
    for (const part of path.split(".")) {
      value = value?.[part];
    }
    return value;
  }

  // node_modules/hyparquet/src/plan.js
  var runLimit = 1 << 21;
  function parquetPlan({ metadata, rowStart = 0, rowEnd = Infinity, columns: columns2, filter, filterStrict = true, useOffsetIndex = false, bloomFiltersByGroup, schemaElements, pageRangesByGroup, pageLocationsByGroup }) {
    if (!metadata) throw new Error("parquetPlan requires metadata");
    const groups = [];
    const fetches = [];
    const indexes = [];
    const schemaTree2 = parquetSchema(metadata);
    const physicalColumns = getPhysicalColumns(schemaTree2);
    const elementsByPath = filter ? {
      ...physicalSchemaElements(schemaTree2),
      ...schemaElements
    } : schemaElements;
    let groupStart = 0;
    let rgIdx = 0;
    for (const rowGroup of metadata.row_groups) {
      const groupRows = Number(rowGroup.num_rows);
      const groupEnd = groupStart + groupRows;
      const bloomFilters = bloomFiltersByGroup?.[rgIdx];
      if (groupRows > 0 && groupEnd > rowStart && groupStart < rowEnd && !canSkipRowGroup({ rowGroup, physicalColumns, filter, strict: filterStrict, bloomFilters, schemaElements: elementsByPath })) {
        const selectStart = Math.max(rowStart - groupStart, 0);
        const selectEnd = Math.min(rowEnd - groupStart, groupRows);
        const pageRanges = pageRangesByGroup?.[rgIdx];
        const pageLocations = pageLocationsByGroup?.[rgIdx];
        let subranges = pageRanges ? pageRanges.map(([start, end]) => {
          const range = [Math.max(start, selectStart), Math.min(end, selectEnd)];
          return range;
        }).filter(([start, end]) => start < end) : [[selectStart, selectEnd]];
        if (subranges.length > 1) {
          const canSplit = rowGroup.columns.every((chunk) => {
            const columnName = chunk.meta_data?.path_in_schema[0];
            const columnPath = chunk.meta_data?.path_in_schema.join(".");
            if (columns2 && columnName && !columns2.includes(columnName)) return true;
            return !!(chunk.offset_index_offset && chunk.offset_index_length) || !!(columnPath && pageLocations?.[columnPath]);
          });
          if (!canSplit) {
            subranges = [[subranges[0][0], subranges[subranges.length - 1][1]]];
          } else {
            subranges = coalesceOverlappingPageRanges(subranges, rowGroup, columns2, pageLocations);
          }
        }
        if (subranges.length) {
          const chunks = [];
          const narrowed = subranges.length > 1 || subranges[0][0] > 0 || subranges[0][1] < groupRows;
          for (const chunk of rowGroup.columns) {
            const meta = chunk.meta_data;
            if (chunk.file_path) throw new Error("parquet file_path not supported");
            if (!meta) throw new Error("parquet column metadata is undefined");
            if (!columns2 || columns2.includes(meta.path_in_schema[0])) {
              const columnOffset = meta.dictionary_page_offset || meta.data_page_offset;
              const startByte = Number(columnOffset);
              const endByte = Number(columnOffset + meta.total_compressed_size);
              const chunkPageLocations = pageLocations?.[meta.path_in_schema.join(".")];
              if (chunkPageLocations && narrowed) {
                chunks.push({
                  columnMetadata: meta,
                  pageLocations: chunkPageLocations,
                  range: { startByte, endByte }
                });
              } else if ((useOffsetIndex || pageRanges) && chunk.offset_index_offset && chunk.offset_index_length && narrowed) {
                const offsetIndexStart = Number(chunk.offset_index_offset);
                chunks.push({
                  columnMetadata: meta,
                  offsetIndex: {
                    startByte: offsetIndexStart,
                    endByte: offsetIndexStart + chunk.offset_index_length
                  },
                  range: { startByte, endByte }
                });
              } else {
                chunks.push({
                  columnMetadata: meta,
                  range: { startByte, endByte }
                });
              }
            }
          }
          for (const [subStart, subEnd] of subranges) {
            groups.push({ chunks, rowGroup, groupStart, groupRows, selectStart: subStart, selectEnd: subEnd });
          }
          let run;
          for (const chunk of chunks) {
            if ("pageLocations" in chunk) {
            } else if ("offsetIndex" in chunk) {
              indexes.push(chunk.offsetIndex);
            } else {
              const { range } = chunk;
              if (columns2) {
                fetches.push(range);
              } else if (run && range.endByte - run.startByte <= runLimit) {
                run.endByte = range.endByte;
              } else {
                if (run) fetches.push(run);
                run = { ...range };
              }
            }
          }
          if (run) fetches.push(run);
        }
      }
      groupStart = groupEnd;
      rgIdx++;
    }
    if (!isFinite(rowEnd)) rowEnd = groupStart;
    fetches.push(...indexes);
    return { metadata, rowStart, rowEnd, columns: columns2, fetches, groups };
  }
  function coalesceOverlappingPageRanges(ranges, rowGroup, columns2, pageLocations) {
    const selectedPageLayouts = rowGroup.columns.filter((chunk) => !columns2 || columns2.includes(chunk.meta_data?.path_in_schema[0] || "")).map((chunk) => pageLocations?.[chunk.meta_data?.path_in_schema.join(".") || ""]);
    const merged = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      const overlapsPage = last && selectedPageLayouts.some((pages) => {
        if (!pages) return true;
        const lastPages = pagesForRange(last, pages, Number(rowGroup.num_rows));
        const rangePages = pagesForRange(range, pages, Number(rowGroup.num_rows));
        return lastPages[0] <= rangePages[1] && rangePages[0] <= lastPages[1];
      });
      if (last && overlapsPage) last[1] = range[1];
      else merged.push([...range]);
    }
    return merged;
  }
  function pagesForRange([rangeStart, rangeEnd], pages, groupRows) {
    let first = Infinity;
    let last = -Infinity;
    for (let i = 0; i < pages.length; i++) {
      const pageStart = Number(pages[i].first_row_index);
      const pageEnd = i + 1 < pages.length ? Number(pages[i + 1].first_row_index) : groupRows;
      if (pageEnd > rangeStart && pageStart < rangeEnd) {
        first = Math.min(first, i);
        last = i;
      }
    }
    return [first, last];
  }
  async function prefetchBloomFilters({ file, metadata, filter, filterStrict = true }) {
    const result = metadata.row_groups.map(() => (
      /** @type {Record<string, BloomFilter>} */
      {}
    ));
    const eligibleCols = bloomEligibleColumns(filter);
    if (eligibleCols.size === 0) return result;
    const physicalColumns = getPhysicalColumns(parquetSchema(metadata));
    const tasks = [];
    metadata.row_groups.forEach((rowGroup, rgIdx) => {
      if (canSkipRowGroup({ rowGroup, physicalColumns, filter, strict: filterStrict })) return;
      for (const colName of eligibleCols) {
        const columnIdx = physicalColumns.indexOf(colName);
        if (columnIdx === -1) continue;
        const meta = rowGroup.columns[columnIdx]?.meta_data;
        if (!meta?.bloom_filter_offset || !meta.bloom_filter_length) continue;
        const start = Number(meta.bloom_filter_offset);
        const end = start + meta.bloom_filter_length;
        tasks.push((async () => {
          const buffer = await file.slice(start, end);
          const bloom = readBloomFilter({ view: new DataView(buffer), offset: 0 });
          if (bloom) result[rgIdx][colName] = bloom;
        })());
      }
    });
    if (tasks.length) await Promise.all(tasks);
    return result;
  }
  async function prefetchPageIndexes({ file, metadata, filter, filterStrict = true, rowStart = 0, rowEnd = Infinity, columns: columns2, bloomFiltersByGroup, schemaElements, parsers }) {
    const pageRangesByGroup = metadata.row_groups.map(() => void 0);
    const pageLocationsByGroup = metadata.row_groups.map(() => (
      /** @type {Record<string, PageLocation[]>} */
      {}
    ));
    if (filter && "$nor" in filter && Array.isArray(filter.$nor)) {
      return { pageRangesByGroup, pageLocationsByGroup };
    }
    const filterColumns = pathsNeededForFilter(filter);
    if (!filterColumns.length) return { pageRangesByGroup, pageLocationsByGroup };
    const schemaTree2 = parquetSchema(metadata);
    const physicalColumns = getPhysicalColumns(schemaTree2);
    const elementsByPath = {
      ...physicalSchemaElements(schemaTree2),
      ...schemaElements
    };
    const indexRanges = [];
    const indexTasks = [];
    const candidateGroups = [];
    let groupStart = 0;
    metadata.row_groups.forEach((rowGroup, rgIdx) => {
      const groupRows = Number(rowGroup.num_rows);
      const groupEnd = groupStart + groupRows;
      const overlaps = groupRows > 0 && groupEnd > rowStart && groupStart < rowEnd;
      groupStart = groupEnd;
      if (!overlaps) return;
      if (canSkipRowGroup({ rowGroup, physicalColumns, filter, strict: filterStrict, bloomFilters: bloomFiltersByGroup?.[rgIdx], schemaElements: elementsByPath })) return;
      const columnPages = {};
      let columnTaskCount = 0;
      const scheduledOffsetPaths = /* @__PURE__ */ new Set();
      let hasFilterIndex = false;
      for (const columnName of filterColumns) {
        const columnIdx = physicalColumns.indexOf(columnName);
        if (columnIdx === -1) continue;
        const chunk = rowGroup.columns[columnIdx];
        const meta = chunk?.meta_data;
        if (!meta) continue;
        if (!chunk.column_index_offset || !chunk.column_index_length) continue;
        if (!chunk.offset_index_offset || !chunk.offset_index_length) continue;
        const element = elementsByPath[columnName];
        if (!element) continue;
        hasFilterIndex = true;
        scheduledOffsetPaths.add(columnName);
        const columnIndexStart = Number(chunk.column_index_offset);
        const offsetIndexStart = Number(chunk.offset_index_offset);
        const columnIndexEnd = columnIndexStart + chunk.column_index_length;
        const offsetIndexEnd = offsetIndexStart + chunk.offset_index_length;
        indexRanges.push(
          { startByte: columnIndexStart, endByte: columnIndexEnd },
          { startByte: offsetIndexStart, endByte: offsetIndexEnd }
        );
        columnTaskCount++;
        indexTasks.push(async (prefetchedFile) => {
          const [columnIndexBuffer, offsetIndexBuffer] = await Promise.all([
            prefetchedFile.slice(columnIndexStart, columnIndexEnd),
            prefetchedFile.slice(offsetIndexStart, offsetIndexEnd)
          ]);
          const columnIndex = readColumnIndex({ view: new DataView(columnIndexBuffer), offset: 0 }, element, parsers);
          const offsetIndex = readOffsetIndex({ view: new DataView(offsetIndexBuffer), offset: 0 });
          pageLocationsByGroup[rgIdx][columnName] = offsetIndex.page_locations;
          columnPages[columnName] = {
            minValues: columnIndex.min_values,
            maxValues: columnIndex.max_values,
            nullPages: columnIndex.null_pages,
            nullCounts: columnIndex.null_counts,
            pageStarts: offsetIndex.page_locations.map((page) => Number(page.first_row_index)),
            element
          };
        });
      }
      if (hasFilterIndex) {
        for (const chunk of rowGroup.columns) {
          const meta = chunk.meta_data;
          if (!meta) continue;
          const columnName = meta.path_in_schema[0];
          const columnPath = meta.path_in_schema.join(".");
          if (columns2 && !columns2.includes(columnName)) continue;
          if (scheduledOffsetPaths.has(columnPath)) continue;
          if (!chunk.offset_index_offset || !chunk.offset_index_length) continue;
          scheduledOffsetPaths.add(columnPath);
          const offsetIndexStart = Number(chunk.offset_index_offset);
          const offsetIndexEnd = offsetIndexStart + chunk.offset_index_length;
          indexRanges.push({ startByte: offsetIndexStart, endByte: offsetIndexEnd });
          columnTaskCount++;
          indexTasks.push(async (prefetchedFile) => {
            const offsetIndexBuffer = await prefetchedFile.slice(offsetIndexStart, offsetIndexEnd);
            const offsetIndex = readOffsetIndex({ view: new DataView(offsetIndexBuffer), offset: 0 });
            pageLocationsByGroup[rgIdx][columnPath] = offsetIndex.page_locations;
          });
        }
      }
      if (columnTaskCount) {
        candidateGroups.push({ rgIdx, groupRows, columnPages });
      }
    });
    if (indexTasks.length) {
      const prefetchedFile = prefetchAsyncBuffer(file, { fetches: coalesceByteRanges(indexRanges) });
      await Promise.all(indexTasks.map((task) => task(prefetchedFile)));
      for (const { rgIdx, groupRows, columnPages } of candidateGroups) {
        pageRangesByGroup[rgIdx] = filterPageRanges(filter, columnPages, groupRows, filterStrict);
      }
    }
    return { pageRangesByGroup, pageLocationsByGroup };
  }
  function coalesceByteRanges(ranges) {
    const sorted = ranges.map((range) => ({ ...range })).sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);
    const merged = [];
    for (const range of sorted) {
      const last = merged[merged.length - 1];
      if (last && range.startByte <= last.endByte) {
        last.endByte = Math.max(last.endByte, range.endByte);
      } else {
        merged.push(range);
      }
    }
    return merged;
  }
  function physicalSchemaElements(schemaTree2) {
    const elements = {};
    function traverse(node) {
      if (node.children.length) {
        for (const child of node.children) traverse(child);
      } else {
        elements[node.path.join(".")] = node.element;
      }
    }
    traverse(schemaTree2);
    return elements;
  }
  function prefetchAsyncBuffer(file, { fetches }) {
    const promises = fetches.map(({ startByte, endByte }) => file.slice(startByte, endByte));
    return {
      byteLength: file.byteLength,
      slice(start, end = file.byteLength) {
        const index = fetches.findIndex(({ startByte, endByte }) => startByte <= start && end <= endByte);
        if (index < 0) {
          return file.slice(start, end);
        }
        if (fetches[index].startByte !== start || fetches[index].endByte !== end) {
          const startOffset = start - fetches[index].startByte;
          const endOffset = end - fetches[index].startByte;
          if (promises[index] instanceof Promise) {
            return promises[index].then((buffer) => buffer.slice(startOffset, endOffset));
          } else {
            return promises[index].slice(startOffset, endOffset);
          }
        } else {
          return promises[index];
        }
      }
    };
  }

  // node_modules/hyparquet/src/variant.js
  var decoder3 = new TextDecoder();
  var metadataCache = /* @__PURE__ */ new WeakMap();
  function decodeVariantColumn(value, parsers = DEFAULT_PARSERS) {
    if (Array.isArray(value)) {
      return value.map((entry) => decodeVariantColumn(entry, parsers));
    }
    if (typeof value !== "object") return value;
    if ("metadata" in value) {
      const metadata = parseVariantMetadata(value.metadata);
      const shreddedFields = value.typed_value && decodeTypedValue(value.typed_value, metadata, parsers);
      const binaryValue = value.value && readVariant(makeReader(value.value), metadata, parsers);
      if (shreddedFields && binaryValue) {
        return { ...binaryValue, ...shreddedFields };
      }
      return shreddedFields ?? binaryValue;
    }
    return value;
  }
  function decodeTypedValue(typedValue, metadata, parsers) {
    if (typedValue instanceof Date) return typedValue;
    if (typedValue && typeof typedValue === "object" && !Array.isArray(typedValue) && !(typedValue instanceof Uint8Array)) {
      if ("typed_value" in typedValue && typedValue.typed_value !== null && typedValue.typed_value !== void 0) {
        return decodeTypedValue(typedValue.typed_value, metadata, parsers);
      }
      if ("value" in typedValue && typedValue.value instanceof Uint8Array) {
        return readVariant(makeReader(typedValue.value), metadata, parsers);
      }
      if ("typed_value" in typedValue || "value" in typedValue) {
        return null;
      }
      const result = {};
      for (const [key, field] of Object.entries(typedValue)) {
        if (!metadata.dictionary.includes(key)) continue;
        result[key] = decodeTypedValue(field, metadata, parsers);
      }
      return result;
    }
    if (typedValue instanceof Uint8Array) {
      return readVariant(makeReader(typedValue), metadata, parsers);
    }
    if (Array.isArray(typedValue)) {
      return typedValue.map((element) => decodeTypedValue(element, metadata, parsers));
    }
    return typedValue;
  }
  function makeReader(bytes) {
    return { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: 0 };
  }
  function parseVariantMetadata(bytes) {
    let bufferCache = metadataCache.get(bytes.buffer);
    if (!bufferCache) {
      bufferCache = /* @__PURE__ */ new Map();
      metadataCache.set(bytes.buffer, bufferCache);
    }
    const key = `${bytes.byteOffset}:${bytes.byteLength}`;
    const cached = bufferCache.get(key);
    if (cached) return cached;
    const reader = makeReader(bytes);
    const header = reader.view.getUint8(reader.offset++);
    const version = header & 15;
    if (version !== 1) throw new Error(`parquet unsupported variant metadata version: ${version}`);
    const sorted = (header >> 4 & 1) === 1;
    const offsetSize = (header >> 6 & 3) + 1;
    const dictionarySize = readUnsigned(reader, offsetSize);
    const offsets = new Array(dictionarySize + 1);
    for (let i = 0; i < offsets.length; i++) {
      offsets[i] = readUnsigned(reader, offsetSize);
    }
    const base = reader.offset;
    const dictionary2 = new Array(dictionarySize);
    for (let i = 0; i < dictionarySize; i++) {
      const start = offsets[i];
      const end = offsets[i + 1];
      const strBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + base + start, end - start);
      dictionary2[i] = decoder3.decode(strBytes);
    }
    const metadata = { dictionary: dictionary2, sorted };
    bufferCache.set(key, metadata);
    return metadata;
  }
  function readUnsigned(reader, byteWidth2) {
    let value = 0;
    for (let i = 0; i < byteWidth2; i++) {
      value |= reader.view.getUint8(reader.offset + i) << i * 8;
    }
    reader.offset += byteWidth2;
    return value;
  }
  function readVariant(reader, metadata, parsers) {
    const typeByte = reader.view.getUint8(reader.offset++);
    const basicType = typeByte & 3;
    const header = typeByte >> 2;
    if (basicType === 0) return readVariantPrimitive(reader, header, parsers);
    if (basicType === 2) return readVariantObject(reader, header, metadata, parsers);
    if (basicType === 3) return readVariantArray(reader, header, metadata, parsers);
    const bytes = new Uint8Array(reader.view.buffer, reader.view.byteOffset + reader.offset, header);
    reader.offset += header;
    return decoder3.decode(bytes);
  }
  function readVariantPrimitive(reader, typeId, parsers) {
    switch (typeId) {
      case 0:
        return null;
      case 1:
        return true;
      case 2:
        return false;
      case 3: {
        const value = reader.view.getInt8(reader.offset);
        reader.offset += 1;
        return value;
      }
      case 4: {
        const value = reader.view.getInt16(reader.offset, true);
        reader.offset += 2;
        return value;
      }
      case 5: {
        const value = reader.view.getInt32(reader.offset, true);
        reader.offset += 4;
        return value;
      }
      case 6: {
        const value = reader.view.getBigInt64(reader.offset, true);
        reader.offset += 8;
        return value;
      }
      case 7: {
        const value = reader.view.getFloat64(reader.offset, true);
        reader.offset += 8;
        return value;
      }
      case 8:
        return readVariantDecimal(reader, 4);
      case 9:
        return readVariantDecimal(reader, 8);
      case 10:
        return readVariantDecimal(reader, 16);
      case 11: {
        const value = reader.view.getInt32(reader.offset, true);
        reader.offset += 4;
        return parsers.dateFromDays(value);
      }
      case 12:
      // timestamp_micros (utc)
      case 13: {
        const value = reader.view.getBigInt64(reader.offset, true);
        reader.offset += 8;
        return parsers.timestampFromMicroseconds(value);
      }
      case 14: {
        const value = reader.view.getFloat32(reader.offset, true);
        reader.offset += 4;
        return value;
      }
      case 15:
        return readVariantBinary(reader);
      case 16: {
        const bytes = readVariantBinary(reader);
        return decoder3.decode(bytes);
      }
      case 17: {
        const value = reader.view.getBigInt64(reader.offset, true);
        reader.offset += 8;
        return value;
      }
      case 18:
      // timestamp_nanos (utc)
      case 19: {
        const value = reader.view.getBigInt64(reader.offset, true);
        reader.offset += 8;
        return parsers.timestampFromNanoseconds(value);
      }
      case 20: {
        const bytes = new Uint8Array(reader.view.buffer, reader.view.byteOffset + reader.offset, 16);
        reader.offset += 16;
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }
      default:
        throw new Error(`parquet unsupported variant primitive type: ${typeId}`);
    }
  }
  function readVariantObject(reader, header, metadata, parsers) {
    const offsetWidth = (header & 3) + 1;
    const idWidth = (header >> 2 & 3) + 1;
    const isLarge = header >> 4 & 1;
    const numElements = isLarge ? readUnsigned(reader, 4) : reader.view.getUint8(reader.offset++);
    const fieldIds = new Array(numElements);
    for (let i = 0; i < numElements; i++) {
      fieldIds[i] = readUnsigned(reader, idWidth);
    }
    const offsets = new Array(numElements + 1);
    for (let i = 0; i < offsets.length; i++) {
      offsets[i] = readUnsigned(reader, offsetWidth);
    }
    const out = {};
    for (let i = 0; i < numElements; i++) {
      const key = metadata.dictionary[fieldIds[i]];
      const valueReader = {
        view: reader.view,
        offset: reader.offset + offsets[i]
      };
      out[key] = readVariant(valueReader, metadata, parsers);
    }
    reader.offset += offsets[offsets.length - 1];
    return out;
  }
  function readVariantArray(reader, header, metadata, parsers) {
    const fieldOffsetSize = header & 3;
    const isLarge = header >> 2 & 1;
    const offsetWidth = fieldOffsetSize + 1;
    const numElements = readUnsigned(reader, isLarge ? 4 : 1);
    const offsets = new Array(numElements + 1);
    for (let i = 0; i < offsets.length; i++) {
      offsets[i] = readUnsigned(reader, offsetWidth);
    }
    const valuesStart = reader.offset;
    const result = new Array(numElements);
    for (let i = 0; i < numElements; i++) {
      const valueReader = {
        view: reader.view,
        offset: valuesStart + offsets[i]
      };
      result[i] = readVariant(valueReader, metadata, parsers);
    }
    reader.offset = valuesStart + offsets[offsets.length - 1];
    return result;
  }
  function readVariantDecimal(reader, width) {
    const scale = reader.view.getUint8(reader.offset);
    reader.offset += 1;
    let unscaled;
    if (width === 4) {
      unscaled = BigInt(reader.view.getInt32(reader.offset, true));
      reader.offset += 4;
    } else if (width === 8) {
      unscaled = reader.view.getBigInt64(reader.offset, true);
      reader.offset += 8;
    } else {
      const low = reader.view.getBigUint64(reader.offset, true);
      const high = reader.view.getBigInt64(reader.offset + 8, true);
      unscaled = high << 64n | low;
      reader.offset += 16;
    }
    return Number(unscaled) * 10 ** -scale;
  }
  function readVariantBinary(reader) {
    const length = reader.view.getUint32(reader.offset, true);
    reader.offset += 4;
    const bytes = new Uint8Array(reader.view.buffer, reader.view.byteOffset + reader.offset, length);
    reader.offset += length;
    return bytes;
  }

  // node_modules/hyparquet/src/assemble.js
  function assembleLists(output, definitionLevels, repetitionLevels, values, schemaPath) {
    const maxDefinitionLevel = getMaxDefinitionLevel(schemaPath);
    if (!definitionLevels?.length && !repetitionLevels.length) {
      if (!maxDefinitionLevel || !values.length) return values;
      definitionLevels = new Array(values.length).fill(maxDefinitionLevel);
    }
    const n = definitionLevels?.length || repetitionLevels.length;
    const repetitionPath = schemaPath.map(({ element }) => element.repetition_type);
    let valueIndex = 0;
    const containerStack = [output];
    let currentContainer = output;
    let currentDepth = 0;
    let currentDefLevel = 0;
    let currentRepLevel = 0;
    if (repetitionLevels[0]) {
      while (currentDepth < repetitionPath.length - 2 && currentRepLevel < repetitionLevels[0]) {
        currentDepth++;
        if (repetitionPath[currentDepth] !== "REQUIRED") {
          currentContainer = currentContainer.at(-1);
          containerStack.push(currentContainer);
          currentDefLevel++;
        }
        if (repetitionPath[currentDepth] === "REPEATED") currentRepLevel++;
      }
    }
    for (let i = 0; i < n; i++) {
      const def = definitionLevels?.length ? definitionLevels[i] : maxDefinitionLevel;
      const rep = repetitionLevels[i];
      while (currentDepth && (rep < currentRepLevel || repetitionPath[currentDepth] !== "REPEATED")) {
        if (repetitionPath[currentDepth] !== "REQUIRED") {
          containerStack.pop();
          currentDefLevel--;
        }
        if (repetitionPath[currentDepth] === "REPEATED") currentRepLevel--;
        currentDepth--;
      }
      currentContainer = containerStack.at(-1);
      while ((currentDepth < repetitionPath.length - 2 || repetitionPath[currentDepth + 1] === "REPEATED") && (currentDefLevel < def || repetitionPath[currentDepth + 1] === "REQUIRED")) {
        currentDepth++;
        if (repetitionPath[currentDepth] !== "REQUIRED") {
          const newList = [];
          currentContainer.push(newList);
          currentContainer = newList;
          containerStack.push(newList);
          currentDefLevel++;
        }
        if (repetitionPath[currentDepth] === "REPEATED") currentRepLevel++;
      }
      if (def === maxDefinitionLevel) {
        currentContainer.push(values[valueIndex++]);
      } else if (currentDepth === repetitionPath.length - 2) {
        currentContainer.push(null);
      } else {
        currentContainer.push([]);
      }
    }
    if (!output.length) {
      for (let i = 0; i < maxDefinitionLevel; i++) {
        const newList = [];
        currentContainer.push(newList);
        currentContainer = newList;
      }
    }
    return output;
  }
  function assembleNested(subcolumnData, schema, parsers, depth = 0) {
    const path = schema.path.join(".");
    const optional = schema.element.repetition_type === "OPTIONAL";
    const nextDepth = optional ? depth + 1 : depth;
    if (isListLike(schema)) {
      let sublist = schema.children[0];
      let subDepth = nextDepth;
      if (sublist.children.length === 1) {
        sublist = sublist.children[0];
        subDepth++;
      }
      assembleNested(subcolumnData, sublist, parsers, subDepth);
      const subcolumn = sublist.path.join(".");
      const values = subcolumnData.get(subcolumn);
      if (!values) throw new Error("parquet list column missing values");
      if (optional) flattenAtDepth(values, depth);
      subcolumnData.set(path, values);
      subcolumnData.delete(subcolumn);
      return;
    }
    if (isMapLike(schema)) {
      const mapName = schema.children[0].element.name;
      assembleNested(subcolumnData, schema.children[0].children[0], parsers, nextDepth + 1);
      assembleNested(subcolumnData, schema.children[0].children[1], parsers, nextDepth + 1);
      const keys = subcolumnData.get(`${path}.${mapName}.key`);
      const values = subcolumnData.get(`${path}.${mapName}.value`);
      if (!keys) throw new Error("parquet map column missing keys");
      if (!values) throw new Error("parquet map column missing values");
      if (keys.length !== values.length) {
        throw new Error("parquet map column key/value length mismatch");
      }
      const out = assembleMaps(keys, values, nextDepth);
      if (optional) flattenAtDepth(out, depth);
      subcolumnData.delete(`${path}.${mapName}.key`);
      subcolumnData.delete(`${path}.${mapName}.value`);
      subcolumnData.set(path, out);
      return;
    }
    if (schema.children.length) {
      const invertDepth = schema.element.repetition_type === "REQUIRED" ? depth : depth + 1;
      const struct = {};
      for (const child of schema.children) {
        assembleNested(subcolumnData, child, parsers, invertDepth);
        const childData = subcolumnData.get(child.path.join("."));
        if (!childData) throw new Error("parquet struct missing child data");
        struct[child.element.name] = childData;
      }
      for (const child of schema.children) {
        subcolumnData.delete(child.path.join("."));
      }
      let inverted = invertStruct(struct, invertDepth);
      if (schema.element.logical_type?.type === "VARIANT") {
        inverted = decodeVariantColumn(inverted, parsers);
      }
      if (optional) flattenAtDepth(inverted, depth);
      subcolumnData.set(path, inverted);
    }
  }
  function flattenAtDepth(arr, depth) {
    for (let i = 0; i < arr.length; i++) {
      if (depth) {
        flattenAtDepth(arr[i], depth - 1);
      } else {
        arr[i] = arr[i][0];
      }
    }
  }
  function assembleMaps(keys, values, depth) {
    const out = [];
    for (let i = 0; i < keys.length; i++) {
      if (depth) {
        out.push(assembleMaps(keys[i], values[i], depth - 1));
      } else {
        if (keys[i]) {
          const obj = {};
          for (let j = 0; j < keys[i].length; j++) {
            const value = values[i][j];
            obj[keys[i][j]] = value === void 0 ? null : value;
          }
          out.push(obj);
        } else {
          out.push(void 0);
        }
      }
    }
    return out;
  }
  function invertStruct(struct, depth) {
    const keys = Object.keys(struct);
    const length = struct[keys[0]]?.length;
    const out = [];
    for (let i = 0; i < length; i++) {
      const obj = {};
      for (const key of keys) {
        if (struct[key].length !== length) throw new Error("parquet struct parsing error");
        obj[key] = struct[key][i];
      }
      if (depth) {
        out.push(invertStruct(obj, depth - 1));
      } else {
        out.push(obj);
      }
    }
    return out;
  }

  // node_modules/hyparquet/src/delta.js
  function deltaBinaryUnpack(reader, count, output) {
    const int32 = output instanceof Int32Array;
    const blockSize = readVarInt(reader);
    const miniblockPerBlock = readVarInt(reader);
    readVarInt(reader);
    let value = readZigZagBigInt(reader);
    let outputIndex = 0;
    output[outputIndex++] = int32 ? Number(value) : value;
    const valuesPerMiniblock = blockSize / miniblockPerBlock;
    while (outputIndex < count) {
      const minDelta = readZigZagBigInt(reader);
      const bitWidths = new Uint8Array(miniblockPerBlock);
      for (let i = 0; i < miniblockPerBlock; i++) {
        bitWidths[i] = reader.view.getUint8(reader.offset++);
      }
      for (let i = 0; i < miniblockPerBlock && outputIndex < count; i++) {
        const bitWidth2 = BigInt(bitWidths[i]);
        if (bitWidth2) {
          let bitpackPos = 0n;
          let miniblockCount = valuesPerMiniblock;
          const mask = (1n << bitWidth2) - 1n;
          while (miniblockCount && outputIndex < count) {
            let bits2 = BigInt(reader.view.getUint8(reader.offset)) >> bitpackPos & mask;
            bitpackPos += bitWidth2;
            while (bitpackPos >= 8) {
              bitpackPos -= 8n;
              reader.offset++;
              if (bitpackPos) {
                bits2 |= BigInt(reader.view.getUint8(reader.offset)) << bitWidth2 - bitpackPos & mask;
              }
            }
            const delta = minDelta + bits2;
            value += delta;
            output[outputIndex++] = int32 ? Number(value) : value;
            miniblockCount--;
          }
          if (miniblockCount) {
            reader.offset += Math.ceil((miniblockCount * Number(bitWidth2) + Number(bitpackPos)) / 8);
          }
        } else {
          for (let j = 0; j < valuesPerMiniblock && outputIndex < count; j++) {
            value += minDelta;
            output[outputIndex++] = int32 ? Number(value) : value;
          }
        }
      }
    }
  }
  function deltaLengthByteArray(reader, count, output) {
    const lengths = new Int32Array(count);
    deltaBinaryUnpack(reader, count, lengths);
    for (let i = 0; i < count; i++) {
      output[i] = new Uint8Array(reader.view.buffer, reader.view.byteOffset + reader.offset, lengths[i]);
      reader.offset += lengths[i];
    }
  }
  function deltaByteArray(reader, count, output) {
    const prefixData = new Int32Array(count);
    deltaBinaryUnpack(reader, count, prefixData);
    const suffixData = new Int32Array(count);
    deltaBinaryUnpack(reader, count, suffixData);
    for (let i = 0; i < count; i++) {
      const suffix = new Uint8Array(reader.view.buffer, reader.view.byteOffset + reader.offset, suffixData[i]);
      if (prefixData[i]) {
        output[i] = new Uint8Array(prefixData[i] + suffixData[i]);
        output[i].set(output[i - 1].subarray(0, prefixData[i]));
        output[i].set(suffix, prefixData[i]);
      } else {
        output[i] = suffix;
      }
      reader.offset += suffixData[i];
    }
  }

  // node_modules/hyparquet/src/encoding.js
  function readRleBitPackedHybrid(reader, width, output, length) {
    if (length === void 0) {
      length = reader.view.getUint32(reader.offset, true);
      reader.offset += 4;
    }
    const startOffset = reader.offset;
    let seen = 0;
    while (seen < output.length) {
      const header = readVarInt(reader);
      if (header & 1) {
        seen = readBitPacked(reader, header, width, output, seen);
      } else {
        const count = header >>> 1;
        readRle(reader, count, width, output, seen);
        seen += count;
      }
    }
    reader.offset = startOffset + length;
  }
  function readRle(reader, count, bitWidth2, output, seen) {
    const width = bitWidth2 + 7 >> 3;
    let value = 0;
    for (let i = 0; i < width; i++) {
      value |= reader.view.getUint8(reader.offset++) << (i << 3);
    }
    for (let i = 0; i < count; i++) {
      output[seen + i] = value;
    }
  }
  function readBitPacked(reader, header, bitWidth2, output, seen) {
    let count = header >> 1 << 3;
    const mask = (1 << bitWidth2) - 1;
    let data = 0;
    if (reader.offset < reader.view.byteLength) {
      data = reader.view.getUint8(reader.offset++);
    } else if (mask) {
      throw new Error(`parquet bitpack offset ${reader.offset} out of range`);
    }
    let left = 8;
    let right = 0;
    while (count) {
      if (right > 8) {
        right -= 8;
        left -= 8;
        data >>>= 8;
      } else if (left - right < bitWidth2) {
        data |= reader.view.getUint8(reader.offset) << left;
        reader.offset++;
        left += 8;
      } else {
        if (seen < output.length) {
          output[seen++] = data >> right & mask;
        }
        count--;
        right += bitWidth2;
      }
    }
    return seen;
  }
  function byteStreamSplit(reader, count, type, typeLength) {
    const width = byteWidth(type, typeLength);
    const bytes = new Uint8Array(count * width);
    for (let b = 0; b < width; b++) {
      for (let i = 0; i < count; i++) {
        bytes[i * width + b] = reader.view.getUint8(reader.offset++);
      }
    }
    if (type === "FLOAT") return new Float32Array(bytes.buffer);
    else if (type === "DOUBLE") return new Float64Array(bytes.buffer);
    else if (type === "INT32") return new Int32Array(bytes.buffer);
    else if (type === "INT64") return new BigInt64Array(bytes.buffer);
    else if (type === "FIXED_LEN_BYTE_ARRAY") {
      const split = new Array(count);
      for (let i = 0; i < count; i++) {
        split[i] = bytes.subarray(i * width, (i + 1) * width);
      }
      return split;
    }
    throw new Error(`parquet byte_stream_split unsupported type: ${type}`);
  }
  function byteWidth(type, typeLength) {
    switch (type) {
      case "INT32":
      case "FLOAT":
        return 4;
      case "INT64":
      case "DOUBLE":
        return 8;
      case "FIXED_LEN_BYTE_ARRAY":
        if (!typeLength) throw new Error("parquet byteWidth missing type_length");
        return typeLength;
      default:
        throw new Error(`parquet unsupported type: ${type}`);
    }
  }

  // node_modules/hyparquet/src/plain.js
  function readPlain(reader, type, count, fixedLength2) {
    if (count === 0) return [];
    if (type === "BOOLEAN") {
      return readPlainBoolean(reader, count);
    } else if (type === "INT32") {
      return readPlainInt32(reader, count);
    } else if (type === "INT64") {
      return readPlainInt64(reader, count);
    } else if (type === "INT96") {
      return readPlainInt96(reader, count);
    } else if (type === "FLOAT") {
      return readPlainFloat(reader, count);
    } else if (type === "DOUBLE") {
      return readPlainDouble(reader, count);
    } else if (type === "BYTE_ARRAY") {
      return readPlainByteArray(reader, count);
    } else if (type === "FIXED_LEN_BYTE_ARRAY") {
      if (!fixedLength2) throw new Error("parquet missing fixed length");
      return readPlainByteArrayFixed(reader, count, fixedLength2);
    } else {
      throw new Error(`parquet unhandled type: ${type}`);
    }
  }
  function readPlainBoolean(reader, count) {
    const values = new Array(count);
    for (let i = 0; i < count; i++) {
      const byteOffset = reader.offset + (i / 8 | 0);
      const bitOffset = i % 8;
      const byte = reader.view.getUint8(byteOffset);
      values[i] = (byte & 1 << bitOffset) !== 0;
    }
    reader.offset += Math.ceil(count / 8);
    return values;
  }
  function readPlainInt32(reader, count) {
    const values = (reader.view.byteOffset + reader.offset) % 4 ? new Int32Array(align(reader.view.buffer, reader.view.byteOffset + reader.offset, count * 4)) : new Int32Array(reader.view.buffer, reader.view.byteOffset + reader.offset, count);
    reader.offset += count * 4;
    return values;
  }
  function readPlainInt64(reader, count) {
    const values = (reader.view.byteOffset + reader.offset) % 8 ? new BigInt64Array(align(reader.view.buffer, reader.view.byteOffset + reader.offset, count * 8)) : new BigInt64Array(reader.view.buffer, reader.view.byteOffset + reader.offset, count);
    reader.offset += count * 8;
    return values;
  }
  function readPlainInt96(reader, count) {
    const values = new Array(count);
    for (let i = 0; i < count; i++) {
      const low = reader.view.getBigInt64(reader.offset + i * 12, true);
      const high = reader.view.getInt32(reader.offset + i * 12 + 8, true);
      values[i] = BigInt(high) << 64n | low;
    }
    reader.offset += count * 12;
    return values;
  }
  function readPlainFloat(reader, count) {
    const values = (reader.view.byteOffset + reader.offset) % 4 ? new Float32Array(align(reader.view.buffer, reader.view.byteOffset + reader.offset, count * 4)) : new Float32Array(reader.view.buffer, reader.view.byteOffset + reader.offset, count);
    reader.offset += count * 4;
    return values;
  }
  function readPlainDouble(reader, count) {
    const values = (reader.view.byteOffset + reader.offset) % 8 ? new Float64Array(align(reader.view.buffer, reader.view.byteOffset + reader.offset, count * 8)) : new Float64Array(reader.view.buffer, reader.view.byteOffset + reader.offset, count);
    reader.offset += count * 8;
    return values;
  }
  function readPlainByteArray(reader, count) {
    const values = new Array(count);
    for (let i = 0; i < count; i++) {
      const length = reader.view.getUint32(reader.offset, true);
      reader.offset += 4;
      values[i] = new Uint8Array(reader.view.buffer, reader.view.byteOffset + reader.offset, length);
      reader.offset += length;
    }
    return values;
  }
  function readPlainByteArrayFixed(reader, count, fixedLength2) {
    const values = new Array(count);
    for (let i = 0; i < count; i++) {
      values[i] = new Uint8Array(reader.view.buffer, reader.view.byteOffset + reader.offset, fixedLength2);
      reader.offset += fixedLength2;
    }
    return values;
  }
  function align(buffer, offset, size) {
    const aligned = new ArrayBuffer(size);
    new Uint8Array(aligned).set(new Uint8Array(buffer, offset, size));
    return aligned;
  }

  // node_modules/hyparquet/src/snappy.js
  var WORD_MASK = [0, 255, 65535, 16777215, 4294967295];
  function copyBytes(fromArray, fromPos, toArray, toPos, length) {
    for (let i = 0; i < length; i++) {
      toArray[toPos + i] = fromArray[fromPos + i];
    }
  }
  function snappyUncompress(input, output) {
    const inputLength = input.byteLength;
    const outputLength = output.byteLength;
    let pos = 0;
    let outPos = 0;
    while (pos < inputLength) {
      const c = input[pos];
      pos++;
      if (c < 128) {
        break;
      }
    }
    if (outputLength && pos >= inputLength) {
      throw new Error("invalid snappy length header");
    }
    while (pos < inputLength) {
      const c = input[pos];
      let len = 0;
      pos++;
      if (pos >= inputLength) {
        throw new Error("missing eof marker");
      }
      if ((c & 3) === 0) {
        let len2 = (c >>> 2) + 1;
        if (len2 > 60) {
          if (pos + 3 >= inputLength) {
            throw new Error("snappy error literal pos + 3 >= inputLength");
          }
          const lengthSize = len2 - 60;
          len2 = input[pos] + (input[pos + 1] << 8) + (input[pos + 2] << 16) + (input[pos + 3] << 24);
          len2 = (len2 & WORD_MASK[lengthSize]) + 1;
          pos += lengthSize;
        }
        if (pos + len2 > inputLength) {
          throw new Error("snappy error literal exceeds input length");
        }
        copyBytes(input, pos, output, outPos, len2);
        pos += len2;
        outPos += len2;
      } else {
        let offset = 0;
        switch (c & 3) {
          case 1:
            len = (c >>> 2 & 7) + 4;
            offset = input[pos] + (c >>> 5 << 8);
            pos++;
            break;
          case 2:
            if (inputLength <= pos + 1) {
              throw new Error("snappy error end of input");
            }
            len = (c >>> 2) + 1;
            offset = input[pos] + (input[pos + 1] << 8);
            pos += 2;
            break;
          case 3:
            if (inputLength <= pos + 3) {
              throw new Error("snappy error end of input");
            }
            len = (c >>> 2) + 1;
            offset = input[pos] + (input[pos + 1] << 8) + (input[pos + 2] << 16) + (input[pos + 3] << 24);
            pos += 4;
            break;
          default:
            break;
        }
        if (offset === 0 || isNaN(offset)) {
          throw new Error(`invalid offset ${offset} pos ${pos} inputLength ${inputLength}`);
        }
        if (offset > outPos) {
          throw new Error("cannot copy from before start of buffer");
        }
        copyBytes(output, outPos - offset, output, outPos, len);
        outPos += len;
      }
    }
    if (outPos !== outputLength) throw new Error("premature end of input");
  }

  // node_modules/hyparquet/src/datapage.js
  function readDataPage(bytes, daph, { type, element, schemaPath }) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const reader = { view, offset: 0 };
    let dataPage;
    const repetitionLevels = readRepetitionLevels(reader, daph, schemaPath);
    const { definitionLevels, numNulls } = readDefinitionLevels(reader, daph, schemaPath);
    const nValues = daph.num_values - numNulls;
    if (daph.encoding === "PLAIN") {
      dataPage = readPlain(reader, type, nValues, element.type_length);
    } else if (daph.encoding === "PLAIN_DICTIONARY" || daph.encoding === "RLE_DICTIONARY" || daph.encoding === "RLE") {
      const bitWidth2 = type === "BOOLEAN" ? 1 : view.getUint8(reader.offset++);
      if (bitWidth2) {
        dataPage = new Array(nValues);
        if (type === "BOOLEAN") {
          readRleBitPackedHybrid(reader, bitWidth2, dataPage);
          dataPage = dataPage.map((x) => !!x);
        } else {
          readRleBitPackedHybrid(reader, bitWidth2, dataPage, view.byteLength - reader.offset);
        }
      } else {
        dataPage = new Uint8Array(nValues);
      }
    } else if (daph.encoding === "BYTE_STREAM_SPLIT") {
      dataPage = byteStreamSplit(reader, nValues, type, element.type_length);
    } else if (daph.encoding === "DELTA_BINARY_PACKED") {
      const int32 = type === "INT32";
      dataPage = int32 ? new Int32Array(nValues) : new BigInt64Array(nValues);
      deltaBinaryUnpack(reader, nValues, dataPage);
    } else if (daph.encoding === "DELTA_LENGTH_BYTE_ARRAY") {
      dataPage = new Array(nValues);
      deltaLengthByteArray(reader, nValues, dataPage);
    } else {
      throw new Error(`parquet unsupported encoding: ${daph.encoding}`);
    }
    return { definitionLevels, repetitionLevels, dataPage };
  }
  function readRepetitionLevels(reader, daph, schemaPath) {
    if (schemaPath.length > 1) {
      const maxRepetitionLevel = getMaxRepetitionLevel(schemaPath);
      if (maxRepetitionLevel) {
        const values = new Array(daph.num_values);
        readRleBitPackedHybrid(reader, bitWidth(maxRepetitionLevel), values);
        return values;
      }
    }
    return [];
  }
  function readDefinitionLevels(reader, daph, schemaPath) {
    const maxDefinitionLevel = getMaxDefinitionLevel(schemaPath);
    if (!maxDefinitionLevel) return { definitionLevels: [], numNulls: 0 };
    const definitionLevels = new Array(daph.num_values);
    readRleBitPackedHybrid(reader, bitWidth(maxDefinitionLevel), definitionLevels);
    let numNulls = daph.num_values;
    for (const def of definitionLevels) {
      if (def === maxDefinitionLevel) numNulls--;
    }
    if (numNulls === 0) definitionLevels.length = 0;
    return { definitionLevels, numNulls };
  }
  function decompressPage(compressedBytes, uncompressed_page_size, codec, compressors2) {
    let page;
    const customDecompressor = compressors2?.[codec];
    if (codec === "UNCOMPRESSED") {
      page = compressedBytes;
    } else if (customDecompressor) {
      page = customDecompressor(compressedBytes, uncompressed_page_size);
    } else if (codec === "SNAPPY") {
      page = new Uint8Array(uncompressed_page_size);
      snappyUncompress(compressedBytes, page);
    } else {
      throw new Error(`parquet unsupported compression codec: ${codec}`);
    }
    if (page?.length !== uncompressed_page_size) {
      throw new Error(`parquet decompressed page length ${page?.length} does not match header ${uncompressed_page_size}`);
    }
    return page;
  }
  function readDataPageV2(compressedBytes, ph, columnDecoder) {
    const view = new DataView(compressedBytes.buffer, compressedBytes.byteOffset, compressedBytes.byteLength);
    const reader = { view, offset: 0 };
    const { type, element, schemaPath, codec, compressors: compressors2 } = columnDecoder;
    const daph2 = ph.data_page_header_v2;
    if (!daph2) throw new Error("parquet data page header v2 is undefined");
    const repetitionLevels = readRepetitionLevelsV2(reader, daph2, schemaPath);
    reader.offset = daph2.repetition_levels_byte_length;
    const definitionLevels = readDefinitionLevelsV2(reader, daph2, schemaPath);
    const uncompressedPageSize = ph.uncompressed_page_size - daph2.definition_levels_byte_length - daph2.repetition_levels_byte_length;
    let page = compressedBytes.subarray(reader.offset);
    if (daph2.is_compressed !== false) {
      page = decompressPage(page, uncompressedPageSize, codec, compressors2);
    }
    const pageView = new DataView(page.buffer, page.byteOffset, page.byteLength);
    const pageReader = { view: pageView, offset: 0 };
    let dataPage;
    const nValues = daph2.num_values - daph2.num_nulls;
    if (daph2.encoding === "PLAIN") {
      dataPage = readPlain(pageReader, type, nValues, element.type_length);
    } else if (daph2.encoding === "RLE") {
      dataPage = new Array(nValues);
      readRleBitPackedHybrid(pageReader, 1, dataPage);
      dataPage = dataPage.map((x) => !!x);
    } else if (daph2.encoding === "PLAIN_DICTIONARY" || daph2.encoding === "RLE_DICTIONARY") {
      const bitWidth2 = pageView.getUint8(pageReader.offset++);
      dataPage = new Array(nValues);
      readRleBitPackedHybrid(pageReader, bitWidth2, dataPage, uncompressedPageSize - 1);
    } else if (daph2.encoding === "DELTA_BINARY_PACKED") {
      const int32 = type === "INT32";
      dataPage = int32 ? new Int32Array(nValues) : new BigInt64Array(nValues);
      deltaBinaryUnpack(pageReader, nValues, dataPage);
    } else if (daph2.encoding === "DELTA_LENGTH_BYTE_ARRAY") {
      dataPage = new Array(nValues);
      deltaLengthByteArray(pageReader, nValues, dataPage);
    } else if (daph2.encoding === "DELTA_BYTE_ARRAY") {
      dataPage = new Array(nValues);
      deltaByteArray(pageReader, nValues, dataPage);
    } else if (daph2.encoding === "BYTE_STREAM_SPLIT") {
      dataPage = byteStreamSplit(pageReader, nValues, type, element.type_length);
    } else {
      throw new Error(`parquet unsupported encoding: ${daph2.encoding}`);
    }
    return { definitionLevels, repetitionLevels, dataPage };
  }
  function readRepetitionLevelsV2(reader, daph2, schemaPath) {
    const maxRepetitionLevel = getMaxRepetitionLevel(schemaPath);
    if (!maxRepetitionLevel) return [];
    const values = new Array(daph2.num_values);
    readRleBitPackedHybrid(reader, bitWidth(maxRepetitionLevel), values, daph2.repetition_levels_byte_length);
    return values;
  }
  function readDefinitionLevelsV2(reader, daph2, schemaPath) {
    const maxDefinitionLevel = getMaxDefinitionLevel(schemaPath);
    if (maxDefinitionLevel) {
      const values = new Array(daph2.num_values);
      readRleBitPackedHybrid(reader, bitWidth(maxDefinitionLevel), values, daph2.definition_levels_byte_length);
      return values;
    }
  }
  function bitWidth(value) {
    return 32 - Math.clz32(value);
  }

  // node_modules/hyparquet/src/column.js
  function readColumn(reader, { groupStart, selectStart, selectEnd }, columnDecoder, onPage) {
    const { pathInSchema, schemaPath } = columnDecoder;
    const isFlat = isFlatColumn(schemaPath);
    const chunks = [];
    let dictionary2 = void 0;
    let lastChunk = void 0;
    let rowCount = 0;
    let skipped = 0;
    const emitLastChunk = onPage && (() => {
      lastChunk && onPage({
        pathInSchema,
        columnData: lastChunk,
        rowStart: groupStart + rowCount - lastChunk.length,
        rowEnd: groupStart + rowCount
      });
    });
    while (isFlat ? rowCount < selectEnd : reader.offset < reader.view.byteLength - 1) {
      if (reader.offset >= reader.view.byteLength - 1) break;
      const header = parquetHeader(reader);
      if (header.type === "DICTIONARY_PAGE") {
        const { data } = readPage(reader, header, columnDecoder, dictionary2, void 0, 0);
        if (data) dictionary2 = convert(data, columnDecoder);
      } else {
        const lastChunkLength = lastChunk?.length || 0;
        const result = readPage(reader, header, columnDecoder, dictionary2, lastChunk, selectStart - rowCount);
        if (result.skipped) {
          if (!chunks.length) {
            skipped += result.skipped;
          }
          rowCount += result.skipped;
        } else if (result.data && lastChunk === result.data) {
          rowCount += result.data.length - lastChunkLength;
        } else if (result.data && result.data.length) {
          emitLastChunk?.();
          chunks.push(result.data);
          rowCount += result.data.length;
          lastChunk = result.data;
        }
      }
    }
    emitLastChunk?.();
    return { data: chunks, skipped };
  }
  function readPage(reader, header, columnDecoder, dictionary2, previousChunk, pageStart) {
    const { type, element, schemaPath, codec, compressors: compressors2 } = columnDecoder;
    const compressedBytes = new Uint8Array(
      reader.view.buffer,
      reader.view.byteOffset + reader.offset,
      header.compressed_page_size
    );
    reader.offset += header.compressed_page_size;
    if (header.type === "DATA_PAGE") {
      const daph = header.data_page_header;
      if (!daph) throw new Error("parquet data page header is undefined");
      if (pageStart > daph.num_values && isFlatColumn(schemaPath)) {
        return { skipped: daph.num_values };
      }
      const page = decompressPage(compressedBytes, Number(header.uncompressed_page_size), codec, compressors2);
      const { definitionLevels, repetitionLevels, dataPage } = readDataPage(page, daph, columnDecoder);
      const values = convertWithDictionary(dataPage, dictionary2, daph.encoding, columnDecoder);
      const output = Array.isArray(previousChunk) ? previousChunk : [];
      const assembled = assembleLists(output, definitionLevels, repetitionLevels, values, schemaPath);
      return { skipped: 0, data: assembled };
    } else if (header.type === "DATA_PAGE_V2") {
      const daph2 = header.data_page_header_v2;
      if (!daph2) throw new Error("parquet data page header v2 is undefined");
      if (pageStart > daph2.num_rows) {
        return { skipped: daph2.num_values };
      }
      const { definitionLevels, repetitionLevels, dataPage } = readDataPageV2(compressedBytes, header, columnDecoder);
      const values = convertWithDictionary(dataPage, dictionary2, daph2.encoding, columnDecoder);
      const output = Array.isArray(previousChunk) ? previousChunk : [];
      const assembled = assembleLists(output, definitionLevels, repetitionLevels, values, schemaPath);
      return { skipped: 0, data: assembled };
    } else if (header.type === "DICTIONARY_PAGE") {
      const diph = header.dictionary_page_header;
      if (!diph) throw new Error("parquet dictionary page header is undefined");
      const page = decompressPage(
        compressedBytes,
        Number(header.uncompressed_page_size),
        codec,
        compressors2
      );
      const reader2 = { view: new DataView(page.buffer, page.byteOffset, page.byteLength), offset: 0 };
      const dictArray = readPlain(reader2, type, diph.num_values, element.type_length);
      return { skipped: 0, data: dictArray };
    } else {
      throw new Error(`parquet unsupported page type: ${header.type}`);
    }
  }
  function parquetHeader(reader) {
    const header = deserializeTCompactProtocol(reader);
    const type = PageTypes[header.field_1];
    const uncompressed_page_size = header.field_2;
    const compressed_page_size = header.field_3;
    const crc = header.field_4;
    const data_page_header = header.field_5 && {
      num_values: header.field_5.field_1,
      encoding: Encodings[header.field_5.field_2],
      definition_level_encoding: Encodings[header.field_5.field_3],
      repetition_level_encoding: Encodings[header.field_5.field_4],
      statistics: header.field_5.field_5 && {
        max: header.field_5.field_5.field_1,
        min: header.field_5.field_5.field_2,
        null_count: header.field_5.field_5.field_3,
        distinct_count: header.field_5.field_5.field_4,
        max_value: header.field_5.field_5.field_5,
        min_value: header.field_5.field_5.field_6
      }
    };
    const index_page_header = header.field_6;
    const dictionary_page_header = header.field_7 && {
      num_values: header.field_7.field_1,
      encoding: Encodings[header.field_7.field_2],
      is_sorted: header.field_7.field_3
    };
    const data_page_header_v2 = header.field_8 && {
      num_values: header.field_8.field_1,
      num_nulls: header.field_8.field_2,
      num_rows: header.field_8.field_3,
      encoding: Encodings[header.field_8.field_4],
      definition_levels_byte_length: header.field_8.field_5,
      repetition_levels_byte_length: header.field_8.field_6,
      is_compressed: header.field_8.field_7 === void 0 ? true : header.field_8.field_7,
      // default true
      statistics: header.field_8.field_8
    };
    return {
      type,
      uncompressed_page_size,
      compressed_page_size,
      crc,
      data_page_header,
      index_page_header,
      dictionary_page_header,
      data_page_header_v2
    };
  }

  // node_modules/hyparquet/src/rowgroup.js
  function readRowGroup(options, { metadata }, groupPlan) {
    const asyncColumns = [];
    for (const chunk of groupPlan.chunks) {
      const { path_in_schema: pathInSchema } = chunk.columnMetadata;
      const schemaPath = getSchemaPath(metadata.schema, pathInSchema);
      const columnDecoder = {
        pathInSchema,
        element: schemaPath[schemaPath.length - 1].element,
        schemaPath,
        parsers: { ...DEFAULT_PARSERS, ...options.parsers },
        ...options,
        ...chunk.columnMetadata
      };
      const { startByte, endByte } = chunk.range;
      if ("pageLocations" in chunk) {
        asyncColumns.push({
          pathInSchema,
          data: readSelectedPages(options, groupPlan, chunk, chunk.pageLocations, columnDecoder)
        });
      } else if ("offsetIndex" in chunk) {
        asyncColumns.push({
          pathInSchema,
          // fetch offset index
          data: Promise.resolve(options.file.slice(chunk.offsetIndex.startByte, chunk.offsetIndex.endByte)).then((arrayBuffer) => {
            const pages = readOffsetIndex({ view: new DataView(arrayBuffer), offset: 0 }).page_locations;
            return readSelectedPages(options, groupPlan, chunk, pages, columnDecoder);
          })
        });
      } else {
        asyncColumns.push({
          pathInSchema,
          data: Promise.resolve(options.file.slice(startByte, endByte)).then((buffer) => {
            const reader = { view: new DataView(buffer), offset: 0 };
            return readColumn(reader, groupPlan, columnDecoder, options.onPage);
          })
        });
      }
    }
    return {
      groupStart: groupPlan.groupStart,
      groupRows: groupPlan.groupRows,
      selectStart: groupPlan.selectStart,
      selectEnd: groupPlan.selectEnd,
      asyncColumns
    };
  }
  async function readSelectedPages(options, groupPlan, chunk, pages, columnDecoder) {
    const { data_page_offset, dictionary_page_offset } = chunk.columnMetadata;
    const { selectStart, selectEnd } = groupPlan;
    let { startByte, endByte } = chunk.range;
    let skipped = -1;
    const hasDict = dictionary_page_offset || data_page_offset < pages[0].offset;
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const pageStart = Number(page.first_row_index);
      const pageEnd = i + 1 < pages.length ? Number(pages[i + 1].first_row_index) : groupPlan.groupRows;
      if (skipped < 0 && pageEnd > selectStart) {
        startByte = Number(page.offset);
        skipped = pageStart;
      }
      if (pageStart < selectEnd) {
        endByte = Number(page.offset) + page.compressed_page_size;
      }
    }
    if (skipped < 0) skipped = 0;
    let view;
    if (hasDict && skipped) {
      const dictLength = Number(pages[0].offset) - chunk.range.startByte;
      const [dictBuffer, dataBuffer] = await Promise.all([
        options.file.slice(chunk.range.startByte, Number(pages[0].offset)),
        options.file.slice(startByte, endByte)
      ]);
      const combined = new Uint8Array(dictLength + dataBuffer.byteLength);
      combined.set(new Uint8Array(dictBuffer, 0, dictLength));
      combined.set(new Uint8Array(dataBuffer), dictLength);
      view = new DataView(combined.buffer);
    } else if (hasDict) {
      view = new DataView(await options.file.slice(chunk.range.startByte, endByte));
    } else {
      view = new DataView(await options.file.slice(startByte, endByte));
    }
    const reader = { view, offset: 0 };
    const adjustedGroupPlan = skipped ? {
      ...groupPlan,
      groupStart: groupPlan.groupStart + skipped,
      selectStart: groupPlan.selectStart - skipped,
      selectEnd: groupPlan.selectEnd - skipped
    } : groupPlan;
    const { data, skipped: columnSkipped } = readColumn(reader, adjustedGroupPlan, columnDecoder, options.onPage);
    return {
      data,
      skipped: skipped + columnSkipped
    };
  }
  async function asyncGroupToRows({ asyncColumns }, selectStart, selectEnd, columns2, rowFormat) {
    const asyncPages = await Promise.all(asyncColumns.map(
      (column) => column.data.then(({ skipped, data }) => ({ skipped, data: flatten(data) }))
    ));
    const selectCount = selectEnd - selectStart;
    if (rowFormat === "object") {
      const groupData2 = Array(selectCount);
      for (let selectRow = 0; selectRow < selectCount; selectRow++) {
        const rowData = {};
        for (let i = 0; i < asyncColumns.length; i++) {
          const { data, skipped } = asyncPages[i];
          rowData[asyncColumns[i].pathInSchema[0]] = data[selectStart + selectRow - skipped];
        }
        groupData2[selectRow] = rowData;
      }
      return groupData2;
    }
    const includedColumnNames = asyncColumns.map((child) => child.pathInSchema[0]).filter((name) => !columns2 || columns2.includes(name));
    const columnOrder = columns2 ?? includedColumnNames;
    const columnIndexes = columnOrder.map((name) => asyncColumns.findIndex((column) => column.pathInSchema[0] === name));
    const groupData = Array(selectCount);
    for (let selectRow = 0; selectRow < selectCount; selectRow++) {
      const rowData = Array(asyncColumns.length);
      for (let i = 0; i < columnOrder.length; i++) {
        const colIdx = columnIndexes[i];
        if (colIdx < 0) throw new Error(`parquet column not found: ${columnOrder[i]}`);
        const { data, skipped } = asyncPages[colIdx];
        rowData[i] = data[selectStart + selectRow - skipped];
      }
      groupData[selectRow] = rowData;
    }
    return groupData;
  }
  function assembleAsync(asyncRowGroup, schemaTree2, parsers) {
    const { asyncColumns } = asyncRowGroup;
    parsers = { ...DEFAULT_PARSERS, ...parsers };
    const assembled = [];
    for (const child of schemaTree2.children) {
      if (child.children.length) {
        const childColumns = asyncColumns.filter((column) => column.pathInSchema[0] === child.element.name);
        if (!childColumns.length) continue;
        assembled.push({
          pathInSchema: child.path,
          data: (async () => {
            const resolved = await Promise.all(childColumns.map((c) => c.data));
            const subcolumnData = /* @__PURE__ */ new Map();
            const flattened = resolved.map(({ data }) => flatten(data));
            const skipped = Math.max(...resolved.map((result) => result.skipped));
            const end = Math.min(...resolved.map((result, i) => result.skipped + flattened[i].length));
            for (let i = 0; i < childColumns.length; i++) {
              const start = skipped - resolved[i].skipped;
              const length = Math.max(0, end - skipped);
              subcolumnData.set(
                childColumns[i].pathInSchema.join("."),
                flattened[i].slice(start, start + length)
              );
            }
            assembleNested(subcolumnData, child, parsers);
            const assembled2 = subcolumnData.get(child.element.name);
            if (!assembled2) throw new Error("parquet column data not assembled");
            return { data: [assembled2], skipped };
          })()
        });
      } else {
        const asyncColumn = asyncColumns.find((column) => column.pathInSchema[0] === child.element.name);
        if (asyncColumn) assembled.push(asyncColumn);
      }
    }
    return { ...asyncRowGroup, asyncColumns: assembled };
  }

  // node_modules/hyparquet/src/read.js
  async function parquetRead(options) {
    options.metadata ??= await parquetMetadataAsync(options.file, options);
    const { rowStart = 0, rowEnd, columns: columns2, onChunk, onComplete, rowFormat, filter, filterStrict = true } = options;
    if (filter && rowFormat !== "object") {
      throw new Error('parquet filter requires rowFormat: "object"');
    }
    const filterColumns = columnsNeededForFilter(filter);
    if (filterColumns.length) {
      const schemaColumns = parquetSchema(options.metadata).children.map((c) => c.element.name);
      const missingColumns = filterColumns.filter((c) => !schemaColumns.includes(c));
      if (missingColumns.length) {
        throw new Error(`parquet filter columns not found: ${missingColumns.join(", ")}`);
      }
    }
    let readColumns = columns2;
    let requiresProjection = false;
    if (columns2 && filter) {
      const missingFilterColumns = filterColumns.filter((c) => !columns2.includes(c));
      if (missingFilterColumns.length) {
        readColumns = [...columns2, ...missingFilterColumns];
        requiresProjection = true;
      }
    }
    let readOptions = readColumns !== columns2 ? { ...options, columns: readColumns } : options;
    readOptions = await withBloomFilters(readOptions);
    readOptions = await withPageIndexes(readOptions);
    const asyncGroups = parquetReadAsync(readOptions);
    if (!onComplete && !onChunk) {
      await awaitAllColumns(asyncGroups);
      return;
    }
    const schemaTree2 = parquetSchema(options.metadata);
    const assembled = asyncGroups.map((arg) => assembleAsync(arg, schemaTree2, options.parsers));
    if (onChunk) {
      for (const asyncGroup of assembled) {
        for (const asyncColumn of asyncGroup.asyncColumns) {
          asyncColumn.data.then(({ data, skipped }) => {
            let rowStart2 = asyncGroup.groupStart + skipped;
            for (const columnData of data) {
              onChunk({
                columnName: asyncColumn.pathInSchema[0],
                columnData,
                rowStart: rowStart2,
                rowEnd: rowStart2 + columnData.length
              });
              rowStart2 += columnData.length;
            }
          }, () => {
          });
        }
      }
    }
    if (onComplete) {
      await awaitAllColumns(assembled);
      const rows = [];
      for (const asyncGroup of assembled) {
        const selectStart = asyncGroup.selectStart ?? Math.max(rowStart - asyncGroup.groupStart, 0);
        const selectEnd = asyncGroup.selectEnd ?? Math.min((rowEnd ?? Infinity) - asyncGroup.groupStart, asyncGroup.groupRows);
        const groupData = rowFormat === "object" ? await asyncGroupToRows(asyncGroup, selectStart, selectEnd, readColumns, "object") : await asyncGroupToRows(asyncGroup, selectStart, selectEnd, columns2, "array");
        if (filter) {
          for (
            const row of
            /** @type {Record<string, any>[]} */
            groupData
          ) {
            if (matchFilter(row, filter, filterStrict)) {
              if (requiresProjection && columns2) {
                for (const col of filterColumns) {
                  if (!columns2.includes(col)) delete row[col];
                }
              }
              rows.push(row);
            }
          }
        } else {
          concat(rows, groupData);
        }
      }
      onComplete(rows);
    } else {
      await awaitAllColumns(assembled);
    }
  }
  async function awaitAllColumns(asyncGroups) {
    const all = asyncGroups.flatMap((g) => g.asyncColumns.map((c) => c.data));
    const results = await Promise.allSettled(all);
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
  }
  function parquetReadAsync(options) {
    if (!options.metadata) throw new Error("parquet requires metadata");
    const plan = parquetPlan(options);
    options.file = prefetchAsyncBuffer(options.file, plan);
    return plan.groups.map((groupPlan) => readRowGroup(options, plan, groupPlan));
  }
  async function withBloomFilters(options) {
    if (!options.useBloomFilters) return options;
    if (!options.filter || !options.metadata) return options;
    const schemaTree2 = parquetSchema(options.metadata);
    const schemaElements = {};
    for (const child of schemaTree2.children) schemaElements[child.element.name] = child.element;
    const bloomFiltersByGroup = await prefetchBloomFilters({
      file: options.file,
      metadata: options.metadata,
      filter: options.filter,
      filterStrict: options.filterStrict
    });
    return (
      /** @type {BaseParquetReadOptions} */
      { ...options, bloomFiltersByGroup, schemaElements }
    );
  }
  async function withPageIndexes(options) {
    if (!options.usePageIndex) return options;
    if (!options.filter || !options.metadata) return options;
    const { pageRangesByGroup, pageLocationsByGroup } = await prefetchPageIndexes({
      file: options.file,
      metadata: options.metadata,
      filter: options.filter,
      filterStrict: options.filterStrict,
      rowStart: options.rowStart,
      rowEnd: options.rowEnd,
      columns: options.columns,
      // @ts-expect-error bloomFiltersByGroup/schemaElements are attached by withBloomFilters
      bloomFiltersByGroup: options.bloomFiltersByGroup,
      // @ts-expect-error bloomFiltersByGroup/schemaElements are attached by withBloomFilters
      schemaElements: options.schemaElements,
      parsers: options.parsers
    });
    const readOptions = { ...options, pageRangesByGroup, pageLocationsByGroup };
    return readOptions;
  }

  // node_modules/fzstd/esm/index.mjs
  var ab = ArrayBuffer;
  var u8 = Uint8Array;
  var u16 = Uint16Array;
  var i16 = Int16Array;
  var i32 = Int32Array;
  var slc = function(v, s, e) {
    if (u8.prototype.slice)
      return u8.prototype.slice.call(v, s, e);
    if (s == null || s < 0)
      s = 0;
    if (e == null || e > v.length)
      e = v.length;
    var n = new u8(e - s);
    n.set(v.subarray(s, e));
    return n;
  };
  var fill = function(v, n, s, e) {
    if (u8.prototype.fill)
      return u8.prototype.fill.call(v, n, s, e);
    if (s == null || s < 0)
      s = 0;
    if (e == null || e > v.length)
      e = v.length;
    for (; s < e; ++s)
      v[s] = n;
    return v;
  };
  var cpw = function(v, t, s, e) {
    if (u8.prototype.copyWithin)
      return u8.prototype.copyWithin.call(v, t, s, e);
    if (s == null || s < 0)
      s = 0;
    if (e == null || e > v.length)
      e = v.length;
    while (s < e) {
      v[t++] = v[s++];
    }
  };
  var ec = [
    "invalid zstd data",
    "window size too large (>2046MB)",
    "invalid block type",
    "FSE accuracy too high",
    "match distance too far back",
    "unexpected EOF"
  ];
  var err = function(ind, msg, nt) {
    var e = new Error(msg || ec[ind]);
    e.code = ind;
    if (Error.captureStackTrace)
      Error.captureStackTrace(e, err);
    if (!nt)
      throw e;
    return e;
  };
  var rb = function(d, b, n) {
    var i = 0, o = 0;
    for (; i < n; ++i)
      o |= d[b++] << (i << 3);
    return o;
  };
  var b4 = function(d, b) {
    return (d[b] | d[b + 1] << 8 | d[b + 2] << 16 | d[b + 3] << 24) >>> 0;
  };
  var rzfh = function(dat, w) {
    var n3 = dat[0] | dat[1] << 8 | dat[2] << 16;
    if (n3 == 3126568 && dat[3] == 253) {
      var flg = dat[4];
      var ss = flg >> 5 & 1, cc = flg >> 2 & 1, df = flg & 3, fcf = flg >> 6;
      if (flg & 8)
        err(0);
      var bt = 6 - ss;
      var db = df == 3 ? 4 : df;
      var di = rb(dat, bt, db);
      bt += db;
      var fsb = fcf ? 1 << fcf : ss;
      var fss = rb(dat, bt, fsb) + (fcf == 1 && 256);
      var ws = fss;
      if (!ss) {
        var wb = 1 << 10 + (dat[5] >> 3);
        ws = wb + (wb >> 3) * (dat[5] & 7);
      }
      if (ws > 2145386496)
        err(1);
      var buf = new u8((w == 1 ? fss || ws : w ? 0 : ws) + 12);
      buf[0] = 1, buf[4] = 4, buf[8] = 8;
      return {
        b: bt + fsb,
        y: 0,
        l: 0,
        d: di,
        w: w && w != 1 ? w : buf.subarray(12),
        e: ws,
        o: new i32(buf.buffer, 0, 3),
        u: fss,
        c: cc,
        m: Math.min(131072, ws)
      };
    } else if ((n3 >> 4 | dat[3] << 20) == 25481893) {
      return b4(dat, 4) + 8;
    }
    err(0);
  };
  var msb = function(val) {
    var bits2 = 0;
    for (; 1 << bits2 <= val; ++bits2)
      ;
    return bits2 - 1;
  };
  var rfse = function(dat, bt, mal) {
    var tpos = (bt << 3) + 4;
    var al = (dat[bt] & 15) + 5;
    if (al > mal)
      err(3);
    var sz = 1 << al;
    var probs = sz, sym = -1, re = -1, i = -1, ht = sz;
    var buf = new ab(512 + (sz << 2));
    var freq = new i16(buf, 0, 256);
    var dstate = new u16(buf, 0, 256);
    var nstate = new u16(buf, 512, sz);
    var bb1 = 512 + (sz << 1);
    var syms = new u8(buf, bb1, sz);
    var nbits = new u8(buf, bb1 + sz);
    while (sym < 255 && probs > 0) {
      var bits2 = msb(probs + 1);
      var cbt = tpos >> 3;
      var msk = (1 << bits2 + 1) - 1;
      var val = (dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16) >> (tpos & 7) & msk;
      var msk1fb = (1 << bits2) - 1;
      var msv = msk - probs - 1;
      var sval = val & msk1fb;
      if (sval < msv)
        tpos += bits2, val = sval;
      else {
        tpos += bits2 + 1;
        if (val > msk1fb)
          val -= msv;
      }
      freq[++sym] = --val;
      if (val == -1) {
        probs += val;
        syms[--ht] = sym;
      } else
        probs -= val;
      if (!val) {
        do {
          var rbt = tpos >> 3;
          re = (dat[rbt] | dat[rbt + 1] << 8) >> (tpos & 7) & 3;
          tpos += 2;
          sym += re;
        } while (re == 3);
      }
    }
    if (sym > 255 || probs)
      err(0);
    var sympos = 0;
    var sstep = (sz >> 1) + (sz >> 3) + 3;
    var smask = sz - 1;
    for (var s = 0; s <= sym; ++s) {
      var sf = freq[s];
      if (sf < 1) {
        dstate[s] = -sf;
        continue;
      }
      for (i = 0; i < sf; ++i) {
        syms[sympos] = s;
        do {
          sympos = sympos + sstep & smask;
        } while (sympos >= ht);
      }
    }
    if (sympos)
      err(0);
    for (i = 0; i < sz; ++i) {
      var ns = dstate[syms[i]]++;
      var nb = nbits[i] = al - msb(ns);
      nstate[i] = (ns << nb) - sz;
    }
    return [tpos + 7 >> 3, {
      b: al,
      s: syms,
      n: nbits,
      t: nstate
    }];
  };
  var rhu = function(dat, bt) {
    var i = 0, wc = -1;
    var buf = new u8(292), hb = dat[bt];
    var hw = buf.subarray(0, 256);
    var rc = buf.subarray(256, 268);
    var ri = new u16(buf.buffer, 268);
    if (hb < 128) {
      var _a = rfse(dat, bt + 1, 6), ebt = _a[0], fdt = _a[1];
      bt += hb;
      var epos = ebt << 3;
      var lb = dat[bt];
      if (!lb)
        err(0);
      var st1 = 0, st2 = 0, btr1 = fdt.b, btr2 = btr1;
      var fpos = (++bt << 3) - 8 + msb(lb);
      for (; ; ) {
        fpos -= btr1;
        if (fpos < epos)
          break;
        var cbt = fpos >> 3;
        st1 += (dat[cbt] | dat[cbt + 1] << 8) >> (fpos & 7) & (1 << btr1) - 1;
        hw[++wc] = fdt.s[st1];
        fpos -= btr2;
        if (fpos < epos)
          break;
        cbt = fpos >> 3;
        st2 += (dat[cbt] | dat[cbt + 1] << 8) >> (fpos & 7) & (1 << btr2) - 1;
        hw[++wc] = fdt.s[st2];
        btr1 = fdt.n[st1];
        st1 = fdt.t[st1];
        btr2 = fdt.n[st2];
        st2 = fdt.t[st2];
      }
      if (++wc > 255)
        err(0);
    } else {
      wc = hb - 127;
      for (; i < wc; i += 2) {
        var byte = dat[++bt];
        hw[i] = byte >> 4;
        hw[i + 1] = byte & 15;
      }
      ++bt;
    }
    var wes = 0;
    for (i = 0; i < wc; ++i) {
      var wt = hw[i];
      if (wt > 11)
        err(0);
      wes += wt && 1 << wt - 1;
    }
    var mb = msb(wes) + 1;
    var ts = 1 << mb;
    var rem = ts - wes;
    if (rem & rem - 1)
      err(0);
    hw[wc++] = msb(rem) + 1;
    for (i = 0; i < wc; ++i) {
      var wt = hw[i];
      ++rc[hw[i] = wt && mb + 1 - wt];
    }
    var hbuf = new u8(ts << 1);
    var syms = hbuf.subarray(0, ts), nb = hbuf.subarray(ts);
    ri[mb] = 0;
    for (i = mb; i > 0; --i) {
      var pv = ri[i];
      fill(nb, i, pv, ri[i - 1] = pv + rc[i] * (1 << mb - i));
    }
    if (ri[0] != ts)
      err(0);
    for (i = 0; i < wc; ++i) {
      var bits2 = hw[i];
      if (bits2) {
        var code = ri[bits2];
        fill(syms, i, code, ri[bits2] = code + (1 << mb - bits2));
      }
    }
    return [bt, {
      n: nb,
      b: mb,
      s: syms
    }];
  };
  var dllt = rfse(/* @__PURE__ */ new u8([
    81,
    16,
    99,
    140,
    49,
    198,
    24,
    99,
    12,
    33,
    196,
    24,
    99,
    102,
    102,
    134,
    70,
    146,
    4
  ]), 0, 6)[1];
  var dmlt = rfse(/* @__PURE__ */ new u8([
    33,
    20,
    196,
    24,
    99,
    140,
    33,
    132,
    16,
    66,
    8,
    33,
    132,
    16,
    66,
    8,
    33,
    68,
    68,
    68,
    68,
    68,
    68,
    68,
    68,
    36,
    9
  ]), 0, 6)[1];
  var doct = rfse(/* @__PURE__ */ new u8([
    32,
    132,
    16,
    66,
    102,
    70,
    68,
    68,
    68,
    68,
    36,
    73,
    2
  ]), 0, 5)[1];
  var b2bl = function(b, s) {
    var len = b.length, bl = new i32(len);
    for (var i = 0; i < len; ++i) {
      bl[i] = s;
      s += 1 << b[i];
    }
    return bl;
  };
  var llb = /* @__PURE__ */ new u8((/* @__PURE__ */ new i32([
    0,
    0,
    0,
    0,
    16843009,
    50528770,
    134678020,
    202050057,
    269422093
  ])).buffer, 0, 36);
  var llbl = /* @__PURE__ */ b2bl(llb, 0);
  var mlb = /* @__PURE__ */ new u8((/* @__PURE__ */ new i32([
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    16843009,
    50528770,
    117769220,
    185207048,
    252579084,
    16
  ])).buffer, 0, 53);
  var mlbl = /* @__PURE__ */ b2bl(mlb, 3);
  var dhu = function(dat, out, hu) {
    var len = dat.length, ss = out.length, lb = dat[len - 1], msk = (1 << hu.b) - 1, eb = -hu.b;
    if (!lb)
      err(0);
    var st = 0, btr = hu.b, pos = (len << 3) - 8 + msb(lb) - btr, i = -1;
    for (; pos > eb && i < ss; ) {
      var cbt = pos >> 3;
      var val = (dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16) >> (pos & 7);
      st = (st << btr | val) & msk;
      out[++i] = hu.s[st];
      pos -= btr = hu.n[st];
    }
    if (pos != eb || i + 1 != ss)
      err(0);
  };
  var dhu4 = function(dat, out, hu) {
    var bt = 6;
    var ss = out.length, sz1 = ss + 3 >> 2, sz2 = sz1 << 1, sz3 = sz1 + sz2;
    dhu(dat.subarray(bt, bt += dat[0] | dat[1] << 8), out.subarray(0, sz1), hu);
    dhu(dat.subarray(bt, bt += dat[2] | dat[3] << 8), out.subarray(sz1, sz2), hu);
    dhu(dat.subarray(bt, bt += dat[4] | dat[5] << 8), out.subarray(sz2, sz3), hu);
    dhu(dat.subarray(bt), out.subarray(sz3), hu);
  };
  var rzb = function(dat, st, out) {
    var _a;
    var bt = st.b;
    var b0 = dat[bt], btype = b0 >> 1 & 3;
    st.l = b0 & 1;
    var sz = b0 >> 3 | dat[bt + 1] << 5 | dat[bt + 2] << 13;
    var ebt = (bt += 3) + sz;
    if (btype == 1) {
      if (bt >= dat.length)
        return;
      st.b = bt + 1;
      if (out) {
        fill(out, dat[bt], st.y, st.y += sz);
        return out;
      }
      return fill(new u8(sz), dat[bt]);
    }
    if (ebt > dat.length)
      return;
    if (btype == 0) {
      st.b = ebt;
      if (out) {
        out.set(dat.subarray(bt, ebt), st.y);
        st.y += sz;
        return out;
      }
      return slc(dat, bt, ebt);
    }
    if (btype == 2) {
      var b3 = dat[bt], lbt = b3 & 3, sf = b3 >> 2 & 3;
      var lss = b3 >> 4, lcs = 0, s4 = 0;
      if (lbt < 2) {
        if (sf & 1)
          lss |= dat[++bt] << 4 | (sf & 2 && dat[++bt] << 12);
        else
          lss = b3 >> 3;
      } else {
        s4 = sf;
        if (sf < 2)
          lss |= (dat[++bt] & 63) << 4, lcs = dat[bt] >> 6 | dat[++bt] << 2;
        else if (sf == 2)
          lss |= dat[++bt] << 4 | (dat[++bt] & 3) << 12, lcs = dat[bt] >> 2 | dat[++bt] << 6;
        else
          lss |= dat[++bt] << 4 | (dat[++bt] & 63) << 12, lcs = dat[bt] >> 6 | dat[++bt] << 2 | dat[++bt] << 10;
      }
      ++bt;
      var buf = out ? out.subarray(st.y, st.y + st.m) : new u8(st.m);
      var spl = buf.length - lss;
      if (lbt == 0)
        buf.set(dat.subarray(bt, bt += lss), spl);
      else if (lbt == 1)
        fill(buf, dat[bt++], spl);
      else {
        var hu = st.h;
        if (lbt == 2) {
          var hud = rhu(dat, bt);
          lcs += bt - (bt = hud[0]);
          st.h = hu = hud[1];
        } else if (!hu)
          err(0);
        (s4 ? dhu4 : dhu)(dat.subarray(bt, bt += lcs), buf.subarray(spl), hu);
      }
      var ns = dat[bt++];
      if (ns) {
        if (ns == 255)
          ns = (dat[bt++] | dat[bt++] << 8) + 32512;
        else if (ns > 127)
          ns = ns - 128 << 8 | dat[bt++];
        var scm = dat[bt++];
        if (scm & 3)
          err(0);
        var dts = [dmlt, doct, dllt];
        for (var i = 2; i > -1; --i) {
          var md = scm >> (i << 1) + 2 & 3;
          if (md == 1) {
            var rbuf = new u8([0, 0, dat[bt++]]);
            dts[i] = {
              s: rbuf.subarray(2, 3),
              n: rbuf.subarray(0, 1),
              t: new u16(rbuf.buffer, 0, 1),
              b: 0
            };
          } else if (md == 2) {
            _a = rfse(dat, bt, 9 - (i & 1)), bt = _a[0], dts[i] = _a[1];
          } else if (md == 3) {
            if (!st.t)
              err(0);
            dts[i] = st.t[i];
          }
        }
        var _b = st.t = dts, mlt = _b[0], oct = _b[1], llt = _b[2];
        var lb = dat[ebt - 1];
        if (!lb)
          err(0);
        var spos = (ebt << 3) - 8 + msb(lb) - llt.b, cbt = spos >> 3, oubt = 0;
        var lst = (dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << llt.b) - 1;
        cbt = (spos -= oct.b) >> 3;
        var ost = (dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << oct.b) - 1;
        cbt = (spos -= mlt.b) >> 3;
        var mst = (dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << mlt.b) - 1;
        for (++ns; --ns; ) {
          var llc = llt.s[lst];
          var lbtr = llt.n[lst];
          var mlc = mlt.s[mst];
          var mbtr = mlt.n[mst];
          var ofc = oct.s[ost];
          var obtr = oct.n[ost];
          cbt = (spos -= ofc) >> 3;
          var ofp = 1 << ofc;
          var off = ofp + ((dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16 | dat[cbt + 3] << 24) >>> (spos & 7) & ofp - 1);
          cbt = (spos -= mlb[mlc]) >> 3;
          var ml = mlbl[mlc] + ((dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16) >> (spos & 7) & (1 << mlb[mlc]) - 1);
          cbt = (spos -= llb[llc]) >> 3;
          var ll = llbl[llc] + ((dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16) >> (spos & 7) & (1 << llb[llc]) - 1);
          cbt = (spos -= lbtr) >> 3;
          lst = llt.t[lst] + ((dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << lbtr) - 1);
          cbt = (spos -= mbtr) >> 3;
          mst = mlt.t[mst] + ((dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << mbtr) - 1);
          cbt = (spos -= obtr) >> 3;
          ost = oct.t[ost] + ((dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << obtr) - 1);
          if (off > 3) {
            st.o[2] = st.o[1];
            st.o[1] = st.o[0];
            st.o[0] = off -= 3;
          } else {
            var idx = off - (ll != 0);
            if (idx) {
              off = idx == 3 ? st.o[0] - 1 : st.o[idx];
              if (idx > 1)
                st.o[2] = st.o[1];
              st.o[1] = st.o[0];
              st.o[0] = off;
            } else
              off = st.o[0];
          }
          for (var i = 0; i < ll; ++i) {
            buf[oubt + i] = buf[spl + i];
          }
          oubt += ll, spl += ll;
          var stin = oubt - off;
          if (stin < 0) {
            var len = -stin;
            var bs = st.e + stin;
            if (len > ml)
              len = ml;
            for (var i = 0; i < len; ++i) {
              buf[oubt + i] = st.w[bs + i];
            }
            oubt += len, ml -= len, stin = 0;
          }
          for (var i = 0; i < ml; ++i) {
            buf[oubt + i] = buf[stin + i];
          }
          oubt += ml;
        }
        if (oubt != spl) {
          while (spl < buf.length) {
            buf[oubt++] = buf[spl++];
          }
        } else
          oubt = buf.length;
        if (out)
          st.y += oubt;
        else
          buf = slc(buf, 0, oubt);
      } else if (out) {
        st.y += lss;
        if (spl) {
          for (var i = 0; i < lss; ++i) {
            buf[i] = buf[spl + i];
          }
        }
      } else if (spl)
        buf = slc(buf, spl);
      st.b = ebt;
      return buf;
    }
    err(2);
  };
  var cct = function(bufs, ol) {
    if (bufs.length == 1)
      return bufs[0];
    var buf = new u8(ol);
    for (var i = 0, b = 0; i < bufs.length; ++i) {
      var chk = bufs[i];
      buf.set(chk, b);
      b += chk.length;
    }
    return buf;
  };
  function decompress(dat, buf) {
    var bufs = [], nb = +!buf;
    var bt = 0, ol = 0;
    for (; dat.length; ) {
      var st = rzfh(dat, nb || buf);
      if (typeof st == "object") {
        if (nb) {
          buf = null;
          if (st.w.length == st.u) {
            bufs.push(buf = st.w);
            ol += st.u;
          }
        } else {
          bufs.push(buf);
          st.e = 0;
        }
        for (; !st.l; ) {
          var blk = rzb(dat, st, buf);
          if (!blk)
            err(5);
          if (buf)
            st.e = st.y;
          else {
            bufs.push(blk);
            ol += blk.length;
            cpw(st.w, 0, blk.length);
            st.w.set(blk, st.w.length - blk.length);
          }
        }
        bt = st.b + st.c * 4;
      } else
        bt = st;
      dat = dat.subarray(bt);
    }
    return cct(bufs, ol);
  }

  // node_modules/hysnappy/hysnappy.js
  function snappyUncompressor() {
    const wasm = instantiateWasm();
    return (input, outputLength) => {
      const { memory, uncompress } = wasm.exports;
      const inputStart = 68e3;
      const outputStart = inputStart + input.byteLength;
      const totalSize = inputStart + input.byteLength + outputLength;
      if (memory.buffer.byteLength < totalSize) {
        const pageSize = 64 * 1024;
        const currentPages = memory.buffer.byteLength / pageSize;
        const requiredPages = Math.ceil(totalSize / pageSize);
        const pagesToGrow = requiredPages - currentPages;
        memory.grow(pagesToGrow);
      }
      const byteArray = new Uint8Array(memory.buffer);
      byteArray.set(input, inputStart);
      const result = uncompress(inputStart, input.byteLength, outputStart);
      if (result === -1) throw new Error("invalid snappy length header");
      if (result === -2) throw new Error("missing eof marker");
      if (result === -3) throw new Error("premature end of input");
      if (result) throw new Error(`failed to uncompress data ${result}`);
      return byteArray.slice(outputStart, outputStart + outputLength);
    };
  }
  function instantiateWasm() {
    const binaryString = atob(wasm64);
    const byteArray = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i += 1) {
      byteArray[i] = binaryString.charCodeAt(i);
    }
    const mod = new WebAssembly.Module(byteArray);
    return new WebAssembly.Instance(mod);
  }
  var wasm64 = "AGFzbQEAAAABEANgAABgA39/fwF/YAF/AX8DBgUAAQEBAgUDAQACBj8KfwFBoIwEC38AQYAIC38AQaAMC38AQaAMC38AQaCMBAt/AEGACAt/AEGgjAQLfwBBgIAIC38AQQALfwBBAQsHwQEOBm1lbW9yeQIAEV9fd2FzbV9jYWxsX2N0b3JzAAAGbWVtY3B5AAEHbWVtbW92ZQACCnVuY29tcHJlc3MAAwxfX2Rzb19oYW5kbGUDAQpfX2RhdGFfZW5kAwILX19zdGFja19sb3cDAwxfX3N0YWNrX2hpZ2gDBA1fX2dsb2JhbF9iYXNlAwULX19oZWFwX2Jhc2UDBgpfX2hlYXBfZW5kAwcNX19tZW1vcnlfYmFzZQMIDF9fdGFibGVfYmFzZQMJCuASBQIAC8sBAQN/AkAgAkUNAAJAAkAgAkEHcSIDDQAgACEEIAIhBQwBCyAAIQQgAiEFA0AgBCABLQAAOgAAIARBAWohBCABQQFqIQEgBUF/aiEFIANBf2oiAw0ACwsgAkEISQ0AA0AgBCABLQAAOgAAIAQgAS0AAToAASAEIAEtAAI6AAIgBCABLQADOgADIAQgAS0ABDoABCAEIAEtAAU6AAUgBCABLQAGOgAGIAQgAS0ABzoAByAEQQhqIQQgAUEIaiEBIAVBeGoiBQ0ACwsgAAugAwEEfwJAIAAgAUYNAAJAAkAgACABSQ0AIAEgAmoiAyAASw0BCyACRQ0BAkACQCACQQdxIgMNACAAIQQgAiEFDAELIAAhBCACIQUDQCAEIAEtAAA6AAAgBEEBaiEEIAFBAWohASAFQX9qIQUgA0F/aiIDDQALCyACQQhJDQEDQCAEIAEtAAA6AAAgBCABLQABOgABIAQgAS0AAjoAAiAEIAEtAAM6AAMgBCABLQAEOgAEIAQgAS0ABToABSAEIAEtAAY6AAYgBCABLQAHOgAHIARBCGohBCABQQhqIQEgBUF4aiIFDQAMAgsLIAJFDQACQAJAIAJBA3EiBA0AIAAgAmohBiACIQUMAQsgAiEFA0AgBUF/aiIFIABqIgYgBSABaiIDLQAAOgAAIARBf2oiBA0ACwsgAkEESQ0AIAZBfGohASADQXxqIQQDQCABQQNqIARBA2otAAA6AAAgAUECaiAEQQJqLQAAOgAAIAFBAWogBEEBai0AADoAACABIAQtAAA6AAAgAUF8aiEBIARBfGohBCAFQXxqIgUNAAsLIAALswoBCX8jgICAgABBIGsiAySAgICAACADQQlqQgA3AAAgA0IANwIEIAMgA0EYajYCAEF/IQQCQCABRQ0AIAMgAUF/aiIFNgIcIAMgAEEBajYCGCAALAAAIgZB/wBxIQcCQCAGQX9KDQAgBUUNASADIAFBfmoiBTYCHCADIABBAmo2AhggACwAASIGQf8AcUEHdCAHciEHQX8hBCAGQX9KDQAgBUUNASADIAFBfWoiBTYCHCADIABBA2o2AhggACwAAiIGQf8AcUEOdCAHciEHQX8hBCAGQX9KDQAgBUUNASADIAFBfGoiBTYCHCADIABBBGo2AhggACwAAyIGQf8AcUEVdCAHciEHQX8hBCAGQX9KDQAgBUUNASADIAFBe2o2AhwgAyAAQQVqNgIYIAAsAAQiAUEASA0BIAFBHHQgB3IhBwsgAiAHaiEIAkACQCADEISAgIAADQAgAiEADAELIAMoAgQhASACIQADQAJAIAMoAgggAWtBBEoNACADIAE2AgQgAxCEgICAAEUNAiADKAIEIQELIAFBAWohBQJAAkAgAS0AACIGQQNxDQAgCCAAayEJIAMoAggiCiAFayEEIAZBAnYiC0EBaiEHAkAgBkE/Sw0AIARBEEkNACAJQRBIDQAgACABKAIBNgIAIAAgASgCBTYCBCAAIAEoAgk2AgggACABKAINNgIMIAAgB2ohACADKAIIIAUgB2oiAWtBBEoNAyADIAE2AgQgAxCEgICAAEUNBAwCCwJAAkAgBkHwAU8NACAFIQYMAQsgCiAFIAtBRWoiAWoiBmshBCABQQJ0QYCIgIAAaigCACAFKAIAcUEBaiEHCwJAIAcgBE0NAANAIAggAGsgBEkNBSAAIAYgBBCBgICAACEAIAMoAgAiASABKAIAIgkgAygCDCIFaiIGNgIAIAFBBGoiASABKAIAIgogBWsiATYCACADIAE2AgwgACAEaiEAIAFFDQUgAyAJIApqNgIIIAcgBGshByABIQQgByABSw0ACyAIIABrIQkLIAkgB0kNAyAAIAYgBxCBgICAACAHaiEAIAMoAgggBiAHaiIBa0EESg0CIAMgATYCBCADEISAgIAADQEMAwsgACACayAGQQF0QaCIgIAAai8BACIBQQt2IgpBAnRBgIiAgABq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";

  // node_modules/hyparquet-compressors/src/brotli.bitreader.js
  var BROTLI_READ_SIZE = 4096;
  var BROTLI_IBUF_SIZE = 2 * BROTLI_READ_SIZE + 32;
  var BROTLI_IBUF_MASK = 2 * BROTLI_READ_SIZE - 1;
  var kBitMask = new Uint32Array([
    0,
    1,
    3,
    7,
    15,
    31,
    63,
    127,
    255,
    511,
    1023,
    2047,
    4095,
    8191,
    16383,
    32767,
    65535,
    131071,
    262143,
    524287,
    1048575,
    2097151,
    4194303,
    8388607,
    16777215
  ]);
  function BrotliBitReader(input) {
    this.buf_ = new Uint8Array(BROTLI_IBUF_SIZE);
    this.input_ = input;
    this.buf_ptr_ = 0;
    this.val_ = 0;
    this.pos_ = 0;
    this.reset();
  }
  BrotliBitReader.READ_SIZE = BROTLI_READ_SIZE;
  BrotliBitReader.IBUF_MASK = BROTLI_IBUF_MASK;
  BrotliBitReader.prototype.reset = function() {
    this.buf_ptr_ = 0;
    this.val_ = 0;
    this.pos_ = 0;
    this.bit_pos_ = 0;
    this.bit_end_pos_ = 0;
    this.eos_ = 0;
    this.readMoreInput();
    for (let i = 0; i < 4; i++) {
      this.val_ |= this.buf_[this.pos_] << 8 * i;
      this.pos_++;
    }
    return this.bit_end_pos_ > 0;
  };
  BrotliBitReader.prototype.readMoreInput = function() {
    if (this.bit_end_pos_ > 256) {
    } else if (this.eos_) {
      if (this.bit_pos_ > this.bit_end_pos_)
        throw new Error("Unexpected end of input " + this.bit_pos_ + " " + this.bit_end_pos_);
    } else {
      const dst = this.buf_ptr_;
      const bytes_read = this.input_.read(this.buf_, dst, BROTLI_READ_SIZE);
      if (bytes_read < 0) {
        throw new Error("Unexpected end of input");
      }
      if (bytes_read < BROTLI_READ_SIZE) {
        this.eos_ = 1;
        for (let p = 0; p < 32; p++)
          this.buf_[dst + bytes_read + p] = 0;
      }
      if (dst === 0) {
        for (let p = 0; p < 32; p++)
          this.buf_[(BROTLI_READ_SIZE << 1) + p] = this.buf_[p];
        this.buf_ptr_ = BROTLI_READ_SIZE;
      } else {
        this.buf_ptr_ = 0;
      }
      this.bit_end_pos_ += bytes_read << 3;
    }
  };
  BrotliBitReader.prototype.fillBitWindow = function() {
    while (this.bit_pos_ >= 8) {
      this.val_ >>>= 8;
      this.val_ |= this.buf_[this.pos_ & BROTLI_IBUF_MASK] << 24;
      this.pos_++;
      this.bit_pos_ = this.bit_pos_ - 8 >>> 0;
      this.bit_end_pos_ = this.bit_end_pos_ - 8 >>> 0;
    }
  };
  BrotliBitReader.prototype.readBits = function(n_bits) {
    if (32 - this.bit_pos_ < n_bits) this.fillBitWindow();
    const val = this.val_ >>> this.bit_pos_ & kBitMask[n_bits];
    this.bit_pos_ += n_bits;
    return val;
  };

  // node_modules/hyparquet-compressors/src/brotli.huffman.js
  var kDefaultCodeLength = 8;
  var HUFFMAN_TABLE_BITS = 8;
  var HUFFMAN_TABLE_MASK = 255;
  var CODE_LENGTH_CODES = 18;
  var kCodeLengthCodeOrder = new Uint8Array([
    1,
    2,
    3,
    4,
    0,
    5,
    17,
    6,
    16,
    7,
    8,
    9,
    10,
    11,
    12,
    13,
    14,
    15
  ]);
  var kMaxHuffmanTableSize = new Uint16Array([
    256,
    402,
    436,
    468,
    500,
    534,
    566,
    598,
    630,
    662,
    694,
    726,
    758,
    790,
    822,
    854,
    886,
    920,
    952,
    984,
    1016,
    1048,
    1080
  ]);
  function HuffmanCode(bits2, value) {
    this.bits = bits2;
    this.value = value;
  }
  var kCodeLengthRepeatCode = 16;
  var MAX_LENGTH = 15;
  function getNextKey(key, len) {
    let step = 1 << len - 1;
    while (key & step) {
      step >>= 1;
    }
    return (key & step - 1) + step;
  }
  function replicateValue(table, i, step, end, code) {
    do {
      end -= step;
      table[i + end] = new HuffmanCode(code.bits, code.value);
    } while (end > 0);
  }
  function nextTableBitSize(count, len, root_bits) {
    let left = 1 << len - root_bits;
    while (len < MAX_LENGTH) {
      left -= count[len];
      if (left <= 0) break;
      ++len;
      left <<= 1;
    }
    return len - root_bits;
  }
  function buildHuffmanTable(root_table, table, root_bits, code_lengths, code_lengths_size) {
    const start_table = table;
    const count = new Int32Array(MAX_LENGTH + 1);
    const offset = new Int32Array(MAX_LENGTH + 1);
    const sorted = new Int32Array(code_lengths_size);
    for (let i = 0; i < code_lengths_size; i++) {
      count[code_lengths[i]]++;
    }
    offset[1] = 0;
    for (let i = 1; i < MAX_LENGTH; i++) {
      offset[i + 1] = offset[i] + count[i];
    }
    for (let i = 0; i < code_lengths_size; i++) {
      if (code_lengths[i] !== 0) {
        sorted[offset[code_lengths[i]]++] = i;
      }
    }
    let table_bits = root_bits;
    let table_size = 1 << table_bits;
    let total_size = table_size;
    if (offset[MAX_LENGTH] === 1) {
      for (let key2 = 0; key2 < total_size; ++key2) {
        root_table[table + key2] = new HuffmanCode(0, sorted[0] & 65535);
      }
      return total_size;
    }
    let key = 0;
    let symbol = 0;
    for (let len = 1, step = 2; len <= root_bits; ++len, step <<= 1) {
      for (; count[len] > 0; --count[len]) {
        const code = new HuffmanCode(len & 255, sorted[symbol++] & 65535);
        replicateValue(root_table, table + key, step, table_size, code);
        key = getNextKey(key, len);
      }
    }
    const mask = total_size - 1;
    let low = -1;
    for (let len = root_bits + 1, step = 2; len <= MAX_LENGTH; ++len, step <<= 1) {
      for (; count[len] > 0; --count[len]) {
        if ((key & mask) !== low) {
          table += table_size;
          table_bits = nextTableBitSize(count, len, root_bits);
          table_size = 1 << table_bits;
          total_size += table_size;
          low = key & mask;
          root_table[start_table + low] = new HuffmanCode(table_bits + root_bits & 255, table - start_table - low & 65535);
        }
        const code = new HuffmanCode(len - root_bits & 255, sorted[symbol++] & 65535);
        replicateValue(root_table, table + (key >> root_bits), step, table_size, code);
        key = getNextKey(key, len);
      }
    }
    return total_size;
  }
  function readHuffmanCode(alphabet_size, tables, table, br) {
    const code_lengths = new Uint8Array(alphabet_size);
    br.readMoreInput();
    const simple_code_or_skip = br.readBits(2);
    if (simple_code_or_skip === 1) {
      let max_bits_counter = alphabet_size - 1;
      let max_bits = 0;
      const symbols = new Int32Array(4);
      const num_symbols = br.readBits(2) + 1;
      while (max_bits_counter) {
        max_bits_counter >>= 1;
        max_bits++;
      }
      for (let i = 0; i < num_symbols; i++) {
        symbols[i] = br.readBits(max_bits) % alphabet_size;
        code_lengths[symbols[i]] = 2;
      }
      code_lengths[symbols[0]] = 1;
      switch (num_symbols) {
        case 1:
          break;
        case 3:
          if (symbols[0] === symbols[1] || symbols[0] === symbols[2] || symbols[1] === symbols[2]) {
            throw new Error("[ReadHuffmanCode] invalid symbols");
          }
          break;
        case 2:
          if (symbols[0] === symbols[1]) {
            throw new Error("[ReadHuffmanCode] invalid symbols");
          }
          code_lengths[symbols[1]] = 1;
          break;
        case 4:
          if (symbols[0] === symbols[1] || symbols[0] === symbols[2] || symbols[0] === symbols[3] || symbols[1] === symbols[2] || symbols[1] === symbols[3] || symbols[2] === symbols[3]) {
            throw new Error("[ReadHuffmanCode] invalid symbols");
          }
          if (br.readBits(1)) {
            code_lengths[symbols[2]] = 3;
            code_lengths[symbols[3]] = 3;
          } else {
            code_lengths[symbols[0]] = 2;
          }
          break;
      }
    } else {
      const code_length_code_lengths = new Uint8Array(CODE_LENGTH_CODES);
      let space = 32;
      let num_codes = 0;
      const huff = [
        new HuffmanCode(2, 0),
        new HuffmanCode(2, 4),
        new HuffmanCode(2, 3),
        new HuffmanCode(3, 2),
        new HuffmanCode(2, 0),
        new HuffmanCode(2, 4),
        new HuffmanCode(2, 3),
        new HuffmanCode(4, 1),
        new HuffmanCode(2, 0),
        new HuffmanCode(2, 4),
        new HuffmanCode(2, 3),
        new HuffmanCode(3, 2),
        new HuffmanCode(2, 0),
        new HuffmanCode(2, 4),
        new HuffmanCode(2, 3),
        new HuffmanCode(4, 5)
      ];
      for (let i = simple_code_or_skip; i < CODE_LENGTH_CODES && space > 0; i++) {
        const code_len_idx = kCodeLengthCodeOrder[i];
        let p = 0;
        br.fillBitWindow();
        p += br.val_ >>> br.bit_pos_ & 15;
        br.bit_pos_ += huff[p].bits;
        const v = huff[p].value;
        code_length_code_lengths[code_len_idx] = v;
        if (v !== 0) {
          space -= 32 >> v;
          num_codes++;
        }
      }
      if (!(num_codes === 1 || space === 0))
        throw new Error("[ReadHuffmanCode] invalid num_codes or space");
      readHuffmanCodeLengths(code_length_code_lengths, alphabet_size, code_lengths, br);
    }
    const table_size = buildHuffmanTable(tables, table, HUFFMAN_TABLE_BITS, code_lengths, alphabet_size);
    if (!table_size) throw new Error("brotli BuildHuffmanTable failed");
    return table_size;
  }
  function readSymbol(table, index, br) {
    br.fillBitWindow();
    index += br.val_ >>> br.bit_pos_ & HUFFMAN_TABLE_MASK;
    const nbits = table[index].bits - HUFFMAN_TABLE_BITS;
    if (nbits > 0) {
      br.bit_pos_ += HUFFMAN_TABLE_BITS;
      index += table[index].value;
      index += br.val_ >>> br.bit_pos_ & (1 << nbits) - 1;
    }
    br.bit_pos_ += table[index].bits;
    return table[index].value;
  }
  function readHuffmanCodeLengths(code_length_code_lengths, num_symbols, code_lengths, br) {
    let symbol = 0;
    let prev_code_len = kDefaultCodeLength;
    let repeat = 0;
    let repeat_code_len = 0;
    let space = 32768;
    const table = [];
    for (let i = 0; i < 32; i++)
      table.push(new HuffmanCode(0, 0));
    buildHuffmanTable(table, 0, 5, code_length_code_lengths, CODE_LENGTH_CODES);
    while (symbol < num_symbols && space > 0) {
      let p = 0;
      br.readMoreInput();
      br.fillBitWindow();
      p += br.val_ >>> br.bit_pos_ & 31;
      br.bit_pos_ += table[p].bits;
      const code_len = table[p].value & 255;
      if (code_len < kCodeLengthRepeatCode) {
        repeat = 0;
        code_lengths[symbol++] = code_len;
        if (code_len !== 0) {
          prev_code_len = code_len;
          space -= 32768 >> code_len;
        }
      } else {
        const extra_bits = code_len - 14;
        let new_len = 0;
        if (code_len === kCodeLengthRepeatCode) {
          new_len = prev_code_len;
        }
        if (repeat_code_len !== new_len) {
          repeat = 0;
          repeat_code_len = new_len;
        }
        const old_repeat = repeat;
        if (repeat > 0) {
          repeat -= 2;
          repeat <<= extra_bits;
        }
        repeat += br.readBits(extra_bits) + 3;
        const repeat_delta = repeat - old_repeat;
        if (symbol + repeat_delta > num_symbols) {
          throw new Error("[ReadHuffmanCodeLengths] symbol + repeat_delta > num_symbols");
        }
        for (let x = 0; x < repeat_delta; x++)
          code_lengths[symbol + x] = repeat_code_len;
        symbol += repeat_delta;
        if (repeat_code_len !== 0) {
          space -= repeat_delta << 15 - repeat_code_len;
        }
      }
    }
    if (space !== 0) {
      throw new Error("[ReadHuffmanCodeLengths] space = " + space);
    }
    for (; symbol < num_symbols; symbol++)
      code_lengths[symbol] = 0;
  }
  function HuffmanTreeGroup(alphabet_size, num_htrees) {
    this.alphabet_size = alphabet_size;
    this.num_htrees = num_htrees;
    this.codes = new Array(num_htrees + num_htrees * kMaxHuffmanTableSize[alphabet_size + 31 >>> 5]);
    this.htrees = new Uint32Array(num_htrees);
  }
  HuffmanTreeGroup.prototype.decode = function(br) {
    let next = 0;
    for (let i = 0; i < this.num_htrees; i++) {
      this.htrees[i] = next;
      next += readHuffmanCode(this.alphabet_size, this.codes, next, br);
    }
  };

  // node_modules/hyparquet-compressors/src/brotli.prefix.js
  function prefix([offset, nbits]) {
    return { offset, nbits };
  }
  var kBlockLengthPrefixCode = [
    [1, 2],
    [5, 2],
    [9, 2],
    [13, 2],
    [17, 3],
    [25, 3],
    [33, 3],
    [41, 3],
    [49, 4],
    [65, 4],
    [81, 4],
    [97, 4],
    [113, 5],
    [145, 5],
    [177, 5],
    [209, 5],
    [241, 6],
    [305, 6],
    [369, 7],
    [497, 8],
    [753, 9],
    [1265, 10],
    [2289, 11],
    [4337, 12],
    [8433, 13],
    [16625, 24]
  ].map(prefix);
  var kInsertLengthPrefixCode = [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 0],
    [5, 0],
    [6, 1],
    [8, 1],
    [10, 2],
    [14, 2],
    [18, 3],
    [26, 3],
    [34, 4],
    [50, 4],
    [66, 5],
    [98, 5],
    [130, 6],
    [194, 7],
    [322, 8],
    [578, 9],
    [1090, 10],
    [2114, 12],
    [6210, 14],
    [22594, 24]
  ].map(prefix);
  var kCopyLengthPrefixCode = [
    [2, 0],
    [3, 0],
    [4, 0],
    [5, 0],
    [6, 0],
    [7, 0],
    [8, 0],
    [9, 0],
    [10, 1],
    [12, 1],
    [14, 2],
    [18, 2],
    [22, 3],
    [30, 3],
    [38, 4],
    [54, 4],
    [70, 5],
    [102, 5],
    [134, 6],
    [198, 7],
    [326, 8],
    [582, 9],
    [1094, 10],
    [2118, 24]
  ].map(prefix);
  var kInsertRangeLut = [
    0,
    0,
    8,
    8,
    0,
    16,
    8,
    16,
    16
  ];
  var kCopyRangeLut = [
    0,
    8,
    0,
    8,
    16,
    0,
    16,
    8,
    16
  ];

  // node_modules/hyparquet-compressors/src/gzip.huffman.js
  var HUFFMAN_MAX_TABLE_SIZE = 1080;
  var fixedLengthExtraBits = new Uint8Array([
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    3,
    3,
    3,
    3,
    4,
    4,
    4,
    4,
    5,
    5,
    5,
    5,
    0,
    /* unused */
    0,
    0,
    /* impossible */
    0
  ]);
  var fixedDistanceExtraBits = new Uint8Array([
    0,
    0,
    0,
    0,
    1,
    1,
    2,
    2,
    3,
    3,
    4,
    4,
    5,
    5,
    6,
    6,
    7,
    7,
    8,
    8,
    9,
    9,
    10,
    10,
    11,
    11,
    12,
    12,
    13,
    13,
    /* unused */
    0,
    0
  ]);
  function freb(eb, start) {
    const base = new Uint16Array(31);
    for (let i = 0; i < 31; i++) {
      base[i] = start += 1 << eb[i - 1];
    }
    const rev2 = new Int32Array(base[30]);
    for (let i = 1; i < 30; i++) {
      for (let j = base[i]; j < base[i + 1]; ++j) {
        rev2[j] = j - base[i] << 5 | i;
      }
    }
    return { base, rev: rev2 };
  }
  var { base: fixedLength, rev: revfl } = freb(fixedLengthExtraBits, 2);
  fixedLength[28] = 258;
  revfl[258] = 28;
  var { base: fixedDistance } = freb(fixedDistanceExtraBits, 0);
  var rev = new Uint16Array(32768);
  for (let i = 0; i < 32768; i++) {
    let x = (i & 43690) >> 1 | (i & 21845) << 1;
    x = (x & 52428) >> 2 | (x & 13107) << 2;
    x = (x & 61680) >> 4 | (x & 3855) << 4;
    rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
  }
  function huffMap(cd, maxBits, r) {
    const l = new Uint16Array(maxBits);
    for (let i = 0; i < cd.length; i++) {
      if (cd[i]) ++l[cd[i] - 1];
    }
    const le = new Uint16Array(maxBits);
    for (let i = 1; i < maxBits; i++) {
      le[i] = le[i - 1] + l[i - 1] << 1;
    }
    let co;
    if (r) {
      co = new Uint16Array(1 << maxBits);
      const rvb = 15 - maxBits;
      for (let i = 0; i < cd.length; i++) {
        if (cd[i]) {
          const sv = i << 4 | cd[i];
          const freeBits = maxBits - cd[i];
          let startValue = le[cd[i] - 1]++ << freeBits;
          for (const endValue = startValue | (1 << freeBits) - 1; startValue <= endValue; startValue++) {
            co[rev[startValue] >> rvb] = sv;
          }
        }
      }
    } else {
      co = new Uint16Array(cd.length);
      for (let i = 0; i < cd.length; i++) {
        if (cd[i]) {
          co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
        }
      }
    }
    return co;
  }
  var fixedLengthTree = new Uint8Array(288);
  for (let i = 0; i < 144; i++) fixedLengthTree[i] = 8;
  for (let i = 144; i < 256; i++) fixedLengthTree[i] = 9;
  for (let i = 256; i < 280; i++) fixedLengthTree[i] = 7;
  for (let i = 280; i < 288; i++) fixedLengthTree[i] = 8;
  var fixedDistanceTree = new Uint8Array(32);
  for (let i = 0; i < 32; i++) fixedDistanceTree[i] = 5;
  var fixedLengthMap = /* @__PURE__ */ huffMap(fixedLengthTree, 9, 1);
  var fixedDistanceMap = /* @__PURE__ */ huffMap(fixedDistanceTree, 5, 1);

  // node_modules/hyparquet-compressors/src/brotli.blocks.js
  function decodeBlockType(max_block_type, trees, tree_type, block_types, ringbuffers, indexes, br) {
    const ringbuffer = tree_type * 2;
    const index = tree_type;
    const type_code = readSymbol(trees, tree_type * HUFFMAN_MAX_TABLE_SIZE, br);
    let block_type;
    if (type_code === 0) {
      block_type = ringbuffers[ringbuffer + (indexes[index] & 1)];
    } else if (type_code === 1) {
      block_type = ringbuffers[ringbuffer + (indexes[index] - 1 & 1)] + 1;
    } else {
      block_type = type_code - 2;
    }
    if (block_type >= max_block_type) {
      block_type -= max_block_type;
    }
    block_types[tree_type] = block_type;
    ringbuffers[ringbuffer + (indexes[index] & 1)] = block_type;
    indexes[index]++;
  }
  function decodeMetaBlockLength(br) {
    const out = {
      meta_block_length: 0,
      input_end: 0,
      is_uncompressed: 0,
      is_metadata: false
    };
    out.input_end = br.readBits(1);
    if (out.input_end && br.readBits(1)) {
      return out;
    }
    const size_nibbles = br.readBits(2) + 4;
    if (size_nibbles === 7) {
      out.is_metadata = true;
      if (br.readBits(1) !== 0)
        throw new Error("Invalid reserved bit");
      const size_bytes = br.readBits(2);
      if (size_bytes === 0)
        return out;
      for (let i = 0; i < size_bytes; i++) {
        const next_byte = br.readBits(8);
        if (i + 1 === size_bytes && size_bytes > 1 && next_byte === 0)
          throw new Error("Invalid size byte");
        out.meta_block_length |= next_byte << i * 8;
      }
    } else {
      for (let i = 0; i < size_nibbles; i++) {
        const next_nibble = br.readBits(4);
        if (i + 1 === size_nibbles && size_nibbles > 4 && next_nibble === 0)
          throw new Error("Invalid size nibble");
        out.meta_block_length |= next_nibble << i * 4;
      }
    }
    out.meta_block_length++;
    if (!out.input_end && !out.is_metadata) {
      out.is_uncompressed = br.readBits(1);
    }
    return out;
  }
  function copyUncompressedBlockToOutput(output, len, pos, ringbuffer, ringbuffer_mask, br) {
    const rb_size = ringbuffer_mask + 1;
    let rb_pos = pos & ringbuffer_mask;
    let br_pos = br.pos_ & BrotliBitReader.IBUF_MASK;
    if (len < 8 || br.bit_pos_ + (len << 3) < br.bit_end_pos_) {
      while (len-- > 0) {
        br.readMoreInput();
        ringbuffer[rb_pos++] = br.readBits(8);
        if (rb_pos === rb_size) {
          output.write(ringbuffer, rb_size);
          rb_pos = 0;
        }
      }
      return;
    }
    if (br.bit_end_pos_ < 32) {
      throw new Error("copyUncompressedBlockToOutput: br.bit_end_pos_ < 32");
    }
    while (br.bit_pos_ < 32) {
      ringbuffer[rb_pos] = br.val_ >>> br.bit_pos_;
      br.bit_pos_ += 8;
      rb_pos++;
      len--;
    }
    let nbytes = br.bit_end_pos_ - br.bit_pos_ >> 3;
    if (br_pos + nbytes > BrotliBitReader.IBUF_MASK) {
      const tail = BrotliBitReader.IBUF_MASK + 1 - br_pos;
      for (let x = 0; x < tail; x++)
        ringbuffer[rb_pos + x] = br.buf_[br_pos + x];
      nbytes -= tail;
      rb_pos += tail;
      len -= tail;
      br_pos = 0;
    }
    for (let x = 0; x < nbytes; x++)
      ringbuffer[rb_pos + x] = br.buf_[br_pos + x];
    rb_pos += nbytes;
    len -= nbytes;
    if (rb_pos >= rb_size) {
      output.write(ringbuffer, rb_size);
      rb_pos -= rb_size;
      for (let x = 0; x < rb_pos; x++)
        ringbuffer[x] = ringbuffer[rb_size + x];
    }
    while (rb_pos + len >= rb_size) {
      nbytes = rb_size - rb_pos;
      if (br.input_.read(ringbuffer, rb_pos, nbytes) < nbytes) {
        throw new Error("copyUncompressedBlockToOutput: not enough bytes");
      }
      output.write(ringbuffer, rb_size);
      len -= nbytes;
      rb_pos = 0;
    }
    if (br.input_.read(ringbuffer, rb_pos, len) < len) {
      throw new Error("copyUncompressedBlockToOutput: not enough bytes");
    }
    br.reset();
  }
  function decodeVarLenUint8(br) {
    if (br.readBits(1)) {
      const nbits = br.readBits(3);
      if (nbits === 0) {
        return 1;
      } else {
        return br.readBits(nbits) + (1 << nbits);
      }
    }
    return 0;
  }
  function decodeWindowBits(br) {
    if (br.readBits(1) === 0) return 16;
    let n = br.readBits(3);
    if (n > 0) return 17 + n;
    n = br.readBits(3);
    if (n > 0) return 8 + n;
    return 17;
  }
  function jumpToByteBoundary(br) {
    const new_bit_pos = br.bit_pos_ + 7 & ~7;
    return !br.readBits(new_bit_pos - br.bit_pos_);
  }
  function readBlockLength(table, index, br) {
    const code = readSymbol(table, index, br);
    const { offset, nbits } = kBlockLengthPrefixCode[code];
    return offset + br.readBits(nbits);
  }

  // node_modules/hyparquet-compressors/src/brotli.context.js
  var lookup = new Uint8Array([
    /* CONTEXT_UTF8, last byte. */
    /* ASCII range. */
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    4,
    4,
    0,
    0,
    4,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    8,
    12,
    16,
    12,
    12,
    20,
    12,
    16,
    24,
    28,
    12,
    12,
    32,
    12,
    36,
    12,
    44,
    44,
    44,
    44,
    44,
    44,
    44,
    44,
    44,
    44,
    32,
    32,
    24,
    40,
    28,
    12,
    12,
    48,
    52,
    52,
    52,
    48,
    52,
    52,
    52,
    48,
    52,
    52,
    52,
    52,
    52,
    48,
    52,
    52,
    52,
    52,
    52,
    48,
    52,
    52,
    52,
    52,
    52,
    24,
    12,
    28,
    12,
    12,
    12,
    56,
    60,
    60,
    60,
    56,
    60,
    60,
    60,
    56,
    60,
    60,
    60,
    60,
    60,
    56,
    60,
    60,
    60,
    60,
    60,
    56,
    60,
    60,
    60,
    60,
    60,
    24,
    12,
    28,
    12,
    0,
    /* UTF8 continuation byte range. */
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    /* UTF8 lead byte range. */
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    2,
    3,
    /* CONTEXT_UTF8 second last byte. */
    /* ASCII range. */
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    1,
    1,
    1,
    1,
    1,
    1,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    1,
    1,
    1,
    1,
    0,
    /* UTF8 continuation byte range. */
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    /* UTF8 lead byte range. */
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    /* CONTEXT_SIGNED, second last byte. */
    0,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    3,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    4,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    5,
    6,
    6,
    6,
    6,
    6,
    6,
    6,
    6,
    6,
    6,
    6,
    6,
    6,
    6,
    6,
    7,
    /* CONTEXT_SIGNED, last byte, same as the above values shifted by 3 bits. */
    0,
    8,
    8,
    8,
    8,
    8,
    8,
    8,
    8,
    8,
    8,
    8,
    8,
    8,
    8,
    8,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    16,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    24,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    32,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    40,
    48,
    48,
    48,
    48,
    48,
    48,
    48,
    48,
    48,
    48,
    48,
    48,
    48,
    48,
    48,
    56,
    /* CONTEXT_LSB6, last byte. */
    0,
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
    13,
    14,
    15,
    16,
    17,
    18,
    19,
    20,
    21,
    22,
    23,
    24,
    25,
    26,
    27,
    28,
    29,
    30,
    31,
    32,
    33,
    34,
    35,
    36,
    37,
    38,
    39,
    40,
    41,
    42,
    43,
    44,
    45,
    46,
    47,
    48,
    49,
    50,
    51,
    52,
    53,
    54,
    55,
    56,
    57,
    58,
    59,
    60,
    61,
    62,
    63,
    0,
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
    13,
    14,
    15,
    16,
    17,
    18,
    19,
    20,
    21,
    22,
    23,
    24,
    25,
    26,
    27,
    28,
    29,
    30,
    31,
    32,
    33,
    34,
    35,
    36,
    37,
    38,
    39,
    40,
    41,
    42,
    43,
    44,
    45,
    46,
    47,
    48,
    49,
    50,
    51,
    52,
    53,
    54,
    55,
    56,
    57,
    58,
    59,
    60,
    61,
    62,
    63,
    0,
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
    13,
    14,
    15,
    16,
    17,
    18,
    19,
    20,
    21,
    22,
    23,
    24,
    25,
    26,
    27,
    28,
    29,
    30,
    31,
    32,
    33,
    34,
    35,
    36,
    37,
    38,
    39,
    40,
    41,
    42,
    43,
    44,
    45,
    46,
    47,
    48,
    49,
    50,
    51,
    52,
    53,
    54,
    55,
    56,
    57,
    58,
    59,
    60,
    61,
    62,
    63,
    0,
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
    13,
    14,
    15,
    16,
    17,
    18,
    19,
    20,
    21,
    22,
    23,
    24,
    25,
    26,
    27,
    28,
    29,
    30,
    31,
    32,
    33,
    34,
    35,
    36,
    37,
    38,
    39,
    40,
    41,
    42,
    43,
    44,
    45,
    46,
    47,
    48,
    49,
    50,
    51,
    52,
    53,
    54,
    55,
    56,
    57,
    58,
    59,
    60,
    61,
    62,
    63,
    /* CONTEXT_MSB6, last byte. */
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    3,
    3,
    3,
    3,
    4,
    4,
    4,
    4,
    5,
    5,
    5,
    5,
    6,
    6,
    6,
    6,
    7,
    7,
    7,
    7,
    8,
    8,
    8,
    8,
    9,
    9,
    9,
    9,
    10,
    10,
    10,
    10,
    11,
    11,
    11,
    11,
    12,
    12,
    12,
    12,
    13,
    13,
    13,
    13,
    14,
    14,
    14,
    14,
    15,
    15,
    15,
    15,
    16,
    16,
    16,
    16,
    17,
    17,
    17,
    17,
    18,
    18,
    18,
    18,
    19,
    19,
    19,
    19,
    20,
    20,
    20,
    20,
    21,
    21,
    21,
    21,
    22,
    22,
    22,
    22,
    23,
    23,
    23,
    23,
    24,
    24,
    24,
    24,
    25,
    25,
    25,
    25,
    26,
    26,
    26,
    26,
    27,
    27,
    27,
    27,
    28,
    28,
    28,
    28,
    29,
    29,
    29,
    29,
    30,
    30,
    30,
    30,
    31,
    31,
    31,
    31,
    32,
    32,
    32,
    32,
    33,
    33,
    33,
    33,
    34,
    34,
    34,
    34,
    35,
    35,
    35,
    35,
    36,
    36,
    36,
    36,
    37,
    37,
    37,
    37,
    38,
    38,
    38,
    38,
    39,
    39,
    39,
    39,
    40,
    40,
    40,
    40,
    41,
    41,
    41,
    41,
    42,
    42,
    42,
    42,
    43,
    43,
    43,
    43,
    44,
    44,
    44,
    44,
    45,
    45,
    45,
    45,
    46,
    46,
    46,
    46,
    47,
    47,
    47,
    47,
    48,
    48,
    48,
    48,
    49,
    49,
    49,
    49,
    50,
    50,
    50,
    50,
    51,
    51,
    51,
    51,
    52,
    52,
    52,
    52,
    53,
    53,
    53,
    53,
    54,
    54,
    54,
    54,
    55,
    55,
    55,
    55,
    56,
    56,
    56,
    56,
    57,
    57,
    57,
    57,
    58,
    58,
    58,
    58,
    59,
    59,
    59,
    59,
    60,
    60,
    60,
    60,
    61,
    61,
    61,
    61,
    62,
    62,
    62,
    62,
    63,
    63,
    63,
    63,
    /* CONTEXT_{M,L}SB6, second last byte, */
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0
  ]);
  var lookupOffsets = new Uint16Array([
    /* CONTEXT_LSB6 */
    1024,
    1536,
    /* CONTEXT_MSB6 */
    1280,
    1536,
    /* CONTEXT_UTF8 */
    0,
    256,
    /* CONTEXT_SIGNED */
    768,
    512
  ]);

  // node_modules/hyparquet-compressors/src/brotli.contextmap.js
  function decodeContextMap(context_map_size, br) {
    let max_run_length_prefix = 0;
    br.readMoreInput();
    const num_htrees = decodeVarLenUint8(br) + 1;
    const context_map = new Uint8Array(context_map_size);
    if (num_htrees <= 1) {
      return [num_htrees, context_map];
    }
    const use_rle_for_zeros = br.readBits(1);
    if (use_rle_for_zeros) {
      max_run_length_prefix = br.readBits(4) + 1;
    }
    const table = [];
    for (let i = 0; i < HUFFMAN_MAX_TABLE_SIZE; i++) {
      table[i] = new HuffmanCode(0, 0);
    }
    readHuffmanCode(num_htrees + max_run_length_prefix, table, 0, br);
    for (let i = 0; i < context_map_size; ) {
      br.readMoreInput();
      const code = readSymbol(table, 0, br);
      if (code === 0) {
        context_map[i] = 0;
        i++;
      } else if (code <= max_run_length_prefix) {
        let reps = 1 + (1 << code) + br.readBits(code);
        while (--reps) {
          if (i >= context_map_size) {
            throw new Error("[DecodeContextMap] i >= context_map_size");
          }
          context_map[i] = 0;
          i++;
        }
      } else {
        context_map[i] = code - max_run_length_prefix;
        i++;
      }
    }
    if (br.readBits(1)) {
      inverseMoveToFrontTransform(context_map, context_map_size);
    }
    return [num_htrees, context_map];
  }
  function moveToFront(v, index) {
    const value = v[index];
    for (let i = index; i; i--) v[i] = v[i - 1];
    v[0] = value;
  }
  function inverseMoveToFrontTransform(v, v_len) {
    const mtf = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      mtf[i] = i;
    }
    for (let i = 0; i < v_len; i++) {
      const index = v[i];
      v[i] = mtf[index];
      if (index) moveToFront(mtf, index);
    }
  }

  // node_modules/hyparquet-compressors/src/brotli.streams.js
  function BrotliInput(buffer) {
    this.buffer = buffer;
    this.pos = 0;
  }
  BrotliInput.prototype.read = function(buf, i, count) {
    if (this.pos + count > this.buffer.length) {
      count = this.buffer.length - this.pos;
    }
    for (let p = 0; p < count; p++)
      buf[i + p] = this.buffer[this.pos + p];
    this.pos += count;
    return count;
  };
  function BrotliOutput(buf) {
    this.buffer = buf;
    this.pos = 0;
  }
  BrotliOutput.prototype.write = function(buf, count) {
    if (this.pos + count > this.buffer.length) throw new Error("brotli output buffer is not large enough");
    this.buffer.set(buf.subarray(0, count), this.pos);
    this.pos += count;
    return count;
  };

  // node_modules/hyparquet-compressors/src/gzip.js
  var codeLengthIndexMap = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
  function bits(input, pos, mask) {
    const o = pos / 8 | 0;
    return (input[o] | input[o + 1] << 8) >> (pos & 7) & mask;
  }
  function bits16(d, p) {
    const o = p / 8 | 0;
    return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
  }
  function shft(p) {
    return (p + 7) / 8 | 0;
  }
  function gzipStart(input, i) {
    if (input[i++] !== 31 || input[i++] !== 139 || input[i++] !== 8) return 0;
    const flag = input[i++];
    i += 6;
    if (flag & 4) i += (input[i + 10] | input[i + 11] << 8) + 2;
    for (let zs = (flag >> 3 & 1) + (flag >> 4 & 1); zs > 0; zs -= Number(!input[i++])) ;
    return i + (flag & 2);
  }
  function gunzip(input, output, inputIndex = 0, outputIndex = 0) {
    let out = output ?? new Uint8Array(1024);
    if (!(input.length - inputIndex)) return out;
    const payloadStart = gzipStart(input, inputIndex);
    if (payloadStart === input.length - 8) return out;
    if (payloadStart > input.length - 8) throw new Error("unexpected EOF");
    let pos = payloadStart * 8;
    let final = 0;
    let lengthBits = 0;
    let distBits = 0;
    let lengthMap;
    let distMap;
    const totalBits = input.length * 8;
    function ensureSize(length) {
      if (!output && length > out.length) {
        const old = out;
        out = new Uint8Array(Math.max(old.length * 2, length));
        out.set(old);
      }
    }
    do {
      if (!lengthMap) {
        final = bits(input, pos, 1);
        const type = bits(input, pos + 1, 3);
        pos += 3;
        if (!type) {
          const s = shft(pos) + 4;
          const l = input[s - 4] | input[s - 3] << 8;
          const t = s + l;
          if (t > input.length) throw new Error("unexpected EOF");
          ensureSize(outputIndex + l);
          out.set(input.subarray(s, t), outputIndex);
          outputIndex += l;
          pos = t * 8;
          continue;
        } else if (type === 1) {
          lengthMap = fixedLengthMap;
          distMap = fixedDistanceMap;
          lengthBits = 9;
          distBits = 5;
        } else if (type === 2) {
          const hLiteral = bits(input, pos, 31) + 257;
          const hcLengths = bits(input, pos + 10, 15) + 4;
          const tl = hLiteral + bits(input, pos + 5, 31) + 1;
          pos += 14;
          const lengthDistanceTree = new Uint8Array(tl);
          const codeLengthTree = new Uint8Array(19);
          for (let i = 0; i < hcLengths; ++i) {
            codeLengthTree[codeLengthIndexMap[i]] = bits(input, pos + i * 3, 7);
          }
          pos += hcLengths * 3;
          const codeLengthBits = Math.max(...codeLengthTree);
          const clbMask = (1 << codeLengthBits) - 1;
          const codeLengthMap = huffMap(codeLengthTree, codeLengthBits, 1);
          for (let i = 0; i < tl; ) {
            const r = codeLengthMap[bits(input, pos, clbMask)];
            pos += r & 15;
            const symbol = r >> 4;
            if (symbol < 16) {
              lengthDistanceTree[i++] = symbol;
            } else {
              let copy = 0;
              let n = 0;
              if (symbol === 16) {
                n = 3 + bits(input, pos, 3);
                pos += 2;
                copy = lengthDistanceTree[i - 1];
              } else if (symbol === 17) {
                n = 3 + bits(input, pos, 7);
                pos += 3;
              } else if (symbol === 18) {
                n = 11 + bits(input, pos, 127);
                pos += 7;
              }
              while (n--) lengthDistanceTree[i++] = copy;
            }
          }
          const lengthTree = lengthDistanceTree.subarray(0, hLiteral);
          const distanceTree = lengthDistanceTree.subarray(hLiteral);
          lengthBits = Math.max(...lengthTree);
          distBits = Math.max(...distanceTree);
          lengthMap = huffMap(lengthTree, lengthBits, 1);
          distMap = huffMap(distanceTree, distBits, 1);
        } else throw new Error("invalid block type");
        if (pos > totalBits) throw new Error("unexpected EOF");
      }
      ensureSize(outputIndex + 131072);
      const lms = (1 << lengthBits) - 1;
      const dms = (1 << distBits) - 1;
      let lpos = pos;
      for (; ; lpos = pos) {
        const code = lengthMap[bits16(input, pos) & lms];
        const sym = code >> 4;
        pos += code & 15;
        if (pos > totalBits) throw new Error("unexpected EOF");
        if (!code) throw new Error("invalid length/literal");
        if (sym < 256) out[outputIndex++] = sym;
        else if (sym === 256) {
          lpos = pos;
          lengthMap = void 0;
          break;
        } else {
          let add = sym - 254;
          if (sym > 264) {
            const index = sym - 257;
            const b = fixedLengthExtraBits[index];
            add = bits(input, pos, (1 << b) - 1) + fixedLength[index];
            pos += b;
          }
          if (!distMap) throw new Error("invalid distance map");
          const d = distMap[bits16(input, pos) & dms];
          const dsym = d >> 4;
          if (!d) throw new Error("invalid distance");
          pos += d & 15;
          let dt = fixedDistance[dsym];
          if (dsym > 3) {
            const b = fixedDistanceExtraBits[dsym];
            dt += bits16(input, pos) & (1 << b) - 1;
            pos += b;
          }
          if (pos > totalBits) throw new Error("unexpected EOF");
          const end = outputIndex + add;
          if (outputIndex < dt) throw new Error("unexpected dictionary case");
          ensureSize(end);
          for (; outputIndex < end; outputIndex++) out[outputIndex] = out[outputIndex - dt];
        }
      }
      pos = lpos;
      if (lengthMap) final = 1;
    } while (!final);
    if (outputIndex < out.length) {
      const nextBlock = Math.ceil(pos / 8) + 8;
      gunzip(input, out, nextBlock, outputIndex);
    }
    if (!output) return out.subarray(0, outputIndex);
    return out;
  }

  // node_modules/hyparquet-compressors/src/brotli.dictionary.js
  var dictionaryGz64 = `
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
XH/9kw/e+uTa937x6JlPn7j+86ee/PnpG7e/+yefvfzM7ddetBc/+977t3/83mcf/PknV4/fPvfq7e+/
+cm7P/z0/F/84uwzn7154uc/PvHp69//9I9/+Ml7P7r9/IXbz57/9Pqf3r7y5GdvX/vs+KlPn/7LT0+9
8en505+dP/PZ+eufPnP99jtvffripU+vnrz9J+duf/+GtefTZ37wyfU37JVPT7/+6bnXfv79lz678vTt
v3jV/v25Pc73HsfFP3j59ok3rc0BJ2xs7t08Zz7DAKYbJnK5UgK2jQzJmCC4augYsG4CCZp91RPMCbYW
8rY2w92psSU9JsJr5eZ15HTJPhdaiJXaqRIg7wbBWKEHHX5adwdhvA2PhJOVkIQAXgHUR5kUgqH6MGbJ
Tde53MIZEy6yqT3ANRAzmtC71THhd+I63zxX1ps3X4Z9ESjZchjwqiFzLkBagm7Pm5oZd/Ona2Dpo0SW
Y7IEIhOZVrcgTg4z9eUeatU7/9w2XQdQNR4xq0vb/pGqKBvnbA8aB2VF1VrreWvMzZdXR+KVEBjpfVg7
ksxeQS+zV7Fw2NR4Ckd5E65GGF/Zc94LlRfsBWghULUSXnoJFac+6hn2H7HmV49EANm8/B5nSxkwvsbN
MkyBIZCVfSDxXmYmA5BcYsTQZk6SrdK/FWjBJmCS0fODJopqn2RJ7A+85DaKjp9kYWwVBb/Kf1/lu5f5
1gV+7ImoRK4i5Sf+9vSf+1v4/Bv89zVW7L4W11FV8mv88HNxneNshm76GptxJr5+ultDqWKw2ngJcDTp
wt++epL1y8/wM+f5+2n+/jN+/QKLo1/li6ejSRejbLnu/njc4kJUDb8Sb1lLXuArF3k7Nen5uJeKlL/B
eurHvan45Ud8imd4R/XYxahQ/gILnD8Vdcpf4/9Oq846r6BOuBL1zk/xuz/gTc/FXX4Q5d7Vkxeyeu0a
uKeiSDwHzvvZOuqElznHWy95b+MBv8NC7M9HJ5yKe/0gCrefZm+kausvRUed5IfVnu/FTc9Hj6nlN2LQ
7c+no0r9j+Je34su0gVVEv4Dvqjevsi+0nx4IwZaj6O5eiN69Tg74Q027wxbq68/EQ17HK97XXnNZ81V
jc5TbO25KGN/IZ7iRZ8q3s/n/bnw7ln++2I84Ktxr+Ns/7Woaq9G/jj+1IdP8JG1gk7zxTRbTkfzXmOb
9ftZbzDa/Awf4Uq057WYWm/GTdXUNzm4vJG3+bjrd6DAF8rHkOwS2fXtM/sDx1I8XB4pRVlMABZWZpOa
xdJWYHOYWGPJNdhAqt2wVMa7UpTEFuZ1ab60azeufFBXDhBQA7WI7upwvLkCa9I2ZLOugfR5BLtTT44q
rrIfJV1QIbN0vY2aSGgP/TygkFbNI6AvW9mj2fZbP72r+GiZPfnSZvAsOkVKYkfFRH2jFKjEq0yYmTiG
0Hxxx9f27RwmtnxCITUIOiiSzbbQUf56SQ3i0aANvs0XyUisySDANxBUWBkio6H8LnU05W3XSXl3b+eL
gbmnzpsbcm4q4Hmro43KIrtmCPoKidta2BpVp6q3DqURfAjFrEtHgG2VjFiPezGW83SMH1yb7cBV7hFL
4ulr9rMnYRtV4INf+NWUVfxGwoQx/W8u06DbHzgldokRbF4F5Di5pBSF2qI3C9lNu8vezlIW4KRzgc40
Q3meprenxOwq+wd99+noXsH/HWHQdtLCT4lx1LQYi84ZKRM9kZ0z1lQoZoh1PRvn8Bx1M0tfPcOoIA7g
CN6+M60ArzCJFE6fA1A31SwLtUC+OmWgOqGy0ikcxWDndzLpFxJaZSZqj7NlZucB2751bNFdzS1zGcHw
2JhEYnc18u6SswOYhhx5Twh2txL0A0JhUnqNcGLFOMEKjI3JxmQLo9GgJBez0bM7FqnSxRA2USNePRga
nXjee9hD7NPAoHUoaLnlKjCujwG+wVjcvIjuok+RLRkpFyoxxW696flEmwf7BaQKDiPSPXDiaCKtro63
NKwDOGxrpHOBI8nS9sOBo8ycD15LIQEkB2iLxC617sCcerWTmEysIseyVinHvtCtYvRX01zbGkMZBVep
etR+EIvYx4PVbAUY2Ao/nhsJ5yRZqWxBchW7G7tj5UFRXKgShx+sSq2T06BB3HaFueAvp31yZuYueqnF
KOUJ4XHU8v+QjiE/aeSxnBF4u5u+BhmJ4HMspYyAwkqIGT2AAj6siLZSTQYa89BKqrrOCrS/HEkkxRJf
C1IEqPqdhA7YPhO6KIuFY3TI6WTZYrBOqe0KIf0Efoq4FrSWmMFnSx2Ltn2mSJCPwGMUhSJofLYV192l
Kp3CRRT9ZP+FZkHVf4js+TFoTciYMlEPrIT5MeCDboZ6FHEhzICWPQZ2wOQ8VjQg4xZfZDiE8QxXbYD6
Zb9wWJGjEh/BTATgEYEJsI9Z2LKJKBsUHZB1w+Mx5klA6caXYm7YbuE41dkU1KaqKOYRTjCWj4cOUce1
07ueZh5OiHTbEkYoduq1dv0eS9ocgkOsjXuBoxo24KNBaWy8SXgJc6ton+IT/YEdinbIjhZd/wOBXSl+
1STGCTfkVcAxPcb9iE4EoG91kkJzEBFHMgWDZPszqykPsX5lmPgcpzpHb1VBaWozcp33bHZ6IhtjSbn7
XQlbHIAn23N6vbGyh2tQPGZ4l7OPW/9D2s3sy7vTd7caxKNxchKZxRyK6KJ4IpvZeAGZ5wFrAdgGBhnX
imsmAY6byDP0JssJRDigWjKUjRF8G7J3601iZlHce61QIYK5UsUj7B73JUvha/3AYSIOqmTjTII+1wo+
2rv7B5EYJRiApR4eUuFTYu4oC4QsZ6ARioMRhZ+TygP5sILl2FW2p5vA7hGAcyQpVmsf5hfQKbYPKXvv
QDJdWfq70OP5n1I2PKDLq5CcdHdXQV/YNLG6lxaSXXJHbcbUrsWiLpYCjrtKZJPALwn82ygajPUWake9
yWggnV6issEBGyHcvNPFf789EzuW889hq4hR/Qg1hCrtBwCx89GWfc0QzzHwkOT9Vdkn63Yu1kIlDAI5
6Ag4q3CGMBkIJR5KViSgjMK5rpTN4YpabgQ8UtbbY6GMSxYeg11KqUxBDjDXWCOO9hUCDRuVFI485d0o
eovN1VX3bI9QYquhKChLAEMdNuWS0hnffEU7P09sx6+F5UF1I2w0xPygFylCs62dkwgosU+XkwOSMP8N
w7ZMkkSGp2ruSntYAtM3ylOOWTdG9FH0SeHZBUoxUmo6YYm3MaBAFIybp9g7q6hT2iKZXOubo0OWIpZ3
gnUrjY9MTkI7F46GsY6+b3zMbDfrnPVQGikRxSk0sZRZQsatI2O4s2PRgRRHS6HRWMmdFAozv/Z2BJu4
G1FjV+ix+eU7Z2/iEDR4HYMtP3XHaT9IzIr+g9npEnvsjMNUkRCmnUitXyJ7bZLDpNE6csi8beQqV43O
35dm2BpAF9w7Z1Jy1BEhDPmDD0pQ4u/GLqqTriGqqOcemmBO9N+Y0sY+PhvzZTahghsVgsCukPIwzRI1
aWFC6whCnoTqKcRyy7OhlCOzIHhflZp4+vktcFoRWEbr5oiDzr3+H3Zvyh/jvk5JeQS23pqLDFB8mZYi
dla7uu3unH8IXFZbARIqqCZDMVhA1nXlhHP9UihPDNaaow64mnfvybq/z6QB7I2jQ2Rz+8XKJIFpmgQL
3Y19pzssj5a9td6gHO2BmG+NkjbEvST8eQvrb1RJGyfSXcm6XkENMVqqW8lHhC0gkAHtqz4J5a4iCZil
EyIKgcawyrDDCdQHj7REDqV0XbUe5poTUxqqUdq0J2hYp333oeSL9+qYOQflOUC9Sy+Y2YFdngZTk7CJ
rN+nIgz3gcWsCAGS8YIKqBAj0+VEyAuiIbxWd19atSnDu3mfwJyD4STBXb+USCuoPux2DjzNiiOovkdZ
vrDLcTdobKAnCUtcMVcRiJqeKg0dTPa9K/lZx0DazE9dV8foIOFbKE8AAWZPSgvNVAlCS/jQnNdJ40x0
cMfMFqtVAs0hGw6Z55QPt7kWGnLJsCxaclVZIJg+JEnD4eAdwIVQAEsroE/L13ZgV+RI2ctCSHvgQhKB
oVClVB4HUrUwC57oprJYq45CP18YJ80f9J9QyECzJGTE8j5UpWdptiJNCe0RFIR3TcyKCsc19TpSFGJG
MX/k6YX+xz3uZsXkolpfT8BvKBsgHWs7yEMpJrM/WUEBIe4spytvX2ghBarEZDNi58NN0z18x44di151
hb5Bq26L9Qmf3V/BPQKY0iQMclESog89nYStNMsc8TvMqYdSLMjOEy/S+VCKFUhJkDGFiiW8rQVeYoFg
laOsk7hRJWBxwrMTjA3Rn127dkEUbVCsg2WVPEjHDMAep9iKz3YBrLqNPcFOABLXBv3D1YR7yGLUXd1z
bxX2qYgiLAEcZJRCNWHpBw1Xvah5WFpHqgTqKBJmq3B9SlhGUnpE/ERVQeGRMrOKTQLoPoGWQmFn2zb2
PaIiYV/ZRHX9O6CPaQMhr4MCE5LB644rr3Snks0YVVhk0vIzWwoSTw4TUzkuLy9nrx0KktIc0lmyn7/q
ap1lX4gBkD/uTlbBYRtK+XlpXQbzj5GxSt8YwnNdB56/aRmZ8IVq81uHVKbcqkGgkQYqK4b1u47qK9Hm
Li23wA77CsDFV5MPAe4O4khmbbpHD2tki1qU8mHp+ZRh/R+pVNiZmjSusdubyFNCqMdzctY+9uQqWkDf
lGNEK9Lszmpkq2esdcZjUQdzcj9nE51qf+aHFo5y4AzjVoUiDSO6bTZaLtkUsAtMQV++v59grzNel9hG
FWejIouhDVSUnSJoBvfVlfUFFHtmEvJOgHGiETTMhGJ0UTxXQMhKT8ldXuXEhuvjyrEktgRowQdQ5I7G
NXfpaQ435f+KSTHegiITELjr9CEUhRisJRQ6dbDlp8wnFNmdQkRw9K1XWFg8sSpZkJS8zKppz99gpM2v
qogzoJv9QnXBZNDvPOpzUvbAQYL48eRuD9UwRXx27mHdUBRwGHg1FKzXB6qjxf8KWFwZZklTJ9ZnN52r
4+CNBjbHtg4AEXnAlhEBP1IR/QcRb/Fwqfq2XwAoe/xgtcIWKbuTg4SfOLaYZZRifTSBIyHcUJQOmCw6
rZKlQLtzBB8RzAbhuOaKUGMS1wLnfoLKYh9x0UnX8Mb4AhvC430hRSHWq4i3M0EjH6zqydKpEgG4AINM
OxzkHJNYmdnAe80gI3CVw4WKcTVL2kH7RSBx2AcAHUBvkWsVKx5I4VQrT/6M9pzxEP58KIZysnKPdXAj
Ip/BNikSqXouMjXcqcfaDwivI/Yb91DZr8TQbhJIrbhL+y4QxgIV7t61i9Bp3txLmAUmhgrFXjEbG/Kg
8FsnVgOhN/fA5tpwzDBqFbqSemcZVbdkwkQUp+y5H9Udb3ohOSz6InY2wN21+osEb04c23kkJHaS90Jr
rlfaoeX4InvsbqLI91RKryhHUofGZUqWryIIC5vwQMUGRHYUPl4oZj8Ei4HAmTyZEjI1eeBHKmHnYGM2
2G0pB69RRpFNL4VcwKZC1RTMAWhx8soofk60J9AHgy1HQQqJrLXPiVr2BaTGOcNcDAOAybpR4USWsFNc
iqrEE+JjmRiCQYF1wOLjLFMqwhTeXRkGdN3jrHAxyP/gLrrqcTgW7ml0FZ+TUnwV2AyzHdVtoIaPmdaF
doAKPWudrwo3u6vYXW3i/4t3ppjMQgpw4CSBs0QH0jMSC0lVAMVmZBeOUqzAds6RbS3D9Y1ko28P3djZ
NelroqCj15tlhI+2yvaZwryEUtGmFSHxYYRAI90pQapuwBgjMZKFw7wwRvtjb59rCSegYKN1VP6mqTNu
kgRB4bhV+2U5nWqJn77kQTOUvkMchdC1eZX+6ywsQOncc6QUugPMMdTe7ayFD7ZaOutRCPpuEUDDfso+
SN8Wyod/85O/+eO/OfM3f/Y3Zz8+QZW3S//nMxBQGsKthL9fqcImdxrCcxp4ao5ooqqZTVeePXx3vFL7
52R71a6GRiRNiwxq0s5aqfYFXkuoLrA46f5i7jswC/lGVyljdIv3CAhvPWDVFd4tuGb1gHoHastgxcFX
iXZdJfBWwwgkvtAoH48dOuyXVLODalrKGDNrbrYBziMp7+spFQuqUcurZ89jr65ApxCudyn0l+BWqr1h
bQ48WhM6dKD9OGipceZf9UgZogpV9AvgV9b8m5dQdCGJS6DeizXTbJ1HFIusmXZ32Jhnm1k8JW28a0hX
SIENHAlprIWsQsUiqXRZqFd0hUpEb0ld6qOT/hp+uwgNpg/f++g5qihd56tPUBMJulNv2c937f3LH96g
HlPSpaIq0nX+hI7VB9SZejepSV1q9aik5MS7vBPaSR+dTO9CA+sqtZWuUrXpCjWw2FJ87sOXXLvqun3m
bVdKcoUoaVt99Jy9Az2sR/WUSUfqmitO4Te07zj74D3+K00vaU9dSwpZp5IG1AXvDehlvSfFL3yCLcS3
vM3WllB5wt0etZ6DwtQH/rxv25Nf4Hevxm+u7yS9LHwPqlTtfdH6G+x1tVmKYlQQ452fYF+8y7/5XXvt
UbxCJSqNyLvU/pKG1NvpOS77qMVoPUH9q5di3PxzV7MrX4unpuYW34Wal/Sp7H4vU6PquiuOQQvrvQ9/
lO5xnSN6ydt7A33qilYYj/d99EOV7Kr0xzCW1qcYN/ZB6r8bvO9l6of9iPpZ6JPTcV/omaEtPlLSJPsg
Zo61ECphz9nVNJbPffS4q4edtG+e5DXepsLaBSqLnUrXu/DhX6TeYFv4JDEjLtiTQ9fsGY7RBVzLR/k4
nzY+p3l2nb+7qpeN+XuatVI3Y79f1W8ffdfnxnucR5c4d6FBxvZRrezZpFqGsX0fT5Pm/Xtst+bu96xN
p+yqF6GidevsrTc/furWqzgpXBVMP6Uhdg2qUFKXku4XVbhO3XqDylpPf/wklLbsc9LDCpWx+O4Ve/VV
6lWd0Gsfn7x1yb9xzfW4zkG5jApSj/HEOovf7N+T1iqodb1J/TB8421qT0FZi2pW9u47dv+n7TdXCbMr
23PgKnafd6CqRY0yapndum4tOItv2TfO8DXoWulZoRl2PvXG096+t/xzJ29dtv/aM7Adp5KmGvXP+Pmf
hR5bPBufxvuN6mJSLXtUuma4EpTU+GzooTf5PD+l5tdbaIv6FIpo9hoUwrwP7HlPUnvrcfvuKbZGCl34
3GX25CnrobfwROwHqsDZ+3waKYlRse0MtM3SKOBzl6gldgpKZlAdY9/jjk9JzwzqaP453O0N9YSPtLXU
78bWuLKZ971r0r2exvgVzAyoxoXKmV/lPMeS8+/Wa/68JzWKVFR709p+yp7/9VvvoIcxE601j3Hc3rHX
NcPU55rJb1Dp7G2Mu/rePvWmK+W9gxnT3Dk5VK5DFWlWpUaYIdzdghbm1+s1f1XnMoFvUeVaWLieO92d
NguWGGMw/iXyZaab8FO8WNU/Ug8HRKd4jo2wGIRktwDIqogr2uyWzcZiYpWDFuGpxqUFpcHpSSJm5ulu
T/4Haq0aMcjMyP4Gi2S32eg9Saars7yrBfhUEiGA5+AAHwFxwF316K7EeWqVw3G/e59HNAlrCmgIdYS3
3IusRl4veXY87M06/GITT8F0SCNMz05ILdMJYUoGZDWa/HbdHW0kq82zN/NfeejL36LG1reSlTSqlLxb
gph2m+lZXGqzJRtmKVl3we2ambk3aJOqFyOoJMJNe5BUXlwdJCSj6i8Xyrybiwqzfm9HohpsOsIy/1tV
wipPQiVVd2tjMHKRo1CQQdihN1psxluANirxA1zO5AGyo2jWhy6Tdd9meUz8vb2dxhrxiD5xVzvcSWWq
B/V+F5UplhaiZNPyaIMRvpV62B1WSe1K+DXOM4xU5Bk9glVXDQAjjWf8Uqy1mdmWPJ0WKdINxhv8W1ci
Q2jYderq0OkFnKD7v7RTro2BLzLYS1YyCM9RvoR9pjhpeP1ruKLChuZ/71tbZz5ipNCwO3P32+RCZeTB
cLYxpw4ePFExfXlsK5XKZLkgBgUVShasVu1au/FSCy1iZEWUx5olQxlCq/tH6Ghag3fMr2uKz+6gGU5P
q3dXhYpkjCt0Wu+wVpCZnXqsjHyrqiv5qwh8aJG1wQWFI+jkRkUQ0ncDltOspFhlgcryvsjuatdQ6FbZ
yppvAUACmgqhmXCAjacgmfJ2VBg7qj8pFAfqpjhTocJLij0OCA9AyuV+lokokDdaagGu7b5j12GZbFwi
GDLcQIoQcwOdoy80IiNJClSFM4eKcR5XAxMPSXn50klvsDdhbUGbaP3RZGeb7IP4ug+syrRydqD3bWPp
gRs7AJygj5lIMGXN2IDQiAQ5fdUmS424hm3bRcI5OSQM01O1JDyBTwiBj3G3EnmTkJRmuLq3s7DUwhs9
xREiLT5T3VNFZn1pISX4onwi9oeaalTiLZMcSDk4HFSrnjvwfEFVqEg1g4HzOtAeABd4fVir/l21r913
UgVLwJQZ+yb7UVE9BtoSb7aYbSHY6F9PurvIzu5du34bMRTXvFhqIQ+keWKU93Z2zCchobTmB/0H+5Gh
KqJgH3ITrkqEAPRQ+B3RDbPEgiJn1HrqlTEWAaZoDrTHeMDSOX/lsbMsZ8GdnSiflPFuN67dbfS/UKkc
XmHHoi1STfYkCIIah1B+Q2n3vgNIETEC0rmv7TOhwjvLLU6fwVcv34QvOL7ht1K8ZXHr2GLhZ2eUwUOk
0XMpjOduuj5Et80LFA6gUza/GXjIemnjf45h6VKuYlV95jICK5OWfdDyQbEFFZH8PyqBQcXjtgBJQ4St
XP1v49oPVsXDGNxlxaKxUIvCn9iv32RpDWDJ9sQBUACNhEg0EDFVy9XoclMAogeoli62NereJCB+cM44
gRJyfT5p4vUmB7LNfFSE5qMT5yaMnZKRD6ihlyXj0wPrWBKErmJ2juhWKIbQ0WHkzrDe7C+cIBgsT+5y
21SsEaFxV7QpKblD2yeKeSAWmlCRBQq9KDjdRLVQKWR4l6gmHKT5qMaRsmeVAM/U6yxT3DMS9GYQ2ZSG
ot8A1aFUbVQAoTWvLcQotoabPFyhK7T5s2qFNTXwOs2AN2XTlTIA5TiqdEIxh6hcUuij5g8hOyyWzn6Q
Aim6+sDBB6NOEsVvBkOA5Np0ViF1EaqJeMEuipTaR0NAjYxlTss9SepwFhOOXWK2sqPGYyeQhNDCw00U
2rCLBSEakXtgvXDnNi4MaUc3RtqjbsZj05hc22eiCM2Sw4IP6dzcqrXvALblibkomwn5mEAosFicK3jQ
IOoLfiixQuVAieYS6GpQNOWEg3B3a5SVRQIihUYqjroED21ci4O6PslkbaJqnF3hXhX6wmqKbDxTY5IE
rXsTKaII7hpyO71J1AVDmhT+QElc5Zrv75i/Dt+zr22I6iCwWUDCmqjcaustivfYwHL5yyhrNrB0RHEv
JVUKESAmyfhy1BTDkiZIkVmpTgszJqYAG2izhxJ6+prNdUn/bVQtertweVzkHwY88ZnvpcZBNJ0VX6WG
K9AqsrsuqWbN25A1CY0NO8oPeEG6Tth31qp+yvG2YElOGCdbzMxk9mSSTG3PniVxF+4+QsiaSnXZXTsF
EuiVHV/fQJnHWk/BsmwO51PRJywaZl5rvrO/PZ2CG2NPoUQVp+f942RE4pBCqsL+bA/LL2FH9w+49Yq/
NutjIeSxUo2OVhLPiEJvmBpJaLqXXNojMGICBBoJAqJt/cw6Ui3cdeiu4r9AFcDFWgnp4bLpr06EuqNW
oH3NIWJYv93WXm8T+kU4QdbQ+aQ2UFB4QqbEvtZ4wh7l9X8CYsVThKrUwJJx35Q+xVzr+gTVxdr50FRE
wMl5TaiB1i6WoRuXKys4G5SWXo+IQJNyREXrjRdRDTXsVOEzmZ+XuRhgbx5fcQbvjiLe9rV7200X2Sov
u6qNnhMFZYKpWzR0S4GbGAdAULUWY54BnRstSOpywEwi1G2lavl5dtcv339INeD2tdY2DGi3Vu5OIYM5
eoA0KFPdX9wL03CFGWHNEhDHNijWskFbLNhY7rxWQi3eT/NWgEjATryjEmqmL2E/msMtspJwQ8/Q22ok
1sKOoAOtPRloQsrwoD5iF7sctjBP+CW/+0jG5WuKllfKvU+nq2YUc6qjkLyhfU+hiyrnH1FRppCPxgdy
CNGGsuAUdENqt2ZZrY2EpliZpDEOwhlWuDn2o50QQk0l5My4cEsXi0Dp6xqcwEFrxeOcA0ig7CocYreU
GjHFA8A5EboAU641OOeWFtLJWsk/p1uddpjfPdD6Fy1DtKEPsJN5uvkiRUaiRNdog9qObrWJysTjK2pq
Q0EKgGQZcBnT0faf4OHwFlp6XgoT452E0UEldpE9a4Tz4ezSVLgTlj5EnmVM2+olDoBF24I6CcMmUE+K
cBQlMYb2v62tOinz91BTNSo4r5DzypZRUIgz46j4BOyAzcrMT1UtPhScEHMIEnS+OdS6RgGio0KPM1KR
Ek6zpOV3NkE+Qs67TN6inYiYWBTyUQ1llExtIaG/n7BxdT/p7lddx0HCUdFPzp3E+iOMjdoWdt37mUOm
jRJywhkWDEZ64xqMNmlbOmOoDpIOl0inQa97BDaXamdjX3ddTOIZu4UjjQha0zqBzF0jaIicE47bQ1So
YN1takc5L3OU7D4uaSwDILILmmjQHSRJj62jCqSEN0Mo1WyuA4kRNNdCEJsR5YzouNlMDSMkxeXKXgpq
lr2UIzY3itpJNp05jUBFP6w5SYfNRjJVmyjK4thmr9/sGazvNbsl0dwTF/7YaH/iGrqIOLsNKEXINALw
SToVQcktinsminBgT7XmuI/C7qQEbRmoDurfbla+DSqqxhOnJelBmAsWDHZ6xvDUvzSbGx5cOHAchtSG
KhZbKv+cHHVieKwNh6tqS2McTOcGG2DBGuiNZjJqgnT2uxNv4xV1Mm00GXAlCHPRMbhYUkKeMSrm4TSU
y7QGQTwQUyMqytKU4EQkx9r7ARBlwkeocRtVyP9bh3UORLIblIXQGgQaSZ2rWAB6S5CH3uTuNiexvaW/
+BDadJhbbg3OXS2nArd1GUSH7mOMgsngjq7L50T98SmgIxC0UJJ3AKFTOZo9fTsxFikRuEQHtICMOWVd
BRKV3Ye1NYAngJllHppgXDQoeLgLNuaUcUyYKJqALiFUc8CK84mXVhyI+P6IHFMnqCbtWrAMtFXYzq1n
Yyy9XtPZimC7bQprYhSVNvFHClhtn9kmt3v7DPrXT7I1gerzarnYXrkuaPA5R4drflAk21uhCPbZUXm/
OCSGCQhJn0aJiSFr43puRohw+N3ALzXyg6hiSJXAlpFRrLZnVsjmYaGE+7wji9MUFGgc9B2F5d7vEmsr
iMHRKmjsCWgodAhC+c3OYFQ6rFeG9XiTDHkddbUrpNqShqqo76ktAZbxB+DmUJ97WAX6lAaknjVKYmMT
gxCgb69w4hVxCcWMutU9RQC+u578IXOWWVUZk1YxLLu2j/rObjlJqv4gTuqABPpurDrw0PJoU2byybSO
G28MEOHAkAuunbTxvVYE1d25Ban6h7wAjB+Bt461H/Tvxwp4ECcRYGRiYEZdV+s+6EQhb2J+gSYtKxyH
Z6kTMk4ynbyMD5RF0s1G/3obks5oPXJyAfXPqZtHUwhT3adBoB8ZxqL0Rrt42bJUcUeHj6MWA9Btn32o
9ZpVs8NXS8K6H4Va6DrZ8SsTdY3D9h1+6spcjiLeAhHJHj74/l69YyTyDW9FMfBeG1Wb59ITcdAlp2GM
hC9WiKwC35QwP66fr80fDI2EKTQmxIF7kWlbawUB8B0/x1MZDsDtiw0ImBJRyqrtXWpvelSGmUYdgoM1
YVrd0PLYymiw27rgbttUgdaUiwrjNKmfIavsHNBCO5jmHdVTld7xy8PniwrCFImtQvTdjULuRt3uPVIZ
q2K336i3uC49lukBQWVSw+4V7pgShkp92292QrJ+NmcJu5RbVJEwuxvaaUU+jI0Jo9mLCFDSosGkdTfB
zi50KvxXFLNIxLjSoz8cIYeDKvaqCHLdD63qUXe575ZTLelpihdDRjGp+NADZPYlZZpWRn0UJfeOCgQ1
NokNGVRMgyk9zIi3rDds0JDlbWeJh8jus13QX000ShzCDZYlRGnvbkMnUYkci6EN9bQKM3Ne+2DoC8ct
LApoKlWUYvHKZ/HIqfvAYR7WlgULzwsXj6LMzh2ob1ogeEz2whrOYJA2vPA1xqJ18KD90/d+kK0iF63F
x7eaQVQPdQoHooY+uZbjhN22zXlX7DNPgpjR7IEwirmatyM9Prvbw7EbJbXM/qTVcpiLQixj1J3ZiogA
yE1eMwQKsz4EbtaFartYEBC2OewhRfD1EYLv1ctaVAVqjdMYYf21rsrjfh0GliOycbf72ohACuPixJGc
KpWDm9jBsSZ83GCHx5TTUcuRl63DuevxKkxWhU1IHFESgpOLs5CGFf8RI225dZNo/evXUVKsmovKNgUm
bRmlj0atk8kERyKbhn1Kjku1H9t/CtnasFTJhzzYWvytvtOcszSEiw6tp8ZF2OnlU4Cf+5kI+HyHpruT
V0Q+wwQN1gf6zItAmXmQYCI4/b02BhQcML+5YrnIjjG+lR6+ppHjdgmWk1srkqfhesMguEyBG/kQrW77
dAEfkEzkxD1UnGvSzmXWSziIJHnraXX44f7ELnQPi1g6E25ahpjZPFcsFRBkG03C/IpcBA0SGadaklAF
hqPb9+7jBwhN7iXpWTC5FD+zWQ7D2EfInwKmz+bnU8lpl/u6mnOojWipOgONp4Ot7x8aN18qvsV4VMEA
TJhATIZsRYBCMjPcBoMXQtcoES6iKpDsM5Qc6SlWDPeFIhRi//Qpgc8FYwYkNdn9SfqDIhJzrsjSKMGh
IKqdItwtUdm+Iu1hE9z9BTfr4LS7wwQHVuEQ9larfjZHQ1YuDT+rIAWnUV/V36K9qD6SdntxpzjtAYyK
pVck/e7NNoTvOzh8/1Zmbo7y9MizmbmVtu1514Fo8ohL3d+WQYRGLWvHxbqxGJrkMKWEF2I3KXXolfjY
dNvUPWfpq5BdonMFv27LhMJQVoEk3a7bGioWROuC9S24TyIm22C1eHQaT+w7EmzEgXYOj1iC1tgelvP7
naFh7pHfQlVxyp7LgzB8o4gL7mZbNQI+ZVteS6F5VYorx326BNxWjvi+48AarMnETJJn6TZXypYcHbji
BhMn8lZh4bWre4496jIafRp7Xp7B9+p5J/JiTiSY4+okXEVkPQcF5HqUBmO6V/mhFDTjuuj5cko6JMqj
I84ygDz5AYnTRE5tA5q0RezyjC9X0LRrtO8wWeyyg9zX19O5eahNnrORipM6KZflSZPpPufm+NdVCGni
dOimZ1O1/1fPQog+sWKaEIrrluo+UTxa0d5WJxIpl1UGiG6eKzV/nSbTDzZLSdiFCqarH1A7vOWfNEG4
AY+QRRR4LAIMUm7WFCSr7OpCh0QFKd7NTfcQZeQtWgZOIuNYI+GxIp7dLbtuWuITq1DO1S2ScK/tNmMv
L9/AHYVOL+V7EzemkdzPqnNOxt26FJGHcAG4htJ+5AdslXfNFnq4hPZ68IqagedK2b+eTIVMClPNa/Zs
YLkN1RxEjs0awhOHfiR7En4WB4DerUZIgFto8pCK5JgbRbb4a9+2gPU0FhS1sZtAXCzkvxnNkOzDnk6x
JymEZQjfBuHiqI8VpRawoywsJKGmmQdVE1ZYosA72u/QrfNUxZ5UuNNco24FdfWdDKdxxwwtswxgGj1I
PGCbBZlZyMKNLpwJAuJskeGDsvYvtACs1Wph4ejRo/Prg8F6zyvsqM0YgbCWsyy2Ys9D50XS4VOUUZnN
Sl0tHBLAtnt2/57ZlyquOIFwXjQoA/q12UviHNtsnlf8ERYV4hTett3/Obtm1CixEzHLf3e/tKv9zM4M
U8XjGVmvFRuv5RYEg1I7a95BdyT5jjt23DNmMg2ewhxxEUc8JJXyv3sRRRkM/QTqQujbfTChK2qvlyre
MIfbDixn1zcsa1Wg6Am4923A+qGq328mvSPWAeW+1iyeW8IouyYfkMMLDh2GSkrI/AMtYkunZz/LFiDT
m2SItBmHHwlondCeZc/ciH0h9pXhmJoUCK+liRVJvL1ZJNBLWqtO8Xx31EUlHWtwqyBZ9vYP2oG/Yy6D
4UQ1UqDWUhodZl3biAwU2WRRx91l0arKLLWU1c7ddnitstx1XQrdIaBlhrbryt8SSD/pg9oz3mWf8UY3
Wb8tpWJqNqapzDcOHRiia4q2tJphiKq0RkucyrNfO7gDfnS/S/9m1sFGyifOF5mDEWiB1aqToYyEZWea
YHE/Y4dH6WkAJBvRvWSd06Vx3wTF1jJvqcr6ZzFL9T88NjM4JBFHbojZ/MjTOwegGyDDYi5D5/+O60o6
fpw66gryNEUqpT3stNq8CYTuSHhQATCf/VWx5ROP1/oT+4MnHVr1YmAlN1EPW/fdKDe3fF8laWJvx75q
xmewbGn3O9qJEQkVPBqOq8WDZGsvLNz9gPU4xsWLrUhHSkk1hIljr8jQo0VSebP5sz9rQ9Iugbbdb/0R
Ssut/dedO5e/3cb/Z5LrwUruCTQ45yWl5Ck7l1xpZ6ZmOTiyLRUVnA35BBqK9KEJpB33W2VQrNtU1CQ0
F61PsnOkSKXMC2Zn+zHumZO/EFgJNEg6R64nJnkqto3nhVfbWcqyzF8e08KVW3qEgNEeQrsewI3Ug1xJ
W25zM/N95EPpm7SAfWoFOrp0Jsd2KrRkm8PWsSJLUexO1cnteTO+y+5NAODSmLbnI2Ez7ouvMxyouLN5
ATgLVFo3eD7W/q8kJe9O0ccypoPSNC3McLW6M6qo2+eXs2hidkzNZMNYJBWwIkq0aHfBZhbo/mwtmKPT
W4v9OTOGi7gVobihF5flPiZK7ARpwXzLEVygHmGvcNSl0mt70bHN3h6dQa2qBlRtkb5UyZYknkpHqkoD
loNnU9Fte8Kv2PHWuAP+ULbPg/8R4haIYe3kTfYMs6Njh7tCXF9waW27xRxGVjNJtKDcH4qSEybQFEkD
R/o89L4XsshDwSrKG3XXJsGiDaldf4U4XO11UsJK9bsxLgjgu0OK70dl320ZO8qr2fLBAojESp0ANyhK
3LCQfZ2qjqqaj62TBwaoDs6pNJcxvZqZba3Pa3t5CvVULXSOUowh8jtrLm/BGoY75jtFq1eyle0z+Hw8
Msfd8+Lb2nTOzEzm2COQ1gsNuRYoWdzrWY174PW2Z0STwey1r6atGINxB4Z5QXDOUJwtUiiZ09RDHd9s
YVB7soBikYW2Q8aE5zW5GE4OifrIVR6ftdf3FS24NYMGFxlaoSvUltq/nFNalKljfHWlzckTWS58TxXj
zvxqBJkZsul2qzaK0TLUWlpP2TuIEjOj4msolmJPHtZH18PSvHufZVuVC6GGTyS527BmkdEDmwN91sqc
Y862vW1Zb7b+DiRFOP0Jn0nBIchKD8Jf2MpyUdzkeneOV/Cd7IDMgnyFPH4upe6wjepKusaa36NASpFk
3Q5kthCNON/3MneqnbQFCvmm8RpujO0vlT6m7xbnl3+eOC8Ge4aaQFnctwhFMyom8TqEqTTsZ29zOaxS
AhC/B+C82WS5TZ0XhehKgMCzkKUjX4G+C5iyDWjClzv8gDAIrhFnfxL4X0n94yClKrHzl/3Wk9k+E9A8
h7Wk6tW44AOeCUqLdwvbK1wL7cOtYh2KGJYQ/B83nuYLvBQ0F+PMZa7WnzcyRggV6azRv23cr1NIF2mL
66g/KFLebVgFRbQ3iX0Pc3U5Q8wzmeY5OX4x6jBmNljkMJRFS0BAduYBbJu1AMSsy6AQHd5ibUhPW/GF
/ZnfkSUVnGuo1YzbcE+nHrMbhwx/CmBk+++x4KjiubLtqsjOMuXpXH0WdkbhuSOBeRQCpgab01VS3l1n
DWOnKizo+SumLomraZCQdb4Pt4lUq3TkYCFPOcxmftyBUSsWiIxonL/WLC5x2OHKPQlhvC/zwR1pyGmc
0faazIbpS1tM7UylhKEcRV/YU5klGVU8TMzaSBpBR7XWVwa97mLSlmNomMXoCRdKRCXsaS29rlatCUU8
WFq2+Ho5LA4cGHGFUFy1iXUs+1nznblKV9ljDr9FqHM+R+iS665h5LeINYi+bm3pFQZTI/q9P8VSVJgV
1kQ3fBM/C7L8ewGF6MIdmofagHO27w36niknQCaDb5IzE3uLvGXhXgKY6Kg6ojYTNHw48vPLq8wr7LsV
XAo/W9k3bm8TrZVx2YOLyk2TmSnfITLwg6tUixGWimNiHdnsi71xOTucEuPJ+ZVOkW0yOn3TyWI7Oh+J
F7B9tfVZog4EYw7MoRWcsANs8m5EuxpcZzTY6iRVcCJf2TXUkc1icdtDxxXJBrdbCFdQ9pp5g8YriIxU
hDoxexrVNIx+9sIjyAeoP50c1XL6uB86FZA+msc9RBWWn4UGBJAy8YXsatortF/xrK9CB0+1dsOOJYK4
HLKYZuwdPEN9EaSyv8wIJrJmwxyyr03zpyBi9uBq1fqRyAOE/hrmUvgxWJsCsmvmMKFwNPzZ4Pk6xtiv
n9G9fJ9UqQweOgm+1QatMrd7Bp+nBKm0ZlmlPUu8cEtqUCsOzs6uznKrOS8lOdWbJwFAFWnp/9oDuMyB
A7Mi+dQEAj+0svvY1UNVHRnCVVkbWFQpe4xzfFilJCzWW+Tt60wFPzBy/ryjWDuwV5EEgr+QAfRndHXF
EAZRLNl2ISAsPT64l55RQhN5lVL2VTpz50LRj+uoAX5OZSmaLM4T9P8Jc6N22HqaOcrTwhzpJAuG9Uko
Kqa90ZU0PWOWUDfZOZVUH7B1+JpFABqfl9+OYjq9NOdtfyO5GTHG1kogLHxTBznLpidEzlHWdNfaCIwG
0EWOtyURvd2HocY6TrlV71su/lTI2967l/bkV2mXBuNRMIgEQGyCeY35wOhwJepkyuKOHP7kTB8vTEub
AP1WMs/vdHC/vtYXynGs+xpXWzNXtRHaQzuYMo867LJteI3P48aH9ljt7SG/jSPPmRIeQWljkpmdOWR4
xg/2QKajPW21gc7yV2HRF3dvAtod+XjtLUVkF+eSXcRsfJEkktE/3EbqtWo2ozkvZw+cwQ+LKkH8zSYx
0yf288S80t7o5O3+gHsOFo1so9hxquTg2HgdaEFucytZ/Ed16rWeU11pWJUCNXE/2WTFCM+1al8S83A1
PJPeBMIqJPQhhoZRcTj3kXpVvWkdM5sFslv1ZuQp3M7Bhhtxm5L5mtQtXLP+ZMFBI27XOSqc50PN8aNg
fgw2E0sExIbwf53F5GdZ2kPmWe9sNArNb9jhjdAKyVedC7oPxmUkyDX50GE7Mc4TFcbF0S2oksB9QzMC
a0D7pHpSh/io53GAUeAswq6XtEbrI7RqFzXLSbe2XwL3qsy924ot36mp6BdECfK0lut+kotQ3D7BukTA
Gvl6dxCUdZk9nTiwjiVykMskzmpVXhB7+5AtIu1dOvuDber7zDjitCUBXW57ExVcEzydDoW2H8zOaqoE
b4MUNuLSA6/dHLkGO91lG0NzAf3T+k0HPYlNiDvxhLI/M+2f3Qv/x//e/M637P//YWG92vFNeAJHi+rb
i26T8CwHISvpZAeiBIW/NwaJTJPoLfCDbMfcSGeZbSGiEDbbMgJQYqcn+0d7UaajBJVoz+P8wY4qy+l8
+CL19S5Rae/lj45/+AHVCa9Soe5//P1G6ItBkev2uVd+8bPvf3L13O0XnlBVaP/92on0++0Xn/rFn30P
xZefu/rJ9eu3L/zx7e9/8On1F3/xww9+8cQzn77ztv3v56dvfPLejz65+u4n1566/afPfvL+iz+/9O7P
333JPvnzcy/cvvT8Z68/5uuOaXDriaFgBlFbBSCC1YHH65Qqty2ScbAua+MOAjTg+Th+JpQwyy44lLj+
zZdVlDleHzSqTMfoMioPrZQPlyyyLBR4qWT9BDWYdX0gA+wT99UrQ9rDrDpspraUGFx3cwzjNXASQRR3
Lc+mjlR/Qx1MKGy2z1gGMgPXUcEgNKM7UJw2ngt6K/rd9sX0Oy4WubMK5e42K4crRLxukKNEovSzwCEp
gg+0xUqUHy2p3AfNQCj0/ZjKhieg/NfqQobu5kfPSE0S6n+uxdjqdkJd8jhVH6nKKPVJu8Jl6m+GWmGo
cUKRMd3ro+cwhzk7L+bXcd1Oag1KjTLuzb/f//B9alW+zZl/BX8l5UKoFaZr2qdwxbeoU3ktu1emjUh9
xavUFNU9QxPzcrr+ZaojhrblVb5HZU3ru7+k6qZUDpNOpn267cNHoXNJzch37XnxLFA0fQqqoa7YeSnT
Cr3kPXwBCp1QF/U+gQZlq2552Z6e/WPjEn0D9caL6Fd7onddefECVUy/Y89+0V5zBdAPL/EqH9j3vpNp
SF7Onv0C+0nKne+6iii1J6li+q637m3psHLE9JmrfKa3XEcVMwBPRh1P6kFKLfN9u8N1tuCqX8fHEcqV
VJa0e9sT4u8n2ALMz9S2D3/SzlvpYHJuvWc/T/qsuZZ9F8/yAfU3b0D5kqN4BZqynIF8cvvuB9Q0vcD+
UXulzfqB5rqN19WkFIt3P3Ad2vf4HP6ZqWe5kY3FVd2Pc+5GO4d5Z82Aq7G+qM958sOXs7XznjRioSWa
VFQvcR69j+fj07br5TL62kaY6yvTAL3caoRaWx7lpy9aK56TjqqvKSncanzf5xrAvP2uzdz3uW6O22/v
uf7uk3n7uR4v+Aq8xvG/QJXYk7wO7vuO3audwxjHdh0lPVTNOvY39p8/dy1b65+sNvdJVmG+ELWkT3n9
cdVAR8npKC3tJaRVI9s+8Czfej5+uRHVse0zL7clyNvrqJD0a9k1z0b5cpaZxusn+cq5qKZ9OmvPcZZo
v9F+Hv9ebtuGot6pWrfue43Vvc/E9Z+Pz7wR9dBTiWoWEPfP6yle9ArmuqaXbn+pvVd7X5Xwfoq/PM/P
v5kVxb7K26m1eq53+O/jfK7noyr3B1Ga/AobpkLw0Wy8/kN2zkvTz3i8fS7Vzvaa46mXno8C6K9HqfdT
WX151Z3Xw57nff8ivqX+fyX6JD2vjex7vG96xpPxmZf4IFdYNf7ZKNKdxvrFGMEz0bdxzVefzAqan427
p7E+HgXBz0SN8pPx7GdjjI57jXjvqxhHvP4Gr/9jXjb1uVpyge18J0b8JF9Mn/lOlG6/ODUfvN+usetO
+y++LtIcOB5PrcLur8W9XuSTnkS9eG//1agFf7V95DRv/Qrsf3z+xayvLscKusrLnon+POMF7ts2q69+
GCXUL7bP5b16nO15Ij7P5uHKp9nmC+zJk+yli+3Y+Tq6EaXkH8/2jcvx+pl2DqvfMMfeiK9ci8/rM1dj
nV5j807zk5pvmv8vRZ+cjkG5EnNAbb7iDda4t3M19eETsd6f5NWuRJ+8lu0Px7NnzPYcf6LoUtw3tecC
q9WnfYb3xdXOZ/Mnzc/jMUsv8y0WsvfxeiGbY6dizrzKm6a1prXwwvT+eZzf0lo7z2f/IK6j+a9N/vnp
Pf9afOa1bM5oYl/M9oGfRZ+8ETv5ad+j8JXz0bAf8InS9S/ECnqv7Qe89Xi8dTZG/EyMAluibmnX+wtT
e0U7uLHWfJ5f9odN+4P/qbHQ3HuG1+e08V36QnvG+fOmfj7FP6/yM29EI5/zZ/TPXI0Bupg94xPx7wu8
wmW+/k52Vl7w72Lf0Hn3ahp3qkVDF/tpKiS/TT3pR5Pq86Vb74Ri88cnoC798Sm+foWKyK1Ws5SUT926
SDXvpAOeFJZfzzSW37QrvAldcOhphzI4Xp3SEH9Myti438cn/V7hAVNVmrrXev0NtMnVpi+46jh+P4fP
+jXPfXySV1J73qLudVzzdXvvFBSp7TpX/fNQ6H6cn4K+9ROhUU4V6VeSNvlbt37Cp4DW+Jnsvk9Sn5tt
c4VzKVJfomq3FL+hzX0Kz88+DWXst6hv/rj0xqVdTR3xS9Sf1uuPUsX8rPfb43zKM1KsvnUWz4/r8NUr
1Et/mq9Dxfws+iB9lxrdrtd9ht94068v3XK1B9d+x5/xvM2Dp29d4hXfSnrdP8v+vUwFbe/zVuvcZkbb
J+ehh+7j/oara7fa8U/E62lMoe99DXMvxiKe8dZraI36wa7qiuPWX49TuTzUvWNcMPPe8vnzpv32JK+M
+X/d/oJO+mW2IObGGSq+n/W2XcXrjCsi8ge3vS0nisj/3gxmJm1wx55SUmN9PPToZb99h3LTEVam+DDY
eIPN2R1MhkivZQIUDyJ7KqK1Wg9Xx5secZzPscE5Jr9Z+hwSs81tZ2JWwHlAB8Fztq2eUu1y1p1U5D20
NMlAP4KSuvP2TyeERIdKtYd8IsJh9yO/s7oxhuyJyBae+d3L5F9kZhhkjzDs1hBlrT2hkWEgvrgWIHQy
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`;
  var dictionary;
  function getDictionary() {
    if (!dictionary) {
      dictionary = new Uint8Array(122784);
      const gzipString = atob(dictionaryGz64);
      const gzipBytes = new Uint8Array(gzipString.length);
      for (let i = 0; i < gzipString.length; i++) {
        gzipBytes[i] = gzipString.charCodeAt(i);
      }
      gunzip(gzipBytes, dictionary);
    }
    return dictionary;
  }

  // node_modules/hyparquet-compressors/src/brotli.transform.js
  var kIdentity = 0;
  var kOmitLast1 = 1;
  var kOmitLast2 = 2;
  var kOmitLast3 = 3;
  var kOmitLast4 = 4;
  var kOmitLast5 = 5;
  var kOmitLast6 = 6;
  var kOmitLast7 = 7;
  var kOmitLast8 = 8;
  var kOmitLast9 = 9;
  var kUppercaseFirst = 10;
  var kUppercaseAll = 11;
  var kOmitFirst1 = 12;
  var kOmitFirst2 = 13;
  var kOmitFirst3 = 14;
  var kOmitFirst4 = 15;
  var kOmitFirst5 = 16;
  var kOmitFirst6 = 17;
  var kOmitFirst7 = 18;
  var kOmitFirst9 = 20;
  function Transform(prefix2, transform, suffix) {
    this.prefix = new Uint8Array(prefix2.length);
    this.transform = transform;
    this.suffix = new Uint8Array(suffix.length);
    for (let i = 0; i < prefix2.length; i++) this.prefix[i] = prefix2.charCodeAt(i);
    for (let i = 0; i < suffix.length; i++) this.suffix[i] = suffix.charCodeAt(i);
  }
  var kTransforms = [
    new Transform("", kIdentity, ""),
    new Transform("", kIdentity, " "),
    new Transform(" ", kIdentity, " "),
    new Transform("", kOmitFirst1, ""),
    new Transform("", kUppercaseFirst, " "),
    new Transform("", kIdentity, " the "),
    new Transform(" ", kIdentity, ""),
    new Transform("s ", kIdentity, " "),
    new Transform("", kIdentity, " of "),
    new Transform("", kUppercaseFirst, ""),
    new Transform("", kIdentity, " and "),
    new Transform("", kOmitFirst2, ""),
    new Transform("", kOmitLast1, ""),
    new Transform(", ", kIdentity, " "),
    new Transform("", kIdentity, ", "),
    new Transform(" ", kUppercaseFirst, " "),
    new Transform("", kIdentity, " in "),
    new Transform("", kIdentity, " to "),
    new Transform("e ", kIdentity, " "),
    new Transform("", kIdentity, '"'),
    new Transform("", kIdentity, "."),
    new Transform("", kIdentity, '">'),
    new Transform("", kIdentity, "\n"),
    new Transform("", kOmitLast3, ""),
    new Transform("", kIdentity, "]"),
    new Transform("", kIdentity, " for "),
    new Transform("", kOmitFirst3, ""),
    new Transform("", kOmitLast2, ""),
    new Transform("", kIdentity, " a "),
    new Transform("", kIdentity, " that "),
    new Transform(" ", kUppercaseFirst, ""),
    new Transform("", kIdentity, ". "),
    new Transform(".", kIdentity, ""),
    new Transform(" ", kIdentity, ", "),
    new Transform("", kOmitFirst4, ""),
    new Transform("", kIdentity, " with "),
    new Transform("", kIdentity, "'"),
    new Transform("", kIdentity, " from "),
    new Transform("", kIdentity, " by "),
    new Transform("", kOmitFirst5, ""),
    new Transform("", kOmitFirst6, ""),
    new Transform(" the ", kIdentity, ""),
    new Transform("", kOmitLast4, ""),
    new Transform("", kIdentity, ". The "),
    new Transform("", kUppercaseAll, ""),
    new Transform("", kIdentity, " on "),
    new Transform("", kIdentity, " as "),
    new Transform("", kIdentity, " is "),
    new Transform("", kOmitLast7, ""),
    new Transform("", kOmitLast1, "ing "),
    new Transform("", kIdentity, "\n	"),
    new Transform("", kIdentity, ":"),
    new Transform(" ", kIdentity, ". "),
    new Transform("", kIdentity, "ed "),
    new Transform("", kOmitFirst9, ""),
    new Transform("", kOmitFirst7, ""),
    new Transform("", kOmitLast6, ""),
    new Transform("", kIdentity, "("),
    new Transform("", kUppercaseFirst, ", "),
    new Transform("", kOmitLast8, ""),
    new Transform("", kIdentity, " at "),
    new Transform("", kIdentity, "ly "),
    new Transform(" the ", kIdentity, " of "),
    new Transform("", kOmitLast5, ""),
    new Transform("", kOmitLast9, ""),
    new Transform(" ", kUppercaseFirst, ", "),
    new Transform("", kUppercaseFirst, '"'),
    new Transform(".", kIdentity, "("),
    new Transform("", kUppercaseAll, " "),
    new Transform("", kUppercaseFirst, '">'),
    new Transform("", kIdentity, '="'),
    new Transform(" ", kIdentity, "."),
    new Transform(".com/", kIdentity, ""),
    new Transform(" the ", kIdentity, " of the "),
    new Transform("", kUppercaseFirst, "'"),
    new Transform("", kIdentity, ". This "),
    new Transform("", kIdentity, ","),
    new Transform(".", kIdentity, " "),
    new Transform("", kUppercaseFirst, "("),
    new Transform("", kUppercaseFirst, "."),
    new Transform("", kIdentity, " not "),
    new Transform(" ", kIdentity, '="'),
    new Transform("", kIdentity, "er "),
    new Transform(" ", kUppercaseAll, " "),
    new Transform("", kIdentity, "al "),
    new Transform(" ", kUppercaseAll, ""),
    new Transform("", kIdentity, "='"),
    new Transform("", kUppercaseAll, '"'),
    new Transform("", kUppercaseFirst, ". "),
    new Transform(" ", kIdentity, "("),
    new Transform("", kIdentity, "ful "),
    new Transform(" ", kUppercaseFirst, ". "),
    new Transform("", kIdentity, "ive "),
    new Transform("", kIdentity, "less "),
    new Transform("", kUppercaseAll, "'"),
    new Transform("", kIdentity, "est "),
    new Transform(" ", kUppercaseFirst, "."),
    new Transform("", kUppercaseAll, '">'),
    new Transform(" ", kIdentity, "='"),
    new Transform("", kUppercaseFirst, ","),
    new Transform("", kIdentity, "ize "),
    new Transform("", kUppercaseAll, "."),
    new Transform("\xC2\xA0", kIdentity, ""),
    new Transform(" ", kIdentity, ","),
    new Transform("", kUppercaseFirst, '="'),
    new Transform("", kUppercaseAll, '="'),
    new Transform("", kIdentity, "ous "),
    new Transform("", kUppercaseAll, ", "),
    new Transform("", kUppercaseFirst, "='"),
    new Transform(" ", kUppercaseFirst, ","),
    new Transform(" ", kUppercaseAll, '="'),
    new Transform(" ", kUppercaseAll, ", "),
    new Transform("", kUppercaseAll, ","),
    new Transform("", kUppercaseAll, "("),
    new Transform("", kUppercaseAll, ". "),
    new Transform(" ", kUppercaseAll, "."),
    new Transform("", kUppercaseAll, "='"),
    new Transform(" ", kUppercaseAll, ". "),
    new Transform(" ", kUppercaseFirst, '="'),
    new Transform(" ", kUppercaseAll, "='"),
    new Transform(" ", kUppercaseFirst, "='")
  ];
  var kNumTransforms = kTransforms.length;
  function ToUpperCase(p, i) {
    if (p[i] < 192) {
      if (p[i] >= 97 && p[i] <= 122) {
        p[i] ^= 32;
      }
      return 1;
    }
    if (p[i] < 224) {
      p[i + 1] ^= 32;
      return 2;
    }
    p[i + 2] ^= 5;
    return 3;
  }
  function transformDictionaryWord(dst, idx, word, len, transform) {
    const dictionary2 = getDictionary();
    const { prefix: prefix2 } = kTransforms[transform];
    const { suffix } = kTransforms[transform];
    const t = kTransforms[transform].transform;
    let skip = t < kOmitFirst1 ? 0 : t - (kOmitFirst1 - 1);
    const start_idx = idx;
    if (skip > len) skip = len;
    let prefix_pos = 0;
    while (prefix_pos < prefix2.length) {
      dst[idx++] = prefix2[prefix_pos++];
    }
    word += skip;
    len -= skip;
    if (t <= kOmitLast9) len -= t;
    for (let i = 0; i < len; i++) {
      dst[idx++] = dictionary2[word + i];
    }
    let uppercase = idx - len;
    if (t === kUppercaseFirst) {
      ToUpperCase(dst, uppercase);
    } else if (t === kUppercaseAll) {
      while (len > 0) {
        const step = ToUpperCase(dst, uppercase);
        uppercase += step;
        len -= step;
      }
    }
    let suffix_pos = 0;
    while (suffix_pos < suffix.length) {
      dst[idx++] = suffix[suffix_pos++];
    }
    return idx - start_idx;
  }

  // node_modules/hyparquet-compressors/src/brotli.js
  var kNumLiteralCodes = 256;
  var kNumInsertAndCopyCodes = 704;
  var kNumBlockLengthCodes = 26;
  var kLiteralContextBits = 6;
  var kDistanceContextBits = 2;
  var NUM_DISTANCE_SHORT_CODES = 16;
  var kDistanceShortCodeIndexOffset = new Uint8Array([
    3,
    2,
    1,
    0,
    3,
    3,
    3,
    3,
    3,
    3,
    2,
    2,
    2,
    2,
    2,
    2
  ]);
  var kDistanceShortCodeValueOffset = new Int8Array([
    0,
    0,
    0,
    0,
    -1,
    1,
    -2,
    2,
    -3,
    3,
    -1,
    1,
    -2,
    2,
    -3,
    3
  ]);
  var offsetsByLength = new Uint32Array([
    0,
    0,
    0,
    0,
    0,
    4096,
    9216,
    21504,
    35840,
    44032,
    53248,
    63488,
    74752,
    87040,
    93696,
    100864,
    104704,
    106752,
    108928,
    113536,
    115968,
    118528,
    119872,
    121280,
    122016
  ]);
  var sizeBitsByLength = new Uint8Array([
    0,
    0,
    0,
    0,
    10,
    10,
    11,
    11,
    10,
    10,
    10,
    10,
    10,
    9,
    9,
    8,
    7,
    7,
    8,
    7,
    7,
    6,
    6,
    5,
    5
  ]);
  var minDictionaryWordLength = 4;
  var maxDictionaryWordLength = 24;
  function decompressBrotli(input, outputLength) {
    const output = new Uint8Array(outputLength);
    const brotliInput = new BrotliInput(input);
    const brotliOutput = new BrotliOutput(output);
    brotli(brotliInput, brotliOutput);
    return output;
  }
  function brotli(input, output) {
    let pos = 0;
    let input_end = 0;
    let window_bits = 0;
    let max_distance = 0;
    const dist_rb = [16, 15, 11, 4];
    let dist_rb_idx = 0;
    let prev_byte1 = 0;
    let prev_byte2 = 0;
    const hgroup = [new HuffmanTreeGroup(0, 0), new HuffmanTreeGroup(0, 0), new HuffmanTreeGroup(0, 0)];
    const kRingBufferWriteAheadSlack = 128 + BrotliBitReader.READ_SIZE;
    const br = new BrotliBitReader(input);
    window_bits = decodeWindowBits(br);
    const max_backward_distance = (1 << window_bits) - 16;
    const ringbuffer_size = 1 << window_bits;
    const ringbuffer_mask = ringbuffer_size - 1;
    const ringbuffer = new Uint8Array(ringbuffer_size + kRingBufferWriteAheadSlack + maxDictionaryWordLength);
    const ringbuffer_end = ringbuffer_size;
    const block_type_trees = [];
    const block_len_trees = [];
    for (let x = 0; x < 3 * HUFFMAN_MAX_TABLE_SIZE; x++) {
      block_type_trees[x] = new HuffmanCode(0, 0);
      block_len_trees[x] = new HuffmanCode(0, 0);
    }
    while (!input_end) {
      let meta_block_remaining_len = 0;
      const block_length = [1 << 28, 1 << 28, 1 << 28];
      const block_type = [0];
      const num_block_types = [1, 1, 1];
      const block_type_rb = [0, 1, 0, 1, 0, 1];
      const block_type_rb_index = [0];
      let context_offset = 0;
      for (let i = 0; i < 3; i++) {
        hgroup[i].codes = [];
        hgroup[i].htrees = new Uint32Array();
      }
      br.readMoreInput();
      const _out = decodeMetaBlockLength(br);
      meta_block_remaining_len = _out.meta_block_length;
      if (pos + meta_block_remaining_len > output.buffer.length) {
        const tmp = new Uint8Array(pos + meta_block_remaining_len);
        tmp.set(output.buffer);
        output.buffer = tmp;
      }
      input_end = _out.input_end;
      if (_out.is_metadata) {
        jumpToByteBoundary(br);
        for (; meta_block_remaining_len > 0; --meta_block_remaining_len) {
          br.readMoreInput();
          br.readBits(8);
        }
        continue;
      }
      if (meta_block_remaining_len === 0) continue;
      if (_out.is_uncompressed) {
        br.bit_pos_ = br.bit_pos_ + 7 & ~7;
        copyUncompressedBlockToOutput(output, meta_block_remaining_len, pos, ringbuffer, ringbuffer_mask, br);
        pos += meta_block_remaining_len;
        continue;
      }
      for (let i = 0; i < 3; i++) {
        num_block_types[i] = decodeVarLenUint8(br) + 1;
        if (num_block_types[i] >= 2) {
          readHuffmanCode(num_block_types[i] + 2, block_type_trees, i * HUFFMAN_MAX_TABLE_SIZE, br);
          readHuffmanCode(kNumBlockLengthCodes, block_len_trees, i * HUFFMAN_MAX_TABLE_SIZE, br);
          block_length[i] = readBlockLength(block_len_trees, i * HUFFMAN_MAX_TABLE_SIZE, br);
          block_type_rb_index[i] = 1;
        }
      }
      br.readMoreInput();
      const distance_postfix_bits = br.readBits(2);
      const num_direct_distance_codes = NUM_DISTANCE_SHORT_CODES + (br.readBits(4) << distance_postfix_bits);
      const distance_postfix_mask = (1 << distance_postfix_bits) - 1;
      const num_distance_codes = num_direct_distance_codes + (48 << distance_postfix_bits);
      const context_modes = new Uint8Array(num_block_types[0]);
      for (let i = 0; i < num_block_types[0]; i++) {
        br.readMoreInput();
        context_modes[i] = br.readBits(2) << 1;
      }
      const [num_literal_htrees, context_map] = decodeContextMap(num_block_types[0] << kLiteralContextBits, br);
      const [num_dist_htrees, dist_context_map] = decodeContextMap(num_block_types[2] << kDistanceContextBits, br);
      hgroup[0] = new HuffmanTreeGroup(kNumLiteralCodes, num_literal_htrees);
      hgroup[1] = new HuffmanTreeGroup(kNumInsertAndCopyCodes, num_block_types[1]);
      hgroup[2] = new HuffmanTreeGroup(num_distance_codes, num_dist_htrees);
      for (let i = 0; i < 3; ++i) {
        hgroup[i].decode(br);
      }
      let context_map_slice = 0;
      let dist_context_map_slice = 0;
      let context_mode = context_modes[block_type[0]];
      let context_lookup_offset1 = lookupOffsets[context_mode];
      let context_lookup_offset2 = lookupOffsets[context_mode + 1];
      let htree_command = hgroup[1].htrees[0];
      while (meta_block_remaining_len > 0) {
        let distance_code;
        br.readMoreInput();
        if (block_length[1] === 0) {
          decodeBlockType(
            num_block_types[1],
            block_type_trees,
            1,
            block_type,
            block_type_rb,
            block_type_rb_index,
            br
          );
          block_length[1] = readBlockLength(block_len_trees, HUFFMAN_MAX_TABLE_SIZE, br);
          htree_command = hgroup[1].htrees[block_type[1]];
        }
        block_length[1]--;
        const cmd_code = readSymbol(hgroup[1].codes, htree_command, br);
        let range_idx = cmd_code >> 6;
        if (range_idx >= 2) {
          range_idx -= 2;
          distance_code = -1;
        } else {
          distance_code = 0;
        }
        const insertIndex = kInsertRangeLut[range_idx] + (cmd_code >> 3 & 7);
        const insertPrefix = kInsertLengthPrefixCode[insertIndex];
        const insertLength = insertPrefix.offset + br.readBits(insertPrefix.nbits);
        const copyIndex = kCopyRangeLut[range_idx] + (cmd_code & 7);
        const copyCode = kCopyLengthPrefixCode[copyIndex];
        const copyLength = copyCode.offset + br.readBits(copyCode.nbits);
        prev_byte1 = ringbuffer[pos - 1 & ringbuffer_mask];
        prev_byte2 = ringbuffer[pos - 2 & ringbuffer_mask];
        for (let j = 0; j < insertLength; j++) {
          br.readMoreInput();
          if (block_length[0] === 0) {
            decodeBlockType(
              num_block_types[0],
              block_type_trees,
              0,
              block_type,
              block_type_rb,
              block_type_rb_index,
              br
            );
            block_length[0] = readBlockLength(block_len_trees, 0, br);
            context_offset = block_type[0] << kLiteralContextBits;
            context_map_slice = context_offset;
            context_mode = context_modes[block_type[0]];
            context_lookup_offset1 = lookupOffsets[context_mode];
            context_lookup_offset2 = lookupOffsets[context_mode + 1];
          }
          const context = lookup[context_lookup_offset1 + prev_byte1] | lookup[context_lookup_offset2 + prev_byte2];
          const literal_htree_index = context_map[context_map_slice + context];
          block_length[0]--;
          prev_byte2 = prev_byte1;
          prev_byte1 = readSymbol(hgroup[0].codes, hgroup[0].htrees[literal_htree_index], br);
          ringbuffer[pos & ringbuffer_mask] = prev_byte1;
          if ((pos & ringbuffer_mask) === ringbuffer_mask) {
            output.write(ringbuffer, ringbuffer_size);
          }
          pos++;
        }
        meta_block_remaining_len -= insertLength;
        if (meta_block_remaining_len <= 0) break;
        if (distance_code < 0) {
          br.readMoreInput();
          if (block_length[2] === 0) {
            decodeBlockType(
              num_block_types[2],
              block_type_trees,
              2,
              block_type,
              block_type_rb,
              block_type_rb_index,
              br
            );
            block_length[2] = readBlockLength(block_len_trees, 2 * HUFFMAN_MAX_TABLE_SIZE, br);
            dist_context_map_slice = block_type[2] << kDistanceContextBits;
          }
          block_length[2]--;
          const context = (copyLength > 4 ? 3 : copyLength - 2) & 255;
          const dist_htree_index = dist_context_map[dist_context_map_slice + context];
          distance_code = readSymbol(hgroup[2].codes, hgroup[2].htrees[dist_htree_index], br);
          if (distance_code >= num_direct_distance_codes) {
            distance_code -= num_direct_distance_codes;
            const postfix = distance_code & distance_postfix_mask;
            distance_code >>= distance_postfix_bits;
            const nbits = (distance_code >> 1) + 1;
            const offset = (2 + (distance_code & 1) << nbits) - 4;
            distance_code = num_direct_distance_codes + (offset + br.readBits(nbits) << distance_postfix_bits) + postfix;
          }
        }
        const distance = translateShortCodes(distance_code, dist_rb, dist_rb_idx);
        if (distance < 0) throw new Error("[BrotliDecompress] invalid distance");
        if (pos < max_backward_distance && max_distance !== max_backward_distance) {
          max_distance = pos;
        } else {
          max_distance = max_backward_distance;
        }
        let copy_dst = pos & ringbuffer_mask;
        if (distance > max_distance) {
          if (copyLength >= minDictionaryWordLength && copyLength <= maxDictionaryWordLength) {
            let offset = offsetsByLength[copyLength];
            const word_id = distance - max_distance - 1;
            const shift = sizeBitsByLength[copyLength];
            const mask = (1 << shift) - 1;
            const word_idx = word_id & mask;
            const transform_idx = word_id >> shift;
            offset += word_idx * copyLength;
            if (transform_idx < kNumTransforms) {
              const len = transformDictionaryWord(ringbuffer, copy_dst, offset, copyLength, transform_idx);
              copy_dst += len;
              pos += len;
              meta_block_remaining_len -= len;
              if (copy_dst >= ringbuffer_end) {
                output.write(ringbuffer, ringbuffer_size);
                for (let _x = 0; _x < copy_dst - ringbuffer_end; _x++)
                  ringbuffer[_x] = ringbuffer[ringbuffer_end + _x];
              }
            } else {
              throw new Error("Invalid backward reference");
            }
          } else {
            throw new Error("Invalid backward reference");
          }
        } else {
          if (distance_code > 0) {
            dist_rb[dist_rb_idx & 3] = distance;
            dist_rb_idx++;
          }
          if (copyLength > meta_block_remaining_len) {
            throw new Error("Invalid backward reference");
          }
          for (let j = 0; j < copyLength; j++) {
            ringbuffer[pos & ringbuffer_mask] = ringbuffer[pos - distance & ringbuffer_mask];
            if ((pos & ringbuffer_mask) === ringbuffer_mask) {
              output.write(ringbuffer, ringbuffer_size);
            }
            pos++;
            meta_block_remaining_len--;
          }
        }
        prev_byte1 = ringbuffer[pos - 1 & ringbuffer_mask];
        prev_byte2 = ringbuffer[pos - 2 & ringbuffer_mask];
      }
      pos &= 1073741823;
    }
    output.write(ringbuffer, pos & ringbuffer_mask);
  }
  function translateShortCodes(code, ringbuffer, index) {
    if (code < NUM_DISTANCE_SHORT_CODES) {
      index += kDistanceShortCodeIndexOffset[code];
      index &= 3;
      return ringbuffer[index] + kDistanceShortCodeValueOffset[code];
    } else {
      return code - NUM_DISTANCE_SHORT_CODES + 1;
    }
  }

  // node_modules/hyparquet-compressors/src/lz4.js
  function decompressLz4(input, outputLength) {
    const output = new Uint8Array(outputLength);
    try {
      let i = 0;
      let o = 0;
      while (i < input.length - 8) {
        const expectedOutputLength = input[i++] << 24 | input[i++] << 16 | input[i++] << 8 | input[i++];
        const expectedInputLength = input[i++] << 24 | input[i++] << 16 | input[i++] << 8 | input[i++];
        if (input.length - i < expectedInputLength) throw new Error("lz4 not hadoop");
        if (output.length < expectedOutputLength) throw new Error("lz4 not hadoop");
        const chunk = lz4basic(input.subarray(i, i + expectedInputLength), output, o);
        if (chunk !== expectedOutputLength) throw new Error("lz4 not hadoop");
        i += expectedInputLength;
        o += expectedOutputLength;
        if (i === input.length) return output;
      }
      if (i < input.length) throw new Error("lz4 not hadoop");
    } catch (error) {
      if (error instanceof Error && error.message !== "lz4 not hadoop") throw error;
      lz4basic(input, output, 0);
    }
    return output;
  }
  function decompressLz4Raw(input, outputLength) {
    const output = new Uint8Array(outputLength);
    lz4basic(input, output, 0);
    return output;
  }
  function lz4basic(input, output, outputIndex) {
    let len = outputIndex;
    for (let i = 0; i < input.length; ) {
      const token = input[i++];
      let literals = token >> 4;
      if (literals) {
        let byte2 = literals + 240;
        while (byte2 === 255) literals += byte2 = input[i++];
        output.set(input.subarray(i, i + literals), len);
        len += literals;
        i += literals;
        if (i >= input.length) return len - outputIndex;
      }
      const offset = input[i++] | input[i++] << 8;
      if (!offset || offset > len) {
        throw new Error(`lz4 offset out of range ${offset}`);
      }
      let matchLength = (token & 15) + 4;
      let byte = matchLength + 240;
      while (byte === 255) matchLength += byte = input[i++];
      let pos = len - offset;
      const end = len + matchLength;
      while (len < end) output[len++] = output[pos++];
    }
    return len - outputIndex;
  }

  // node_modules/hyparquet-compressors/src/compressors.js
  var compressors = {
    SNAPPY: snappyUncompressor(),
    // loads wasm
    GZIP: (input, length) => gunzip(input, new Uint8Array(length)),
    BROTLI: decompressBrotli,
    ZSTD: (input) => decompress(input),
    LZ4: decompressLz4,
    LZ4_RAW: decompressLz4Raw
  };

  // src/table-core.js
  function previewLimit(name, defaultValue, minimum2, maximum) {
    const raw = typeof GLib !== "undefined" && typeof GLib.getenv === "function" ? GLib.getenv(name) : null;
    if (!raw || !/^\d+$/.test(raw)) return defaultValue;
    return Math.max(minimum2, Math.min(maximum, Number(raw)));
  }
  var MAX_TABLE_CELLS = 1e4 * 128;
  var requestedRows = previewLimit("SUSHI_BIOINFO_MAX_ROWS", 1e4, 100, 25e3);
  var columns = previewLimit("SUSHI_BIOINFO_MAX_COLUMNS", 128, 8, 256);
  var tableRows = Math.min(requestedRows, Math.floor(MAX_TABLE_CELLS / columns));
  var LIMITS = Object.freeze({
    bytes: previewLimit("SUSHI_BIOINFO_MAX_MIB", 16, 1, 64) * 1024 * 1024,
    rows: requestedRows,
    tableRows,
    columns,
    cells: MAX_TABLE_CELLS,
    tableCellLimitActive: tableRows < requestedRows,
    fieldChars: 512
  });

  // src/parquet-core.js
  var MAGIC = [80, 65, 82, 49];
  var MAX_ROWS = 1e4;
  var MAX_COLUMNS = 128;
  var MAX_ENTRIES = 1e5;
  var MAX_DEPTH = 64;
  function fail(message) {
    throw new Error(`Parquet preview: ${message}`);
  }
  function asBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    fail("range reader returned invalid bytes");
  }
  function readByte(state) {
    if (state.offset >= state.bytes.length) fail("truncated compact-Thrift data");
    return state.bytes[state.offset++];
  }
  function readVarint(state, maxBytes = 5) {
    let value = 0n;
    let shift = 0n;
    for (let i = 0; i < maxBytes; i++) {
      const byte = readByte(state);
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) {
        if (maxBytes === 5 && value > 0xffffffffn) fail("compact-Thrift integer exceeds 32 bits");
        return value;
      }
      shift += 7n;
    }
    fail("invalid compact-Thrift integer");
  }
  function readZigzag(state, wide = false) {
    const value = readVarint(state, wide ? 10 : 5);
    const decoded = value >> 1n ^ -(value & 1n);
    return wide ? decoded : Number(BigInt.asIntN(32, decoded));
  }
  function countEntries(state, count) {
    if (!Number.isSafeInteger(count) || count < 0 || state.entries + count > MAX_ENTRIES)
      fail(`compact-Thrift container exceeds ${MAX_ENTRIES} entries`);
    state.entries += count;
  }
  function readCompactStruct(state, depth) {
    if (depth > MAX_DEPTH) fail(`compact-Thrift nesting exceeds ${MAX_DEPTH} levels`);
    const result = /* @__PURE__ */ Object.create(null);
    let fieldId = 0;
    while (true) {
      const header = readByte(state);
      const type = header & 15;
      if (type === 0) return result;
      countEntries(state, 1);
      const delta = header >> 4;
      fieldId = delta ? fieldId + delta : readZigzag(state);
      result[`field_${fieldId}`] = readCompactValue(state, type, depth + 1);
    }
  }
  function readCompactValue(state, type, depth) {
    switch (type) {
      case 1:
        return true;
      case 2:
        return false;
      case 3:
        return readByte(state) << 24 >> 24;
      case 4:
      case 5:
        return readZigzag(state);
      case 6:
        return readZigzag(state, true);
      case 7: {
        if (state.offset + 8 > state.bytes.length) fail("truncated compact-Thrift double");
        const value = new DataView(state.bytes.buffer, state.bytes.byteOffset + state.offset, 8).getFloat64(0, true);
        state.offset += 8;
        return value;
      }
      case 8: {
        const length = Number(readVarint(state));
        if (!Number.isSafeInteger(length) || length > state.bytes.length - state.offset)
          fail("compact-Thrift binary exceeds available bytes");
        const value = state.bytes.subarray(state.offset, state.offset + length);
        state.offset += length;
        return value;
      }
      case 9:
      case 10: {
        if (depth > MAX_DEPTH) fail(`compact-Thrift nesting exceeds ${MAX_DEPTH} levels`);
        const header = readByte(state);
        let count = header >> 4;
        if (count === 15) count = Number(readVarint(state));
        countEntries(state, count);
        const elementType = header & 15;
        const values = new Array(count);
        for (let i = 0; i < count; i++)
          values[i] = elementType === 1 || elementType === 2 ? readByte(state) === 1 : readCompactValue(state, elementType, depth + 1);
        return values;
      }
      case 11: {
        if (depth > MAX_DEPTH) fail(`compact-Thrift nesting exceeds ${MAX_DEPTH} levels`);
        const count = Number(readVarint(state));
        countEntries(state, count);
        if (!count) return /* @__PURE__ */ new Map();
        const types = readByte(state);
        const keyType = types >> 4;
        const valueType = types & 15;
        const values = /* @__PURE__ */ new Map();
        for (let i = 0; i < count; i++) {
          const key = keyType === 1 || keyType === 2 ? readByte(state) === 1 : readCompactValue(state, keyType, depth + 1);
          const value = valueType === 1 || valueType === 2 ? readByte(state) === 1 : readCompactValue(state, valueType, depth + 1);
          values.set(key, value);
        }
        return values;
      }
      case 12:
        return readCompactStruct(state, depth);
      default:
        fail(`unsupported compact-Thrift type ${type}`);
    }
  }
  function compactStruct(bytes, offset = 0) {
    const state = { bytes: asBytes(bytes), offset, entries: 0 };
    const value = readCompactStruct(state, 0);
    return { value, offset: state.offset };
  }
  function validateCompactProtocol(bytes) {
    const input = asBytes(bytes);
    if (input.length > LIMITS.bytes) fail(`footer exceeds ${LIMITS.bytes} bytes`);
    const parsed = compactStruct(input);
    if (parsed.offset !== input.length) fail("unexpected bytes after compact-Thrift structure");
    return parsed.value;
  }
  function validateSchemaElements(elements) {
    if (!Array.isArray(elements) || !elements.length) fail("schema elements are missing");
    const children = (element) => {
      const count = element.field_5 ?? 0;
      if (!Number.isInteger(count) || count < 0 || count > MAX_ENTRIES)
        fail("schema child count exceeds its limit");
      return count;
    };
    const stack = [{ remaining: children(elements[0]), depth: 0 }];
    for (let i = 1; i < elements.length; i++) {
      while (stack.length && stack[stack.length - 1].remaining === 0) stack.pop();
      if (!stack.length) fail("schema contains extra elements");
      const parent = stack[stack.length - 1];
      parent.remaining--;
      const depth = parent.depth + 1;
      if (depth > MAX_DEPTH) fail(`schema nesting exceeds ${MAX_DEPTH} levels`);
      stack.push({ remaining: children(elements[i]), depth });
    }
    while (stack.length && stack[stack.length - 1].remaining === 0) stack.pop();
    if (stack.length) fail("schema is missing child elements");
  }
  function checkedPageCount(value) {
    if (!Number.isInteger(value) || value < 0 || value > LIMITS.cells)
      fail(`page value count exceeds ${LIMITS.cells}`);
  }
  function validatePageChunk(bytes) {
    const input = asBytes(bytes);
    if (input.length > LIMITS.bytes) fail(`column chunk exceeds ${LIMITS.bytes} bytes`);
    const state = { bytes: input, offset: 0, entries: 0 };
    let pages = 0;
    let dataValues = 0;
    while (state.offset < input.length) {
      const header = readCompactStruct(state, 0);
      if (++pages > LIMITS.cells) fail(`column chunk page count exceeds ${LIMITS.cells}`);
      const type = header.field_1;
      const uncompressed = header.field_2;
      const compressed = header.field_3;
      if (!Number.isInteger(uncompressed) || uncompressed < 0 || uncompressed > LIMITS.bytes || !Number.isInteger(compressed) || compressed < 0 || compressed > LIMITS.bytes)
        fail(`page size exceeds ${LIMITS.bytes} bytes`);
      const pageHeader = type === 0 ? header.field_5 : type === 2 ? header.field_7 : type === 3 ? header.field_8 : null;
      if (![0, 1, 2, 3].includes(type)) fail("unknown page type");
      if (type !== 1 && !pageHeader) fail("page is missing its type-specific header");
      if (pageHeader) {
        checkedPageCount(pageHeader.field_1);
        if (type !== 2) {
          dataValues += pageHeader.field_1;
          if (dataValues > LIMITS.cells) fail(`column page values exceed ${LIMITS.cells}`);
        }
        if (type === 3) {
          const levels = pageHeader.field_5 + pageHeader.field_6;
          if (!Number.isInteger(levels) || levels < 0 || levels > uncompressed || levels > compressed)
            fail("invalid v2 page level lengths");
        }
      }
      const end = state.offset + compressed;
      if (end > input.length) fail("page extends past its column chunk");
      state.offset = end;
    }
    if (!pages) fail("column chunk has no pages");
    return pages;
  }
  function magic(bytes, start = 0) {
    return MAGIC.every((value, index) => bytes[start + index] === value);
  }
  function safeInteger(value, label) {
    const result = typeof value === "bigint" ? Number(value) : value;
    if (!Number.isSafeInteger(result) || result < 0) fail(`invalid ${label}`);
    return result;
  }
  function asCount(value, label) {
    if (typeof value !== "bigint" && !Number.isSafeInteger(value)) fail(`invalid ${label}`);
    const result = typeof value === "bigint" ? value : BigInt(value);
    if (result < 0n) fail(`invalid ${label}`);
    return result;
  }
  function minimum(a, b) {
    return a < b ? a : b;
  }
  function utf8Length(text) {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 128) bytes++;
      else if (code < 2048) bytes += 2;
      else if (code >= 55296 && code <= 56319 && i + 1 < text.length && text.charCodeAt(i + 1) >= 56320 && text.charCodeAt(i + 1) <= 57343) {
        bytes += 4;
        i++;
      } else bytes += 3;
    }
    return bytes;
  }
  function boundedText(value) {
    let text = "";
    let clipped = false;
    let visits = 0;
    const append = (item) => {
      if (text.length >= LIMITS.fieldChars) {
        clipped = true;
        return;
      }
      const part = String(item);
      const room = LIMITS.fieldChars - text.length;
      text += part.slice(0, room);
      if (part.length > room) clipped = true;
    };
    const write = (item, depth) => {
      if (text.length >= LIMITS.fieldChars) {
        clipped = true;
        return;
      }
      if (depth > MAX_DEPTH || ++visits > MAX_ENTRIES) {
        append("\u2026");
        clipped = true;
        return;
      }
      if (item === null || item === void 0) return;
      if (typeof item === "string") {
        append(depth ? JSON.stringify(item) : item);
        return;
      }
      if (typeof item === "number" || typeof item === "bigint" || typeof item === "boolean") {
        append(item);
        return;
      }
      if (item instanceof Date) {
        append(Number.isNaN(item.getTime()) ? "Invalid date" : item.toISOString());
        return;
      }
      if (item instanceof Uint8Array || item instanceof ArrayBuffer) {
        append(`[binary ${item.byteLength} bytes]`);
        return;
      }
      if (Array.isArray(item)) {
        append("[");
        for (let i = 0; i < item.length && text.length < LIMITS.fieldChars; i++) {
          if (i) append(", ");
          write(item[i], depth + 1);
        }
        if (item.length && text.length >= LIMITS.fieldChars) clipped = true;
        append("]");
        return;
      }
      if (typeof item === "object") {
        append("{");
        let index = 0;
        for (const key in item) {
          if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
          if (text.length >= LIMITS.fieldChars) {
            clipped = true;
            break;
          }
          if (index++) append(", ");
          append(`${JSON.stringify(String(key).slice(0, LIMITS.fieldChars))}:`);
          write(item[key], depth + 1);
        }
        append("}");
        return;
      }
      append(String(item));
    };
    write(value, 0);
    return { text, clipped };
  }
  function normalizeRange(bytes, start, end) {
    const input = asBytes(bytes);
    if (input.length !== end - start) fail("range reader returned a short read");
    return new Uint8Array(input);
  }
  async function parquetPreview({ size, readRange, isCancelled = () => false }) {
    if (!Number.isSafeInteger(size) || size < 12) fail("file is too short");
    if (typeof readRange !== "function") fail("range reader unavailable");
    const cache = [];
    let fetched = 0;
    let displayBytes = 0;
    const checkCancelled = () => {
      if (isCancelled()) fail("cancelled");
    };
    const getRange = async (start, end) => {
      checkCancelled();
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > size)
        fail("requested byte range is outside the file");
      const existing = cache.find((range) => range.start <= start && range.end >= end);
      if (existing) return existing.bytes.subarray(start - existing.start, end - existing.start);
      const length = end - start;
      if (length > LIMITS.bytes || fetched + length > LIMITS.bytes)
        fail(`fetched-byte limit of ${LIMITS.bytes} bytes exceeded`);
      const bytes = normalizeRange(await readRange(start, end), start, end);
      checkCancelled();
      fetched += length;
      cache.push({ start, end, bytes });
      return bytes;
    };
    try {
      const head = await getRange(0, 4);
      if (!magic(head)) fail("leading magic bytes do not match PAR1");
      const trailer = await getRange(size - 8, size);
      if (!magic(trailer, 4)) fail("footer magic bytes do not match PAR1");
      const footerLength = new DataView(trailer.buffer, trailer.byteOffset, trailer.byteLength).getUint32(0, true);
      if (footerLength > LIMITS.bytes || footerLength > size - 12)
        fail(`footer length exceeds the available ${LIMITS.bytes}-byte limit`);
      const footerStart = size - 8 - footerLength;
      const footer = await getRange(footerStart, size - 8);
      const rawMetadata = validateCompactProtocol(footer);
      validateSchemaElements(rawMetadata.field_2);
      const metadataBuffer = new Uint8Array(footerLength + 8);
      metadataBuffer.set(footer);
      metadataBuffer.set(trailer, footerLength);
      const metadata = parquetMetadata(metadataBuffer.buffer, { geoparquet: false });
      const totalRows = asCount(metadata.num_rows, "metadata row count");
      const schema = parquetSchema(metadata);
      const allNames = schema.children.map((child) => child.element.name);
      if (allNames.some((name) => typeof name !== "string" || !name.length)) fail("schema contains an empty column name");
      if (new Set(allNames).size !== allNames.length) fail("schema contains duplicate top-level column names");
      const headers = allNames.slice(0, Math.min(MAX_COLUMNS, LIMITS.columns));
      const rowCap = Math.min(MAX_ROWS, LIMITS.tableRows, Math.floor(LIMITS.cells / Math.max(1, headers.length)));
      const requestedRows2 = Number(minimum(totalRows, BigInt(rowCap)));
      const groups = metadata.row_groups;
      let groupTotal = 0n;
      const selectedGroups = [];
      let remaining = BigInt(requestedRows2);
      for (const group of groups) {
        const count = asCount(group.num_rows, "row-group count");
        groupTotal += count;
        if (remaining > 0n && count > 0n) {
          selectedGroups.push(group);
          remaining -= minimum(count, remaining);
        }
      }
      if (groupTotal !== totalRows || remaining > 0n) fail("row-group counts do not match footer metadata");
      const rows = Array.from({ length: requestedRows2 }, () => Array(headers.length).fill(""));
      const truncatedFields = /* @__PURE__ */ new Map();
      let truncatedHeader = false;
      const retain = (value, row, column) => {
        const formatted = boundedText(value);
        displayBytes += utf8Length(formatted.text);
        if (displayBytes > LIMITS.bytes) fail(`display text limit of ${LIMITS.bytes} bytes exceeded`);
        if (formatted.clipped) {
          const clipped = truncatedFields.get(row) ?? [];
          clipped.push(column);
          truncatedFields.set(row, clipped);
        }
        return formatted.text;
      };
      for (let c = 0; c < headers.length; c++) {
        const formatted = boundedText(headers[c]);
        if (formatted.clipped) truncatedHeader = true;
        displayBytes += utf8Length(formatted.text);
        if (displayBytes > LIMITS.bytes) fail(`display text limit of ${LIMITS.bytes} bytes exceeded`);
        headers[c] = formatted.text;
      }
      const rangeFile = {
        byteLength: size,
        async slice(start, end = size) {
          const bytes = await getCachedRange(start, end);
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        }
      };
      async function getCachedRange(start, end) {
        checkCancelled();
        const range = cache.find((item) => item.start <= start && item.end >= end);
        if (!range) fail("reader requested an unvalidated Parquet range");
        return range.bytes.subarray(start - range.start, end - range.start);
      }
      const guardedCompressors = Object.fromEntries(Object.entries(compressors).map(([codec, decompress2]) => [
        codec,
        (input, outputLength) => {
          if (!Number.isSafeInteger(outputLength) || outputLength < 0 || outputLength > LIMITS.bytes || input.length > LIMITS.bytes)
            fail(`decompressed page exceeds ${LIMITS.bytes} bytes`);
          const output = codec === "ZSTD" ? decompress(input, new Uint8Array(outputLength)) : decompress2(input, outputLength);
          if (!(output instanceof Uint8Array) || output.length !== outputLength)
            fail("decompressed page length does not match its header");
          return output;
        }
      ]));
      for (let c = 0; c < headers.length; c++) {
        checkCancelled();
        const name = allNames[c];
        for (const group of selectedGroups) {
          const leaves = group.columns.filter((column) => column.meta_data?.path_in_schema?.[0] === name);
          if (!leaves.length) fail(`column chunk not found for ${name}`);
          for (const column of leaves) {
            if (column.file_path) fail("external Parquet column files are unsupported");
            const details = column.meta_data;
            const offsets = [details.dictionary_page_offset, details.data_page_offset].filter((value) => value !== void 0).map((value) => safeInteger(value, "column page offset"));
            if (!offsets.length) fail(`column page offset is missing for ${name}`);
            const start = Math.min(...offsets);
            const length = safeInteger(details.total_compressed_size, "compressed column size");
            const end = start + length;
            if (start < 4 || !Number.isSafeInteger(end) || end > footerStart || end < start)
              fail("column byte range is outside the data section");
            validatePageChunk(await getRange(start, end));
          }
        }
        const seen = new Uint8Array(requestedRows2);
        let callbackError = null;
        await parquetRead({
          file: rangeFile,
          metadata,
          columns: [name],
          rowStart: 0,
          rowEnd: requestedRows2,
          compressors: guardedCompressors,
          onChunk(chunk) {
            if (callbackError) return;
            try {
              if (chunk.columnName !== name) fail("unexpected column in Parquet decoder");
              const start = safeInteger(chunk.rowStart, "decoded row start");
              if (start + chunk.columnData.length > requestedRows2) fail("decoder returned rows outside the sample");
              for (let i = 0; i < chunk.columnData.length; i++) {
                const row = start + i;
                if (seen[row]) fail("decoder returned duplicate sampled rows");
                seen[row] = 1;
                rows[row][c] = retain(chunk.columnData[i], row, c);
              }
            } catch (error) {
              callbackError = error;
            }
          }
        });
        checkCancelled();
        if (callbackError) throw callbackError;
        if (seen.some((value) => value !== 1)) fail(`decoder returned an incomplete sample for ${name}`);
      }
      const shown = rows.length;
      const notes = [
        `First stored rows shown: ${shown} in file order; this is not a random or representative sample.`,
        `Footer metadata reports ${totalRows} rows. Only the footer and displayed column pages were read; the complete file was not validated.`
      ];
      if (allNames.length > headers.length) notes.push(`Only the first ${headers.length} of ${allNames.length} columns are shown.`);
      return {
        kind: "Apache Parquet",
        headers,
        rows,
        notes,
        clippedColumns: allNames.length > headers.length,
        clippedFields: truncatedFields.size > 0,
        truncatedFields,
        truncatedHeader,
        rowLimit: totalRows > BigInt(shown),
        cellLimited: LIMITS.tableRows < LIMITS.rows
      };
    } finally {
      cache.length = 0;
    }
  }
  return __toCommonJS(parquet_core_exports);
})();

const shortText = value => String(value ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 180);
function queryInfoAsync(file, cancellable) {
    return new Promise((resolve, reject) => file.query_info_async('standard::size', Gio.FileQueryInfoFlags.NONE,
        GLib.PRIORITY_DEFAULT, cancellable, (f, result) => {
            try { resolve(f.query_info_finish(result)); } catch (error) { reject(error); }
        }));
}
function openReadAsync(file, cancellable) {
    return new Promise((resolve, reject) => file.read_async(GLib.PRIORITY_DEFAULT, cancellable, (f, result) => {
        try { resolve(f.read_finish(result)); } catch (error) { reject(error); }
    }));
}
function readBytesAsync(input, count, cancellable) {
    return new Promise((resolve, reject) => input.read_bytes_async(count, GLib.PRIORITY_DEFAULT, cancellable,
        (stream, result) => {
            try { resolve(stream.read_bytes_finish(result)); } catch (error) { reject(error); }
        }));
}
var Klass = GObject.registerClass({
    Implements: [Renderer.Renderer],
    Properties: {
        fullscreen: GObject.ParamSpec.boolean('fullscreen', '', '', GObject.ParamFlags.READABLE, false),
        ready: GObject.ParamSpec.boolean('ready', '', '', GObject.ParamFlags.READABLE, false),
    },
}, class LabTable extends Gtk.Box {
    get ready() { return !!this._ready; }
    get fullscreen() { return false; }
    get moveOnClick() { return false; }
    _init(file) {
        super._init({orientation: Gtk.Orientation.VERTICAL, spacing: 1, border_width: 3, visible: true});
        this._file = file;
        this._name = file.get_basename(); this._format = formatFromName(this._name);
        this._cancellable = new Gio.Cancellable();
        this._sortColumn = null; this._descending = false;
        this.connect('destroy', () => this._cancellable.cancel());
        this._build(); this._load();
    }
    _build() {
        this._hint = new Gtk.Label({label: '', xalign: 1, visible: true,
            halign: Gtk.Align.END, ellipsize: Pango.EllipsizeMode.END, max_width_chars: 120,
            margin_end: 8});
        this._hint.set_tooltip_text('The preview reads only bounded file data.');
        this.pack_start(this._hint, false, false, 0);
        this._scroll = new Gtk.ScrolledWindow({visible: true, hexpand: true, vexpand: true,
            min_content_width: 960, min_content_height: 560,
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC});
        this.pack_start(this._scroll, true, true, 0);
        this.show_all();
        this._hint.hide();
    }
    _readyNow() { if (!this._ready) { this._ready = true; this.isReady(); } }
    _message(s) {
        this._hint.hide();
        if (this._scroll.get_child()) this._scroll.remove(this._scroll.get_child());
        this._scroll.add(new Gtk.Label({label: String(s), visible: true, xalign: 0}));
        this._scroll.show_all();
    }
    _load() {
        if (this._format === 'parquet') { this._loadParquet(); return; }
        this._file.read_async(GLib.PRIORITY_DEFAULT, this._cancellable, (f, res) => {
            let stream;
            try { stream = f.read_finish(res); } catch (e) {
                if (!this._cancellable.is_cancelled()) { this._message(e.message); this._readyNow(); }
                return;
            }
            let count = 0; const chunks = []; let eof = false;
            const binary = this._format === 'h5ad';
            const limit = binary ? 64 : LIMITS.bytes;
            const finish = () => {
                try { stream.close(null); } catch (_) {}
                const bytes = new Uint8Array(count); let pos = 0;
                for (const chunk of chunks) { bytes.set(chunk, pos); pos += chunk.length; }
                if (binary) {
                    const info = binaryPreview(this._name, bytes, count);
                    this._message(`${info.kind}\n${info.message}`);
                } else {
                    this._text = ByteArray.toString(bytes);
                    this._partial = !eof; this._parse();
                }
                this._readyNow();
            };
            const next = () => {
                if (this._cancellable.is_cancelled()) { try { stream.close(null); } catch (_) {} return; }
                if (count >= limit) { finish(); return; }
                stream.read_bytes_async(Math.min(131072, limit - count), GLib.PRIORITY_DEFAULT, this._cancellable,
                    (input, result) => {
                        try {
                            const b = input.read_bytes_finish(result);
                            if (this._cancellable.is_cancelled()) { try { input.close(null); } catch (_) {} return; }
                            if (!b.get_size()) { eof = true; finish(); return; }
                            const chunk = b.get_data(); chunks.push(chunk); count += chunk.length; next();
                        } catch (e) {
                            try { input.close(null); } catch (_) {}
                            if (!this._cancellable.is_cancelled()) { this._message(e.message); this._readyNow(); }
                        }
                    });
            };
            next();
        });
    }
    async _loadParquet() {
        let input;
        try {
            const info = await queryInfoAsync(this._file, this._cancellable);
            const size = Number(info.get_size());
            input = await openReadAsync(this._file, this._cancellable);
            if (!input.can_seek()) throw new Error('Parquet preview requires a seekable file');
            const readRange = async (start, end) => {
                if (this._cancellable.is_cancelled()) throw new Error('Parquet preview cancelled');
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start ||
                    end > size || end - start > LIMITS.bytes)
                    throw new Error('Parquet byte range is outside the file or preview limit');
                input.seek(start, GLib.SeekType.SET, this._cancellable);
                const bytes = new Uint8Array(end - start);
                let offset = 0;
                while (offset < bytes.length) {
                    if (this._cancellable.is_cancelled()) throw new Error('Parquet preview cancelled');
                    const part = await readBytesAsync(input, Math.min(131072, bytes.length - offset), this._cancellable);
                    const data = part.get_data();
                    if (!data.length) throw new Error('Unexpected end of file in Parquet range');
                    bytes.set(data, offset);
                    offset += data.length;
                }
                if (this._cancellable.is_cancelled()) throw new Error('Parquet preview cancelled');
                return bytes;
            };
            this._table = await ParquetSupport.parquetPreview({size, readRange,
                isCancelled: () => this._cancellable.is_cancelled()});
            if (this._cancellable.is_cancelled()) return;
            this._types = guessTypes(this._table.rows, this._table.headers.length, this._table.headers);
            this._draw();
        } catch (error) {
            if (!this._cancellable.is_cancelled()) this._message(`Preview unavailable: ${error.message}`);
        } finally {
            try { input?.close(null); } catch (_) {}
            if (!this._cancellable.is_cancelled()) this._readyNow();
        }
    }
    _parse() {
        const genomic = genomicPreview(this._name, this._text, this._partial);
        this._table = genomic ? {...genomic, truncatedRows: genomic.rowLimit, truncatedBytes: this._partial,
            clippedColumns: genomic.colLimit} : prepareTable(this._text, detectSeparator(this._text, this._name), true, this._partial);
        this._types = guessTypes(this._table.rows, this._table.headers.length, this._table.headers);
        this._draw();
    }
    _draw() {
        const {headers, rows} = this._table;
        const status = previewStatus(this._table);
        const notes = this._table.notes ?? [];
        const summary = [this._table.kind, notes[0], status.label]
            .filter(Boolean).join(' · ');
        this._hint.set_text(summary);
        this._hint.set_tooltip_text([notes.join('\n'), status.tooltip]
            .filter(Boolean).join('\n'));
        this._hint.set_visible(!!summary);
        if (!headers.length) { this._message('No table columns detected'); return; }
        const widths = columnWidthHints(headers, rows, this._types);
        try {
            const store = new Gtk.ListStore();
            store.set_column_types([GObject.TYPE_STRING, ...headers.map(() => GObject.TYPE_STRING)]);
            this._store = store;
            const populate = () => {
                store.clear();
                const sorted = sortRows(rows, this._sortColumn, this._descending, this._types);
                this._displayRows = sorted;
                sorted.forEach(({cells, originalIndex}) => {
                    const iter = store.append();
                    store.set_value(iter, 0, String(originalIndex + 1));
                    for (let c = 0; c < headers.length; c++)
                        store.set_value(iter, c + 1, shortText(cells[c]));
                });
            };
            populate();
            const view = new Gtk.TreeView({model: store, visible: true,
                headers_visible: true, enable_search: false,
                enable_grid_lines: Gtk.TreeViewGridLines.HORIZONTAL});
            this._view = view;
            const gutterRenderer = new Gtk.CellRendererText({xalign: 1, xpad: 2, ypad: 3});
            const gutter = new Gtk.TreeViewColumn({title: '#', resizable: false, sizing: Gtk.TreeViewColumnSizing.FIXED});
            gutter.pack_start(gutterRenderer, true);
            gutter.add_attribute(gutterRenderer, 'text', 0);
            gutter.set_fixed_width(42);
            view.append_column(gutter);
            for (let col = 0; col < headers.length; col++) {
                const numeric = this._types[col] === 'number';
                const renderer = new Gtk.CellRendererText({ellipsize: Pango.EllipsizeMode.END,
                    xalign: numeric ? 1 : 0,
                    xpad: 8, ypad: 4});
                const column = new Gtk.TreeViewColumn({title: String(headers[col]).slice(0, 55),
                    resizable: true, expand: !numeric, clickable: true,
                    min_width: Math.min(widths[col], 100)});
                column.pack_start(renderer, true);
                column.add_attribute(renderer, 'text', col + 1);
                column.set_fixed_width(widths[col]);
                column.connect('clicked', () => {
                    if (this._sortColumn !== col) { this._sortColumn = col; this._descending = false; }
                    else if (!this._descending) this._descending = true;
                    else this._sortColumn = null;
                    populate();
                });
                view.append_column(column);
            }
            view.connect('button-press-event', (_view, event) => {
                if (event.button !== Gdk.BUTTON_SECONDARY) return false;
                const hit = view.get_path_at_pos(Math.floor(event.x), Math.floor(event.y));
                if (!hit || !hit[0]) return false;
                const [path, column] = hit;
                view.get_selection().select_path(path);
                const row = this._rowAtPath(path);
                if (!row) return false;
                const dataColumn = view.get_columns().indexOf(column) - 1;
                const menu = new Gtk.Menu();
                if (dataColumn >= 0) {
                    const area = view.get_cell_area(path, column);
                    const active = {value: String(row.cells[dataColumn] ?? ''),
                        cells: row.cells.map(value => String(value ?? '')),
                        row: row.originalIndex, column: dataColumn,
                        anchor: {x: area.x, y: area.y, width: area.width, height: area.height}};
                    for (const [label, callback] of [
                        ['Copy cell value', () => this._copyText(active.value)],
                        ['Copy row as TSV', () => this._copyText(rowToTsv(active.cells))],
                        ['Inspect value', () => this._inspectValue(active)],
                    ]) {
                        const item = new Gtk.MenuItem({label});
                        item.connect('activate', callback);
                        menu.append(item);
                    }
                } else {
                    const item = new Gtk.MenuItem({label: 'Copy row as TSV'});
                    item.connect('activate', () => this._copyText(rowToTsv(row.cells)));
                    menu.append(item);
                }
                menu.show_all();
                menu.popup_at_pointer(event);
                return true;
            });
            view.connect('row-activated', (_view, path, column) => {
                const dataColumn = view.get_columns().indexOf(column) - 1;
                const row = this._rowAtPath(path);
                if (row && dataColumn >= 0) {
                    const area = view.get_cell_area(path, column);
                    this._inspectValue({value: String(row.cells[dataColumn] ?? ''),
                        row: row.originalIndex, column: dataColumn,
                        anchor: {x: area.x, y: area.y, width: area.width, height: area.height}});
                }
            });
            view.connect('key-press-event', (_view, event) => {
                if ((event.state & Gdk.ModifierType.CONTROL_MASK) && event.keyval === Gdk.KEY_c) {
                    const [model, iter] = view.get_selection().get_selected();
                    if (iter) {
                        const path = model.get_path(iter);
                        const row = this._rowAtPath(path);
                        if (row) { this._copyText(rowToTsv(row.cells)); return true; }
                    }
                }
                return false;
            });
            if (this._scroll.get_child()) this._scroll.remove(this._scroll.get_child());
            this._scroll.add(view);
            this._scroll.show_all();
        } catch (e) {
            logError(e);
            // Small, robust fallback when a GTK3 binding is missing.
            const text = [headers.join('\t'), ...rows.map(c => c.join('\t'))].join('\n');
            const buffer = new Gtk.TextBuffer(); buffer.set_text(text, -1);
            const view = new Gtk.TextView({buffer, editable: false, monospace: true,
                wrap_mode: Gtk.WrapMode.NONE, visible: true});
            if (this._scroll.get_child()) this._scroll.remove(this._scroll.get_child());
            this._scroll.add(view); this._scroll.show_all();
        }
    }
    _rowAtPath(path) {
        const index = path.get_indices()[0];
        return Number.isInteger(index) ? this._displayRows[index] ?? null : null;
    }
    _copyText(text) {
        if (text !== undefined && text !== null)
            Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text(String(text), -1);
    }
    _inspectValue(active) {
        if (!active) return;
        if (this._inspectPopover) {
            const previous = this._inspectPopover;
            this._inspectPopover = null;
            previous.destroy();
        }
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6,
            margin: 8, visible: true});
        const status = new Gtk.Label({label: cellValueStatus(this._table, active.row, active.column),
            xalign: 0, wrap: true, visible: true});
        const buffer = new Gtk.TextBuffer(); buffer.set_text(active.value, -1);
        const text = new Gtk.TextView({buffer, editable: false, cursor_visible: true,
            monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR, visible: true});
        const scroll = new Gtk.ScrolledWindow({visible: true, min_content_width: 280,
            max_content_width: 520, min_content_height: 80, max_content_height: 280});
        scroll.add(text);
        const copy = new Gtk.Button({label: 'Copy value', halign: Gtk.Align.END, visible: true});
        copy.connect('clicked', () => this._copyText(active.value));
        box.pack_start(status, false, false, 0); box.pack_start(scroll, true, true, 0);
        box.pack_start(copy, false, false, 0);
        const popover = Gtk.Popover.new(this._view);
        popover.add(box); popover.set_pointing_to(new Gdk.Rectangle(active.anchor));
        this._inspectPopover = popover;
        popover.connect('closed', () => {
            if (this._inspectPopover === popover) this._inspectPopover = null;
            popover.destroy();
        });
        popover.show_all(); popover.popup();
    }
});
var mimeTypes = [
    'text/tab-separated-values','text/csv','text/x-csv','application/csv','application/tab-separated-values',
    'text/x-sushi-bed','text/x-sushi-vcf','text/x-sushi-mtx','text/x-sushi-gff',
    'application/x-sushi-h5ad','application/x-sushi-parquet','application/vnd.apache.parquet',
    'application/x-parquet','text/x-bed','text/x-gff3',
];
