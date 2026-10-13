import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sortRows, guessTypes} from '../src/table-core.js';

for (const viewer of ['table-51.js', 'table-50.template.js']) {
    const source = readFileSync(new URL(`../src/${viewer}`, import.meta.url), 'utf8');
    for (const forbidden of ['Gtk.SearchEntry', 'this._search', 'edit-find-symbolic', '_filter()', 'Filter sampled rows']) {
        assert.ok(!source.includes(forbidden), `${viewer} still contains ${forbidden}`);
    }
}
const cells = [['A', '12'], ['B', '3'], ['Q gene', '7']];
const types = guessTypes(cells, 2);
assert.deepEqual(sortRows(cells, null, false, types).map(x => x.cells[0]), ['A','B','Q gene']);
assert.deepEqual(sortRows(cells, 1, false, types).map(x => x.cells[0]), ['B','Q gene','A']);
assert.deepEqual(sortRows(cells, 1, true, types).map(x => x.cells[0]), ['A','Q gene','B']);
console.log('No search/filter UI in either Sushi version; sorting unchanged.');
