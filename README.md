# PlasmoFP Explorer — static MVP

A fully static rebuild of the gene/GO-term lookup core of PlasmoFP Explorer.
No Python server, no Streamlit, no process to keep warm. Every lookup is a
small file fetch served exactly as-is.

## Run it

You need a local static file server (not double-clicking index.html —
browsers block fetch() of local files opened via `file://`).

```bash
cd plasmofp_static
python3 -m http.server 8000
```

Then open **http://localhost:8000** in a browser.

Try searching "PADL01_0100100" or "kinase" in the gene panel, or
"GO:0006468" or "phosphorylation" in the GO panel. Click any result —
the timing badge on the detail card shows exactly how long that one fetch
took.

## What's actually happening

On page load, three small files are fetched once: `data/genes_index.json`
(~7.7MB — every gene ID, its species, and its product description),
`data/go_index.json` (~0.26MB — every GO ID and name that has at least one
hit), and `data/species.json` (~2KB). All searching/filtering after that
happens in the browser against those three files — no further network
calls until you click an actual result.

Clicking a gene fetches exactly one small file:
`data/genes/<species>/<gene_id>.json` (median ~740 bytes, max ~11KB across
all 96,285 genes). Clicking a GO term fetches
`data/go/<go_id>.json` (these vary more — a handful of very generic terms
like GO:0005488 run ~2MB since thousands of genes share them, but the vast
majority are well under 100KB).

## Name resolution

About 40% of all annotation/prediction entries in the source data have
`name` equal to the bare GO ID (e.g. `{"id": "GO:0005488", "name":
"GO:0005488"}`) — they were never resolved to a human-readable name when
`optimized_gene_index.json` was originally built. `build_data.py` resolves
these in two tiers:

1. **`go_terms.json` lookup** — the same fallback the original Streamlit
   app uses at render time (`plasmoFP_explorer_simple.py` lines ~489-490
   and ~538-539). Resolves 485,805 of the ~511,500 affected entries.
2. **`go-basic.obo` parsing** — for the remainder, where `go_terms.json` has
   no entry at all. These split into: IDs that were merged into a current
   term (resolved via `alt_id` to that term's name, e.g. GO:0000777 →
   "kinetochore"), obsolete terms with an explicit successor (resolved via
   `replaced_by`), and obsolete terms with no single successor (shown with
   their own retired name, "obsolete " prefix stripped). This resolves a
   further 25,677 entries.

After both tiers, 40 entries (all referencing a single GO ID, `GO:0160215`)
remained unresolved — that ID is genuinely too new to be in this
`go-basic.obo` snapshot at all (it sits in the very recently added
`GO:0160xxx` range; QuickGO's own term page is a JS app that won't return
data to a plain fetch, but AmiGO's server-rendered pages do — it's
"deacylase activity", molecular_function). Added as a small, explicitly-
sourced manual override (`MANUAL_NAME_OVERRIDES` in `build_data.py`) for
this last case. **Net result: 511,522 of 511,522 originally-unresolved
entries now resolve to a real name — zero remaining.**

`build_scripts/test_logic.js` includes regression checks for all three
resolution tiers (tests 9-11), including an exhaustive scan across all
96,285 gene shards confirming the unresolved count is exactly zero.

## Rebuilding the data

`build_scripts/build_data.py` is the script that produced everything under
`data/`. It reads the original PlasmoFP Explorer repo's
`optimized_gene_index.json`, `protein_descriptions.json`,
`go_id_to_genes.json`, and `go_terms.json`, and shards them into the
per-gene / per-GO-term files this app actually fetches. If the underlying
predictions ever get updated, clone the source repo as a sibling directory
and re-run:

```bash
git clone https://github.com/harshstava/PlasmoFP_Explorer.git
cd PlasmoFP_Explorer_static/build_scripts   # this directory
python3 build_data.py
```

`build_scripts/test_logic.js` is a headless correctness check (run with
`node test_logic.js`) — it verifies search results resolve to real files on
disk, gene/GO-term content round-trips correctly, and that searching stays
well under one debounce cycle (80ms) even across all 96,285 genes.

## What's intentionally NOT in this MVP

- The GO-term DAG visualization (the colored hierarchy view) — same static
  architecture would work for it, just not built yet here.
- Cluster distribution pie charts from the original app.
- The original 19-species pickle files / full go-basic.obo — not needed at
  runtime, only used upstream when PlasmoFP's predictions were generated.

## Deploying for real

Push `plasmofp_static/` (everything except `build_scripts/`, which is a
build-time tool, not a runtime dependency) to GitHub Pages, Cloudflare
Pages, Netlify, or wherever the lab's domain can point. No server config,
no Dockerfile — it's just files.
