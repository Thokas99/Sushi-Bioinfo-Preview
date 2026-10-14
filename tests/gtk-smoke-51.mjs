import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

Gtk.init();
Adw.init();
const {Klass} = await import(GLib.filename_to_uri(ARGV[0], null));
for (const [prototype, name] of [
    [Gio.File.prototype, 'read_async'],
    [Gio.InputStream.prototype, 'read_bytes_async'],
]) {
    const original = prototype[name];
    prototype[name] = function(...args) {
        print(`GTK4 smoke: ${name} called`);
        return Promise.resolve(original.apply(this, args)).then(value => {
            print(`GTK4 smoke: ${name} resolved`);
            return value;
        }, error => {
            printerr(`GTK4 smoke: ${name} rejected: ${error.stack ?? error}`);
            throw error;
        });
    };
}
const loop = new GLib.MainLoop(null, false);
let ready = false, timedOut = false;
const load = Klass.prototype._load;
Klass.prototype._load = function(file) {
    this.cancellable = new Gio.Cancellable();
    print(`GTK4 smoke: load started (cancellable=${Boolean(this.cancellable)})`);
    return load.call(this, file).then(value => {
        print('GTK4 smoke: load resolved');
        return value;
    }, error => {
        printerr(`GTK4 smoke: load rejected: ${error.stack ?? error}`);
        throw error;
    });
};
Klass.prototype.markReady = function() { print('GTK4 smoke: markReady called'); ready = true; loop.quit(); };
const file = Gio.File.new_for_path(ARGV[1]);
const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
const preview = new Klass(file, info);
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
    timedOut = true;
    printerr(`GTK4 smoke: timeout (table=${Boolean(preview._table)}, store=${Boolean(preview._store)})`);
    loop.quit(); return GLib.SOURCE_REMOVE;
});
loop.run();
if (!ready || timedOut) throw new Error('GTK4 table preview did not become ready');
if (preview._table?.rows?.length !== 2 || preview._store.get_n_items() !== 2)
    throw new Error('GTK4 table preview did not populate its rows');
if (!(preview._scroll.get_child() instanceof Gtk.ColumnView))
    throw new Error('GTK4 table preview did not create its native table view');
preview.cleanup();
print('GTK4 table preview loaded and populated.');
