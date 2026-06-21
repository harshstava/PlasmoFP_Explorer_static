// PlasmoFP Explorer — static MVP client logic.
// No build step, no framework. Everything below is plain fetch() + DOM updates.

const state = {
  genesIndex: null,   // { gene_id: [species_code, product] }
  goIndex: null,      // [{id, name}]
  species: null,      // [{code, display_name, gene_count}]
};

function safeFilename(s) {
  // Mirrors build_data.py's safe_filename() exactly, so client-built paths
  // match the files the build script actually wrote.
  return s.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

async function timedFetchJSON(url) {
  const start = performance.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const data = await res.json();
  const ms = performance.now() - start;
  return { data, ms };
}

// ---------- Boot: load the three small upfront indices ----------

async function boot() {
  const [genesRes, goRes, speciesRes] = await Promise.all([
    timedFetchJSON("data/genes_index.json"),
    timedFetchJSON("data/go_index.json"),
    timedFetchJSON("data/species.json"),
  ]);

  state.genesIndex = genesRes.data;
  state.goIndex = goRes.data;
  state.species = speciesRes.data;

  console.log(
    `Loaded ${Object.keys(state.genesIndex).length} genes (${genesRes.ms.toFixed(0)}ms), ` +
    `${state.goIndex.length} GO terms (${goRes.ms.toFixed(0)}ms), ` +
    `${state.species.length} species (${speciesRes.ms.toFixed(0)}ms)`
  );

  renderSpeciesStrip();
  wireSearch();
}

function renderSpeciesStrip() {
  const strip = document.getElementById("species-strip");
  strip.innerHTML = state.species
    .map(s => `<span class="species-chip"><b>${s.display_name}</b> · ${s.gene_count.toLocaleString()} genes</span>`)
    .join("");
}

// ---------- Gene search ----------

function searchGenes(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results = [];
  const index = state.genesIndex;
  for (const geneId in index) {
    const entry = index[geneId];
    const species = entry[0], product = entry[1];
    if (geneId.toLowerCase().includes(q) || (product && product.toLowerCase().includes(q))) {
      results.push({ geneId, species, product });
      if (results.length >= 50) break;
    }
  }
  return results;
}

function renderGeneResults(results) {
  const el = document.getElementById("gene-results");
  if (!results.length) {
    el.innerHTML = `<p class="result-empty">No matches yet — try a gene ID or a word from a product description.</p>`;
    return;
  }
  el.innerHTML = results.map(r => `
    <div class="result-row" role="option" tabindex="0"
         data-gene-id="${r.geneId}" data-species="${r.species}">
      <span class="result-id">${r.geneId}</span>
      <span class="result-meta">${r.product || "(no description)"}</span>
    </div>
  `).join("");

  el.querySelectorAll(".result-row").forEach(row => {
    row.addEventListener("click", () => openGene(row.dataset.geneId, row.dataset.species));
  });
}

async function openGene(geneId, species) {
  const path = `data/genes/${species}/${safeFilename(geneId)}.json`;
  const { data, ms } = await timedFetchJSON(path);
  renderGeneDetail(geneId, species, data, ms);
}

function scoreBar(score) {
  const pct = Math.max(2, Math.min(100, Math.round(score * 100)));
  return `<span class="score-bar" style="width:${pct}px"></span>`;
}

function renderPredictionTable(predictionsByFdr) {
  const thresholds = Object.keys(predictionsByFdr).sort((a, b) => parseFloat(a) - parseFloat(b));
  if (!thresholds.length) return `<p class="muted-note">No PlasmoFP predictions for this aspect.</p>`;

  const selectId = `fdr-${Math.random().toString(36).slice(2)}`;
  const renderRows = (fdr) => (predictionsByFdr[fdr] || []).map(p => `
    <tr>
      <td class="go-id">${p.id}</td>
      <td>${p.name}</td>
      <td class="score">${scoreBar(p.score)}${p.score.toFixed(4)}</td>
    </tr>
  `).join("");

  const defaultFdr = thresholds.includes("0.05") ? "0.05" : thresholds[0];

  setTimeout(() => {
    const sel = document.getElementById(selectId);
    if (sel) sel.addEventListener("change", () => {
      sel.closest(".aspect-block").querySelector("tbody").innerHTML = renderRows(sel.value);
    });
  }, 0);

  return `
    <label class="muted-note" for="${selectId}">eFDR threshold</label><br>
    <select id="${selectId}" class="fdr-select">
      ${thresholds.map(f => `<option value="${f}" ${f === defaultFdr ? "selected" : ""}>≤ ${f}</option>`).join("")}
    </select>
    <table class="pred-table">
      <thead><tr><th>GO ID</th><th>Name</th><th>Score</th></tr></thead>
      <tbody>${renderRows(defaultFdr)}</tbody>
    </table>
  `;
}

function renderOriginalAnnotations(annotations) {
  if (!annotations || !annotations.length) return `<p class="muted-note">None on record.</p>`;
  return `<ul style="margin:0;padding-left:1.1rem;font-size:0.85rem;">
    ${annotations.map(a => `<li><span class="result-id" style="font-size:0.8rem;">${a.id}</span> — ${a.name}</li>`).join("")}
  </ul>`;
}

function renderGeneDetail(geneId, species, data, ms) {
  const detail = document.getElementById("detail");
  const aspects = ["MF", "BP", "CC"];
  const aspectLabels = { MF: "Molecular function", BP: "Biological process", CC: "Cellular component" };
  const product = (state.genesIndex[geneId] || [])[1] || "";

  detail.innerHTML = `
    <div class="detail-card">
      <div class="detail-header">
        <div>
          <div class="detail-id">${geneId}</div>
          <div class="detail-sub">${species} — ${product || "no product description"}</div>
        </div>
        <span class="timing-badge">fetched in ${ms.toFixed(1)} ms</span>
      </div>
      ${aspects.map(asp => `
        <div class="aspect-block">
          <p class="aspect-title">${aspectLabels[asp]} — original annotations</p>
          ${renderOriginalAnnotations((data.original_annotations || {})[asp])}
          <p class="aspect-title" style="margin-top:0.6rem;">${aspectLabels[asp]} — PlasmoFP predictions</p>
          ${renderPredictionTable((data.pfp_predictions || {})[asp] || {})}
        </div>
      `).join("")}
    </div>
  `;
  detail.hidden = false;
  detail.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- GO term search ----------

function searchGoTerms(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results = [];
  for (const term of state.goIndex) {
    if (term.id.toLowerCase().includes(q) || term.name.toLowerCase().includes(q)) {
      results.push(term);
      if (results.length >= 50) break;
    }
  }
  return results;
}

function renderGoResults(results) {
  const el = document.getElementById("go-results");
  if (!results.length) {
    el.innerHTML = `<p class="result-empty">No matches yet — try a GO ID or a word from a term name.</p>`;
    return;
  }
  el.innerHTML = results.map(r => `
    <div class="result-row" role="option" tabindex="0" data-go-id="${r.id}">
      <span class="result-id">${r.id}</span>
      <span class="result-meta">${r.name}</span>
    </div>
  `).join("");

  el.querySelectorAll(".result-row").forEach(row => {
    row.addEventListener("click", () => openGoTerm(row.dataset.goId));
  });
}

async function openGoTerm(goId) {
  const path = `data/go/${safeFilename(goId)}.json`;
  const { data, ms } = await timedFetchJSON(path);
  renderGoDetail(data, ms);
}

function renderGoDetail(data, ms) {
  const detail = document.getElementById("detail");
  const genes = data.genes || [];
  const shown = genes.slice(0, 300);

  detail.innerHTML = `
    <div class="detail-card">
      <div class="detail-header">
        <div>
          <div class="detail-id">${data.id}</div>
          <div class="detail-sub">${data.name} — ${genes.length.toLocaleString()} annotated/predicted gene${genes.length === 1 ? "" : "s"}</div>
        </div>
        <span class="timing-badge">fetched in ${ms.toFixed(1)} ms</span>
      </div>
      <table class="pred-table">
        <thead><tr><th>Gene ID</th><th>Species</th><th>Source</th></tr></thead>
        <tbody>
          ${shown.map(([geneId, species, source]) => `
            <tr>
              <td class="go-id" style="cursor:pointer;text-decoration:underline;"
                  data-gene-id="${geneId}" data-species="${species}">${geneId}</td>
              <td>${species}</td>
              <td>${source}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      ${genes.length > shown.length ? `<p class="muted-note">Showing first ${shown.length.toLocaleString()} of ${genes.length.toLocaleString()} genes.</p>` : ""}
    </div>
  `;
  detail.querySelectorAll("td.go-id[data-gene-id]").forEach(cell => {
    cell.addEventListener("click", () => openGene(cell.dataset.geneId, cell.dataset.species));
  });
  detail.hidden = false;
  detail.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- Wiring ----------

function wireSearch() {
  const geneInput = document.getElementById("gene-search");
  const goInput = document.getElementById("go-search");

  geneInput.addEventListener("input", debounce(() => {
    renderGeneResults(searchGenes(geneInput.value));
  }, 80));

  goInput.addEventListener("input", debounce(() => {
    renderGoResults(searchGoTerms(goInput.value));
  }, 80));
}

boot().catch(err => {
  console.error(err);
  document.body.insertAdjacentHTML("afterbegin",
    `<div style="background:#fee;color:#900;padding:1rem;font-family:monospace;">
      Failed to load data indices: ${err.message}. Make sure you're running this through a local
      server (e.g. <code>python3 -m http.server</code>) rather than opening index.html directly,
      and that the data/ folder sits next to index.html.
    </div>`);
});
