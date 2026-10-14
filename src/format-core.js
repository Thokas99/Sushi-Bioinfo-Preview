import {LIMITS} from './table-core.js';

/* SPDX-License-Identifier: MIT
 * Sushi Bioinfo Preview: bounded, dependency-free genomics format parsing.
 * This module never opens files: callers supply a small head buffer.
 */
export function formatFromName(name) {
    const n = name.toLowerCase();
    if (/\.(h5ad)$/.test(n)) return 'h5ad';
    if (/\.(parquet)$/.test(n)) return 'parquet';
    if (/\.(vcf)$/.test(n)) return 'vcf';
    if (/\.(bed|bedgraph|narrowpeak|broadpeak)$/.test(n)) return 'bed';
    if (/\.(mtx)$/.test(n)) return 'mtx';
    if (/\.(gff|gff3|gtf)$/.test(n)) return 'gff';
    return 'table';
}

export function binaryPreview(name, bytes, totalSize) {
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

export function genomicPreview(name, text, partial) {
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
