/* Sushi Bioinfo Preview: GTK3 bounded Office fallback. SPDX-License-Identifier: MIT */
const {Gio, GLib, GObject, Gtk, Pango} = imports.gi;
const Renderer = imports.ui.renderer;
/* EMBED_OFFICE_HERE */
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
