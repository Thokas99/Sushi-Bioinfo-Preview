imports.gi.versions.Gtk = '3.0';
const {Gtk, Gio, GLib} = imports.gi;
Gtk.init(null);
imports.searchPath.unshift(ARGV[0]);
const plugin = imports.table50_smoke;
const loop = new GLib.MainLoop(null, false);
let ready = false;
plugin.Klass.prototype.isReady = function() { ready = true; loop.quit(); };
const preview = new plugin.Klass(Gio.File.new_for_path(ARGV[1]));
let timedOut = false;
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
    timedOut = true; loop.quit(); return GLib.SOURCE_REMOVE;
});
loop.run();
if (!ready || timedOut) throw new Error('GTK3 table preview did not become ready');
if (preview._table?.rows?.length !== 2 || preview._store.iter_n_children(null) !== 2)
    throw new Error('GTK3 table preview did not populate its rows');
if (!(preview._scroll.get_child() instanceof Gtk.TreeView))
    throw new Error('GTK3 table preview did not create its native table view');
const [horizontalPolicy, verticalPolicy] = preview._scroll.get_policy();
if (horizontalPolicy !== Gtk.PolicyType.ALWAYS || verticalPolicy !== Gtk.PolicyType.ALWAYS)
    throw new Error('GTK3 row and column scrollbars must stay visible');
preview._message('No table preview');
const [messageHorizontalPolicy, messageVerticalPolicy] = preview._scroll.get_policy();
if (messageHorizontalPolicy !== Gtk.PolicyType.AUTOMATIC || messageVerticalPolicy !== Gtk.PolicyType.AUTOMATIC)
    throw new Error('GTK3 message view must not show inactive table scrollbars');
preview.destroy();
print('GTK3 table preview loaded and populated.');
