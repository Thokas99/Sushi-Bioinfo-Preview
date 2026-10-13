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
