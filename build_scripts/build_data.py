#!/usr/bin/env python3
"""
Build script: shards PlasmoFP Explorer's monolithic JSON indices into many
small static files suitable for direct client-side fetch() — no server,
no eager full-dataset load.

Run once (or whenever source data changes):
    python3 build_data.py

Input:  ../../PlasmoFP_Explorer/  (the original repo's data files)
Output: ../data/                  (sharded static data, served as-is)
"""

import csv
import json
import re
from pathlib import Path
from collections import defaultdict

SRC = Path(__file__).parent.parent.parent / "PlasmoFP_Explorer"
OUT = Path(__file__).parent.parent / "data"

SPECIES_DISPLAY = {
    "Pfalciparum3D7": "P. falciparum 3D7",
    "PvivaxSal1": "P. vivax Sal1",
    "PknowlesiH": "P. knowlesi H",
    "PcynomolgiM": "P. cynomolgi M",
    "PcoatneyiHackeri": "P. coatneyi Hackeri",
    "PinuiSanAntonio1": "P. inui San Antonio 1",
    "PfragileNilgiri": "P. fragile Nilgiri",
    "PmalariaeUG01": "P. malariae UG01",
    "PovalecurtisiGH01": "P. ovale curtisi GH01",
    "PovalewallikeriPowCR01": "P. ovale wallikeri PowCR01",
    "PreichenowiCDC": "P. reichenowi CDC",
    "PgaboniG01": "P. gaboni G01",
    "PadleriG01": "P. adleri G01",
    "PblacklockiG01": "P. blacklocki G01",
    "PgallinaceumLT8": "P. gallinaceum 8A",
    "Pgallinaceum8A": "P. gallinaceum 8A",
    "PbergheiANKA": "P. berghei ANKA",
    "Pyoeliiyoelii17XNL2023": "P. yoelii yoelii 17XNL",
    "Pchabaudichabaudi": "P. chabaudi chabaudi",
    "PvinckeibrucechwattiDA": "P. vinckei brucechwatti DA",
}


def safe_filename(s: str) -> str:
    """Make a string safe to use as a filename across filesystems."""
    return re.sub(r"[^A-Za-z0-9_.\-]", "_", s)


def load_json(name):
    with open(SRC / name) as f:
        return json.load(f)


CLUSTER_FILES = {
    "MF": "MF_term_clusters.tsv",
    "BP": "BP_term_clusters.tsv",
    "CC": "CC_term_clusters.tsv",
}


def load_cluster_mappings():
    """Mirrors plasmoFP_explorer_simple.py's load_cluster_mappings(): one
    GO_ID -> {cluster_id, cluster_name} map per aspect, from the lab's
    functional clustering TSVs."""
    mappings = {}
    for aspect, filename in CLUSTER_FILES.items():
        aspect_map = {}
        with open(SRC / filename) as f:
            for row in csv.DictReader(f, delimiter="\t"):
                aspect_map[row["GO_ID"]] = {
                    "cluster_id": row["ClusterID"],
                    "cluster_name": row["ClusterName"],
                }
        mappings[aspect] = aspect_map
        print(f"Loaded {len(aspect_map)} cluster mappings for {aspect} from {filename}.")
    return mappings


def parse_obo_fallback_names(go_terms):
    """For the small remainder of GO IDs that go_terms.json has no entry
    for at all (merged-away IDs, obsolete terms), parse go-basic.obo
    directly and build a best-effort name for each:
      - if the ID was merged into a current term (alt_id), use that term's name
      - if obsolete with a single replaced_by successor, use that successor's name
      - otherwise (obsolete with no/ambiguous successor), use the term's own
        retired name with the "obsolete " prefix stripped
    Returns {go_id: resolved_name} for only the IDs this can actually help with.
    """
    terms = {}
    alt_to_primary = {}
    cur = None

    def flush(c):
        if c and c.get("id"):
            terms[c["id"]] = c
            for a in c.get("alt_id", []):
                alt_to_primary[a] = c["id"]

    with open(SRC / "go-basic.obo") as f:
        for raw in f:
            line = raw.rstrip("\n").rstrip("\r")
            if line == "[Term]":
                flush(cur)
                cur = {"alt_id": []}
            elif cur is None:
                continue
            elif line.startswith("id: "):
                cur["id"] = line[4:].split(" ! ")[0].strip()
            elif line.startswith("name: "):
                cur["name"] = line[6:].strip()
            elif line.startswith("alt_id: "):
                cur["alt_id"].append(line[8:].split(" ! ")[0].strip())
            elif line.startswith("is_obsolete: "):
                cur["is_obsolete"] = line[13:].strip() == "true"
            elif line.startswith("replaced_by: "):
                cur["replaced_by"] = line[13:].split(" ! ")[0].strip()
        flush(cur)

    def lookup_name(go_id):
        return go_terms.get(go_id) or terms.get(go_id, {}).get("name")

    fallback = {}
    for alt_id, primary_id in alt_to_primary.items():
        name = lookup_name(primary_id)
        if name:
            fallback[alt_id] = name

    for go_id, t in terms.items():
        if go_id in fallback:
            continue
        if t.get("is_obsolete"):
            rep = t.get("replaced_by")
            if rep and lookup_name(rep):
                fallback[go_id] = lookup_name(rep)
            elif t.get("name", "").startswith("obsolete "):
                fallback[go_id] = t["name"][len("obsolete "):]

    print(f"Parsed go-basic.obo fallback names for {len(fallback)} merged/obsolete GO IDs.")
    return fallback


# GO IDs too new to be in the go-basic.obo snapshot shipped in this repo
# (added to the ontology after that file was generated). Looked up by hand
# against AmiGO (https://amigo.geneontology.org/amigo/term/<id>) since
# QuickGO's own term pages are a JS SPA that don't return data to a plain
# fetch. Checked 2026-06-20.
MANUAL_NAME_OVERRIDES = {
    "GO:0160215": "deacylase activity",  # molecular_function; PMID:29637793, 38355760, 2760018
}


def resolve_name(go_id, go_name, go_terms, obo_fallback):
    """Mirror plasmoFP_explorer_simple.py's exact fallback first (go_terms.json),
    then fall back further to go-basic.obo for merged/obsolete IDs go_terms.json
    has no entry for at all, then finally to a small hand-checked override table
    for IDs too new to be in either."""
    if go_name != go_id:
        return go_name
    if go_id in go_terms:
        return go_terms[go_id]
    if go_id in obo_fallback:
        return obo_fallback[go_id]
    if go_id in MANUAL_NAME_OVERRIDES:
        return MANUAL_NAME_OVERRIDES[go_id]
    return go_name


def attach_cluster(entry, aspect, cluster_mappings):
    info = cluster_mappings.get(aspect, {}).get(entry["id"])
    if info:
        entry["cluster_id"] = info["cluster_id"]
        entry["cluster_name"] = info["cluster_name"]
    return entry


def build_genes(go_terms, obo_fallback, cluster_mappings):
    print("Loading optimized_gene_index.json ...")
    genes = load_json("optimized_gene_index.json")
    print("Loading protein_descriptions.json ...")
    products = load_json("protein_descriptions.json")

    species_counts = defaultdict(int)
    genes_index = {}  # gene_id -> [species_code, product]

    gene_dir = OUT / "genes"
    gene_dir.mkdir(parents=True, exist_ok=True)

    species_dirs_made = set()
    resolved_count = 0

    for gid, rec in genes.items():
        species = rec.get("species", "Unknown")
        species_counts[species] += 1
        product = products.get(gid, "")
        genes_index[gid] = [species, product]

        if species not in species_dirs_made:
            (gene_dir / species).mkdir(parents=True, exist_ok=True)
            species_dirs_made.add(species)

        original_annotations = {}
        for aspect, alist in rec.get("original_annotations", {}).items():
            fixed = []
            for a in alist:
                name = resolve_name(a["id"], a["name"], go_terms, obo_fallback)
                if name != a["name"]:
                    resolved_count += 1
                entry = {"id": a["id"], "name": name}
                attach_cluster(entry, aspect, cluster_mappings)
                fixed.append(entry)
            original_annotations[aspect] = fixed

        pfp_predictions = {}
        for aspect, by_fdr in rec.get("pfp_predictions", {}).items():
            fixed_by_fdr = {}
            for fdr, plist in by_fdr.items():
                fixed = []
                for p in plist:
                    name = resolve_name(p["id"], p["name"], go_terms, obo_fallback)
                    if name != p["name"]:
                        resolved_count += 1
                    entry = {"id": p["id"], "name": name, "score": p["score"]}
                    attach_cluster(entry, aspect, cluster_mappings)
                    fixed.append(entry)
                fixed_by_fdr[fdr] = fixed
            pfp_predictions[aspect] = fixed_by_fdr

        detail = {
            "original_annotations": original_annotations,
            "pfp_predictions": pfp_predictions,
        }
        out_path = gene_dir / species / f"{safe_filename(gid)}.json"
        with open(out_path, "w") as f:
            json.dump(detail, f, separators=(",", ":"))

    print(f"Wrote {len(genes)} per-gene shards across {len(species_counts)} species.")
    print(f"Resolved {resolved_count} previously-unresolved GO names via go_terms.json.")

    with open(OUT / "genes_index.json", "w") as f:
        json.dump(genes_index, f, separators=(",", ":"))
    print(f"Wrote genes_index.json ({len(genes_index)} entries).")

    species_list = [
        {
            "code": sp,
            "display_name": SPECIES_DISPLAY.get(sp, sp),
            "gene_count": count,
        }
        for sp, count in sorted(species_counts.items(), key=lambda x: -x[1])
    ]
    with open(OUT / "species.json", "w") as f:
        json.dump(species_list, f, indent=2)
    print(f"Wrote species.json ({len(species_list)} species).")

    return genes_index


def build_go_terms(go_terms, obo_fallback):
    print("Loading go_id_to_genes.json ...")
    go_id_to_genes = load_json("go_id_to_genes.json")

    go_dir = OUT / "go"
    go_dir.mkdir(parents=True, exist_ok=True)

    go_index = []  # [{id, name}] for terms that actually have hits

    for go_id, hits in go_id_to_genes.items():
        name = go_terms.get(go_id) or obo_fallback.get(go_id) or go_id
        go_index.append({"id": go_id, "name": name})

        detail = {"id": go_id, "name": name, "genes": hits}
        out_path = go_dir / f"{safe_filename(go_id)}.json"
        with open(out_path, "w") as f:
            json.dump(detail, f, separators=(",", ":"))

    with open(OUT / "go_index.json", "w") as f:
        json.dump(go_index, f, separators=(",", ":"))

    print(f"Wrote {len(go_id_to_genes)} per-term GO shards and go_index.json.")


def report_sizes():
    def du(p):
        total = sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
        return total / 1e6

    print("\n--- Output sizes ---")
    print(f"genes_index.json : {(OUT / 'genes_index.json').stat().st_size / 1e6:.2f} MB")
    print(f"go_index.json    : {(OUT / 'go_index.json').stat().st_size / 1e6:.2f} MB")
    print(f"species.json     : {(OUT / 'species.json').stat().st_size / 1e3:.1f} KB")
    print(f"genes/ (all shards) : {du(OUT / 'genes'):.2f} MB total, "
          f"{len(list((OUT/'genes').rglob('*.json')))} files")
    print(f"go/ (all shards)    : {du(OUT / 'go'):.2f} MB total, "
          f"{len(list((OUT/'go').glob('*.json')))} files")
    print(f"\nTOTAL data/ size: {du(OUT):.2f} MB")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    print("Loading go_terms.json (shared name-resolution lookup) ...")
    go_terms = load_json("go_terms.json")
    obo_fallback = parse_obo_fallback_names(go_terms)
    cluster_mappings = load_cluster_mappings()
    build_genes(go_terms, obo_fallback, cluster_mappings)
    build_go_terms(go_terms, obo_fallback)
    report_sizes()
    print("\nDone.")
