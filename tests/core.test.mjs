import assert from 'node:assert/strict';
import * as core from '../src/table-core.js';
const {parseDelimited, detectSeparator, prepareTable, guessTypes, sortRows, numericValue} = core;
const csv = 'gene,logFC,note\n"TP,53",1.2,"line 1\nline 2"\nMYC,-0.7,"a ""quote"""\n';
let result = parseDelimited(csv, ',');
assert.equal(result.rows.length, 3);
assert.deepEqual(result.rows[1], ['TP,53', '1.2', 'line 1\nline 2']);
assert.equal(result.rows[2][2], 'a "quote"');
const crlf = parseDelimited('a,b\r\n1,\r\n', ',');
assert.deepEqual(crlf.rows, [['a','b'],['1','']]);
assert.equal(detectSeparator(csv, 'data.csv'), ',');
assert.equal(detectSeparator('a\tb\nc\td\n', 'data.tsv'), '\t');
const table = prepareTable(csv, ',');
assert.deepEqual(table.headers, ['gene','logFC','note']);
assert.equal(table.rows.length, 2);
const types = guessTypes(table.rows, 3);
assert.deepEqual(types, ['text','number','text']);
const sorted = sortRows(table.rows, 1, false, types);
assert.equal(sorted[0].cells[0], 'MYC');
const tied = [['2','first'],['2','second'],['','missing'],['1','last']];
assert.deepEqual(sortRows(tied, 0, false, ['number']).map(row => row.cells[1]),
    ['last','first','second','missing']);
assert.deepEqual(sortRows(tied, 0, true, ['number']).map(row => row.cells[1]),
    ['missing','first','second','last']); // missing values follow GTK's selected sort direction
assert.deepEqual(sortRows([['.'],['2'],['NA'],['1']], 0, false, ['number']).map(row => row.cells[0]),
    ['1','2','.','NA']);
assert.deepEqual(sortRows([['NA'],['note'],['10'],['2']], 0, false, ['number']).map(row => row.cells[0]),
    ['2','10','note','NA']);
assert.equal(numericValue('1.2e-4'), 0.00012);
assert.equal(numericValue('TP53'), null);
const largeNumbers = [['9007199254740993'], ['1e300'], ['9007199254740992'], ['-1e300']];
assert.deepEqual(sortRows(largeNumbers, 0, false, ['number']).map(row => row.cells[0]),
    ['-1e300','9007199254740992','9007199254740993','1e300']);
assert.deepEqual(guessTypes([['1'],['2']], 1, ['gene_id']), ['text']);
assert.deepEqual(guessTypes([['1'],['2']], 1, ['gene_name']), ['text']);
assert.deepEqual(guessTypes([['1'],['10']], 1, ['#CHROM']), ['text']);
assert.deepEqual(guessTypes([['1.2'],['2.3']], 1, ['log2FoldChange']), ['number']);
assert.deepEqual(prepareTable('a\ta\t\n1\t2\t3\n','\t').headers, ['a','a (2)','Column 3']);
const limited = parseDelimited('a,b\nc,d\ne,f\n', ',', {maxRows: 2});
assert.equal(limited.rows.length, 2);
assert.equal(limited.hitRowLimit, true);
assert.equal(prepareTable('a,b\n1,2\n3,4', ',', true, true).rows.length, 1); // drop partial
assert.equal(prepareTable('a,b\n1,2\n3,4', ',', true, false).rows.length, 2);
assert.equal(prepareTable('a\tb\n1\t2\n3\n','\t').raggedRows, 1);
const ragged = prepareTable('a,b\n1,2\n3\n', ',');
assert.equal(ragged.raggedRows, 1);
assert.match(core.previewStatus(ragged).tooltip, /1 sampled data row has a different field count/);
assert.equal(prepareTable('a,b\n1,2\n3,4\n', ',').raggedRows, 0);
assert.equal(prepareTable('a,b\n1,2,3\n4,5,6\n', ',').raggedRows, 2);
const clipped = parseDelimited(`name\n${'x'.repeat(600)}\n`, ',');
assert.equal(clipped.rows[1][0].length, 512);
assert.equal(clipped.clippedFields, true);
assert.deepEqual(clipped.clippedFieldColumns.get(1), [0]);
const clippedTable = prepareTable(`value\n${'x'.repeat(600)}\n`, ',');
assert.deepEqual(clippedTable.truncatedFields.get(0), [0]);
assert.equal(clippedTable.truncatedHeader, false);
const clippedHeader = prepareTable(`${'h'.repeat(600)}\na\n`, ',');
assert.equal(clippedHeader.truncatedHeader, true);
const wideInput = `${Array.from({length: 130}, (_, i) => `c${i}`).join(',')}\n${'x,'.repeat(129)}x\n`;
const wideTable = prepareTable(wideInput, ',');
assert.equal(wideTable.headers.length, core.LIMITS.columns);
assert.equal(wideTable.clippedColumns, true);
assert.match(core.previewStatus(wideTable).tooltip, /first 128 columns/);
const partialRecord = prepareTable('id\ncomplete\nunfinished', ',', true, true);
assert.equal(partialRecord.rows.length, 1);
assert.equal(partialRecord.truncatedRows, false);
assert.equal(partialRecord.incompleteRecord, true);
const malformedQuotes = prepareTable('id,note\n1,"unfinished', ',');
assert.equal(malformedQuotes.quoteWarning, true);
assert.match(core.previewStatus(malformedQuotes).tooltip, /unterminated quoted field/i);
assert.equal(typeof core.rowToTsv, 'function');
assert.equal(core.rowToTsv(['TP53', '1.42', '']), 'TP53\t1.42\t');
assert.equal(core.rowToTsv(['a\tb', 'a"b', 'line 1\r\nline 2']),
    '"a\tb"\t"a""b"\t"line 1\r\nline 2"');
assert.equal(core.rowToTsv([]), '');
const copiedSortedRow = sortRows([['B','2'],['A','10']], 1, false, ['text','number'])[1];
assert.equal(core.rowToTsv(copiedSortedRow.cells), 'A\t10');
assert.equal(copiedSortedRow.originalIndex, 1, 'sorting preserves the sampled record identity');
const quotedTsv = core.rowToTsv(['a\tb', 'a"b', 'line 1\r\nline 2', '']);
assert.deepEqual(parseDelimited(`${quotedTsv}\n`, '\t').rows[0], ['a\tb', 'a"b', 'line 1\r\nline 2', '']);
assert.match(core.cellValueStatus({truncatedFields: new Map(), truncatedBytes: false}, 0, 0), /complete field/i);
assert.match(core.cellValueStatus({truncatedFields: new Map([[0,[0]]]), truncatedBytes: false}, 0, 0), /512 characters/i);
assert.match(core.cellValueStatus({truncatedFields: new Map(), truncatedBytes: true,
    incompleteRecord: true}, 0, 0), /trailing partial record was omitted/i);
assert.equal(core.previewStatus({rows:[['x']],headers:['x']}).label, '');
const limitedStatus = core.previewStatus({rows:Array.from({length:10000},()=>['x']),headers:['x'],
    truncatedRows:true,truncatedBytes:true,clippedColumns:true,clippedFields:true,incompleteRecord:true});
assert.equal(limitedStatus.label, 'Preview limited');
assert.match(limitedStatus.tooltip, /bounded file prefix/);
assert.match(limitedStatus.tooltip, /10000 rows shown from the file prefix/);
assert.match(limitedStatus.tooltip, /first 128 columns/);
assert.match(limitedStatus.tooltip, /field.*512 characters/i);
assert.match(limitedStatus.tooltip, /trailing partial record/i);
assert.match(core.previewStatus({rows:[['x']],headers:['x'],cellLimited:true}).tooltip,
    /total cell limit/i);
assert.deepEqual(prepareTable('', ',').headers, []);
console.log('All core parsing, sorting, type inference tests passed.');
