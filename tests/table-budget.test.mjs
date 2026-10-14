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

const table = prepareTable('a,b\n' + '1,2\n'.repeat(LIMITS.tableRows + 2), ',');
assert.equal(table.rows.length, LIMITS.tableRows);
assert.equal(table.cellLimited, true);
assert.match(previewStatus(table).tooltip, /total cell limit/i);

const bed = genomicPreview('limited.bed', 'chr1\t1\t2\n'.repeat(LIMITS.tableRows + 2), false);
assert.equal(bed.rows.length, LIMITS.tableRows);
assert.equal(bed.cellLimited, true);
console.log('Configured table rows stay within the total cell cap.');
