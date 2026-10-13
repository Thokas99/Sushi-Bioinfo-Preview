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

export const LIMITS = Object.freeze({
    bytes: previewLimit('SUSHI_BIOINFO_MAX_MIB', 16, 1, 64) * 1024 * 1024,
    rows: previewLimit('SUSHI_BIOINFO_MAX_ROWS', 10000, 100, 25000),
    columns: previewLimit('SUSHI_BIOINFO_MAX_COLUMNS', 128, 8, 256),
    fieldChars: 512,
});

export function parseDelimited(text, separator, options = {}) {
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
    let hitRowLimit = false;
    let startOfField = true;

    const append = ch => {
        if (field.length < fieldChars)
            field += ch;
        else
            clippedFields = true;
    };
    const flushField = () => {
        if (fullCols < colLimit) row.push(field);
        else clippedColumns = true;
        fullCols++;
        field = '';
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
        rows, widths, clippedColumns, clippedFields, hitRowLimit,
        droppedPartial: unfinished && !keepPartial,
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
        keepPartial: !partialByteRead,
    });
    const all = parsed.rows;
    const originalHeaders = hasHeader ? (all.shift() ?? []) : [];
    const rows = all.slice(0, LIMITS.rows);
    const cols = Math.min(LIMITS.columns, Math.max(0, originalHeaders.length, ...rows.map(row => row.length)));
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
    return {
        headers, rows, separator, hasHeader,
        truncatedRows: parsed.hitRowLimit || all.length > LIMITS.rows || (partialByteRead && parsed.droppedPartial),
        truncatedBytes: partialByteRead,
        clippedFields: parsed.clippedFields,
        clippedColumns: parsed.clippedColumns,
        raggedRows: parsed.widths.filter(w => w !== cols).length,
        quoteWarning: parsed.unterminatedQuote && !partialByteRead,
    };
}

export function isMissing(v) {
    if (v === undefined || v === null) return true;
    const s = v.trim();
    return s === '' || /^(NA|N\/A|NULL|NONE|NAN)$/i.test(s);
}

export function numericValue(v) {
    if (isMissing(v)) return null;
    const x = v.trim();
    if (!/^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(x)) return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
}

export function compareCells(left, right, type, leftIndex = 0, rightIndex = 0, descending = false) {
    const aMissing = isMissing(left), bMissing = isMissing(right);
    if (aMissing && bMissing) return leftIndex - rightIndex;
    if (aMissing) return 1;
    if (bMissing) return -1;
    let diff;
    if (type === 'number') {
        const a = numericValue(left), b = numericValue(right);
        diff = a === null || b === null ? left.localeCompare(right) : a - b;
    } else diff = left.localeCompare(right, undefined, {numeric: true});
    return diff === 0 ? leftIndex - rightIndex : (descending ? -diff : diff);
}

export function guessTypes(rows, count) {
    return Array.from({length: count}, (_, col) => {
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
            types[sortColumn], a.originalIndex, b.originalIndex, descending));
    return sorted;
}

/** Suggest legible pixel widths from bounded sample data, without creating GTK widgets.
 * Columns are allowed to expand to use spare preview width.
 */
export function columnWidthHints(headers, rows, types = []) {
    return headers.map((header, col) => {
        let longest = Math.min(40, String(header).length);
        // Scan no more than 64 sample rows; do not infer widths from entire files.
        for (const row of rows.slice(0, 64)) {
            const length = String(row[col] ?? '').replace(/[\r\n\t]/g, ' ').length;
            longest = Math.max(longest, Math.min(length, 40));
        }
        // Numeric values tend to require narrower cells. Keep a readable header.
        const minimum = types[col] === 'number' ? 84 : 94;
        return Math.max(minimum, Math.min(280, Math.round(longest * 7.4 + 24)));
    });
}
