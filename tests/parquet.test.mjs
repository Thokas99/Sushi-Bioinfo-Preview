import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parquetWriteBuffer} from 'hyparquet-writer';
import {LIMITS} from '../src/table-core.js';
import {parquetPreview, validateCompactProtocol, validatePageChunk} from '../src/parquet-core.js';

function zstdRaw(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const flag = bytes.length < 256 ? 0 : bytes.length < 65792 ? 1 : 2;
    const header = [0x28, 0xb5, 0x2f, 0xfd, (flag << 6) | 0x20];
    const contentSize = flag === 0 ? [bytes.length]
        : flag === 1 ? [bytes.length - 256 & 255, (bytes.length - 256) >>> 8]
            : [bytes.length & 255, bytes.length >>> 8 & 255, bytes.length >>> 16 & 255, bytes.length >>> 24 & 255];
    const parts = [Uint8Array.from([...header, ...contentSize])];
    if (!bytes.length) parts.push(Uint8Array.of(1, 0, 0));
    for (let offset = 0; offset < bytes.length;) {
        const length = Math.min(131071, bytes.length - offset);
        const last = offset + length === bytes.length ? 1 : 0;
        const block = length << 3 | last;
        parts.push(Uint8Array.from([block & 255, block >>> 8 & 255, block >>> 16 & 255]));
        parts.push(bytes.subarray(offset, offset + length));
        offset += length;
    }
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
}

function fixture({columns, codec = 'UNCOMPRESSED', rowGroupSize = 1000, pageSize = 4096}) {
    const compressors = codec === 'ZSTD' ? {ZSTD: zstdRaw} : undefined;
    return new Uint8Array(parquetWriteBuffer({
        columnData: columns, codec, compressors, rowGroupSize, pageSize, statistics: false,
    }));
}

function sampleColumns() {
    return [
        {name: 'count', data: [10, 20, 30], type: 'INT32'},
        {name: 'label', data: ['alpha', 'beta', 'gamma'], type: 'STRING'},
        {name: 'record', data: [{x: 'a', n: 1}, {x: 'b', n: 2}, {x: 'c', n: 3}],
            type: 'VARIANT', shredding: true},
    ];
}

function readPreview(bytes, options = {}) {
    let fetched = 0;
    return parquetPreview({
        size: bytes.length,
        isCancelled: options.isCancelled ?? (() => false),
        readRange: async (start, end) => {
            fetched += end - start;
            return bytes.slice(start, end);
        },
    }).then(table => ({table, fetched}));
}

function varint(value) {
    const out = [];
    for (let n = BigInt(value); n >= 128n; n >>= 7n) out.push(Number(n & 127n) | 128);
    out.push(Number(value < 128 ? value : BigInt(value) & 127n));
    return out;
}

function zigzag(value) { return value < 0 ? -value * 2 - 1 : value * 2; }

function pageHeader({pageType = 0, uncompressed = 1, compressed = 1, values = 1}) {
    return Uint8Array.from([
        0x15, ...varint(zigzag(pageType)),
        0x15, ...varint(zigzag(uncompressed)),
        0x15, ...varint(zigzag(compressed)),
        0x2c, 0x15, ...varint(zigzag(values)), 0,
        0,
    ]);
}

test('reads exact first stored rows and metadata count for all requested codecs', async () => {
    for (const codec of ['UNCOMPRESSED', 'SNAPPY', 'ZSTD']) {
        const {table} = await readPreview(fixture({columns: sampleColumns(), codec, rowGroupSize: 2}));
        assert.deepEqual(table.headers, ['count', 'label', 'record']);
        assert.deepEqual(table.rows.slice(0, 2).map(row => row.slice(0, 2)), [
            ['10', 'alpha'], ['20', 'beta'],
        ]);
        assert.match(table.notes.join(' '), /first stored rows/i);
        assert.match(table.notes.join(' '), /metadata reports 3 rows/i);
        assert.match(table.rows[0][2], /"x":"a"/);
    }
});

test('caps rows, columns, cells, field text, and retained UTF-8 display bytes', async () => {
    const manyRows = fixture({columns: [{name: 'value', data: Array.from({length: 10001}, (_, i) => i), type: 'INT32'}]});
    const rowTable = (await readPreview(manyRows)).table;
    assert.equal(rowTable.rows.length, Math.min(LIMITS.tableRows, 10000));
    assert.equal(rowTable.rows[0][0], '0');
    assert.equal(rowTable.rows.at(-1)[0], String(rowTable.rows.length - 1));

    const wide = fixture({columns: Array.from({length: 130}, (_, c) =>
        ({name: `c${c}`, data: [c], type: 'INT32'}))});
    const wideTable = (await readPreview(wide)).table;
    assert.equal(wideTable.headers.length, Math.min(LIMITS.columns, 128));
    assert.ok(wideTable.rows.length * wideTable.headers.length <= LIMITS.cells);

    const longField = fixture({columns: [{name: 'text', data: ['x'.repeat(600)], type: 'STRING'}]});
    const fieldTable = (await readPreview(longField)).table;
    assert.equal(fieldTable.rows[0][0].length, LIMITS.fieldChars);
    assert.equal(fieldTable.clippedFields, true);

    const longText = 'y'.repeat(LIMITS.fieldChars);
    const oversizedDisplay = fixture({columns: Array.from({length: 4}, (_, c) =>
        ({name: `c${c}`, data: Array(10000).fill(longText), type: 'STRING'})), rowGroupSize: 10000});
    await assert.rejects(readPreview(oversizedDisplay), /display text limit/i);
});

test('rejects bad footer signatures and declared footer lengths before large reads', async () => {
    const bytes = fixture({columns: sampleColumns()});
    const badMagic = bytes.slice();
    badMagic.set([0, 0, 0, 0], badMagic.length - 4);
    await assert.rejects(readPreview(badMagic), /footer|parquet/i);

    const hugeFooter = bytes.slice();
    new DataView(hugeFooter.buffer).setUint32(hugeFooter.length - 8, 0xffffffff, true);
    let fetched = 0;
    await assert.rejects(parquetPreview({
        size: hugeFooter.length, isCancelled: () => false,
        readRange: async (start, end) => { fetched += end - start; return hugeFooter.slice(start, end); },
    }), /footer|metadata|limit/i);
    assert.ok(fetched <= 12);
});

test('rejects oversized footer containers and excessive nesting', () => {
    const listCount = Uint8Array.from([0x19, 0xfc, ...varint(100001), 0]);
    assert.throws(() => validateCompactProtocol(listCount), /container|entry|limit/i);
    const deep = Uint8Array.from([...Array(65).fill(0x1c), 0, ...Array(65).fill(0)]);
    assert.throws(() => validateCompactProtocol(deep), /depth|nest|limit/i);
});

test('rejects a deeply nested Parquet schema before tree construction', async () => {
    const {validateSchemaElements} = await import('../src/parquet-core.js');
    assert.equal(typeof validateSchemaElements, 'function');
    const elements = Array.from({length: 66}, (_, i) => ({field_5: i < 65 ? 1 : 0}));
    assert.throws(() => validateSchemaElements(elements), /schema|depth|limit/i);
});

test('rejects oversized page buffers and value counts before decode', () => {
    assert.throws(() => validatePageChunk(pageHeader({uncompressed: LIMITS.bytes + 1})), /page|size|limit/i);
    assert.throws(() => validatePageChunk(pageHeader({values: LIMITS.cells + 1})), /page|value|limit/i);
});

test('stops before I/O when cancellation has already been requested', async () => {
    let reads = 0;
    await assert.rejects(parquetPreview({
        size: 100, isCancelled: () => true,
        readRange: async () => { reads++; return new Uint8Array(); },
    }), /cancel/i);
    assert.equal(reads, 0);
});

test('stops after cancellation at an I/O boundary', async () => {
    const bytes = fixture({columns: sampleColumns()});
    let reads = 0;
    let cancelled = false;
    await assert.rejects(parquetPreview({
        size: bytes.length, isCancelled: () => cancelled,
        readRange: async (start, end) => { reads++; cancelled = true; return bytes.slice(start, end); },
    }), /cancel/i);
    assert.equal(reads, 1);
});
