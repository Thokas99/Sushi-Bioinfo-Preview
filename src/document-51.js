/* Sushi Bioinfo Preview — GTK4 Markdown, local-only preview. MIT */
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import {Renderer, ResizePolicy} from 'resource://org/gnome/NautilusPreviewer/plugin-api-1.js';
/* EMBED_DOC_HERE */
Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
let WebKit = null;
try { WebKit = (await import('gi://WebKit?version=6.0')).default; } catch (_) {}
try {
    const css = new Gtk.CssProvider();
    css.load_from_data('.lab-document-mini button { min-height: 22px; min-width: 40px; padding: 0px 5px; font-size: 11px; }');
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
} catch (e) { console.warn(`Compact document styling not applied: ${e}`); }

export const Klass = class LabDocument extends Adw.Bin {
    static { GObject.registerClass({Implements: [Renderer]}, this); }
    constructor(file, fileInfo, props = {}) {
        super(props);
        this._size = Number(fileInfo?.get_size?.() ?? 0);
        const outer = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 0, hexpand: true, vexpand: true});
        this.set_child(outer);
        const bar = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 2,
            margin_top: 1, margin_bottom: 1, margin_start: 4, margin_end: 4});
        bar.add_css_class('lab-document-mini');
        outer.append(bar);
        this._status = new Gtk.Label({label: '', xalign: 0, hexpand: true});
        this._status.add_css_class('dim-label');
        bar.append(this._status);
        this._stack = new Gtk.Stack({hexpand: true, vexpand: true});
        this._stack.set_transition_type(Gtk.StackTransitionType.NONE);
        this._toggle = new Gtk.Button({label: 'Source', has_frame: false,
            tooltip_text: 'Toggle source / rendered preview'});
        this._toggle.connect('clicked', () => {
            const raw = this._stack.get_visible_child_name() === 'source';
            this._stack.set_visible_child_name(raw && WebKit ? 'preview' : 'source');
            this._toggle.set_label(this._stack.get_visible_child_name() === 'source' ? 'Preview' : 'Source');
        });
        bar.append(this._toggle);
        outer.append(this._stack);
        this._source = new Gtk.TextView({editable: false, cursor_visible: false,
            monospace: true, wrap_mode: Gtk.WrapMode.NONE,
            left_margin: 8, top_margin: 8, right_margin: 8, bottom_margin: 8});
        const sourceScroll = new Gtk.ScrolledWindow({hexpand: true, vexpand: true,
            min_content_width: 920, min_content_height: 560});
        sourceScroll.set_child(this._source);
        if (WebKit) {
            this._web = new WebKit.WebView({hexpand: true, vexpand: true});
            const settings = this._web.get_settings();
            settings.set_enable_javascript(false);
            settings.set_enable_html5_database(false);
            settings.set_enable_html5_local_storage(false);
            this._web.connect('decide-policy', (_view, decision, kind) => {
                if (kind === WebKit.PolicyDecisionType.NAVIGATION_ACTION) {
                    const uri = decision.get_navigation_action().get_request().get_uri();
                    if (!uri.startsWith('about:')) { decision.ignore(); return true; }
                }
                return false;
            });
            this._stack.add_titled(this._web, 'preview', 'Preview');
        } else {
            const missing = new Gtk.Label({label: 'WebKit is unavailable; select Source.', wrap: true,
                xalign: 0, margin_start: 20, margin_end: 20});
            this._stack.add_titled(missing, 'preview', 'Preview');
        }
        this._stack.add_titled(sourceScroll, 'source', 'Source');
        this._stack.set_visible_child_name(WebKit ? 'preview' : 'source');
        this._toggle.set_label(WebKit ? 'Source' : 'Preview');
        this._toggle.set_sensitive(!!WebKit);
        this._load(file).catch(e => {
            if (this.cancellable.is_cancelled()) return;
            console.error(`Lab document preview: ${e}`);
            this._source.get_buffer().set_text(`Preview unavailable: ${e.message}`, -1);
            this._stack.set_visible_child_name('source');
            this.markReady();
        });
    }
    get resizePolicy() { return ResizePolicy.NAT_SIZE; }
    get topBarStyle() { return Adw.ToolbarStyle.FLAT; }
    cleanup() { this._web?.stop_loading(); }
    async _load(file) {
        const input = await file.read_async(GLib.PRIORITY_DEFAULT, this.cancellable);
        const chunks = []; let n = 0; let eof = false;
        try {
            while (n < DOC_LIMIT) {
                const b = await input.read_bytes_async(Math.min(32768, DOC_LIMIT - n), GLib.PRIORITY_DEFAULT, this.cancellable);
                if (!b.get_size()) { eof = true; break; }
                const buf = b.get_data(); chunks.push(buf); n += buf.length;
            }
        } finally { try { input.close(null); } catch (_) {} }
        if (this.cancellable.is_cancelled()) return;
        const bytes = new Uint8Array(n);
        let pos = 0; for (const c of chunks) { bytes.set(c, pos); pos += c.length; }
        const raw = new TextDecoder('utf-8').decode(bytes);
        this._source.get_buffer().set_text(raw, -1);
        if (this._web) {
            const html = markdownDocument(raw);
            this._web.load_html(html, 'about:blank');
        }
        if (!eof && (this._size <= 0 || this._size > n)) this._status.set_label('·');
        this._status.set_tooltip_text('Partial preview when marked ·');
        this.markReady();
    }
};
export const contentTypes = [
    'text/x-sushi-markdown', 'text/markdown', 'text/x-markdown',

];
