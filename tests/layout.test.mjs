import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {columnWidthHints} from '../src/table-core.js';

const gtk4 = readFileSync(new URL('../src/table-51.js', import.meta.url), 'utf8');
const gtk3 = readFileSync(new URL('../src/table-50.template.js', import.meta.url), 'utf8');
assert.match(gtk4, /new Gtk\.ColumnView\(/, 'GTK4 must use native, virtualized ColumnView');
assert.match(gtk4, /new Gtk\.SortListModel\(/, 'GTK4 sorting remains native');
assert.match(gtk4, /new Gtk\.ScrolledWindow\(/, 'GTK4 must use scrollable viewport');
assert.match(gtk3, /new Gtk\.TreeView\(/, 'GTK3 must use native TreeView');
assert.match(gtk3, /new Gtk\.ScrolledWindow\(/, 'GTK3 must use scrollable viewport');
assert.match(gtk3, /this\._message\(`\$\{info\.kind\}\\n\$\{info\.message\}`\)/,
    'GTK3 signature-only previews must disclose metadata limitations');
for (const [name, code] of [['GTK4', gtk4], ['GTK3', gtk3]]) {
    for (const obsolete of ['_page', '_rowPrev', '_rowNext', 'rows.slice(r0', 'pages =', 'new Gtk.Grid(',
        'Gtk.SearchEntry', 'this._search', '_filter()', 'application/gzip', 'gzipPreview']) {
        assert.ok(!code.includes(obsolete), `${name}: unexpected old UI ${obsolete}`);
    }
    assert.match(code, /min_content_width: 960, min_content_height: 560/);
    assert.match(code, /columnWidthHints\(headers, rows, this\._types\)/);
}
const hints = columnWidthHints(
    ['gene', 'log2FoldChange', 'pvalue'],
    [['TP53', '1.324', '0.001'], ['MYC', '-0.73', '0.15']],
    ['text', 'number', 'number']);
assert.equal(hints.length, 3);
assert.ok(hints[1] >= hints[2], 'longer header should get more space');
assert.ok(hints.every(x => x >= 64 && x <= 280));
assert.ok(hints[2] < 84, 'short numeric columns should stay compact');
assert.ok(columnWidthHints(['log2FoldChange'], [['1.42']], ['number'])[0] > hints[2],
    'numeric widths must still accommodate longer headers');
const longValue = columnWidthHints(['comment'], [['x'.repeat(10_000)]], ['text']);
assert.ok(longValue[0] <= 280 && longValue[0] > 200,
    'individual long strings must not make huge columns');
for (const name of ['office-51.js', 'office-50.template.js', 'document-51.js', 'document-50.template.js']) {
    const source = readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
    assert.match(source, /min_content_width: 920, min_content_height: 560/);
}
const mime = readFileSync(new URL('../mime/sushi-bioinfo-preview.xml', import.meta.url), 'utf8');
assert.ok(!mime.includes('application/x-sushi-bgzf'));
console.log('Native scrolling, compact column sizing and bounded layout confirmed.');
