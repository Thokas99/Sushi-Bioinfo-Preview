import assert from 'node:assert/strict';
import {LIMITS as standard} from '../src/table-core.js';
assert.equal(standard.bytes, 16*1024*1024);
assert.equal(standard.rows, 10000);
assert.equal(standard.columns, 128);
globalThis.GLib = {getenv: key => ({
    SUSHI_BIOINFO_MAX_MIB: '32',
    SUSHI_BIOINFO_MAX_ROWS: '20000',
    SUSHI_BIOINFO_MAX_COLUMNS: '192',
})[key] ?? null};
const {LIMITS: increased} = await import('../src/table-core.js?override=1');
assert.deepEqual([increased.bytes, increased.rows, increased.columns],
    [32*1024*1024, 20000, 192]);
globalThis.GLib = {getenv: key => ({
    SUSHI_BIOINFO_MAX_MIB: '9999',
    SUSHI_BIOINFO_MAX_ROWS: '99999',
    SUSHI_BIOINFO_MAX_COLUMNS: '99999',
})[key] ?? null};
const {LIMITS: clamped} = await import('../src/table-core.js?override=2');
assert.deepEqual([clamped.bytes, clamped.rows, clamped.columns],
    [64*1024*1024, 25000, 256]);
delete globalThis.GLib;
console.log('Defaults, Flatpak overrides and hard ceilings passed.');
