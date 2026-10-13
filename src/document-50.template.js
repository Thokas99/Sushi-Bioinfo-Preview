/* Sushi Bioinfo Preview — GTK3 Markdown viewer. MIT */
const {Gio, GLib, GObject, Gtk} = imports.gi;
const ByteArray = imports.byteArray;
const Renderer = imports.ui.renderer;
/* EMBED_DOC_HERE */
let WebKit2;
try { imports.gi.versions.WebKit2 = '4.1'; WebKit2 = imports.gi.WebKit2; } catch (_) { WebKit2 = null; }
var Klass = GObject.registerClass({
    Implements: [Renderer.Renderer],
    Properties: {
        fullscreen: GObject.ParamSpec.boolean('fullscreen', '', '', GObject.ParamFlags.READABLE, false),
        ready: GObject.ParamSpec.boolean('ready', '', '', GObject.ParamFlags.READABLE, false),
    },
}, class LabDocument extends Gtk.Box {
    get ready() { return !!this._ready; }
    get fullscreen() { return false; }
    get moveOnClick() { return false; }
    _init(file) {
        super._init({orientation: Gtk.Orientation.VERTICAL, spacing: 0, visible: true});
        this._cancellable = new Gio.Cancellable();
        this.connect('destroy', () => {
            this._cancellable.cancel();
            try { this._web?.stop_loading(); } catch (_) {}
        });
        const bar = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, visible: true,
            spacing: 2, border_width: 2});
        this.pack_start(bar, false, false, 0);
        this._status = new Gtk.Label({label: '', visible: true, xalign: 0, hexpand: true});
        bar.pack_start(this._status, true, true, 0);
        this._stack = new Gtk.Stack({visible: true, hexpand: true, vexpand: true});
        this._toggle = new Gtk.Button({label: 'Source', visible: true, relief: Gtk.ReliefStyle.NONE});
        this._toggle.connect('clicked', () => {
            const source = this._stack.get_visible_child_name() === 'source';
            this._stack.set_visible_child_name(source && WebKit2 ? 'preview' : 'source');
            this._toggle.set_label(this._stack.get_visible_child_name() === 'source' ? 'Preview' : 'Source');
        });
        bar.pack_end(this._toggle, false, false, 0);
        this.pack_start(this._stack, true, true, 0);
        this._source = new Gtk.TextView({visible: true, editable: false, cursor_visible: false,
            monospace: true, wrap_mode: Gtk.WrapMode.NONE,
            left_margin: 8, right_margin: 8, top_margin: 8, bottom_margin: 8});
        const sourceScroll = new Gtk.ScrolledWindow({visible: true, hexpand: true, vexpand: true,
            min_content_width: 920, min_content_height: 560});
        sourceScroll.add(this._source);
        if (WebKit2) {
            this._web = new WebKit2.WebView({visible: true, hexpand: true, vexpand: true});
            const settings = this._web.get_settings();
            settings.set_enable_javascript(false);
            settings.set_enable_html5_database(false);
            settings.set_enable_html5_local_storage(false);
            this._web.connect('decide-policy', (_view, decision, kind) => {
                if (kind === WebKit2.PolicyDecisionType.NAVIGATION_ACTION) {
                    const uri = decision.get_navigation_action().get_request().get_uri();
                    if (!uri.startsWith('about:')) { decision.ignore(); return true; }
                }
                return false;
            });
            this._stack.add_titled(this._web, 'preview', 'Preview');
        } else {
            this._stack.add_titled(new Gtk.Label({label: 'WebKit unavailable', visible: true}), 'preview', 'Preview');
        }
        this._stack.add_titled(sourceScroll, 'source', 'Source');
        this._stack.set_visible_child_name(WebKit2 ? 'preview' : 'source');
        this._toggle.set_sensitive(!!WebKit2);
        this._load(file); this.show_all();
    }
    _done() { if (!this._ready) { this._ready = true; this.isReady(); } }
    _load(file) {
        file.read_async(GLib.PRIORITY_DEFAULT, this._cancellable, (f, res) => {
            let stream;
            try { stream = f.read_finish(res); } catch (e) { this._fail(e); return; }
            let n = 0, eof = false; const chunks = [];
            const finish = () => {
                try { stream.close(null); } catch (_) {}
                const bytes = new Uint8Array(n); let at = 0;
                for (const part of chunks) { bytes.set(part, at); at += part.length; }
                const raw = ByteArray.toString(bytes);
                this._source.get_buffer().set_text(raw, -1);
                if (this._web) this._web.load_html(markdownDocument(raw), 'about:blank');
                if (!eof) this._status.set_text('·');
                this._done();
            };
            const next = () => {
                if (this._cancellable.is_cancelled()) return;
                if (n >= DOC_LIMIT) { finish(); return; }
                stream.read_bytes_async(Math.min(32768, DOC_LIMIT - n), GLib.PRIORITY_DEFAULT,
                    this._cancellable, (input, result) => {
                        try {
                            const b = input.read_bytes_finish(result);
                            if (!b.get_size()) { eof = true; finish(); return; }
                            const part = b.get_data(); chunks.push(part); n += part.length; next();
                        } catch (e) { this._fail(e); }
                    });
            };
            next();
        });
    }
    _fail(e) {
        if (this._cancellable.is_cancelled()) return;
        this._source.get_buffer().set_text(`Preview unavailable: ${e.message}`, -1);
        this._stack.set_visible_child_name('source'); this._done();
    }
});
var mimeTypes = [
    'text/x-sushi-markdown','text/markdown','text/x-markdown',

];
