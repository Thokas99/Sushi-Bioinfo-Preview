/* Sushi Bioinfo Preview — native GTK4 table. SPDX-License-Identifier: MIT */
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Pango from 'gi://Pango';
import {Renderer, ResizePolicy} from 'resource://org/gnome/NautilusPreviewer/plugin-api-1.js';
/* EMBED_CORE_HERE */
/* EMBED_FORMAT_HERE */
Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');

// A CSS-scoped data table: no changes to Sushi's window, titlebar or other previews.
try {
    const css = new Gtk.CssProvider();
    css.load_from_data(`
        .bioinfo-table label { padding: 5px 8px; }
        .bioinfo-table .numeric { font-feature-settings: "tnum"; }
        .bioinfo-table columnview { border: none; }
        .bioinfo-table .dim-label { font-size: 11px; }
    `);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
} catch (e) { console.warn(`Bioinfo table CSS unavailable: ${e}`); }

// Rows are GObjects because Gio.ListStore and Gtk.ColumnView expect a GListModel.
const TableItem = GObject.registerClass(class TableItem extends GObject.Object {
    constructor(cells, index) {
        super();
        this.cells = cells;
        this.index = index;
    }
});

async function readHead(file, cancellable, limit) {
    const input = await file.read_async(GLib.PRIORITY_DEFAULT, cancellable);
    let total = 0, eof = false;
    const chunks = [];
    try {
        while (total < limit) {
            const b = await input.read_bytes_async(Math.min(131072, limit - total),
                GLib.PRIORITY_DEFAULT, cancellable);
            if (!b.get_size()) { eof = true; break; }
            const chunk = b.get_data();
            chunks.push(chunk); total += chunk.length;
        }
    } finally { try { input.close(null); } catch (_) {} }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return {bytes, text: new TextDecoder('utf-8').decode(bytes), eof};
}

export const Klass = class LabTable extends Adw.Bin {
    static { GObject.registerClass({Implements: [Renderer]}, this); }
    constructor(file, info, props = {}) {
        super(props);
        this._name = file.get_basename();
        this._size = Number(info?.get_size?.() ?? 0);
        this._format = formatFromName(this._name);
        this._makeUI();
        this._load(file).catch(e => {
            if (this.cancellable.is_cancelled()) return;
            console.error(`Bioinfo preview: ${e}`);
            this._showMessage(`Preview unavailable: ${e.message}`);
            this.markReady();
        });
    }
    get resizePolicy() { return ResizePolicy.NAT_SIZE; }
    get topBarStyle() { return Adw.ToolbarStyle.FLAT; }
    cleanup() { this._table = null; this._types = null; this._store = null; this._scroll.set_child(null); }

    _makeUI() {
        const root = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 0,
            margin_top: 2, margin_bottom: 2, margin_start: 3, margin_end: 3,
            hexpand: true, vexpand: true});
        root.add_css_class('bioinfo-table');
        this.set_child(root);
        // Small sample indicator, no search, pagination or redundant toolbar.
        this._hint = new Gtk.Label({label: '', visible: false, xalign: 1, halign: Gtk.Align.END,
            ellipsize: Pango.EllipsizeMode.END, max_width_chars: 120,
            margin_end: 7, margin_bottom: 2});
        this._hint.add_css_class('dim-label');
        this._hint.set_tooltip_text('The preview reads a bounded prefix of the file.');
        root.append(this._hint);
        this._scroll = new Gtk.ScrolledWindow({hexpand: true, vexpand: true,
            min_content_width: 960, min_content_height: 560,
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC});
        root.append(this._scroll);
    }
    _showMessage(message) {
        this._hint.set_visible(false);
        this._scroll.set_child(new Gtk.Label({label: message, xalign: 0, wrap: true,
            margin_top: 12, margin_start: 12}));
    }
    async _load(file) {
        const binary = this._format === 'h5ad' || this._format === 'parquet';
        const {bytes, text, eof} = await readHead(file, this.cancellable, binary ? 64 : LIMITS.bytes);
        if (this.cancellable.is_cancelled()) return;
        if (binary) {
            const summary = binaryPreview(this._name, bytes, this._size);
            this._showMessage(summary.recognized ?
                `${summary.kind} · ${formatSize(this._size)}\nMetadata not indexed` : summary.message);
        } else {
            const partial = !eof && (this._size === 0 || this._size > bytes.length);
            const genomic = genomicPreview(this._name, text, partial);
            this._table = genomic ? {
                ...genomic, truncatedRows: genomic.rowLimit, truncatedBytes: partial,
                clippedColumns: genomic.colLimit,
            } : prepareTable(text, detectSeparator(text, this._name), true, partial);
            this._types = guessTypes(this._table.rows, this._table.headers.length);
            this._renderTable();
        }
        this.markReady();
    }
    _renderTable() {
        const {headers, rows} = this._table;
        const sampled = this._table.truncatedRows || this._table.truncatedBytes ||
            this._table.clippedColumns;
        const notes = this._table.notes ?? [];
        const summary = [this._table.kind, notes[0], sampled ? `${rows.length} rows from file prefix` : '']
            .filter(Boolean).join(' · ');
        this._hint.set_label(summary);
        this._hint.set_tooltip_text([notes.join('\n'), `${rows.length} rows shown from the file prefix`]
            .filter(Boolean).join('\n'));
        this._hint.set_visible(!!summary);
        if (headers.length === 0) {
            this._showMessage('No table columns detected'); return;
        }
        const widths = columnWidthHints(headers, rows, this._types);
        try {
            const store = new Gio.ListStore({item_type: TableItem});
            rows.forEach((cells, index) => store.append(new TableItem(cells, index)));
            const view = new Gtk.ColumnView({show_row_separators: true,
                show_column_separators: false, reorderable: false,
                hexpand: true, vexpand: true});
            view.add_css_class('data-table');
            const sorting = new Gtk.SortListModel({model: store, sorter: view.get_sorter(), incremental: true});
            const selection = new Gtk.SingleSelection({model: sorting,
                autoselect: false, can_unselect: true});
            view.set_model(selection);

            headers.forEach((header, col) => {
                const factory = new Gtk.SignalListItemFactory();
                const numeric = this._types[col] === 'number';
                factory.connect('setup', (_factory, item) => {
                    const widget = new Gtk.Label({xalign: numeric ? 1 : 0,
                        halign: Gtk.Align.FILL, hexpand: true,
                        ellipsize: Pango.EllipsizeMode.END, single_line_mode: true});
                    if (numeric) widget.add_css_class('numeric');
                    item.set_child(widget);
                });
                factory.connect('bind', (_factory, item) => {
                    const value = String(item.get_item()?.cells?.[col] ?? '');
                    const widget = item.get_child();
                    widget.set_label(value.replace(/[\r\n\t]/g, ' ').slice(0, 180));
                    widget.set_tooltip_text(value || '(empty)');
                });
                factory.connect('unbind', (_factory, item) => {
                    item.get_child().set_tooltip_text(null);
                });
                const column = new Gtk.ColumnViewColumn({title: String(header).slice(0, 55),
                    factory, resizable: true, expand: headers.length <= 10});
                column.set_fixed_width(widths[col]);
                column.set_sorter(Gtk.CustomSorter.new((a, b) => compareCells(
                    a.cells[col] ?? '', b.cells[col] ?? '', this._types[col], a.index, b.index)));
                view.append_column(column);
            });
            this._store = store;
            this._scroll.set_child(view);
        } catch (e) {
            console.warn(`Native column view unavailable, showing bounded text preview: ${e}`);
            // Do not create thousands of GTK widgets in an error fallback.
            const text = [headers.join('\t'), ...rows.map(cells => cells.join('\t'))].join('\n');
            const buffer = new Gtk.TextBuffer();
            buffer.set_text(text, -1);
            this._scroll.set_child(new Gtk.TextView({buffer, editable: false,
                monospace: true, wrap_mode: Gtk.WrapMode.NONE}));
        }
    }
};
function formatSize(n) {
    if (!Number.isFinite(n) || n <= 0) return 'unknown size';
    const unit = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** unit).toFixed(1)} ${['B','KiB','MiB','GiB','TiB'][unit]}`;
}
export const contentTypes = [
    'text/tab-separated-values','text/csv','text/x-csv',
    'application/csv','application/tab-separated-values',
    'text/x-sushi-bed','text/x-sushi-vcf','text/x-sushi-mtx','text/x-sushi-gff',
    'application/x-sushi-h5ad','application/x-sushi-parquet',
    'application/vnd.apache.parquet','application/x-parquet','text/x-bed','text/x-gff3',
];
