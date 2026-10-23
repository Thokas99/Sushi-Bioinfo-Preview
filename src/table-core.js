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
const requestedRows = previewLimit('SUSHI_BIOINFO_MAX_ROWS', 25000, 100, 25000);
const columns = previewLimit('SUSHI_BIOINFO_MAX_COLUMNS', 256, 8, 256);
const tableRows = Math.min(requestedRows, Math.floor(MAX_TABLE_CELLS / columns));

export const LIMITS = Object.freeze({
    bytes: previewLimit('SUSHI_BIOINFO_MAX_MIB', 64, 1, 64) * 1024 * 1024,
    rows: requestedRows,
    tableRows,
    columns,
    cells: MAX_TABLE_CELLS,
    tableCellLimitActive: tableRows < requestedRows,
    fieldChars: 512,
});

export function parseDelimited(text, separator, options = {}) {
    const rowLimit = options.maxRows ?? LIMITS.rows + 1;
    const colLimit = options.maxColumns ?? LIMITS.columns;
    const keepPartial = options.keepPartial ?? false;
    const fieldChars = options.fieldChars ?? LIMITS.fieldChars;
    const maxCells = options.maxCells ?? Infinity;
    const rows = [];
    const widths = [];
    let cells = 0;
    let row = [];
    let field = '';
    let fullCols = 0;
    let inQuotes = false;
    let clippedColumns = false;
    let clippedFields = false;
    const clippedFieldColumns = new Map();
    let fieldClipped = false;
    let hitRowLimit = false;
    let hitCellLimit = false;
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
        if (cells + row.length > maxCells) {
            hitCellLimit = true;
            return;
        }
        rows.push(row);
        widths.push(fullCols);
        cells += row.length;
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
            if (hitCellLimit) break;
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
    if (unfinished && rows.length < rowLimit && keepPartial && !inQuotes && !hitCellLimit) flushRow();
    return {
        rows, widths, clippedColumns, clippedFields, clippedFieldColumns, hitRowLimit, hitCellLimit,
        droppedPartial: unfinished && !keepPartial && !hitCellLimit,
        unterminatedQuote: inQuotes,
    };
}

export function detectSeparator(text, extension = '') {
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

export function prepareTable(text, separator, hasHeader = true, partialByteRead = false) {
    const parsed = parseDelimited(text, separator, {
        maxRows: LIMITS.rows + (hasHeader ? 2 : 1),
        maxColumns: LIMITS.columns,
        maxCells: LIMITS.cells,
        keepPartial: !partialByteRead,
    });
    const all = parsed.rows;
    const originalHeaders = hasHeader ? (all.shift() ?? []) : [];
    const parsedRowCount = all.length;
    if (all.length > LIMITS.rows) all.length = LIMITS.rows;
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
        truncatedRows: parsed.hitRowLimit || parsed.hitCellLimit || parsedRowCount > LIMITS.rows,
        truncatedBytes: partialByteRead,
        clippedFields: truncatedHeader || truncatedFields.size > 0,
        truncatedHeader,
        truncatedFields,
        clippedColumns: parsed.clippedColumns,
        incompleteRecord: partialByteRead && parsed.droppedPartial,
        raggedRows,
        cellLimited: parsed.hitCellLimit,
        quoteWarning: parsed.unterminatedQuote && !partialByteRead,
    };
}

export function isMissing(v) {
    if (v === undefined || v === null) return true;
    const s = v.trim();
    return s === '' || s === '.' || /^(NA|N\/A|NULL|NONE|NAN)$/i.test(s);
}

export function numericValue(v) {
    if (isMissing(v)) return null;
    const x = v.trim();
    if (!/^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(x)) return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
}

export function compareCells(left, right, type, descending = false) {
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

export function guessTypes(rows, count, headers = []) {
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

export function sortRows(rows, sortColumn, descending, types) {
    const sorted = rows.map((cells, originalIndex) => ({cells, originalIndex}));
    if (sortColumn !== null && sortColumn >= 0)
        sorted.sort((a, b) => compareCells(a.cells[sortColumn] ?? '', b.cells[sortColumn] ?? '',
            types[sortColumn], descending));
    return sorted;
}

/** Suggest legible pixel widths from bounded sample data, without creating GTK widgets.
 * Columns are allowed to expand to use spare preview width.
 */
export function columnWidthHints(headers, rows, types = []) {
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

export function rowToTsv(cells) {
    return cells.map(value => {
        const text = String(value ?? '');
        return /[\t"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join('\t');
}

export function cellValueStatus(table, row, column) {
    if (table.truncatedFields?.get(row)?.includes(column))
        return `Field truncated to ${LIMITS.fieldChars} characters by the preview.`;
    if (table.incompleteRecord)
        return 'The file prefix ended inside a record; the trailing partial record was omitted.';
    return 'Complete field retained within the sampled input.';
}

export function previewStatus(table) {
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
