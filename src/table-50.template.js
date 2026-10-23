/* Sushi Bioinfo Preview — native GTK3 tree table. SPDX-License-Identifier: MIT */
const {Gdk, Gio, GLib, GObject, Gtk, Pango} = imports.gi;
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
        this._name = file.get_basename();
        this._cancellable = new Gio.Cancellable();
        this._sortColumn = null; this._descending = false;
        this.connect('destroy', () => this._cancellable.cancel());
        this._build(); this._load();
    }
    _build() {
        this._hint = new Gtk.Label({label: '', xalign: 1, visible: true,
            halign: Gtk.Align.END, ellipsize: Pango.EllipsizeMode.END, max_width_chars: 120,
            margin_end: 8});
        this._hint.set_tooltip_text('The preview reads only bounded file data.');
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
        this._scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);
        this._hint.hide();
        if (this._scroll.get_child()) this._scroll.remove(this._scroll.get_child());
        this._scroll.add(new Gtk.Label({label: String(s), visible: true, xalign: 0}));
        this._scroll.show_all();
    }
    _load() {
        this._file.read_async(GLib.PRIORITY_DEFAULT, this._cancellable, (f, res) => {
            let stream;
            try { stream = f.read_finish(res); } catch (e) {
                if (!this._cancellable.is_cancelled()) { this._message(e.message); this._readyNow(); }
                return;
            }
            let count = 0; const chunks = []; let eof = false;
            const limit = LIMITS.bytes;
            const finish = () => {
                try { stream.close(null); } catch (_) {}
                const bytes = new Uint8Array(count); let pos = 0;
                for (const chunk of chunks) { bytes.set(chunk, pos); pos += chunk.length; }
                this._text = ByteArray.toString(bytes);
                this._partial = !eof; this._parse();
                this._readyNow();
            };
            const next = () => {
                if (this._cancellable.is_cancelled()) { try { stream.close(null); } catch (_) {} return; }
                if (count >= limit) { finish(); return; }
                stream.read_bytes_async(Math.min(131072, limit - count), GLib.PRIORITY_DEFAULT, this._cancellable,
                    (input, result) => {
                        try {
                            const b = input.read_bytes_finish(result);
                            if (this._cancellable.is_cancelled()) { try { input.close(null); } catch (_) {} return; }
                            if (!b.get_size()) { eof = true; finish(); return; }
                            const chunk = b.get_data(); chunks.push(chunk); count += chunk.length; next();
                        } catch (e) {
                            try { input.close(null); } catch (_) {}
                            if (!this._cancellable.is_cancelled()) { this._message(e.message); this._readyNow(); }
                        }
                    });
            };
            next();
        });
    }
    _parse() {
        const genomic = genomicPreview(this._name, this._text, this._partial);
        this._table = genomic ? {...genomic, truncatedRows: genomic.rowLimit, truncatedBytes: this._partial,
        clippedColumns: genomic.colLimit} : prepareTable(this._text, detectSeparator(this._text, this._name),
            /\.(csv|tsv|tab)$/i.test(this._name), this._partial);
        this._types = guessTypes(this._table.rows, this._table.headers.length, this._table.headers);
        this._draw();
    }
    _draw() {
        const {headers, rows} = this._table;
        const status = previewStatus(this._table);
        const notes = this._table.notes ?? [];
        const summary = [this._table.kind, notes[0], status.label]
            .filter(Boolean).join(' · ');
        this._hint.set_text(summary);
        this._hint.set_tooltip_text([notes.join('\n'), status.tooltip]
            .filter(Boolean).join('\n'));
        this._hint.set_visible(!!summary);
        if (!headers.length) { this._message('No table columns detected'); return; }
        this._scroll.set_policy(Gtk.PolicyType.ALWAYS, Gtk.PolicyType.ALWAYS);
        const widths = columnWidthHints(headers, rows, this._types);
        try {
            const store = new Gtk.ListStore();
            store.set_column_types([GObject.TYPE_STRING, ...headers.map(() => GObject.TYPE_STRING)]);
            this._store = store;
            const populate = () => {
                store.clear();
                const sorted = sortRows(rows, this._sortColumn, this._descending, this._types);
                this._displayRows = sorted;
                sorted.forEach(({cells, originalIndex}) => {
                    const iter = store.append();
                    store.set_value(iter, 0, String(originalIndex + 1));
                    for (let c = 0; c < headers.length; c++)
                        store.set_value(iter, c + 1, shortText(cells[c]));
                });
            };
            populate();
            const view = new Gtk.TreeView({model: store, visible: true,
                headers_visible: true, enable_search: false,
                enable_grid_lines: Gtk.TreeViewGridLines.HORIZONTAL});
            this._view = view;
            const gutterRenderer = new Gtk.CellRendererText({xalign: 1, xpad: 2, ypad: 3});
            const gutter = new Gtk.TreeViewColumn({title: '#', resizable: false, sizing: Gtk.TreeViewColumnSizing.FIXED});
            gutter.pack_start(gutterRenderer, true);
            gutter.add_attribute(gutterRenderer, 'text', 0);
            gutter.set_fixed_width(42);
            view.append_column(gutter);
            for (let col = 0; col < headers.length; col++) {
                const numeric = this._types[col] === 'number';
                const renderer = new Gtk.CellRendererText({ellipsize: Pango.EllipsizeMode.END,
                    xalign: numeric ? 1 : 0,
                    xpad: 8, ypad: 4});
                const column = new Gtk.TreeViewColumn({title: String(headers[col]).slice(0, 55),
                    resizable: true, expand: !numeric, clickable: true,
                    min_width: Math.min(widths[col], 100)});
                column.pack_start(renderer, true);
                column.add_attribute(renderer, 'text', col + 1);
                column.set_fixed_width(widths[col]);
                column.connect('clicked', () => {
                    if (this._sortColumn !== col) { this._sortColumn = col; this._descending = false; }
                    else if (!this._descending) this._descending = true;
                    else this._sortColumn = null;
                    populate();
                });
                view.append_column(column);
            }
            view.connect('button-press-event', (_view, event) => {
                if (event.button !== Gdk.BUTTON_SECONDARY) return false;
                const hit = view.get_path_at_pos(Math.floor(event.x), Math.floor(event.y));
                if (!hit || !hit[0]) return false;
                const [path, column] = hit;
                view.get_selection().select_path(path);
                const row = this._rowAtPath(path);
                if (!row) return false;
                const dataColumn = view.get_columns().indexOf(column) - 1;
                const menu = new Gtk.Menu();
                if (dataColumn >= 0) {
                    const area = view.get_cell_area(path, column);
                    const active = {value: String(row.cells[dataColumn] ?? ''),
                        cells: row.cells.map(value => String(value ?? '')),
                        row: row.originalIndex, column: dataColumn,
                        anchor: {x: area.x, y: area.y, width: area.width, height: area.height}};
                    for (const [label, callback] of [
                        ['Copy cell value', () => this._copyText(active.value)],
                        ['Copy row as TSV', () => this._copyText(rowToTsv(active.cells))],
                        ['Inspect value', () => this._inspectValue(active)],
                    ]) {
                        const item = new Gtk.MenuItem({label});
                        item.connect('activate', callback);
                        menu.append(item);
                    }
                } else {
                    const item = new Gtk.MenuItem({label: 'Copy row as TSV'});
                    item.connect('activate', () => this._copyText(rowToTsv(row.cells)));
                    menu.append(item);
                }
                menu.show_all();
                menu.popup_at_pointer(event);
                return true;
            });
            view.connect('row-activated', (_view, path, column) => {
                const dataColumn = view.get_columns().indexOf(column) - 1;
                const row = this._rowAtPath(path);
                if (row && dataColumn >= 0) {
                    const area = view.get_cell_area(path, column);
                    this._inspectValue({value: String(row.cells[dataColumn] ?? ''),
                        row: row.originalIndex, column: dataColumn,
                        anchor: {x: area.x, y: area.y, width: area.width, height: area.height}});
                }
            });
            view.connect('key-press-event', (_view, event) => {
                if ((event.state & Gdk.ModifierType.CONTROL_MASK) && event.keyval === Gdk.KEY_c) {
                    const [model, iter] = view.get_selection().get_selected();
                    if (iter) {
                        const path = model.get_path(iter);
                        const row = this._rowAtPath(path);
                        if (row) { this._copyText(rowToTsv(row.cells)); return true; }
                    }
                }
                return false;
            });
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
    _rowAtPath(path) {
        const index = path.get_indices()[0];
        return Number.isInteger(index) ? this._displayRows[index] ?? null : null;
    }
    _copyText(text) {
        if (text !== undefined && text !== null)
            Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text(String(text), -1);
    }
    _inspectValue(active) {
        if (!active) return;
        if (this._inspectPopover) {
            const previous = this._inspectPopover;
            this._inspectPopover = null;
            previous.destroy();
        }
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6,
            margin: 8, visible: true});
        const status = new Gtk.Label({label: cellValueStatus(this._table, active.row, active.column),
            xalign: 0, wrap: true, visible: true});
        const buffer = new Gtk.TextBuffer(); buffer.set_text(active.value, -1);
        const text = new Gtk.TextView({buffer, editable: false, cursor_visible: true,
            monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR, visible: true});
        const scroll = new Gtk.ScrolledWindow({visible: true, min_content_width: 280,
            max_content_width: 520, min_content_height: 80, max_content_height: 280});
        scroll.add(text);
        const copy = new Gtk.Button({label: 'Copy value', halign: Gtk.Align.END, visible: true});
        copy.connect('clicked', () => this._copyText(active.value));
        box.pack_start(status, false, false, 0); box.pack_start(scroll, true, true, 0);
        box.pack_start(copy, false, false, 0);
        const popover = Gtk.Popover.new(this._view);
        popover.add(box); popover.set_pointing_to(new Gdk.Rectangle(active.anchor));
        this._inspectPopover = popover;
        popover.connect('closed', () => {
            if (this._inspectPopover === popover) this._inspectPopover = null;
            popover.destroy();
        });
        popover.show_all(); popover.popup();
    }
});
var mimeTypes = [
    'text/tab-separated-values','text/csv','text/x-csv','application/csv','application/tab-separated-values',
    'text/x-sushi-bed','text/x-sushi-vcf','text/x-sushi-mtx','text/x-sushi-gff',
    'text/x-bed','text/x-gff3',
];
