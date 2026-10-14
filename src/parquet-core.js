/* SPDX-License-Identifier: MIT
 * Bounded Parquet inspection shared by the GTK3 and GTK4 table plugins.
 */
import {parquetMetadata, parquetSchema, parquetRead} from 'hyparquet';
import {compressors as codecCompressors, decompressZstd} from 'hyparquet-compressors';
import {LIMITS} from './table-core.js';

const MAGIC = [80, 65, 82, 49];
const MAX_ROWS = 10000;
const MAX_COLUMNS = 128;
const MAX_ENTRIES = 100000;
const MAX_DEPTH = 64;

function fail(message) { throw new Error(`Parquet preview: ${message}`); }

function asBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    fail('range reader returned invalid bytes');
}

function readByte(state) {
    if (state.offset >= state.bytes.length) fail('truncated compact-Thrift data');
    return state.bytes[state.offset++];
}

function readVarint(state, maxBytes = 5) {
    let value = 0n;
    let shift = 0n;
    for (let i = 0; i < maxBytes; i++) {
        const byte = readByte(state);
        value |= BigInt(byte & 0x7f) << shift;
        if (!(byte & 0x80)) {
            if (maxBytes === 5 && value > 0xffffffffn) fail('compact-Thrift integer exceeds 32 bits');
            return value;
        }
        shift += 7n;
    }
    fail('invalid compact-Thrift integer');
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
    const result = Object.create(null);
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
    case 1: return true;
    case 2: return false;
    case 3: return (readByte(state) << 24) >> 24;
    case 4:
    case 5: return readZigzag(state);
    case 6: return readZigzag(state, true);
    case 7: {
        if (state.offset + 8 > state.bytes.length) fail('truncated compact-Thrift double');
        const value = new DataView(state.bytes.buffer, state.bytes.byteOffset + state.offset, 8).getFloat64(0, true);
        state.offset += 8;
        return value;
    }
    case 8: {
        const length = Number(readVarint(state));
        if (!Number.isSafeInteger(length) || length > state.bytes.length - state.offset)
            fail('compact-Thrift binary exceeds available bytes');
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
        if (!count) return new Map();
        const types = readByte(state);
        const keyType = types >> 4;
        const valueType = types & 15;
        const values = new Map();
        for (let i = 0; i < count; i++) {
            const key = keyType === 1 || keyType === 2 ? readByte(state) === 1 : readCompactValue(state, keyType, depth + 1);
            const value = valueType === 1 || valueType === 2 ? readByte(state) === 1 : readCompactValue(state, valueType, depth + 1);
            values.set(key, value);
        }
        return values;
    }
    case 12: return readCompactStruct(state, depth);
    default: fail(`unsupported compact-Thrift type ${type}`);
    }
}

function compactStruct(bytes, offset = 0) {
    const state = {bytes: asBytes(bytes), offset, entries: 0};
    const value = readCompactStruct(state, 0);
    return {value, offset: state.offset};
}

export function validateCompactProtocol(bytes) {
    const input = asBytes(bytes);
    if (input.length > LIMITS.bytes) fail(`footer exceeds ${LIMITS.bytes} bytes`);
    const parsed = compactStruct(input);
    if (parsed.offset !== input.length) fail('unexpected bytes after compact-Thrift structure');
    return parsed.value;
}

export function validateSchemaElements(elements) {
    if (!Array.isArray(elements) || !elements.length) fail('schema elements are missing');
    const children = element => {
        const count = element.field_5 ?? 0;
        if (!Number.isInteger(count) || count < 0 || count > MAX_ENTRIES)
            fail('schema child count exceeds its limit');
        return count;
    };
    const stack = [{remaining: children(elements[0]), depth: 0}];
    for (let i = 1; i < elements.length; i++) {
        while (stack.length && stack[stack.length - 1].remaining === 0) stack.pop();
        if (!stack.length) fail('schema contains extra elements');
        const parent = stack[stack.length - 1];
        parent.remaining--;
        const depth = parent.depth + 1;
        if (depth > MAX_DEPTH) fail(`schema nesting exceeds ${MAX_DEPTH} levels`);
        stack.push({remaining: children(elements[i]), depth});
    }
    while (stack.length && stack[stack.length - 1].remaining === 0) stack.pop();
    if (stack.length) fail('schema is missing child elements');
}

function checkedPageCount(value) {
    if (!Number.isInteger(value) || value < 0 || value > LIMITS.cells)
        fail(`page value count exceeds ${LIMITS.cells}`);
}

export function validatePageChunk(bytes) {
    const input = asBytes(bytes);
    if (input.length > LIMITS.bytes) fail(`column chunk exceeds ${LIMITS.bytes} bytes`);
    const state = {bytes: input, offset: 0, entries: 0};
    let pages = 0;
    let dataValues = 0;
    while (state.offset < input.length) {
        const header = readCompactStruct(state, 0);
        if (++pages > LIMITS.cells) fail(`column chunk page count exceeds ${LIMITS.cells}`);
        const type = header.field_1;
        const uncompressed = header.field_2;
        const compressed = header.field_3;
        if (!Number.isInteger(uncompressed) || uncompressed < 0 || uncompressed > LIMITS.bytes ||
            !Number.isInteger(compressed) || compressed < 0 || compressed > LIMITS.bytes)
            fail(`page size exceeds ${LIMITS.bytes} bytes`);

        const pageHeader = type === 0 ? header.field_5 : type === 2 ? header.field_7 : type === 3 ? header.field_8 : null;
        if (![0, 1, 2, 3].includes(type)) fail('unknown page type');
        if (type !== 1 && !pageHeader) fail('page is missing its type-specific header');
        if (pageHeader) {
            checkedPageCount(pageHeader.field_1);
            if (type !== 2) {
                dataValues += pageHeader.field_1;
                if (dataValues > LIMITS.cells) fail(`column page values exceed ${LIMITS.cells}`);
            }
            if (type === 3) {
                const levels = pageHeader.field_5 + pageHeader.field_6;
                if (!Number.isInteger(levels) || levels < 0 || levels > uncompressed || levels > compressed)
                    fail('invalid v2 page level lengths');
            }
        }
        const end = state.offset + compressed;
        if (end > input.length) fail('page extends past its column chunk');
        state.offset = end;
    }
    if (!pages) fail('column chunk has no pages');
    return pages;
}

function magic(bytes, start = 0) {
    return MAGIC.every((value, index) => bytes[start + index] === value);
}

function safeInteger(value, label) {
    const result = typeof value === 'bigint' ? Number(value) : value;
    if (!Number.isSafeInteger(result) || result < 0) fail(`invalid ${label}`);
    return result;
}

function asCount(value, label) {
    if (typeof value !== 'bigint' && !Number.isSafeInteger(value)) fail(`invalid ${label}`);
    const result = typeof value === 'bigint' ? value : BigInt(value);
    if (result < 0n) fail(`invalid ${label}`);
    return result;
}

function minimum(a, b) { return a < b ? a : b; }

function utf8Length(text) {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x80) bytes++;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length &&
            text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
        else bytes += 3;
    }
    return bytes;
}

function boundedText(value) {
    let text = '';
    let clipped = false;
    let visits = 0;
    const append = item => {
        if (text.length >= LIMITS.fieldChars) { clipped = true; return; }
        const part = String(item);
        const room = LIMITS.fieldChars - text.length;
        text += part.slice(0, room);
        if (part.length > room) clipped = true;
    };
    const write = (item, depth) => {
        if (text.length >= LIMITS.fieldChars) { clipped = true; return; }
        if (depth > MAX_DEPTH || ++visits > MAX_ENTRIES) { append('…'); clipped = true; return; }
        if (item === null || item === undefined) return;
        if (typeof item === 'string') { append(depth ? JSON.stringify(item) : item); return; }
        if (typeof item === 'number' || typeof item === 'bigint' || typeof item === 'boolean') { append(item); return; }
        if (item instanceof Date) { append(Number.isNaN(item.getTime()) ? 'Invalid date' : item.toISOString()); return; }
        if (item instanceof Uint8Array || item instanceof ArrayBuffer) {
            append(`[binary ${item.byteLength} bytes]`); return;
        }
        if (Array.isArray(item)) {
            append('[');
            for (let i = 0; i < item.length && text.length < LIMITS.fieldChars; i++) {
                if (i) append(', ');
                write(item[i], depth + 1);
            }
            if (item.length && text.length >= LIMITS.fieldChars) clipped = true;
            append(']');
            return;
        }
        if (typeof item === 'object') {
            append('{');
            let index = 0;
            for (const key in item) {
                if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
                if (text.length >= LIMITS.fieldChars) { clipped = true; break; }
                if (index++) append(', ');
                append(`${JSON.stringify(String(key).slice(0, LIMITS.fieldChars))}:`);
                write(item[key], depth + 1);
            }
            append('}');
            return;
        }
        append(String(item));
    };
    write(value, 0);
    return {text, clipped};
}

function normalizeRange(bytes, start, end) {
    const input = asBytes(bytes);
    if (input.length !== end - start) fail('range reader returned a short read');
    return new Uint8Array(input);
}

export async function parquetPreview({size, readRange, isCancelled = () => false}) {
    if (!Number.isSafeInteger(size) || size < 12) fail('file is too short');
    if (typeof readRange !== 'function') fail('range reader unavailable');
    const cache = [];
    let fetched = 0;
    let displayBytes = 0;
    const checkCancelled = () => { if (isCancelled()) fail('cancelled'); };
    const getRange = async (start, end) => {
        checkCancelled();
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > size)
            fail('requested byte range is outside the file');
        const existing = cache.find(range => range.start <= start && range.end >= end);
        if (existing) return existing.bytes.subarray(start - existing.start, end - existing.start);
        const length = end - start;
        if (length > LIMITS.bytes || fetched + length > LIMITS.bytes)
            fail(`fetched-byte limit of ${LIMITS.bytes} bytes exceeded`);
        const bytes = normalizeRange(await readRange(start, end), start, end);
        checkCancelled();
        fetched += length;
        cache.push({start, end, bytes});
        return bytes;
    };
    try {
        const head = await getRange(0, 4);
        if (!magic(head)) fail('leading magic bytes do not match PAR1');
        const trailer = await getRange(size - 8, size);
        if (!magic(trailer, 4)) fail('footer magic bytes do not match PAR1');
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
        const metadata = parquetMetadata(metadataBuffer.buffer, {geoparquet: false});
        const totalRows = asCount(metadata.num_rows, 'metadata row count');
        const schema = parquetSchema(metadata);
        const allNames = schema.children.map(child => child.element.name);
        if (allNames.some(name => typeof name !== 'string' || !name.length)) fail('schema contains an empty column name');
        if (new Set(allNames).size !== allNames.length) fail('schema contains duplicate top-level column names');

        const headers = allNames.slice(0, Math.min(MAX_COLUMNS, LIMITS.columns));
        const rowCap = Math.min(MAX_ROWS, LIMITS.tableRows, Math.floor(LIMITS.cells / Math.max(1, headers.length)));
        const requestedRows = Number(minimum(totalRows, BigInt(rowCap)));
        const groups = metadata.row_groups;
        let groupTotal = 0n;
        const selectedGroups = [];
        let remaining = BigInt(requestedRows);
        for (const group of groups) {
            const count = asCount(group.num_rows, 'row-group count');
            groupTotal += count;
            if (remaining > 0n && count > 0n) {
                selectedGroups.push(group);
                remaining -= minimum(count, remaining);
            }
        }
        if (groupTotal !== totalRows || remaining > 0n) fail('row-group counts do not match footer metadata');

        const rows = Array.from({length: requestedRows}, () => Array(headers.length).fill(''));
        const truncatedFields = new Map();
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
            },
        };
        async function getCachedRange(start, end) {
            checkCancelled();
            const range = cache.find(item => item.start <= start && item.end >= end);
            if (!range) fail('reader requested an unvalidated Parquet range');
            return range.bytes.subarray(start - range.start, end - range.start);
        }
        const guardedCompressors = Object.fromEntries(Object.entries(codecCompressors).map(([codec, decompress]) => [codec,
            (input, outputLength) => {
                if (!Number.isSafeInteger(outputLength) || outputLength < 0 || outputLength > LIMITS.bytes || input.length > LIMITS.bytes)
                    fail(`decompressed page exceeds ${LIMITS.bytes} bytes`);
                const output = codec === 'ZSTD'
                    ? decompressZstd(input, new Uint8Array(outputLength))
                    : decompress(input, outputLength);
                if (!(output instanceof Uint8Array) || output.length !== outputLength)
                    fail('decompressed page length does not match its header');
                return output;
            },
        ]));

        for (let c = 0; c < headers.length; c++) {
            checkCancelled();
            const name = allNames[c];
            for (const group of selectedGroups) {
                const leaves = group.columns.filter(column => column.meta_data?.path_in_schema?.[0] === name);
                if (!leaves.length) fail(`column chunk not found for ${name}`);
                for (const column of leaves) {
                    if (column.file_path) fail('external Parquet column files are unsupported');
                    const details = column.meta_data;
                    const offsets = [details.dictionary_page_offset, details.data_page_offset]
                        .filter(value => value !== undefined).map(value => safeInteger(value, 'column page offset'));
                    if (!offsets.length) fail(`column page offset is missing for ${name}`);
                    const start = Math.min(...offsets);
                    const length = safeInteger(details.total_compressed_size, 'compressed column size');
                    const end = start + length;
                    if (start < 4 || !Number.isSafeInteger(end) || end > footerStart || end < start)
                        fail('column byte range is outside the data section');
                    validatePageChunk(await getRange(start, end));
                }
            }

            const seen = new Uint8Array(requestedRows);
            let callbackError = null;
            await parquetRead({
                file: rangeFile, metadata, columns: [name], rowStart: 0, rowEnd: requestedRows,
                compressors: guardedCompressors,
                onChunk(chunk) {
                    if (callbackError) return;
                    try {
                        if (chunk.columnName !== name) fail('unexpected column in Parquet decoder');
                        const start = safeInteger(chunk.rowStart, 'decoded row start');
                        if (start + chunk.columnData.length > requestedRows) fail('decoder returned rows outside the sample');
                        for (let i = 0; i < chunk.columnData.length; i++) {
                            const row = start + i;
                            if (seen[row]) fail('decoder returned duplicate sampled rows');
                            seen[row] = 1;
                            rows[row][c] = retain(chunk.columnData[i], row, c);
                        }
                    } catch (error) {
                        callbackError = error;
                    }
                },
            });
            checkCancelled();
            if (callbackError) throw callbackError;
            if (seen.some(value => value !== 1)) fail(`decoder returned an incomplete sample for ${name}`);
        }

        const shown = rows.length;
        const notes = [
            `First stored rows shown: ${shown} in file order; this is not a random or representative sample.`,
            `Footer metadata reports ${totalRows} rows. Only the footer and displayed column pages were read; the complete file was not validated.`,
        ];
        if (allNames.length > headers.length) notes.push(`Only the first ${headers.length} of ${allNames.length} columns are shown.`);
        return {
            kind: 'Apache Parquet', headers, rows, notes, clippedColumns: allNames.length > headers.length,
            clippedFields: truncatedFields.size > 0, truncatedFields, truncatedHeader,
            rowLimit: totalRows > BigInt(shown), cellLimited: LIMITS.tableRows < LIMITS.rows,
        };
    } finally {
        cache.length = 0;
    }
}
