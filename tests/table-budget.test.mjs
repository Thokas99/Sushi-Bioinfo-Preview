import assert from 'node:assert/strict';

globalThis.GLib = {getenv: key => ({
    SUSHI_BIOINFO_MAX_ROWS: '25000',
    SUSHI_BIOINFO_MAX_COLUMNS: '256',
})[key] ?? null};

const {LIMITS, prepareTable, previewStatus} = await import('../src/table-core.js');
const {genomicPreview} = await import('../src/format-core.js');
assert.equal(LIMITS.rows, 25000);
assert.equal(LIMITS.tableRows, 5000);
assert.ok(LIMITS.tableRows * LIMITS.columns <= LIMITS.cells);

const width = 64;
const wideHeader = Array.from({length: width}, (_, i) => `c${i}`).join(',');
const wideRow = Array(width).fill('x').join(',');
const table = prepareTable(`${wideHeader}\n` + `${wideRow}\n`.repeat(Math.floor(LIMITS.cells / width) + 2), ',');
assert.equal(table.rows.length, Math.floor(LIMITS.cells / width) - 1);
assert.equal(table.cellLimited, true);
assert.match(previewStatus(table).tooltip, /total cell limit/i);

const bed = genomicPreview('limited.bed', 'chr1\t1\t2\n'.repeat(LIMITS.tableRows + 2), false);
assert.equal(bed.rows.length, LIMITS.tableRows);
assert.equal(bed.cellLimited, true);
console.log('Configured table rows stay within the total cell cap.');
