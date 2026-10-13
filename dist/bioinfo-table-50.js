/* Sushi Bioinfo Preview — native GTK3 tree table. SPDX-License-Identifier: MIT */
const {Gio, GLib, GObject, Gtk, Pango} = imports.gi;
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

function isMissing(v) {
    if (v === undefined || v === null) return true;
    const s = v.trim();
    return s === '' || /^(NA|N\/A|NULL|NONE|NAN)$/i.test(s);
}

function numericValue(v) {
    if (isMissing(v)) return null;
    const x = v.trim();
    if (!/^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(x)) return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
}

function compareCells(left, right, type, leftIndex = 0, rightIndex = 0, descending = false) {
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

function guessTypes(rows, count) {
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

function sortRows(rows, sortColumn, descending, types) {
    const sorted = rows.map((cells, originalIndex) => ({cells, originalIndex}));
    if (sortColumn !== null && sortColumn >= 0)
        sorted.sort((a, b) => compareCells(a.cells[sortColumn] ?? '', b.cells[sortColumn] ?? '',
            types[sortColumn], a.originalIndex, b.originalIndex, descending));
    return sorted;
}

/** Suggest legible pixel widths from bounded sample data, without creating GTK widgets.
 * Columns are allowed to expand to use spare preview width.
 */
function columnWidthHints(headers, rows, types = []) {
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
    while (cursor < text.length && lines.length < maxLines) {
        const lf = text.indexOf('\n', cursor);
        const cr = text.indexOf('\r', cursor);
        let end;
        if (lf === -1) end = cr;
        else if (cr === -1) end = lf;
        else end = Math.min(lf, cr);
        if (end === -1) {
            if (!partial) lines.push(text.slice(cursor));
            break;
        }
        lines.push(text.slice(cursor, end));
        cursor = end + (text[end] === '\r' && text[end + 1] === '\n' ? 2 : 1);
    }
    return lines;
}

function cleanRows(lines, skip, maxRows) {
    return lines.filter(s => s.trim() && !skip(s)).slice(0, maxRows);
}

function trimDelimited(line, cols) {
    // Extract only the columns we display; never split a huge row into
    // arbitrarily many temporary strings.
    const cells = [];
    let pos = 0;
    while (cells.length < cols) {
        const next = line.indexOf('\t', pos);
        const end = next === -1 ? line.length : next;
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

function trimWhitespace(line, columns) {
    const cells = [];
    let cursor = 0;
    while (cells.length < columns) {
        while (cursor < line.length && /\s/.test(line[cursor])) cursor++;
        if (cursor === line.length) break;
        let end = cursor;
        while (end < line.length && !/\s/.test(line[end])) end++;
        cells.push(line.slice(cursor, Math.min(end, cursor + LIMITS.fieldChars)));
        cursor = end;
    }
    while (cursor < line.length && /\s/.test(line[cursor])) cursor++;
    return {cells, extra: cursor < line.length};
}

function result(kind, headers, lines, columns, notes) {
    const rows = lines.slice(0, LIMITS.rows).map(line => trimDelimited(line, columns));
    const nc = Math.min(LIMITS.columns, kind === 'BED intervals'
        ? Math.max(3, ...rows.map(r => r.length), 0)
        : Math.max(headers.length, ...rows.map(r => r.length), 0));
    const names = Array.from({length: nc}, (_, i) => headers[i] || `Column ${i + 1}`);
    return {kind, headers: names, rows, notes,
        rowLimit: lines.length > LIMITS.rows,
        colLimit: headers.length > LIMITS.columns || lines.some(line => exceedsColumns(line, LIMITS.columns))};
}

function genomicPreview(name, text, partial) {
    const kind = formatFromName(name);
    const lines = splitLines(text, partial);
    if (kind === 'vcf') {
        const meta = lines.filter(line => line.startsWith('##'));
        const headerLine = lines.find(line => line.startsWith('#CHROM\t'));
        const headers = headerLine ? trimDelimited(headerLine.slice(1), LIMITS.columns + 1) :
            ['CHROM','POS','ID','REF','ALT','QUAL','FILTER','INFO','FORMAT'];
        const records = cleanRows(lines, x => x.startsWith('#'), LIMITS.rows + 1);
        const samples = Math.max(0, headers.length - 9);
        return result('VCF variants', headers, records, LIMITS.columns,
            ['POS uses 1-based coordinates', 'INFO/FORMAT displayed as text; no genotype interpretation',
                `${samples} sample columns in header`, `${meta.length} header metadata lines in sample`]);
    }
    if (kind === 'bed') {
        const headers = ['chrom','chromStart','chromEnd','name','score','strand',
            'thickStart','thickEnd','itemRgb','blockCount','blockSizes','blockStarts'];
        const records = cleanRows(lines, x => /^(#|track\b|browser\b)/i.test(x), LIMITS.rows + 1);
        return result('BED intervals', headers, records, LIMITS.columns,
            ['BED starts are 0-based; ends are exclusive', 'Columns are positional; additional columns are generic']);
    }
    if (kind === 'gff') {
        const headers = ['seqid','source','type','start','end','score','strand','phase','attributes'];
        const fastaStart = lines.findIndex(x => x.startsWith('##FASTA'));
        const annotationLines = fastaStart >= 0 ? lines.slice(0, fastaStart) : lines;
        const records = cleanRows(annotationLines, x => x.startsWith('#'), LIMITS.rows + 1);
        return result('GFF / GTF features', headers, records, LIMITS.columns,
            ['GFF/GTF starts and ends are 1-based inclusive', 'Attributes are not expanded']);
    }
    if (kind === 'mtx') {
        const mark = lines.find(x => /^%%MatrixMarket\s/i.test(x));
        const content = cleanRows(lines, x => x.startsWith('%'), LIMITS.rows + 2);
        const banner = /^%%MatrixMarket\s+matrix\s+(coordinate|array)\s+(integer|real|complex|pattern)\s+(general|symmetric|hermitian|skew-symmetric)\s*$/i.exec(mark ?? '');
        const storage = banner?.[1].toLowerCase();
        const field = banner?.[2].toLowerCase();
        if (!banner || (storage === 'array' && field === 'pattern')) {
            const raw = content.slice(0, LIMITS.rows);
            return {kind: 'Matrix Market text', headers: ['line'], rows: raw.map(line => [line.slice(0, LIMITS.fieldChars)]),
                notes: ['Unsupported or invalid Matrix Market banner; non-comment lines are shown as text',
                    (mark ?? 'No MatrixMarket banner found').slice(0, 140)],
                rowLimit: content.length > LIMITS.rows, colLimit: false};
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
        const parsed = entries.slice(0, LIMITS.rows).map(line => trimWhitespace(line, headers.length));
        const malformed = parsed.filter(row => row.cells.length !== headers.length || row.extra).length;
        const notes = [matrixInfo, isCoordinate
            ? 'Coordinate indices are 1-based; entries are not expanded into a dense matrix'
            : 'Dense array values are shown in storage order; symmetry is not expanded',
            (mark ?? 'No MatrixMarket banner found').slice(0, 140)];
        if (malformed) notes.push(`${malformed} sampled entries have unexpected field counts; extra fields are omitted`);
        return {kind: isArray ? 'Matrix Market array' : 'Matrix Market coordinates', headers,
            rows: parsed.map(row => row.cells), notes,
            rowLimit: entries.length > LIMITS.rows, colLimit: false};
    }
    return null;
}

const shortText = value => String(value ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 180);
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
        this._hint.set_tooltip_text('The preview reads a bounded prefix of the file.');
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
        this._file.read_async(GLib.PRIORITY_DEFAULT, this._cancellable, (f, res) => {
            let stream;
            try { stream = f.read_finish(res); } catch (e) { this._message(e.message); this._readyNow(); return; }
            let count = 0; const chunks = []; let eof = false;
            const binary = this._format === 'h5ad' || this._format === 'parquet';
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
                if (this._cancellable.is_cancelled()) return;
                if (count >= limit) { finish(); return; }
                stream.read_bytes_async(Math.min(131072, limit - count), GLib.PRIORITY_DEFAULT, this._cancellable,
                    (input, result) => {
                        try {
                            const b = input.read_bytes_finish(result);
                            if (!b.get_size()) { eof = true; finish(); return; }
                            const chunk = b.get_data(); chunks.push(chunk); count += chunk.length; next();
                        } catch (e) { this._message(e.message); this._readyNow(); }
                    });
            };
            next();
        });
    }
    _parse() {
        const genomic = genomicPreview(this._name, this._text, this._partial);
        this._table = genomic ? {...genomic, truncatedRows: genomic.rowLimit, truncatedBytes: this._partial,
            clippedColumns: genomic.colLimit} : prepareTable(this._text, detectSeparator(this._text, this._name), true, this._partial);
        this._types = guessTypes(this._table.rows, this._table.headers.length);
        this._draw();
    }
    _draw() {
        const {headers, rows} = this._table;
        const sampled = this._partial || this._table.truncatedRows || this._table.clippedColumns;
        const notes = this._table.notes ?? [];
        const summary = [this._table.kind, notes[0], sampled ? `${rows.length} rows from file prefix` : '']
            .filter(Boolean).join(' · ');
        this._hint.set_text(summary);
        this._hint.set_tooltip_text([notes.join('\n'), `${rows.length} rows shown from the file prefix`]
            .filter(Boolean).join('\n'));
        this._hint.set_visible(!!summary);
        if (!headers.length) { this._message('No table columns detected'); return; }
        const widths = columnWidthHints(headers, rows, this._types);
        try {
            const store = new Gtk.ListStore();
            store.set_column_types(headers.map(() => GObject.TYPE_STRING));
            this._store = store;
            const populate = () => {
                store.clear();
                const sorted = sortRows(rows, this._sortColumn, this._descending, this._types);
                sorted.forEach(({cells}) => {
                    const iter = store.append();
                    for (let c = 0; c < headers.length; c++)
                        store.set_value(iter, c, shortText(cells[c]));
                });
            };
            populate();
            const view = new Gtk.TreeView({model: store, visible: true,
                headers_visible: true, enable_search: false,
                grid_lines: Gtk.TreeViewGridLines.HORIZONTAL});
            for (let col = 0; col < headers.length; col++) {
                const renderer = new Gtk.CellRendererText({ellipsize: Pango.EllipsizeMode.END,
                    xalign: this._types[col] === 'number' ? 1 : 0,
                    xpad: 8, ypad: 4});
                const column = new Gtk.TreeViewColumn({title: String(headers[col]).slice(0, 55),
                    resizable: true, expand: headers.length <= 10, clickable: true,
                    min_width: Math.min(widths[col], 100)});
                column.pack_start(renderer, true);
                column.add_attribute(renderer, 'text', col);
                column.set_fixed_width(widths[col]);
                column.connect('clicked', () => {
                    if (this._sortColumn !== col) { this._sortColumn = col; this._descending = false; }
                    else if (!this._descending) this._descending = true;
                    else this._sortColumn = null;
                    populate();
                });
                view.append_column(column);
            }
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
});
var mimeTypes = [
    'text/tab-separated-values','text/csv','text/x-csv','application/csv','application/tab-separated-values',
    'text/x-sushi-bed','text/x-sushi-vcf','text/x-sushi-mtx','text/x-sushi-gff',
    'application/x-sushi-h5ad','application/x-sushi-parquet','application/vnd.apache.parquet',
    'application/x-parquet','text/x-bed','text/x-gff3',
];
