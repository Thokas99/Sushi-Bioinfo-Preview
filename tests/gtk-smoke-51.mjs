import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

Gtk.init();
Adw.init();
const {Klass} = await import(GLib.filename_to_uri(ARGV[0], null));
const loop = new GLib.MainLoop(null, false);
let ready = false, timedOut = false;
// The smoke stub replaces Sushi's Renderer interface, which supplies this property.
Klass.prototype.cancellable = new Gio.Cancellable();
Klass.prototype.markReady = function() { ready = true; loop.quit(); };
const file = Gio.File.new_for_path(ARGV[1]);
const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
const preview = new Klass(file, info);
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
    timedOut = true; loop.quit(); return GLib.SOURCE_REMOVE;
});
loop.run();
if (!ready || timedOut) throw new Error('GTK4 table preview did not become ready');
if (preview._table?.rows?.length !== 2 || preview._store.get_n_items() !== 2)
    throw new Error('GTK4 table preview did not populate its rows');
if (!(preview._scroll.get_child() instanceof Gtk.ColumnView))
    throw new Error('GTK4 table preview did not create its native table view');
preview.cleanup();
print('GTK4 table preview loaded and populated.');
