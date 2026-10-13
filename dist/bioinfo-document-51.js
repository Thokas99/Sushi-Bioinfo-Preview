/* Sushi Bioinfo Preview — GTK4 Markdown, local-only preview. MIT */
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import {Renderer, ResizePolicy} from 'resource://org/gnome/NautilusPreviewer/plugin-api-1.js';
/* SPDX-License-Identifier: MIT
 * Small, intentionally bounded, script-free Markdown preview helpers.
 * Markdown supports common constructs, not the complete CommonMark/GFM specification.
 */
const DOC_LIMIT = 256 * 1024;
function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const DOCUMENT_STYLE = `
:root { color-scheme: light dark; }
html { box-sizing: border-box; }
*, *::before, *::after { box-sizing: inherit; }
body { margin: 0 auto; padding: 24px 32px 36px; max-width: 780px;
  color: light-dark(#24292f,#e6edf3); background: light-dark(#fff,#161b22);
  font: 15px/1.62 system-ui, -apple-system, sans-serif; overflow-wrap: anywhere; }
img, video, svg, canvas, iframe, object { max-width: 100%; }
p { margin: 0 0 13px; }
h1,h2,h3,h4,h5,h6 { line-height: 1.26; font-weight: 650; margin: 1.05em 0 .45em; }
h1 { font-size: 1.6em; border-bottom: 1px solid #8884; padding-bottom: .26em; }
h2 { font-size: 1.32em; border-bottom: 1px solid #8884; padding-bottom: .22em; }
h3 { font-size: 1.1em; }
pre { font: 13px/1.5 ui-monospace, monospace; padding: 8px 10px; overflow: auto;
  border-radius: 7px; background: light-dark(#f6f8fa,#242a32); }
code { font: .9em ui-monospace, monospace; padding: 2px 4px;
  background: light-dark(#f1f2f3,#343941); border-radius: 4px; }
pre code { padding: 0; background: transparent; }
blockquote { margin: 10px 0; padding: 3px 15px; border-left: 3px solid #8888; color: light-dark(#57606a,#9aa6b2); }
hr { border: 0; border-top: 1px solid #8886; margin: 14px 0; }
a { color: light-dark(#0969da,#80aeff); text-decoration: none; }
a:hover { text-decoration: underline; }
ul,ol { padding-left: 1.55em; margin: 6px 0 10px; }
li + li { margin-top: 2px; }
table { border-collapse: collapse; display: block; max-width: 100%; overflow-x: auto;
  font-size: .92em; margin: 9px 0 12px; }
th, td { text-align: left; padding: 4px 7px; border: 1px solid #8885; white-space: nowrap; }
th { background: light-dark(#f6f8fa,#292f38); font-weight: 600; }
tr:nth-child(even) { background: light-dark(#fbfcfd,#1d232b); }
.task { list-style: none; }
.muted { opacity: .6; }
@media (max-width: 650px) { body { padding: 16px 18px; } }
`;
// No remote resources, scripts, forms, navigation or subframes. Inline CSS is needed for preview.
const CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; media-src 'none'; font-src data:; style-src 'unsafe-inline'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const META = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">`;

function inlineMarkdown(text) {
    const codes = [];
    let safe = escapeHtml(text).replace(/`([^`\n]+)`/g, (_all, content) => {
        const marker = `\u0001${codes.length}\u0002`;
        codes.push(`<code>${content}</code>`);
        return marker;
    });
    // Links become styled text: external navigation intentionally disabled.
    safe = safe.replace(/\[([^\]\n]{1,180})\]\(([^)\n]{1,512})\)/g,
        (_all, title, url) => `<span class="link" title="${escapeHtml(url)}">${title}</span>`);
    safe = safe.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
        .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
        .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
    return safe.replace(/\u0001(\d+)\u0002/g, (_all, n) => codes[Number(n)] ?? '');
}
function isTableRule(s) {
    return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(s);
}
function cells(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').slice(0, 24);
}
function renderMarkdown(source) {
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let paragraph = [], list = null, quote = [], inCode = false, code = [];
    const flushParagraph = () => {
        if (paragraph.length) { out.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`); paragraph = []; }
    };
    const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    const flushQuote = () => {
        if (quote.length) { out.push(`<blockquote>${inlineMarkdown(quote.join(' '))}</blockquote>`); quote = []; }
    };
    const flushBlocks = () => { flushParagraph(); flushList(); flushQuote(); };
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i], line = raw.trimEnd();
        const fence = /^\s*(`{3,}|~{3,})/.exec(line);
        if (fence) {
            if (inCode) { out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = []; inCode = false; }
            else { flushBlocks(); inCode = true; }
            continue;
        }
        if (inCode) { code.push(raw); continue; }
        if (!line.trim()) { flushBlocks(); continue; }
        const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
        if (heading) { flushBlocks(); const n = heading[1].length; out.push(`<h${n}>${inlineMarkdown(heading[2])}</h${n}>`); continue; }
        if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushBlocks(); out.push('<hr>'); continue; }
        if (i + 1 < lines.length && line.includes('|') && isTableRule(lines[i + 1])) {
            flushBlocks();
            const hdr = cells(line), max = Math.min(24, hdr.length);
            out.push('<table><thead><tr>' + hdr.slice(0, max).map(c => `<th>${inlineMarkdown(c.trim())}</th>`).join('') + '</tr></thead><tbody>');
            i += 2;
            for (; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) {
                const row = cells(lines[i]);
                out.push('<tr>' + Array.from({length: max}, (_, j) => `<td>${inlineMarkdown((row[j] ?? '').trim())}</td>`).join('') + '</tr>');
            }
            out.push('</tbody></table>'); i--; continue;
        }
        const blockquote = /^\s{0,3}>\s?(.*)$/.exec(line);
        if (blockquote) { flushParagraph(); flushList(); quote.push(blockquote[1]); continue; }
        flushQuote();
        const li = /^\s{0,4}(?:([-+*])|(\d{1,6})\.)\s+(.*)$/.exec(line);
        if (li) {
            flushParagraph();
            const kind = li[2] ? 'ol' : 'ul';
            if (list !== kind) { flushList(); out.push(`<${kind}>`); list = kind; }
            const todo = /^\[([ xX])\]\s+/.exec(li[3]);
            const prefix = todo ? `${todo[1].toLowerCase() === 'x' ? '☑' : '☐'} ` : '';
            out.push(`<li>${prefix}${inlineMarkdown(todo ? li[3].slice(todo[0].length) : li[3])}</li>`);
            continue;
        }
        flushList(); paragraph.push(line.trim());
    }
    if (inCode) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
    flushBlocks();
    return out.join('\n');
}
function markdownDocument(raw) {
    const body = renderMarkdown(raw);
    return `<!doctype html><html><head>${META}<meta name="viewport" content="width=device-width,initial-scale=1"><style>${DOCUMENT_STYLE}.link {color:light-dark(#0969da,#80aeff)}</style></head><body>${body}</body></html>`;
}

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
