/* Sushi Bioinfo Preview — native GTK4 table. SPDX-License-Identifier: MIT */
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import {Renderer, ResizePolicy} from 'resource://org/gnome/NautilusPreviewer/plugin-api-1.js';
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

const LIMITS = Object.freeze({
    bytes: previewLimit('SUSHI_BIOINFO_MAX_MIB', 16, 1, 64) * 1024 * 1024,
    rows: previewLimit('SUSHI_BIOINFO_MAX_ROWS', 10000, 100, 25000),
    columns: previewLimit('SUSHI_BIOINFO_MAX_COLUMNS', 128, 8, 256),
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
        maxRows: LIMITS.rows + (hasHeader ? 2 : 1),
        maxColumns: LIMITS.columns,
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
    return {
        headers, rows, separator, hasHeader,
        truncatedRows: parsed.hitRowLimit || parsedRowCount > LIMITS.rows,
        truncatedBytes: partialByteRead,
        clippedFields: truncatedHeader || truncatedFields.size > 0,
        truncatedHeader,
        truncatedFields,
        clippedColumns: parsed.clippedColumns,
        incompleteRecord: partialByteRead && parsed.droppedPartial,
        raggedRows: parsed.widths.filter(w => w !== cols).length,
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
    if (table.clippedColumns) messages.push(`Only the first ${LIMITS.columns} columns are shown.`);
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
    for (let index = 0; index < Math.min(lines.length, LIMITS.rows); index++)
        rows.push(trimDelimited(lines[index], columns, truncatedFields, index));
    let nc = kind === 'BED intervals' ? 3 : headers.length;
    for (const row of rows) nc = Math.max(nc, row.length);
    nc = Math.min(LIMITS.columns, nc);
    const names = Array.from({length: nc}, (_, i) => headers[i] || `Column ${i + 1}`);
    return {kind, headers: names, rows, notes, truncatedFields,
        clippedFields: truncatedFields.size > 0, truncatedHeader: false,
        incompleteRecord, truncatedBytes: partial || lineLimit,
        truncatedRows: lines.length > LIMITS.rows || lineLimit,
        rowLimit: lines.length > LIMITS.rows || lineLimit,
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
        const records = cleanRows(lines, x => x.startsWith('#'), LIMITS.rows + 1);
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
        const records = cleanRows(lines, x => /^(#|track\b|browser\b)/i.test(x), LIMITS.rows + 1);
        return result('BED intervals', headers, records, LIMITS.columns,
            ['BED starts are 0-based; ends are exclusive', 'Columns are positional; additional columns are generic'],
            incompleteRecord, lineLimit, partial);
    }
    if (kind === 'gff') {
        const headers = ['seqid','source','type','start','end','score','strand','phase','attributes'];
        const fastaStart = lines.findIndex(x => x.startsWith('##FASTA'));
        const annotationLines = fastaStart >= 0 ? lines.slice(0, fastaStart) : lines;
        const records = cleanRows(annotationLines, x => x.startsWith('#'), LIMITS.rows + 1);
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

Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');

// A CSS-scoped data table: no changes to Sushi's window, titlebar or other previews.
try {
    const css = new Gtk.CssProvider();
    css.load_from_data(`
        .bioinfo-table label { padding: 5px 8px; }
        .bioinfo-table .row-number { padding: 2px 3px; }
        .bioinfo-table .numeric { font-feature-settings: "tnum"; }
        .bioinfo-table columnview { border: none; }
        .bioinfo-table .dim-label { font-size: 11px; }
    `);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
} catch (e) { console.warn(`Bioinfo table CSS unavailable: ${e}`); }

// Rows are GObjects because Gio.ListStore and Gtk.ColumnView expect a GListModel.
const TableItem = GObject.registerClass(class TableItem extends GObject.Object {
    constructor(cells, recordIndex) {
        super();
        this.cells = cells;
        this.recordIndex = recordIndex;
    }
});

async function readHead(file, cancellable, limit) {
    const input = await file.read_async(GLib.PRIORITY_DEFAULT, cancellable);
    let total = 0, eof = false;
    const chunks = [];
    try {
        while (total < limit) {
            const b = await input.read_bytes_async(Math.min(131072, limit - total),
                GLib.PRIORITY_DEFAULT, cancellable);
            if (!b.get_size()) { eof = true; break; }
            const chunk = b.get_data();
            chunks.push(chunk); total += chunk.length;
        }
    } finally { try { input.close(null); } catch (_) {} }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return {bytes, text: new TextDecoder('utf-8').decode(bytes), eof};
}

export const Klass = class LabTable extends Adw.Bin {
    static { GObject.registerClass({Implements: [Renderer]}, this); }
    constructor(file, info, props = {}) {
        super(props);
        this._name = file.get_basename();
        this._size = Number(info?.get_size?.() ?? 0);
        this._format = formatFromName(this._name);
        this._makeUI();
        this._load(file).catch(e => {
            if (this.cancellable.is_cancelled()) return;
            console.error(`Bioinfo preview: ${e}`);
            this._showMessage(`Preview unavailable: ${e.message}`);
            this.markReady();
        });
    }
    get resizePolicy() { return ResizePolicy.NAT_SIZE; }
    get topBarStyle() { return Adw.ToolbarStyle.FLAT; }
    cleanup() {
        this.cancellable.cancel();
        const menu = this._menuPopover; this._menuPopover = null;
        const inspect = this._inspectPopover; this._inspectPopover = null;
        menu?.popdown(); menu?.unparent();
        inspect?.popdown(); inspect?.unparent();
        this._activeCell = null; this._table = null; this._types = null; this._store = null;
        this._view = null;
        this._scroll.set_child(null);
    }

    _makeUI() {
        const root = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 0,
            margin_top: 2, margin_bottom: 2, margin_start: 3, margin_end: 3,
            hexpand: true, vexpand: true});
        root.add_css_class('bioinfo-table');
        this.set_child(root);
        // Small sample indicator, no search, pagination or redundant toolbar.
        this._hint = new Gtk.Label({label: '', visible: false, xalign: 1, halign: Gtk.Align.END,
            ellipsize: Pango.EllipsizeMode.END, max_width_chars: 120,
            margin_end: 7, margin_bottom: 2});
        this._hint.add_css_class('dim-label');
        this._hint.set_tooltip_text('The preview reads a bounded prefix of the file.');
        root.append(this._hint);
        this._scroll = new Gtk.ScrolledWindow({hexpand: true, vexpand: true,
            min_content_width: 960, min_content_height: 560,
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC});
        root.append(this._scroll);
    }
    _showMessage(message) {
        this._hint.set_visible(false);
        this._scroll.set_child(new Gtk.Label({label: message, xalign: 0, wrap: true,
            margin_top: 12, margin_start: 12}));
    }
    async _load(file) {
        const binary = this._format === 'h5ad' || this._format === 'parquet';
        const {bytes, text, eof} = await readHead(file, this.cancellable, binary ? 64 : LIMITS.bytes);
        if (this.cancellable.is_cancelled()) return;
        if (binary) {
            const summary = binaryPreview(this._name, bytes, this._size);
            this._showMessage(summary.recognized ?
                `${summary.kind} · ${formatSize(this._size)}\nMetadata not indexed` : summary.message);
        } else {
            const partial = !eof && (this._size === 0 || this._size > bytes.length);
            const genomic = genomicPreview(this._name, text, partial);
            this._table = genomic ? {
                ...genomic, truncatedRows: genomic.rowLimit, truncatedBytes: partial,
                clippedColumns: genomic.colLimit,
            } : prepareTable(text, detectSeparator(text, this._name), true, partial);
            this._types = guessTypes(this._table.rows, this._table.headers.length, this._table.headers);
            this._renderTable();
        }
        this.markReady();
    }
    _renderTable() {
        const {headers, rows} = this._table;
        const status = previewStatus(this._table);
        const notes = this._table.notes ?? [];
        const summary = [this._table.kind, notes[0], status.label]
            .filter(Boolean).join(' · ');
        this._hint.set_label(summary);
        this._hint.set_tooltip_text([notes.join('\n'), status.tooltip]
            .filter(Boolean).join('\n'));
        this._hint.set_visible(!!summary);
        if (headers.length === 0) {
            this._showMessage('No table columns detected'); return;
        }
        const widths = columnWidthHints(headers, rows, this._types);
        try {
            const store = new Gio.ListStore({item_type: TableItem});
            rows.forEach((cells, index) => store.append(new TableItem(cells, index)));
            const view = new Gtk.ColumnView({show_row_separators: true,
                show_column_separators: false, reorderable: false,
                hexpand: true, vexpand: true});
            this._view = view;
            view.add_css_class('data-table');
            const sorting = new Gtk.SortListModel({model: store, sorter: view.get_sorter(), incremental: true});
            const selection = new Gtk.SingleSelection({model: sorting,
                autoselect: false, can_unselect: true});
            view.set_model(selection);

            const menuModel = new Gio.Menu();
            menuModel.append('Copy cell value', 'table.copy-cell');
            menuModel.append('Copy row as TSV', 'table.copy-row');
            menuModel.append('Inspect value', 'table.inspect');
            const actions = new Gio.SimpleActionGroup();
            for (const [name, callback] of [
                ['copy-cell', () => this._copyText(this._activeCell?.value)],
                ['copy-row', () => this._copyText(this._activeCell && rowToTsv(this._activeCell.cells))],
                ['inspect', () => this._inspectValue(this._activeCell)],
            ]) {
                const action = new Gio.SimpleAction({name});
                action.connect('activate', callback);
                actions.add_action(action);
            }
            view.insert_action_group('table', actions);
            const menuPopover = Gtk.PopoverMenu.new_from_model(menuModel);
            menuPopover.set_parent(view);
            menuPopover.connect('closed', () => { this._activeCell = null; });
            this._menuPopover = menuPopover;

            const keys = new Gtk.EventControllerKey();
            keys.connect('key-pressed', (_controller, keyval, _keycode, state) => {
                const control = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
                const item = selection.get_selected_item();
                if (control && keyval === Gdk.KEY_c && item) {
                    this._copyText(rowToTsv(item.cells));
                    return true;
                }
                return false;
            });
            view.add_controller(keys);

            const showAt = (popover, point) => {
                const anchor = new Graphene.Point(point ?? {x: 0, y: 0});
                popover.set_pointing_to(new Gdk.Rectangle({x: anchor.x, y: anchor.y, width: 1, height: 1}));
                popover.popup();
            };

            headers.forEach((header, col) => {
                const factory = new Gtk.SignalListItemFactory();
                const numeric = this._types[col] === 'number';
                factory.connect('setup', (_factory, item) => {
                    const widget = new Gtk.Label({xalign: numeric ? 1 : 0,
                        halign: Gtk.Align.FILL, hexpand: true,
                        ellipsize: Pango.EllipsizeMode.END, single_line_mode: true});
                    if (numeric) widget.add_css_class('numeric');
                    const click = new Gtk.GestureClick({button: 0});
                    widget.add_controller(click);
                    click.connect('pressed', (gesture, presses, x, y) => {
                        const current = item.get_item();
                        const position = item.get_position();
                        if (!current || position < 0) return;
                        const [ok, point] = widget.compute_point(view, new Graphene.Point({x, y}));
                        const anchor = ok ? {x: point.x, y: point.y} : {x: 0, y: 0};
                        const cells = current.cells.map(value => String(value ?? ''));
                        const active = {value: cells[col] ?? '', cells,
                            row: current.recordIndex, column: col, anchor};
                        if (gesture.get_current_button() === Gdk.BUTTON_SECONDARY) {
                            this._activeCell = active;
                            selection.set_selected(position);
                            showAt(menuPopover, anchor);
                        } else if (gesture.get_current_button() === Gdk.BUTTON_PRIMARY && presses === 2) {
                            this._inspectValue(active);
                        }
                    });
                    item.set_child(widget);
                });
                factory.connect('bind', (_factory, item) => {
                    const value = String(item.get_item()?.cells?.[col] ?? '');
                    const widget = item.get_child();
                    widget.set_label(value.replace(/[\r\n\t]/g, ' ').slice(0, 180));
                    widget.set_tooltip_text(value || '(empty)');
                });
                factory.connect('unbind', (_factory, item) => {
                    item.get_child().set_tooltip_text(null);
                });
                const column = new Gtk.ColumnViewColumn({title: String(header).slice(0, 55),
                    factory, resizable: true, expand: !numeric});
                column.set_fixed_width(widths[col]);
                column.set_sorter(Gtk.CustomSorter.new((a, b) => compareCells(
                    a.cells[col] ?? '', b.cells[col] ?? '', this._types[col])));
                view.append_column(column);
            });
            const gutterFactory = new Gtk.SignalListItemFactory();
            gutterFactory.connect('setup', (_factory, item) => {
                const label = new Gtk.Label({xalign: 1, halign: Gtk.Align.FILL, width_chars: 3});
                label.add_css_class('dim-label');
                label.add_css_class('row-number');
                item.set_child(label);
            });
            gutterFactory.connect('bind', (_factory, item) => {
                item.get_child().set_label(String(item.get_item().recordIndex + 1));
            });
            const gutter = new Gtk.ColumnViewColumn({title: '#', factory: gutterFactory, resizable: false});
            gutter.set_fixed_width(42);
            view.insert_column(0, gutter);
            this._store = store;
            this._scroll.set_child(view);
        } catch (e) {
            console.warn(`Native column view unavailable, showing bounded text preview: ${e}`);
            // Do not create thousands of GTK widgets in an error fallback.
            const text = [headers.join('\t'), ...rows.map(cells => cells.join('\t'))].join('\n');
            const buffer = new Gtk.TextBuffer();
            buffer.set_text(text, -1);
            this._scroll.set_child(new Gtk.TextView({buffer, editable: false,
                monospace: true, wrap_mode: Gtk.WrapMode.NONE}));
        }
    }
    _copyText(text) {
        if (text === undefined || text === null) return;
        this.get_display().get_clipboard().set_content(Gdk.ContentProvider.new_for_value(String(text)));
    }
    _inspectValue(active) {
        if (!active) return;
        if (this._inspectPopover) {
            const previous = this._inspectPopover;
            this._inspectPopover = null;
            previous.popdown();
            previous.unparent();
        }
        const buffer = new Gtk.TextBuffer();
        buffer.set_text(active.value, -1);
        const text = new Gtk.TextView({buffer, editable: false, cursor_visible: true,
            monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR,
            left_margin: 8, right_margin: 8, top_margin: 6, bottom_margin: 6});
        const scroll = new Gtk.ScrolledWindow({max_content_width: 520, max_content_height: 280,
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC, vscrollbar_policy: Gtk.PolicyType.AUTOMATIC});
        scroll.set_child(text);
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 8,
            margin_bottom: 8, margin_start: 8, margin_end: 8});
        const status = new Gtk.Label({label: cellValueStatus(this._table, active.row, active.column),
            xalign: 0, wrap: true});
        status.add_css_class('dim-label');
        const copy = new Gtk.Button({label: 'Copy value', halign: Gtk.Align.END});
        copy.connect('clicked', () => this._copyText(active.value));
        box.append(status); box.append(scroll); box.append(copy);
        const popover = new Gtk.Popover({autohide: true});
        popover.set_child(box);
        popover.set_parent(this._view);
        popover.connect('closed', () => {
            if (this._inspectPopover === popover) {
                this._inspectPopover = null;
                popover.unparent();
            }
        });
        this._inspectPopover = popover;
        const anchor = new Graphene.Point(active.anchor ?? {x: 0, y: 0});
        popover.set_pointing_to(new Gdk.Rectangle({x: anchor.x, y: anchor.y, width: 1, height: 1}));
        popover.popup();
    }
};
function formatSize(n) {
    if (!Number.isFinite(n) || n <= 0) return 'unknown size';
    const unit = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** unit).toFixed(1)} ${['B','KiB','MiB','GiB','TiB'][unit]}`;
}
export const contentTypes = [
    'text/tab-separated-values','text/csv','text/x-csv',
    'application/csv','application/tab-separated-values',
    'text/x-sushi-bed','text/x-sushi-vcf','text/x-sushi-mtx','text/x-sushi-gff',
    'application/x-sushi-h5ad','application/x-sushi-parquet',
    'application/vnd.apache.parquet','application/x-parquet','text/x-bed','text/x-gff3',
];
