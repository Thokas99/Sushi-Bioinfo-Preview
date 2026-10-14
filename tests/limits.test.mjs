import assert from 'node:assert/strict';
import {LIMITS as standard} from '../src/table-core.js';
assert.equal(standard.bytes, 16*1024*1024);
assert.equal(standard.rows, 10000);
assert.equal(standard.columns, 128);
assert.equal(standard.cells, 1_280_000);
assert.equal(standard.tableRows, 10000);
assert.equal(standard.tableCellLimitActive, false);
globalThis.GLib = {getenv: key => ({
    SUSHI_BIOINFO_MAX_MIB: '32',
    SUSHI_BIOINFO_MAX_ROWS: '20000',
    SUSHI_BIOINFO_MAX_COLUMNS: '192',
})[key] ?? null};
const {LIMITS: increased} = await import('../src/table-core.js?override=1');
assert.deepEqual([increased.bytes, increased.rows, increased.tableRows, increased.columns],
    [32*1024*1024, 20000, 6666, 192]);
assert.equal(increased.tableCellLimitActive, true);
assert.ok(increased.tableRows * increased.columns <= increased.cells);
globalThis.GLib = {getenv: key => ({
    SUSHI_BIOINFO_MAX_MIB: '9999',
    SUSHI_BIOINFO_MAX_ROWS: '99999',
    SUSHI_BIOINFO_MAX_COLUMNS: '99999',
})[key] ?? null};
const {LIMITS: clamped} = await import('../src/table-core.js?override=2');
assert.deepEqual([clamped.bytes, clamped.rows, clamped.tableRows, clamped.columns],
    [64*1024*1024, 25000, 5000, 256]);
assert.equal(clamped.tableCellLimitActive, true);
assert.ok(clamped.tableRows * clamped.columns <= clamped.cells);
delete globalThis.GLib;
console.log('Defaults, Flatpak overrides and hard ceilings passed.');
