// Headless logic test — mirrors the pure (non-DOM) functions in app.js exactly,
// run against the real generated data, to verify search + path-building work
// before trusting it in an actual browser.

const fs = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "..", "data");

function safeFilename(s) {
  return s.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function searchGenes(genesIndex, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results = [];
  for (const geneId in genesIndex) {
    const entry = genesIndex[geneId];
    const species = entry[0], product = entry[1];
    if (geneId.toLowerCase().includes(q) || (product && product.toLowerCase().includes(q))) {
      results.push({ geneId, species, product });
      if (results.length >= 50) break;
    }
  }
  return results;
}

function searchGoTerms(goIndex, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results = [];
  for (const term of goIndex) {
    if (term.id.toLowerCase().includes(q) || term.name.toLowerCase().includes(q)) {
      results.push(term);
      if (results.length >= 50) break;
    }
  }
  return results;
}

function assert(cond, msg) {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("ok  -", msg);
}

console.log("Loading genes_index.json + go_index.json from disk (as the browser would after fetch)...");
const t0 = Date.now();
const genesIndex = JSON.parse(fs.readFileSync(path.join(DATA, "genes_index.json")));
const goIndex = JSON.parse(fs.readFileSync(path.join(DATA, "go_index.json")));
console.log(`Parsed ${Object.keys(genesIndex).length} genes + ${goIndex.length} GO terms in ${Date.now() - t0}ms\n`);

// --- Test 1: known gene ID search resolves and its shard file actually exists ---
const idResults = searchGenes(genesIndex, "PADL01_0100100");
assert(idResults.length === 1 && idResults[0].geneId === "PADL01_0100100-t36_1-p1",
  "exact-ish gene ID search finds PADL01_0100100-t36_1-p1");

const { geneId, species } = idResults[0];
const genePath = path.join(DATA, "genes", species, safeFilename(geneId) + ".json");
assert(fs.existsSync(genePath), `built path resolves to a real file: ${genePath}`);

// --- Test 2: product/description search finds kinase-related genes ---
const kinaseResults = searchGenes(genesIndex, "kinase");
assert(kinaseResults.length > 0, `free-text product search "kinase" returns ${kinaseResults.length} hits`);
assert(kinaseResults.every(r => r.product.toLowerCase().includes("kinase")),
  "every kinase search hit actually contains 'kinase' in its product description");

// --- Test 3: GO ID search resolves and its shard exists ---
const goByIdResults = searchGoTerms(goIndex, "GO:0006468");
assert(goByIdResults.length === 1 && goByIdResults[0].name === "protein phosphorylation",
  "GO ID search resolves GO:0006468 -> 'protein phosphorylation'");
const goPath = path.join(DATA, "go", safeFilename(goByIdResults[0].id) + ".json");
assert(fs.existsSync(goPath), `built GO path resolves to a real file: ${goPath}`);

// --- Test 4: GO name search (case-insensitive, partial) works ---
const goByNameResults = searchGoTerms(goIndex, "phosphorylation");
assert(goByNameResults.some(r => r.id === "GO:0006468"),
  `free-text GO name search "phosphorylation" includes GO:0006468 (${goByNameResults.length} total hits)`);

// --- Test 5: gene detail content round-trips correctly through the shard ---
const geneDetail = JSON.parse(fs.readFileSync(genePath));
assert(geneDetail.pfp_predictions.MF["0.2"].some(p => p.id === "GO:0097159"),
  "gene shard content matches expected PlasmoFP predictions (spot-checked GO:0097159 at eFDR 0.2)");

// --- Test 6: GO term detail content round-trips and gene count is sane ---
const goDetail = JSON.parse(fs.readFileSync(goPath));
assert(goDetail.genes.length > 0 && goDetail.genes.some(g => g[0] === "PADL01_0723900-t36_1-p1"),
  `GO:0006468 shard lists ${goDetail.genes.length} genes and includes a known one (PADL01_0723900-t36_1-p1)`);

// --- Test 7: empty query returns no results (no accidental "match everything") ---
assert(searchGenes(genesIndex, "").length === 0, "empty gene query returns zero results");
assert(searchGoTerms(goIndex, "   ").length === 0, "whitespace-only GO query returns zero results");

// --- Test 8: search timing at full scale (96,285 genes) is fast enough for live typing ---
// Run each query a few times (JIT warms up after the first call, same as it would
// in a real browsing session after the first couple of keystrokes).
const queries = ["PF3D7", "kinase", "transport", "PADL", "GO:0005"];
const timings = queries.map(q => {
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const start = Date.now();
    searchGenes(genesIndex, q);
    best = Math.min(best, Date.now() - start);
  }
  return best;
});
console.log(`\nClient-side filter timing over ${Object.keys(genesIndex).length} genes (best of 5 per query): ${timings.join(", ")} ms`);
assert(Math.max(...timings) < 80, "every sample search resolves in well under one debounce cycle (80ms)");

// --- Test 9: name-resolution fallback actually applied (regression check for the
// "GO:0005488 instead of 'binding'" bug) ---
const pf3d7Path = path.join(DATA, "genes", "Pfalciparum3D7", "PF3D7_0106000.1-p1.json");
const pf3d7 = JSON.parse(fs.readFileSync(pf3d7Path));
const mf02 = pf3d7.pfp_predictions.MF["0.2"];
const binding = mf02.find(p => p.id === "GO:0005488");
assert(binding && binding.name === "binding",
  "GO:0005488 resolves to 'binding' instead of showing the bare ID (name-resolution fallback)");
assert(!mf02.some(p => p.name === p.id),
  "no remaining unresolved (name === id) entries in this gene's MF/0.2 predictions where go_terms.json had a real name");

// --- Test 10: obo-based fallback resolves merged/obsolete IDs go_terms.json
// has no entry for at all (regression check for the "313 still unresolvable" gap) ---
const vinckeiPath = path.join(DATA, "genes", "PvinckeibrucechwattiDA", "CAD2102245.1.json");
const vinckei = JSON.parse(fs.readFileSync(vinckeiPath));
const kinetochore = vinckei.original_annotations.CC.find(a => a.id === "GO:0000777");
assert(kinetochore && kinetochore.name === "kinetochore",
  "GO:0000777 (merged into GO:0000776 via alt_id, absent from go_terms.json) resolves to 'kinetochore'");

// --- Test 11: manual override resolves the last gap (GO:0160215), and the
// dataset-wide unresolved count is now exactly zero ---
const fs2 = require("fs");
let unresolvedCount = 0;
let foundDeacylase = false;
for (const species of fs2.readdirSync(path.join(DATA, "genes"))) {
  for (const file of fs2.readdirSync(path.join(DATA, "genes", species))) {
    const rec = JSON.parse(fs2.readFileSync(path.join(DATA, "genes", species, file)));
    for (const byFdr of Object.values(rec.pfp_predictions || {})) {
      for (const plist of Object.values(byFdr)) {
        for (const p of plist) {
          if (p.name === p.id) unresolvedCount++;
          if (p.id === "GO:0160215" && !foundDeacylase) {
            assert(p.name === "deacylase activity", "GO:0160215 resolves to 'deacylase activity' via manual override");
            foundDeacylase = true;
          }
        }
      }
    }
    for (const alist of Object.values(rec.original_annotations || {})) {
      for (const a of alist) {
        if (a.name === a.id) unresolvedCount++;
        if (a.id === "GO:0160215" && !foundDeacylase) {
          assert(a.name === "deacylase activity", "GO:0160215 resolves to 'deacylase activity' via manual override");
          foundDeacylase = true;
        }
      }
    }
  }
}
assert(unresolvedCount === 0, `zero unresolved (name === id) entries remain across all 96,285 genes (found ${unresolvedCount})`);
console.log(foundDeacylase ? "(GO:0160215 occurrence found and checked)" : "(GO:0160215 doesn't occur in this dataset, but the zero-unresolved check above still covers it)");

console.log("\nAll logic checks passed.");
