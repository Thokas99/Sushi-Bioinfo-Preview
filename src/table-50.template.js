/* Sushi Bioinfo Preview — native GTK3 tree table. SPDX-License-Identifier: MIT */
const {Gio, GLib, GObject, Gtk, Pango} = imports.gi;
const ByteArray = imports.byteArray;
const Renderer = imports.ui.renderer;
/* EMBED_CORE_HERE */
/* EMBED_FORMAT_HERE */
const shortText = value => String(value ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 180);
var Klass = GObject.registerClass({
    Implements: [Renderer.Renderer],
    Properties: {
        fullscreen: GObject.ParamSpec.boolean('fullscreen', '', '', GObject.ParamFlags.READABLE, false),
        ready: GObject.ParamSpec.boolean('ready', '', '', GObject.ParamFlags.READABLE, false),
    },
}, class LabTable extends Gtk.Box {
    get ready() { return !!this._ready; }
    get fullscreen() { return false; }
    get moveOnClick() { return false; }
    _init(file) {
        super._init({orientation: Gtk.Orientation.VERTICAL, spacing: 1, border_width: 3, visible: true});
        this._file = file;
        this._name = file.get_basename(); this._format = formatFromName(this._name);
        this._cancellable = new Gio.Cancellable();
        this._sortColumn = null; this._descending = false;
        this.connect('destroy', () => this._cancellable.cancel());
        this._build(); this._load();
    }
    _build() {
        this._hint = new Gtk.Label({label: '', xalign: 1, visible: true,
            halign: Gtk.Align.END, ellipsize: Pango.EllipsizeMode.END, max_width_chars: 120,
            margin_end: 8});
        this._hint.set_tooltip_text('The preview reads a bounded prefix of the file.');
        this.pack_start(this._hint, false, false, 0);
        this._scroll = new Gtk.ScrolledWindow({visible: true, hexpand: true, vexpand: true,
            min_content_width: 960, min_content_height: 560,
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC});
        this.pack_start(this._scroll, true, true, 0);
        this.show_all();
        this._hint.hide();
    }
    _readyNow() { if (!this._ready) { this._ready = true; this.isReady(); } }
    _message(s) {
        this._hint.hide();
        if (this._scroll.get_child()) this._scroll.remove(this._scroll.get_child());
        this._scroll.add(new Gtk.Label({label: String(s), visible: true, xalign: 0}));
        this._scroll.show_all();
    }
    _load() {
        this._file.read_async(GLib.PRIORITY_DEFAULT, this._cancellable, (f, res) => {
            let stream;
            try { stream = f.read_finish(res); } catch (e) { this._message(e.message); this._readyNow(); return; }
            let count = 0; const chunks = []; let eof = false;
            const binary = this._format === 'h5ad' || this._format === 'parquet';
            const limit = binary ? 64 : LIMITS.bytes;
            const finish = () => {
                try { stream.close(null); } catch (_) {}
                const bytes = new Uint8Array(count); let pos = 0;
                for (const chunk of chunks) { bytes.set(chunk, pos); pos += chunk.length; }
                if (binary) {
                    const info = binaryPreview(this._name, bytes, count);
                    this._message(`${info.kind}\n${info.message}`);
                } else {
                    this._text = ByteArray.toString(bytes);
                    this._partial = !eof; this._parse();
                }
                this._readyNow();
            };
            const next = () => {
                if (this._cancellable.is_cancelled()) return;
                if (count >= limit) { finish(); return; }
                stream.read_bytes_async(Math.min(131072, limit - count), GLib.PRIORITY_DEFAULT, this._cancellable,
                    (input, result) => {
                        try {
                            const b = input.read_bytes_finish(result);
                            if (!b.get_size()) { eof = true; finish(); return; }
                            const chunk = b.get_data(); chunks.push(chunk); count += chunk.length; next();
                        } catch (e) { this._message(e.message); this._readyNow(); }
                    });
            };
            next();
        });
    }
    _parse() {
        const genomic = genomicPreview(this._name, this._text, this._partial);
        this._table = genomic ? {...genomic, truncatedRows: genomic.rowLimit, truncatedBytes: this._partial,
            clippedColumns: genomic.colLimit} : prepareTable(this._text, detectSeparator(this._text, this._name), true, this._partial);
        this._types = guessTypes(this._table.rows, this._table.headers.length);
        this._draw();
    }
    _draw() {
        const {headers, rows} = this._table;
        const sampled = this._partial || this._table.truncatedRows || this._table.clippedColumns;
        const notes = this._table.notes ?? [];
        const summary = [this._table.kind, notes[0], sampled ? `${rows.length} rows from file prefix` : '']
            .filter(Boolean).join(' · ');
        this._hint.set_text(summary);
        this._hint.set_tooltip_text([notes.join('\n'), `${rows.length} rows shown from the file prefix`]
            .filter(Boolean).join('\n'));
        this._hint.set_visible(!!summary);
        if (!headers.length) { this._message('No table columns detected'); return; }
        const widths = columnWidthHints(headers, rows, this._types);
        try {
            const store = new Gtk.ListStore();
            store.set_column_types(headers.map(() => GObject.TYPE_STRING));
            this._store = store;
            const populate = () => {
                store.clear();
                const sorted = sortRows(rows, this._sortColumn, this._descending, this._types);
                sorted.forEach(({cells}) => {
                    const iter = store.append();
                    for (let c = 0; c < headers.length; c++)
                        store.set_value(iter, c, shortText(cells[c]));
                });
            };
            populate();
            const view = new Gtk.TreeView({model: store, visible: true,
                headers_visible: true, enable_search: false,
                grid_lines: Gtk.TreeViewGridLines.HORIZONTAL});
            for (let col = 0; col < headers.length; col++) {
                const renderer = new Gtk.CellRendererText({ellipsize: Pango.EllipsizeMode.END,
                    xalign: this._types[col] === 'number' ? 1 : 0,
                    xpad: 8, ypad: 4});
                const column = new Gtk.TreeViewColumn({title: String(headers[col]).slice(0, 55),
                    resizable: true, expand: headers.length <= 10, clickable: true,
                    min_width: Math.min(widths[col], 100)});
                column.pack_start(renderer, true);
                column.add_attribute(renderer, 'text', col);
                column.set_fixed_width(widths[col]);
                column.connect('clicked', () => {
                    if (this._sortColumn !== col) { this._sortColumn = col; this._descending = false; }
                    else if (!this._descending) this._descending = true;
                    else this._sortColumn = null;
                    populate();
                });
                view.append_column(column);
            }
            if (this._scroll.get_child()) this._scroll.remove(this._scroll.get_child());
            this._scroll.add(view);
            this._scroll.show_all();
        } catch (e) {
            logError(e);
            // Small, robust fallback when a GTK3 binding is missing.
            const text = [headers.join('\t'), ...rows.map(c => c.join('\t'))].join('\n');
            const buffer = new Gtk.TextBuffer(); buffer.set_text(text, -1);
            const view = new Gtk.TextView({buffer, editable: false, monospace: true,
                wrap_mode: Gtk.WrapMode.NONE, visible: true});
            if (this._scroll.get_child()) this._scroll.remove(this._scroll.get_child());
            this._scroll.add(view); this._scroll.show_all();
        }
    }
});
var mimeTypes = [
    'text/tab-separated-values','text/csv','text/x-csv','application/csv','application/tab-separated-values',
    'text/x-sushi-bed','text/x-sushi-vcf','text/x-sushi-mtx','text/x-sushi-gff',
    'application/x-sushi-h5ad','application/x-sushi-parquet','application/vnd.apache.parquet',
    'application/x-parquet','text/x-bed','text/x-gff3',
];
