/* Sushi Bioinfo Preview: bounded, GTK text-only Office preview. SPDX-License-Identifier: MIT */
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import Gdk from 'gi://Gdk';
import Pango from 'gi://Pango';
import {Renderer, ResizePolicy} from 'resource://org/gnome/NautilusPreviewer/plugin-api-1.js';
/* EMBED_OFFICE_HERE */
// Document canvas styling only; does not change Sushi window chrome.
try {
    const css = new Gtk.CssProvider();
    css.load_from_data('.lab-office-paper { font-size: 15px; font-family: Cantarell, sans-serif; }');
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
} catch (e) { console.warn(`Office typography unavailable: ${e}`); }
Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
function inflateRaw(bytes, expected) {
    if (expected > OFFICE_XML_LIMIT) throw new Error('Document XML too large');
    const source = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(bytes));
    const inflater = new Gio.ZlibDecompressor({format: Gio.ZlibCompressorFormat.RAW});
    const stream = new Gio.ConverterInputStream({base_stream: source, converter: inflater});
    const chunks = []; let total = 0;
    try {
        while (total <= OFFICE_XML_LIMIT) {
            const b = stream.read_bytes(Math.min(8192, OFFICE_XML_LIMIT + 1 - total), null);
            if (!b.get_size()) break;
            const arr = b.get_data(); chunks.push(arr); total += arr.length;
        }
    } finally { try { stream.close(null); } catch (_) {} }
    if (total > OFFICE_XML_LIMIT || total !== expected) throw new Error('Invalid / oversized document XML');
    const buf = new Uint8Array(total); let pos = 0;
    for (const c of chunks) { buf.set(c, pos); pos += c.length; }
    return new TextDecoder().decode(buf);
}
function unpackXML(data, entries, name) {
    const entry = zipEntryCompressed(data, entries, name);
    return entry.method === 0 ? new TextDecoder().decode(entry.bytes) : inflateRaw(entry.bytes, entry.expected);
}
export const Klass = class LabOffice extends Adw.Bin {
    static { GObject.registerClass({Implements: [Renderer]}, this); }
    constructor(file, info, props = {}) {
        super(props);
        const scroller = new Gtk.ScrolledWindow({hexpand: true, vexpand: true,
            min_content_width: 920, min_content_height: 560});
        this.set_child(scroller);
        this._scroller = scroller;
        const view = new Gtk.TextView({editable: false, cursor_visible: false, wrap_mode: Gtk.WrapMode.WORD_CHAR,
            left_margin: 38, right_margin: 32, top_margin: 26, bottom_margin: 30});
        view.add_css_class('lab-office-paper');
        scroller.set_child(view);
        this._view = view;
        if (Number(info?.get_size?.() ?? 0) > OFFICE_ARCHIVE_LIMIT) {
            view.buffer.set_text('Office file exceeds lightweight preview limit (12 MiB). Open it in LibreOffice.', -1);
            this.markReady(); return;
        }
        this._load(file).catch(e => {
            if (!this.cancellable.is_cancelled()) {
                view.buffer.set_text(`Office preview unavailable: ${e.message}\nOpen in LibreOffice for full fidelity.`, -1);
                this.markReady();
            }
        });
    }
    get resizePolicy() { return ResizePolicy.NAT_SIZE; }
    get topBarStyle() { return Adw.ToolbarStyle.FLAT; }
    async _load(file) {
        const input = await file.read_async(GLib.PRIORITY_DEFAULT, this.cancellable);
        const chunks = []; let length = 0; let eof = false;
        try {
            while (length <= OFFICE_ARCHIVE_LIMIT) {
                const bytes = await input.read_bytes_async(Math.min(65536, OFFICE_ARCHIVE_LIMIT + 1 - length),
                    GLib.PRIORITY_DEFAULT, this.cancellable);
                if (!bytes.get_size()) { eof = true; break; }
                const d = bytes.get_data(); chunks.push(d); length += d.length;
            }
        } finally { try { input.close(null); } catch (_) {} }
        if (this.cancellable.is_cancelled()) return;
        if (!eof || length > OFFICE_ARCHIVE_LIMIT) throw new Error('Office file exceeds 12 MiB limit');
        const data = new Uint8Array(length); let p = 0;
        for (const c of chunks) { data.set(c, p); p += c.length; }
        const entries = zipEntries(data);
        let budget = 0;
        const extract = name => {
            if (budget >= 3 * OFFICE_XML_LIMIT) throw new Error('Document processing limit');
            const xml = unpackXML(data, entries, name);
            budget += xml.length;
            if (budget > 3 * OFFICE_XML_LIMIT) throw new Error('Document processing limit');
            return xml;
        };
        const blocks = officeBlocks(file.get_basename(), extract);
        try { renderOfficeBlocks(this._view.buffer, blocks); }
        catch (styleError) {
            console.warn(`Office rich text fallback: ${styleError}`);
            this._view.buffer.set_text(blocks.map(b => b.spans.map(s => s.text).join('')).join('\n') || '(Empty document)', -1);
        }
        this.markReady();
    }

};
export const contentTypes = [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.text-template',
    'application/vnd.ms-word.document.macroEnabled.12',
    'application/vnd.ms-excel.sheet.macroEnabled.12',
    'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
];
