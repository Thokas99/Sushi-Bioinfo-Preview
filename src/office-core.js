/* Minimal OOXML/OpenDocument text extraction; no external converter.
 * STRICT LIMITS: archive <= 12 MiB, each extracted XML <= 512 KiB,
 * <= 3 entries, <= 1.5 MiB cumulative expanded XML.
 * Not a pixel-accurate Office renderer. SPDX-License-Identifier: MIT.
 */
export const OFFICE_ARCHIVE_LIMIT = 12 * 1024 * 1024;
export const OFFICE_XML_LIMIT = 512 * 1024;
const utf8 = new TextDecoder('utf-8');
const u16 = (d, p) => d[p] | d[p + 1] << 8;
const u32 = (d, p) => (d[p] | d[p + 1] << 8 | d[p + 2] << 16 | d[p + 3] << 24) >>> 0;

export function zipEntries(data) {
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
export function zipEntryCompressed(data, entries, name) {
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
export function decodeEntities(t) {
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
export function officeText(name, fetchXml) {
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
export function officeBlocks(name, fetchXml) {
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
