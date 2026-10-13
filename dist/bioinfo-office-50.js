/* Sushi Bioinfo Preview: GTK3 bounded Office fallback. SPDX-License-Identifier: MIT */
const {Gio, GLib, GObject, Gtk, Pango} = imports.gi;
const Renderer = imports.ui.renderer;
/* Minimal OOXML/OpenDocument text extraction; no external converter.
 * STRICT LIMITS: archive <= 12 MiB, each extracted XML <= 512 KiB,
 * <= 3 entries, <= 1.5 MiB cumulative expanded XML.
 * Not a pixel-accurate Office renderer. SPDX-License-Identifier: MIT.
 */
const OFFICE_ARCHIVE_LIMIT = 12 * 1024 * 1024;
const OFFICE_XML_LIMIT = 512 * 1024;
const utf8 = new TextDecoder('utf-8');
const u16 = (d, p) => d[p] | d[p + 1] << 8;
const u32 = (d, p) => (d[p] | d[p + 1] << 8 | d[p + 2] << 16 | d[p + 3] << 24) >>> 0;

function zipEntries(data) {
    // Always parse the central directory; local headers may use data descriptors.
    let end = -1;
    const start = Math.max(0, data.length - 65557);
    for (let i = data.length - 22; i >= start; i--) {
        if (u32(data, i) === 0x06054b50 && i + 22 + u16(data, i + 20) === data.length) {
            end = i; break;
        }
    }
    if (end < 0) throw new Error('Unsupported Office archive');
    const disk = u16(data, end + 4), directoryDisk = u16(data, end + 6);
    const diskEntries = u16(data, end + 8), n = u16(data, end + 10);
    const size = u32(data, end + 12), offset = u32(data, end + 16);
    if (n === 65535 || size === 0xffffffff || offset === 0xffffffff || n > 5000)
        throw new Error('ZIP64 / unusually complex archive not supported');
    if (disk || directoryDisk || diskEntries !== n) throw new Error('Multi-disk ZIP archives are not supported');
    const directoryEnd = offset + size;
    if (directoryEnd > end) throw new Error('Incomplete ZIP directory');
    const entries = new Map();
    let p = offset;
    for (let i = 0; i < n; i++) {
        if (p + 46 > directoryEnd || u32(data, p) !== 0x02014b50) throw new Error('Damaged ZIP directory');
        const flags = u16(data, p + 8), method = u16(data, p + 10);
        const compressed = u32(data, p + 20), uncompressed = u32(data, p + 24);
        const len = u16(data, p + 28), extra = u16(data, p + 30), comment = u16(data, p + 32);
        const startDisk = u16(data, p + 34), at = u32(data, p + 42);
        if (startDisk || p + 46 + len + extra + comment > directoryEnd)
            throw new Error('Damaged ZIP entry');
        const name = utf8.decode(data.subarray(p + 46, p + 46 + len));
        if (entries.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
        entries.set(name, {flags, method, compressed, uncompressed, at});
        p += 46 + len + extra + comment;
    }
    return entries;
}
function zipEntryCompressed(data, entries, name) {
    const e = entries.get(name);
    if (!e) throw new Error(`Missing document part: ${name}`);
    if ((e.flags & 1) !== 0) throw new Error('Encrypted Office document');
    if (e.uncompressed > OFFICE_XML_LIMIT || e.compressed > OFFICE_XML_LIMIT)
        throw new Error('Document XML exceeds preview limit');
    if (e.method !== 0 && e.method !== 8) throw new Error('Unsupported ZIP compression');
    if (e.method === 0 && e.compressed !== e.uncompressed) throw new Error('Invalid stored ZIP entry');
    const p = e.at;
    if (p + 30 > data.length || u32(data, p) !== 0x04034b50) throw new Error('Invalid ZIP entry');
    const flags = u16(data, p + 6), method = u16(data, p + 8);
    const nameLength = u16(data, p + 26), extraLength = u16(data, p + 28);
    const localName = utf8.decode(data.subarray(p + 30, p + 30 + nameLength));
    if ((flags & 1) !== 0 || flags !== e.flags || method !== e.method || localName !== name)
        throw new Error('Mismatched ZIP entry header');
    const start = p + 30 + nameLength + extraLength;
    if (start + e.compressed > data.length) throw new Error('Truncated ZIP entry');
    return {bytes: data.subarray(start, start + e.compressed), method: e.method, expected: e.uncompressed};
}
function decodeEntities(t) {
    return t.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|amp|lt|gt|quot|apos);/gi, (match, hex, dec) => {
        if (hex || dec) {
            const num = parseInt(hex || dec, hex ? 16 : 10);
            return num > 0 && num <= 0x10ffff && !(num >= 0xd800 && num <= 0xdfff)
                ? String.fromCodePoint(num) : '';
        }
        return {'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[match.toLowerCase()] ?? match;
    });
}
function textFromTaggedXML(xml, para, textTag) {
    const blocks = xml.match(para) ?? [];
    const out = [];
    const re = textTag;
    for (const b of blocks.slice(0, 1500)) {
        re.lastIndex = 0;
        const parts = [];
        let m;
        while ((m = re.exec(b)) !== null) parts.push(decodeEntities(m[1] ?? m[2] ?? ''));
        const line = parts.join('');
        if (line.trim()) out.push(line.trim());
    }
    return out.join('\n').slice(0, OFFICE_XML_LIMIT);
}
function officeText(name, fetchXml) {
    name = name.toLowerCase();
    if (name.endsWith('.docx') || name.endsWith('.docm')) {
        const xml = fetchXml('word/document.xml');
        return textFromTaggedXML(xml, /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g,
            /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g);
    }
    if (name.endsWith('.odt') || name.endsWith('.ott')) {
        const xml = fetchXml('content.xml');
        return (xml.match(/<text:(?:p|h)(?:\s[^>]*)?>[\s\S]*?<\/text:(?:p|h)>/g) ?? [])
            .slice(0, 1500).map(block => decodeEntities(block.replace(/<text:tab[^>]*\/>/g, '\t')
                .replace(/<[^>]*>/g, '')).trim()).filter(Boolean).join('\n').slice(0, OFFICE_XML_LIMIT);
    }
    if (name.endsWith('.pptx') || name.endsWith('.pptm')) {
        const sections = [];
        for (let i = 1; i <= 3; i++) {
            let xml;
            try { xml = fetchXml(`ppt/slides/slide${i}.xml`); } catch { break; }
            sections.push(`Slide ${i}\n` + textFromTaggedXML(xml, /<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g,
                /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g));
        }
        return sections.join('\n\n');
    }
    if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) {
        let shared = [];
        try {
            const strings = fetchXml('xl/sharedStrings.xml');
            const matches = strings.match(/<si(?:\s[^>]*)?>[\s\S]*?<\/si>/g) ?? [];
            shared = matches.slice(0, 3000).map(s => {
                const words = [];
                for (const m of s.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) words.push(decodeEntities(m[1]));
                return words.join('');
            });
        } catch (_) { /* inline strings only */ }
        const sheet = fetchXml('xl/worksheets/sheet1.xml');
        const lines = [];
        for (const row of (sheet.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) ?? []).slice(0, 80)) {
            const cells = [];
            for (const cell of (row.match(/<c\b[^>]*>[\s\S]*?<\/c>/g) ?? []).slice(0, 16)) {
                const val = /<v>([\s\S]*?)<\/v>/.exec(cell)?.[1] ?? /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(cell)?.[1] ?? '';
                cells.push(/<c\b[^>]*\bt="s"/.test(cell) ? (shared[Number(val)] ?? val) : decodeEntities(val));
            }
            if (cells.length) lines.push(cells.join(' \t '));
        }
        return lines.join('\n');
    }
    throw new Error('Not a supported Office document');
}

/* Presentation-only structure for the bounded Office fallback.
 * This is intentionally a lightweight XML preview, not a Word layout engine.
 * It never reads more ZIP members than officeText(), and creates <= 240 blocks.
 */
function officeBlocks(name, fetchXml) {
    const lower = String(name).toLowerCase();
    const blocks = [];
    const MAX_BLOCKS = 240;
    const MAX_CHARS = 30000;
    let charBudget = MAX_CHARS;
    const add = (kind, spans) => {
        if (blocks.length >= MAX_BLOCKS || charBudget <= 0) return;
        const packed = [];
        for (const s of spans) {
            if (charBudget <= 0 || packed.length >= 120) break;
            const value = String(s.text ?? '').slice(0, Math.min(1400, charBudget));
            if (!value) continue;
            charBudget -= value.length;
            const bold = !!s.bold, italic = !!s.italic;
            const last = packed[packed.length - 1];
            if (last && last.bold === bold && last.italic === italic)
                last.text += value;
            else packed.push({text: value, bold, italic});
        }
        if (packed.some(s => s.text.trim())) blocks.push({kind, spans: packed});
    };
    const plain = text => [{text, bold: false, italic: false}];
    if (lower.endsWith('.docx') || lower.endsWith('.docm')) {
        const xml = fetchXml('word/document.xml');
        const paragraphs = xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) ?? [];
        for (const p of paragraphs.slice(0, MAX_BLOCKS * 2)) {
            const style = /<w:pStyle\b[^>]*\bw:val=["']([^"']+)/.exec(p)?.[1] ?? '';
            let kind = /^title$/i.test(style) ? 'title'
                : /^subtitle$/i.test(style) ? 'subtitle'
                : /^heading\s*1$/i.test(style) ? 'h1'
                : /^heading\s*2$/i.test(style) ? 'h2'
                : /^heading\s*[3-9]$/i.test(style) ? 'h3'
                : 'body';
            if (/<w:numPr\b/.test(p) || /^List/.test(style)) kind = 'list';
            const runs = p.match(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g) ?? [];
            const spans = [];
            if (kind === 'list') spans.push({text: '•  '});
            for (const run of runs.slice(0, 120)) {
                const words = [];
                const parts = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?\s*>|<w:br\b[^>]*\/?\s*>/g;
                let match;
                while ((match = parts.exec(run)) !== null) {
                    words.push(match[1] === undefined ? (match[0].startsWith('<w:tab') ? '\t' : '\n') : decodeEntities(match[1]));
                }
                const content = words.join('');
                if (!content) continue;
                const bold = /<w:b(?:\s|\/>|>)/.test(run) &&
                    !/<w:b\b[^>]*\bw:val=["'](?:0|false|off)["']/.test(run);
                const italic = /<w:i(?:\s|\/>|>)/.test(run) &&
                    !/<w:i\b[^>]*\bw:val=["'](?:0|false|off)["']/.test(run);
                spans.push({text: content, bold, italic});
            }
            // Some producers place visible text outside standard <w:r> blocks.
            if (!spans.some(s => s.text?.trim())) {
                const words = [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
                    .map(m => decodeEntities(m[1]));
                spans.push(...plain(words.join('')));
            }
            add(kind, spans);
            if (blocks.length >= MAX_BLOCKS) break;
        }
        return blocks;
    }
    if (lower.endsWith('.odt') || lower.endsWith('.ott')) {
        const xml = fetchXml('content.xml');
        const paras = xml.match(/<text:(?:p|h)(?:\s[^>]*)?>[\s\S]*?<\/text:(?:p|h)>/g) ?? [];
        for (const p of paras.slice(0, MAX_BLOCKS)) {
            const outline = /text:outline-level=["'](\d+)/.exec(p)?.[1];
            const kind = outline ? (Number(outline) === 1 ? 'h1' : 'h2') : 'body';
            const txt = decodeEntities(p.replace(/<text:tab\b[^>]*\/>/g, '\t')
                .replace(/<text:line-break\b[^>]*\/>/g, '\n').replace(/<[^>]*>/g, ''));
            add(kind, plain(txt));
        }
        return blocks;
    }
    if (lower.endsWith('.pptx') || lower.endsWith('.pptm')) {
        for (let i = 1; i <= 3; i++) {
            let xml;
            try { xml = fetchXml(`ppt/slides/slide${i}.xml`); } catch { break; }
            add('h2', plain(`Slide ${i}`));
            const paras = xml.match(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g) ?? [];
            for (const [index, p] of paras.entries()) {
                const runs = [...p.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
                    .map(m => decodeEntities(m[1]));
                add(index === 0 ? 'subtitle' : 'body', plain(runs.join('')));
            }
        }
        return blocks;
    }
    if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
        const txt = officeText(name, fetchXml);
        add('subtitle', plain('Sheet 1'));
        for (const [i, row] of txt.split('\n').slice(0, 80).entries())
            add(i === 0 ? 'sheethead' : 'sheetrow', plain(row));
        return blocks;
    }
    throw new Error('Not a supported Office document');
}

/* Shared GtkTextBuffer formatter for Office structured previews.
 * Called only with the bounded output of officeBlocks().
 */
function renderOfficeBlocks(buffer, blocks) {
    const tagSpecs = {
        title: {weight: 700, scale: 1.55, pixels_above_lines: 11, pixels_below_lines: 11},
        subtitle: {weight: 600, scale: 1.16, pixels_above_lines: 8, pixels_below_lines: 8},
        h1: {weight: 700, scale: 1.32, pixels_above_lines: 12, pixels_below_lines: 6},
        h2: {weight: 700, scale: 1.18, pixels_above_lines: 10, pixels_below_lines: 5},
        h3: {weight: 700, scale: 1.06, pixels_above_lines: 7, pixels_below_lines: 4},
        body: {pixels_below_lines: 7},
        list: {left_margin: 18, pixels_below_lines: 5},
        sheethead: {weight: 700, family: 'monospace', pixels_below_lines: 5},
        sheetrow: {family: 'monospace', pixels_below_lines: 3},
    };
    const tags = {};
    // gtk_text_buffer_create_tag() is varargs and unavailable to GJS bindings.
    // Construct Gtk.TextTag explicitly, then register it in the buffer's table.
    const table = buffer.get_tag_table();
    const makeTag = (name, properties) => {
        const tag = new Gtk.TextTag({name, ...properties});
        table.add(tag);
        return tag;
    };
    for (const [kind, properties] of Object.entries(tagSpecs))
        tags[kind] = makeTag(`lab-${kind}`, properties);
    const bold = makeTag('lab-bold', {weight: 700});
    const italic = makeTag('lab-italic', {style: Pango.Style.ITALIC});
    const pieces = [];
    const ranges = [];
    let off = 0;
    for (const block of blocks.slice(0, 240)) {
        const start = off;
        for (const span of block.spans ?? []) {
            if (off >= 30000) break;
            const value = String(span.text ?? '').slice(0, 30000 - off);
            const len = Array.from(value).length; // GtkTextIter counts Unicode characters, not UTF-16 units.
            if (!len) continue;
            pieces.push(value);
            if (span.bold) ranges.push([off, off + len, bold]);
            if (span.italic) ranges.push([off, off + len, italic]);
            off += len;
        }
        if (off > start) {
            ranges.push([start, off, tags[block.kind] ?? tags.body]);
            pieces.push('\n'); off++;
        }
        if (off >= 30000) break;
    }
    buffer.set_text(pieces.join('') || '(No readable document text)', -1);
    for (const [from, to, tag] of ranges)
        buffer.apply_tag(tag, buffer.get_iter_at_offset(from), buffer.get_iter_at_offset(to));
}

function inflateRaw(bytes, expected) {
    if (expected > OFFICE_XML_LIMIT) throw new Error('Document XML too large');
    const source = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(bytes));
    const inflater = new Gio.ZlibDecompressor({format: Gio.ZlibCompressorFormat.RAW});
    const stream = new Gio.ConverterInputStream({base_stream: source, converter: inflater});
    const parts = []; let n = 0;
    try {
        while (n <= OFFICE_XML_LIMIT) {
            const b = stream.read_bytes(Math.min(8192, OFFICE_XML_LIMIT + 1 - n), null);
            if (!b.get_size()) break;
            const item = b.get_data(); parts.push(item); n += item.length;
        }
    } finally { try { stream.close(null); } catch (_) {} }
    if (n > OFFICE_XML_LIMIT || n !== expected) throw new Error('Invalid / oversized document XML');
    const total = new Uint8Array(n); let pos = 0;
    for (const c of parts) { total.set(c, pos); pos += c.length; }
    return new TextDecoder().decode(total);
}
function unpackXML(data, entries, name) {
    const part = zipEntryCompressed(data, entries, name);
    return part.method === 0 ? new TextDecoder().decode(part.bytes) : inflateRaw(part.bytes, part.expected);
}
var Klass = GObject.registerClass({
    Implements: [Renderer.Renderer],
    Properties: {
        fullscreen: GObject.ParamSpec.boolean('fullscreen', '', '', GObject.ParamFlags.READABLE, false),
        ready: GObject.ParamSpec.boolean('ready', '', '', GObject.ParamFlags.READABLE, false),
    },
}, class LabOffice extends Gtk.ScrolledWindow {
    get ready() { return !!this._ready; }
    get fullscreen() { return false; }
    get moveOnClick() { return false; }
    _init(file) {
        super._init({visible: true, hexpand: true, vexpand: true,
            min_content_width: 920, min_content_height: 560});
        this._cancellable = new Gio.Cancellable();
        this.connect('destroy', () => this._cancellable.cancel());
        this._view = new Gtk.TextView({visible: true, editable: false, cursor_visible: false,
            wrap_mode: Gtk.WrapMode.WORD_CHAR, left_margin: 38, right_margin: 32, top_margin: 26, bottom_margin: 30});
        this._view.override_font(Pango.FontDescription.from_string('Sans 12'));
        this.add(this._view);
        this._load(file);
    }
    _done() { if (!this._ready) { this._ready = true; this.isReady(); } }
    _message(text) { this._view.get_buffer().set_text(text, -1); this._done(); }
    _load(file) {
        file.read_async(GLib.PRIORITY_DEFAULT, this._cancellable, (f, res) => {
            let stream;
            try { stream = f.read_finish(res); } catch (e) { this._message(e.message); return; }
            const chunks = []; let n = 0;
            const finish = (complete) => {
                try { stream.close(null); } catch (_) {}
                if (!complete || n > OFFICE_ARCHIVE_LIMIT) {
                    this._message('Office file exceeds 12 MiB lightweight preview limit. Open in LibreOffice.'); return;
                }
                const all = new Uint8Array(n); let pos = 0;
                for (const c of chunks) { all.set(c, pos); pos += c.length; }
                try {
                    const entries = zipEntries(all); let budget = 0;
                    const part = name => {
                        const xml = unpackXML(all, entries, name);
                        budget += xml.length;
                        if (budget > 3 * OFFICE_XML_LIMIT) throw new Error('Document processing limit');
                        return xml;
                    };
                    const blocks = officeBlocks(file.get_basename(), part);
                    try { renderOfficeBlocks(this._view.get_buffer(), blocks); }
                    catch (styleError) {
                        log(`Office rich text fallback: ${styleError}`);
                        this._view.get_buffer().set_text(blocks.map(b => b.spans.map(s => s.text).join('')).join('\n') || '(Empty document)', -1);
                    }
                    this._done();
                } catch (e) { this._message(`Office preview unavailable: ${e.message}\nOpen in LibreOffice for full formatting.`); }
            };
            const next = () => {
                if (this._cancellable.is_cancelled()) return;
                if (n > OFFICE_ARCHIVE_LIMIT) { finish(false); return; }
                stream.read_bytes_async(Math.min(65536, OFFICE_ARCHIVE_LIMIT + 1 - n), GLib.PRIORITY_DEFAULT,
                    this._cancellable, (input, result) => {
                        try {
                            const b = input.read_bytes_finish(result);
                            if (!b.get_size()) { finish(true); return; }
                            const part = b.get_data(); chunks.push(part); n += part.length; next();
                        } catch (e) { this._message(e.message); }
                    });
            };
            next();
        });
    }
});
var mimeTypes = [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.text-template',
    'application/vnd.ms-word.document.macroEnabled.12',
    'application/vnd.ms-excel.sheet.macroEnabled.12',
    'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
];
