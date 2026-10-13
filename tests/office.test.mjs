import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inflateRawSync} from 'node:zlib';
import {zipEntries,zipEntryCompressed,officeText,officeBlocks,decodeEntities,OFFICE_XML_LIMIT} from '../src/office-core.js';
for (const [file, wanted] of Object.entries({
    'mini.docx': 'Melanoma PBMCs\nTP53 & MYC',
    'mini.pptx': 'Slide 1\nMetastasis',
    'mini.xlsx': 'gene \t 1.1\nTP53',
    'mini.odt': 'Hello World!',
})) {
    const bytes = new Uint8Array(fs.readFileSync(new URL(`./fixtures/${file}`, import.meta.url)));
    const entries = zipEntries(bytes);
    const extracted = name => {
        const part = zipEntryCompressed(bytes, entries, name);
        const raw = part.method ? inflateRawSync(part.bytes) : part.bytes;
        assert.equal(raw.length, part.expected);
        return new TextDecoder().decode(raw);
    };
    const actual = officeText(file, extracted);
    assert.equal(actual, wanted, `${file} preview wrong: ${JSON.stringify(actual)}`);
}
assert.equal(decodeEntities('&#x1F9EC; &amp; &#35;'), '🧬 & #');
assert.throws(() => zipEntries(new Uint8Array([1,2,3])), /Unsupported/);
const zip = new Uint8Array(fs.readFileSync(new URL('./fixtures/mini.docx', import.meta.url)));
const zipMap = zipEntries(zip);
const mainPart = zipMap.get('word/document.xml');
const oversized = new Map(zipMap);
oversized.set('word/document.xml', {...mainPart, uncompressed: OFFICE_XML_LIMIT + 1});
assert.throws(() => zipEntryCompressed(zip, oversized, 'word/document.xml'), /exceeds preview limit/);
const badLocalHeader = zip.slice();
badLocalHeader[mainPart.at + 8] = mainPart.method === 0 ? 8 : 0;
assert.throws(() => zipEntryCompressed(badLocalHeader, zipMap, 'word/document.xml'), /Mismatched ZIP entry header/);
let eocd = -1;
for (let i = zip.length - 22; i >= 0; i--) {
    if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x05 && zip[i + 3] === 0x06) {
        eocd = i; break;
    }
}
assert.ok(eocd >= 0);
const multiDisk = zip.slice();
multiDisk[eocd + 4] = 1;
assert.throws(() => zipEntries(multiDisk), /Multi-disk/);
console.log('Office ZIP parsing and bounded extraction test passed');

// Rich paragraph extraction must preserve hierarchy and inline formatting, not just text.
const documentXML = `<w:document><w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Melanoma analysis</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Results</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>TP53</w:t></w:r><w:r><w:t> changed</w:t></w:r></w:p>
</w:body></w:document>`;
const rich = officeBlocks('test.docx', part => {
    assert.equal(part, 'word/document.xml'); return documentXML;
});
assert.deepEqual(rich.map(x => x.kind), ['title','h1','body']);
assert.deepEqual(rich[2].spans.map(x => [x.text, x.bold]), [['TP53',true],[' changed',false]]);
const many = `<w:document><w:body>${'<w:p><w:r><w:t>A</w:t></w:r></w:p>'.repeat(1000)}</w:body></w:document>`;
assert.equal(officeBlocks('test.docx', () => many).length, 240);
assert.equal(officeBlocks('test.odt', () => '<text:h text:outline-level="1">Summary</text:h>')[0].kind, 'h1');
assert.equal(officeBlocks('test.pptx', () => '<a:p><a:r><a:t>Sample slide</a:t></a:r></a:p>')[0].kind, 'h2');
