import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Unit-test GJS formatter logic without requiring GTK display/Flatpak in CI.
const tags = [];
const Gtk = {TextTag: class {constructor(props) {Object.assign(this, props);}}};
const Pango = {Style: {ITALIC: 2}};
class MockBuffer {
    constructor() {this.tags = []; this.applied = []; this.text = '';}
    get_tag_table() {return {add: tag => {this.tags.push(tag); return true;}};}
    set_text(txt) {this.text = txt;}
    get_iter_at_offset(offset) {return {offset};}
    apply_tag(tag, a, b) {this.applied.push([tag.name,a.offset,b.offset]);}
}
const source = fs.readFileSync(new URL('../src/office-style.js', import.meta.url),'utf-8');
vm.runInNewContext(source + '\nglobalThis.renderOfficeBlocks = renderOfficeBlocks;', {Gtk,Pango,globalThis:globalThis});
const b = new MockBuffer();
globalThis.renderOfficeBlocks(b, [
    {kind:'title', spans:[{text:'Study 🧬',bold:true}]},
    {kind:'body', spans:[{text:'MYC',bold:true},{text:' expression',italic:true}]},
]);
assert.equal(b.text,'Study 🧬\nMYC expression\n');
assert.ok(b.tags.some(t=>t.name==='lab-title' && t.scale > 1.4));
assert.ok(b.applied.some(([tag,start,end])=>tag==='lab-bold' && start===0 && end===7));
assert.ok(b.applied.some(([tag,start,end])=>tag==='lab-italic' && start===11 && end===22));
console.log('Rich Office display tags and Unicode offsets passed');
