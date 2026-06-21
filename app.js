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

  wireSearch();
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

async function openGene(geneId, species, focusGoId) {
  const path = `data/genes/${species}/${safeFilename(geneId)}.json`;
  const { data, ms } = await timedFetchJSON(path);
  renderGeneDetail(geneId, species, data, ms, focusGoId);
}

// Given a GO id, find the subontology it belongs to and the tightest (smallest)
// eFDR threshold whose prediction bucket already includes it — so opening a
// gene from that term's search result shows it without the user having to
// loosen the threshold themselves.
function findFdrForGoTerm(pfpPredictions, goId) {
  if (!goId) return null;
  for (const subontology in pfpPredictions) {
    const thresholds = Object.keys(pfpPredictions[subontology]).sort((a, b) => parseFloat(a) - parseFloat(b));
    for (const fdr of thresholds) {
      if ((pfpPredictions[subontology][fdr] || []).some(p => p.id === goId)) {
        return { subontology, fdr };
      }
    }
  }
  return null;
}

function scoreBar(score) {
  const pct = Math.max(2, Math.min(100, Math.round(score * 100)));
  return `<span class="score-bar" style="width:${pct}px"></span>`;
}

// ---------- Functional clustering ----------

// Stable color per cluster ID, independent of subontology — same cluster id
// always gets the same color so repeat viewing across subontologies/genes
// stays legible.
const CLUSTER_COLORS = [
  "#b8841a", "#5b8a72", "#5e7ea8", "#a85e7e", "#8f6512",
  "#6b9e4f", "#9e5b4f", "#6b6457",
];

function clusterColor(clusterId) {
  const n = parseInt(clusterId, 10);
  return CLUSTER_COLORS[Number.isFinite(n) ? n % CLUSTER_COLORS.length : 0];
}

function clusterLabel(entry) {
  if (!entry.cluster_id) return `<span class="muted-note">not clustered</span>`;
  return `<span class="cluster-tag" style="--cluster-color:${clusterColor(entry.cluster_id)}">${entry.cluster_id}: ${entry.cluster_name}</span>`;
}

function renderClusterChart(predictions) {
  const counts = new Map(); // cluster_id -> {name, count}
  let clustered = 0;
  for (const p of predictions) {
    if (!p.cluster_id) continue;
    clustered++;
    const c = counts.get(p.cluster_id) || { name: p.cluster_name, count: 0 };
    c.count++;
    counts.set(p.cluster_id, c);
  }
  if (!clustered) return `<p class="muted-note">No clustered terms available for this threshold.</p>`;

  const r = 38, cx = 44, cy = 44;
  let angle = 0;
  const slices = [];
  for (const [clusterId, { count }] of counts) {
    const frac = count / clustered;
    const start = angle;
    const end = angle + frac * 2 * Math.PI;
    angle = end;
    const large = frac > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.sin(start), y1 = cy - r * Math.cos(start);
    const x2 = cx + r * Math.sin(end), y2 = cy - r * Math.cos(end);
    const path = frac >= 0.9999
      ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`
      : `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
    slices.push(`<path d="${path}" fill="${clusterColor(clusterId)}"></path>`);
  }

  const legend = [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([clusterId, { name, count }]) => `
      <li><span class="legend-dot" style="background:${clusterColor(clusterId)}"></span>
        ${clusterId}: ${name} <span class="muted-note">(${count})</span></li>
    `).join("");

  return `
    <div class="cluster-chart">
      <svg viewBox="0 0 88 88" width="88" height="88" role="img" aria-label="Functional cluster distribution">${slices.join("")}</svg>
      <ul class="cluster-legend">${legend}</ul>
    </div>
  `;
}

function renderPredictionTable(predictionsByFdr, preferredFdr) {
  const thresholds = Object.keys(predictionsByFdr).sort((a, b) => parseFloat(a) - parseFloat(b));

  const selectId = `fdr-${Math.random().toString(36).slice(2)}`;
  const renderRows = (fdr) => (predictionsByFdr[fdr] || []).map(p => `
    <tr>
      <td class="go-id">${p.id}</td>
      <td>${p.name}</td>
      <td>${clusterLabel(p)}</td>
      <td class="score">${scoreBar(p.score)}${p.score.toFixed(4)}</td>
    </tr>
  `).join("");

  const defaultFdr = (preferredFdr && thresholds.includes(preferredFdr)) ? preferredFdr :
    (thresholds.includes("0.05") ? "0.05" : thresholds[0]);

  setTimeout(() => {
    const sel = document.getElementById(selectId);
    if (sel) sel.addEventListener("change", () => {
      const block = sel.closest(".subontology-block");
      block.querySelector("tbody").innerHTML = renderRows(sel.value);
      block.querySelector(".cluster-chart-wrap").innerHTML = renderClusterChart(predictionsByFdr[sel.value] || []);
    });
  }, 0);

  return `
    <p class="subontology-title" style="margin-top:0.6rem;"><span class="brand-name">PlasmoFP</span> predictions</p>
    <label class="muted-note" for="${selectId}">eFDR threshold</label><br>
    <select id="${selectId}" class="fdr-select">
      ${thresholds.map(f => `<option value="${f}" ${f === defaultFdr ? "selected" : ""}>≤ ${f}</option>`).join("")}
    </select>
    <table class="pred-table">
      <thead><tr><th>GO ID</th><th>Name</th><th>Cluster</th><th>Score</th></tr></thead>
      <tbody>${renderRows(defaultFdr)}</tbody>
    </table>
    <p class="subontology-title" style="margin-top:0.8rem;">Functional cluster distribution</p>
    <div class="cluster-chart-wrap">${renderClusterChart(predictionsByFdr[defaultFdr] || [])}</div>
  `;
}

function renderOriginalAnnotations(annotations) {
  return `
    <p class="subontology-title">Original annotations</p>
    <ul class="annotation-list">
      ${annotations.map(a => `<li><span class="result-id" style="font-size:0.8rem;">${a.id}</span> — ${a.name} ${clusterLabel(a)}</li>`).join("")}
    </ul>
    <p class="subontology-title" style="margin-top:0.8rem;">Functional cluster distribution</p>
    <div class="cluster-chart-wrap">${renderClusterChart(annotations)}</div>
  `;
}

function renderSubontologyBlock(label, annotations, predictionsByFdr, preferredFdr) {
  const annCount = annotations.length;
  const predCount = Object.values(predictionsByFdr).reduce((max, list) => Math.max(max, list.length), 0);
  const isEmpty = annCount === 0 && predCount === 0;

  const summary = isEmpty
    ? "no predictions ≤30% eFDR or original annotations"
    : `${annCount.toLocaleString()} annotation${annCount === 1 ? "" : "s"} · ${predCount.toLocaleString()} prediction${predCount === 1 ? "" : "s"}`;

  const body = isEmpty
    ? `<p class="muted-note">No predictions ≤30% eFDR or original annotations for this subontology.</p>`
    : `${annCount ? renderOriginalAnnotations(annotations) : ""}${predCount ? renderPredictionTable(predictionsByFdr, preferredFdr) : ""}`;

  return `
    <details class="subontology-block" ${isEmpty ? "" : "open"}>
      <summary class="subontology-summary">
        <span class="subontology-name">${label}</span>
        <span class="muted-note">${summary}</span>
      </summary>
      <div class="subontology-body">${body}</div>
    </details>
  `;
}

function renderGeneDetail(geneId, species, data, ms, focusGoId) {
  const detail = document.getElementById("detail");
  const subontologies = ["MF", "BP", "CC"];
  const subontologyLabels = { MF: "Molecular function", BP: "Biological process", CC: "Cellular component" };
  const product = (state.genesIndex[geneId] || [])[1] || "";
  const focus = findFdrForGoTerm(data.pfp_predictions || {}, focusGoId);

  detail.innerHTML = `
    <div class="detail-card">
      <div class="detail-header">
        <div>
          <div class="detail-id">${geneId}</div>
          <div class="detail-sub">${species} — ${product || "no product description"}</div>
        </div>
        <span class="timing-badge">fetched in ${ms.toFixed(1)} ms</span>
      </div>
      ${subontologies.map(sub => renderSubontologyBlock(
        subontologyLabels[sub],
        (data.original_annotations || {})[sub] || [],
        (data.pfp_predictions || {})[sub] || {},
        focus && focus.subontology === sub ? focus.fdr : null
      )).join("")}
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
    cell.addEventListener("click", () => openGene(cell.dataset.geneId, cell.dataset.species, data.id));
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
