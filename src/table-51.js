/* Sushi Bioinfo Preview — native GTK4 table. SPDX-License-Identifier: MIT */
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Graphene from 'gi://Graphene';
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
        .bioinfo-table .row-number { padding: 2px 3px; }
        .bioinfo-table .numeric { font-feature-settings: "tnum"; }
        .bioinfo-table columnview { border: none; }
        .bioinfo-table .dim-label { font-size: 11px; }
    `);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
} catch (e) { console.warn(`Bioinfo table CSS unavailable: ${e}`); }

// Rows are GObjects because Gio.ListStore and Gtk.ColumnView expect a GListModel.
const TableItem = GObject.registerClass(class TableItem extends GObject.Object {
    constructor(cells, recordIndex) {
        super();
        this.cells = cells;
        this.recordIndex = recordIndex;
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
    cleanup() {
        this.cancellable.cancel();
        const menu = this._menuPopover; this._menuPopover = null;
        const inspect = this._inspectPopover; this._inspectPopover = null;
        menu?.popdown(); menu?.unparent();
        inspect?.popdown(); inspect?.unparent();
        this._activeCell = null; this._table = null; this._types = null; this._store = null;
        this._view = null;
        this._scroll.set_child(null);
    }

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
            this._types = guessTypes(this._table.rows, this._table.headers.length, this._table.headers);
            this._renderTable();
        }
        this.markReady();
    }
    _renderTable() {
        const {headers, rows} = this._table;
        const status = previewStatus(this._table);
        const notes = this._table.notes ?? [];
        const summary = [this._table.kind, notes[0], status.label]
            .filter(Boolean).join(' · ');
        this._hint.set_label(summary);
        this._hint.set_tooltip_text([notes.join('\n'), status.tooltip]
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
            this._view = view;
            view.add_css_class('data-table');
            const sorting = new Gtk.SortListModel({model: store, sorter: view.get_sorter(), incremental: true});
            const selection = new Gtk.SingleSelection({model: sorting,
                autoselect: false, can_unselect: true});
            view.set_model(selection);

            const menuModel = new Gio.Menu();
            menuModel.append('Copy cell value', 'table.copy-cell');
            menuModel.append('Copy row as TSV', 'table.copy-row');
            menuModel.append('Inspect value', 'table.inspect');
            const actions = new Gio.SimpleActionGroup();
            for (const [name, callback] of [
                ['copy-cell', () => this._copyText(this._activeCell?.value)],
                ['copy-row', () => this._copyText(this._activeCell && rowToTsv(this._activeCell.cells))],
                ['inspect', () => this._inspectValue(this._activeCell)],
            ]) {
                const action = new Gio.SimpleAction({name});
                action.connect('activate', callback);
                actions.add_action(action);
            }
            view.insert_action_group('table', actions);
            const menuPopover = Gtk.PopoverMenu.new_from_model(menuModel);
            menuPopover.set_parent(view);
            menuPopover.connect('closed', () => { this._activeCell = null; });
            this._menuPopover = menuPopover;

            const keys = new Gtk.EventControllerKey();
            keys.connect('key-pressed', (_controller, keyval, _keycode, state) => {
                const control = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
                const item = selection.get_selected_item();
                if (control && keyval === Gdk.KEY_c && item) {
                    this._copyText(rowToTsv(item.cells));
                    return true;
                }
                return false;
            });
            view.add_controller(keys);

            const showAt = (popover, point) => {
                const anchor = new Graphene.Point(point ?? {x: 0, y: 0});
                popover.set_pointing_to(new Gdk.Rectangle({x: anchor.x, y: anchor.y, width: 1, height: 1}));
                popover.popup();
            };

            headers.forEach((header, col) => {
                const factory = new Gtk.SignalListItemFactory();
                const numeric = this._types[col] === 'number';
                factory.connect('setup', (_factory, item) => {
                    const widget = new Gtk.Label({xalign: numeric ? 1 : 0,
                        halign: Gtk.Align.FILL, hexpand: true,
                        ellipsize: Pango.EllipsizeMode.END, single_line_mode: true});
                    if (numeric) widget.add_css_class('numeric');
                    const click = new Gtk.GestureClick({button: 0});
                    widget.add_controller(click);
                    click.connect('pressed', (gesture, presses, x, y) => {
                        const current = item.get_item();
                        const position = item.get_position();
                        if (!current || position < 0) return;
                        const [ok, point] = widget.compute_point(view, new Graphene.Point({x, y}));
                        const anchor = ok ? {x: point.x, y: point.y} : {x: 0, y: 0};
                        const cells = current.cells.map(value => String(value ?? ''));
                        const active = {value: cells[col] ?? '', cells,
                            row: current.recordIndex, column: col, anchor};
                        if (gesture.get_current_button() === Gdk.BUTTON_SECONDARY) {
                            this._activeCell = active;
                            selection.set_selected(position);
                            showAt(menuPopover, anchor);
                        } else if (gesture.get_current_button() === Gdk.BUTTON_PRIMARY && presses === 2) {
                            this._inspectValue(active);
                        }
                    });
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
                    factory, resizable: true, expand: !numeric});
                column.set_fixed_width(widths[col]);
                column.set_sorter(Gtk.CustomSorter.new((a, b) => compareCells(
                    a.cells[col] ?? '', b.cells[col] ?? '', this._types[col])));
                view.append_column(column);
            });
            const gutterFactory = new Gtk.SignalListItemFactory();
            gutterFactory.connect('setup', (_factory, item) => {
                const label = new Gtk.Label({xalign: 1, halign: Gtk.Align.FILL, width_chars: 3});
                label.add_css_class('dim-label');
                label.add_css_class('row-number');
                item.set_child(label);
            });
            gutterFactory.connect('bind', (_factory, item) => {
                item.get_child().set_label(String(item.get_item().recordIndex + 1));
            });
            const gutter = new Gtk.ColumnViewColumn({title: '#', factory: gutterFactory, resizable: false});
            gutter.set_fixed_width(42);
            view.insert_column(0, gutter);
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
    _copyText(text) {
        if (text === undefined || text === null) return;
        this.get_display().get_clipboard().set_content(Gdk.ContentProvider.new_for_value(String(text)));
    }
    _inspectValue(active) {
        if (!active) return;
        if (this._inspectPopover) {
            const previous = this._inspectPopover;
            this._inspectPopover = null;
            previous.popdown();
            previous.unparent();
        }
        const buffer = new Gtk.TextBuffer();
        buffer.set_text(active.value, -1);
        const text = new Gtk.TextView({buffer, editable: false, cursor_visible: true,
            monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR,
            left_margin: 8, right_margin: 8, top_margin: 6, bottom_margin: 6});
        const scroll = new Gtk.ScrolledWindow({max_content_width: 520, max_content_height: 280,
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC, vscrollbar_policy: Gtk.PolicyType.AUTOMATIC});
        scroll.set_child(text);
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 8,
            margin_bottom: 8, margin_start: 8, margin_end: 8});
        const status = new Gtk.Label({label: cellValueStatus(this._table, active.row, active.column),
            xalign: 0, wrap: true});
        status.add_css_class('dim-label');
        const copy = new Gtk.Button({label: 'Copy value', halign: Gtk.Align.END});
        copy.connect('clicked', () => this._copyText(active.value));
        box.append(status); box.append(scroll); box.append(copy);
        const popover = new Gtk.Popover({autohide: true});
        popover.set_child(box);
        popover.set_parent(this._view);
        popover.connect('closed', () => {
            if (this._inspectPopover === popover) {
                this._inspectPopover = null;
                popover.unparent();
            }
        });
        this._inspectPopover = popover;
        const anchor = new Graphene.Point(active.anchor ?? {x: 0, y: 0});
        popover.set_pointing_to(new Gdk.Rectangle({x: anchor.x, y: anchor.y, width: 1, height: 1}));
        popover.popup();
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
