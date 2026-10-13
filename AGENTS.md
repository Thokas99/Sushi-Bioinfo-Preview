# Project notes for contributors and coding agents

Sushi Bioinfo Preview is a read-only GNOME Sushi plugin for bounded inspection of scientific tables and selected documents. Keep it small, native to GTK, and predictable; do not add analysis features or dependencies without a concrete need.

## Architecture

- `src/` is the editable source. GTK3 plugins target the legacy Sushi `viewers` API; GTK4 plugins target the Sushi 51+ `plugins-1` API.
- `src/*-core.js` contains shared parsing and formatting logic without GTK dependencies.
- `python3 build.py` embeds shared sources into the self-contained, committed files in `dist/`. Rebuild `dist/` after every source change.
- `mime/` registers only the project-specific types. Do not claim full H5AD or Parquet parsing: these formats receive signature checks only.
- `install.sh` and `uninstall.sh` modify user-level Sushi and MIME files. Test them only with temporary home directories.

## Conventions and safety

- Prefer GTK's native widgets, models, scrolling, sorting, and lifecycle. Preserve Sushi keyboard and window behavior.
- Keep reads, decompression, rows, columns, fields, and document extraction bounded. Do not materialize sparse matrices densely or execute document content.
- Treat all preview files as untrusted. Preserve cancellation, parse errors, and size checks; never write to previewed inputs.
- Keep source and generated distribution files consistent. Do not add a framework or dependency for a small helper.
- Keep table cell interactions on virtualized widgets; resolve the currently bound row when a gesture fires and retain only a short-lived value snapshot for menus/popovers.
- The `#` gutter represents sampled data-record order before sorting, not physical file lines. Keep it outside the scientific data model and copied TSV.
- GTK4 clipboard text uses `Gdk.ContentProvider`; native sort direction reverses the comparator, so missing values follow that direction. Keep equal-row comparisons at zero for stable source order.
- Examples and fixtures must be synthetic; never add patient or study data.

## Build and checks

Run `npm test` for parser, limits, MIME, build reproducibility, and mocked install/uninstall checks. Run `python3 build.py` and `for file in dist/*.js; do node --check "$file"; done` after source changes. Live GTK rendering still needs a GNOME session.

When a GitNexus index is available, inspect callers and impact before changing a function; confirm `UNKNOWN` results with text search. Run graph change detection before any commit. Do not install or bootstrap GitNexus just for this project.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **Sushi-Bioinfo-Preview** (374 symbols, 916 relationships, 21 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/Sushi-Bioinfo-Preview/context` | Codebase overview, check index freshness |
| `gitnexus://repo/Sushi-Bioinfo-Preview/clusters` | All functional areas |
| `gitnexus://repo/Sushi-Bioinfo-Preview/processes` | All execution flows |
| `gitnexus://repo/Sushi-Bioinfo-Preview/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
