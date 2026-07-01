// Network statistics, computed once from the already-loaded connectome. The
// counting is a pure function (computeStats) shared by the browser panel and the
// Node self-check, so both agree by construction. Additive: it reads the same
// nodes/chemical/gap data the app already holds and never refetches or rebuilds
// the graph.

(function (global) {
  "use strict";

  const HUB_COUNT = 8;
  const HIST_BINS = 12;

  // Degree here is a neuron's total connection count: every chemical synapse it
  // sends or receives, plus every gap junction it touches. Matches the app's own
  // in + out + gap degree.
  function computeStats(data) {
    const nodes = (data && data.nodes) || [];
    const chem = (data && data.chemical) || [];
    const gap = (data && data.gap) || [];
    const n = nodes.length;

    const types = { sensory: 0, inter: 0, motor: 0, unknown: 0 };
    const deg = new Map();
    for (const nd of nodes) {
      types[Object.prototype.hasOwnProperty.call(types, nd.type) ? nd.type : "unknown"]++;
      deg.set(nd.id, 0);
    }
    const bump = (id) => { if (deg.has(id)) deg.set(id, deg.get(id) + 1); };
    for (const e of chem) { bump(e.source); bump(e.target); }
    for (const e of gap) { bump(e.source); bump(e.target); }

    let sum = 0;
    let maxDeg = 0;
    const degrees = [];
    for (const nd of nodes) {
      const d = deg.get(nd.id);
      degrees.push(d);
      sum += d;
      if (d > maxDeg) maxDeg = d;
    }

    const hubs = nodes
      .map((nd) => ({ id: nd.id, name: nd.name, type: nd.type, degree: deg.get(nd.id) }))
      .sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, HUB_COUNT);

    // Fixed-count histogram of the degree distribution, bins of equal width.
    const binWidth = Math.max(1, Math.ceil((maxDeg + 1) / HIST_BINS));
    const bins = new Array(Math.max(1, Math.ceil((maxDeg + 1) / binWidth))).fill(0);
    for (const d of degrees) bins[Math.min(bins.length - 1, Math.floor(d / binWidth))]++;

    return {
      total: n,
      types: types,
      chem: chem.length,
      gap: gap.length,
      mean: n ? sum / n : 0,
      hubs: hubs,
      hist: { bins: bins, binWidth: binWidth, maxDeg: maxDeg },
    };
  }

  // --- browser panel (skipped under Node) ------------------------------------

  if (typeof document !== "undefined") {
    let panel, bodyEl, histCanvas, btn;
    let stats = null;

    function buildPanel() {
      panel = document.createElement("div");
      panel.id = "stats";
      panel.hidden = true;
      panel.innerHTML =
        '<div id="stats-head"><span>Network</span>' +
        '<button id="stats-close" type="button" title="close">close</button></div>' +
        '<div id="stats-body"></div>';
      document.body.appendChild(panel);
      bodyEl = panel.querySelector("#stats-body");
      panel.querySelector("#stats-close").addEventListener("click", () => { panel.hidden = true; });
    }

    // Compute once, the first time the panel is opened (data is loaded by then).
    function ensureStats() {
      if (stats) return true;
      if (typeof nodes === "undefined" || !nodes.length || typeof chemical === "undefined" || typeof gap === "undefined") {
        return false;
      }
      stats = computeStats({ nodes: nodes, chemical: chemical, gap: gap });
      render();
      return true;
    }

    function typeColor(t) {
      return (typeof TYPES !== "undefined" && (TYPES[t] || TYPES.unknown)).color || "#c9d1d9";
    }
    function typeLabel(t) {
      return (typeof TYPES !== "undefined" && (TYPES[t] || TYPES.unknown)).label || t;
    }

    function render() {
      const s = stats;
      const tSpan = (t) => '<span style="color:' + typeColor(t) + '">' + s.types[t] + " " + typeLabel(t).toLowerCase() + "</span>";

      let hubs = '<div class="st-sub">Top hubs by connections</div><div class="st-hubs">';
      for (const h of s.hubs) {
        hubs += '<div class="st-hub" data-id="' + h.id + '">' +
          '<span><span class="dot" style="background:' + typeColor(h.type) + '"></span>' + h.name + "</span>" +
          '<span class="deg">' + h.degree + "</span></div>";
      }
      hubs += "</div>";

      bodyEl.innerHTML =
        '<div class="st-row"><b>' + s.total + "</b> neurons</div>" +
        '<div class="st-row st-types">' + tSpan("sensory") + " &middot; " + tSpan("inter") + " &middot; " +
          tSpan("motor") + " &middot; " + tSpan("unknown") + "</div>" +
        '<div class="st-row">' + s.chem + " chemical synapses</div>" +
        '<div class="st-row">' + s.gap + " gap junctions</div>" +
        '<div class="st-row">mean <b>' + s.mean.toFixed(1) + "</b> connections per neuron</div>" +
        hubs +
        '<div class="st-sub" style="margin-top:2px">Degree distribution</div>' +
        '<canvas id="stats-hist"></canvas>' +
        '<div class="st-cap">These count chemical and gap connections together.</div>';

      histCanvas = bodyEl.querySelector("#stats-hist");
      for (const row of bodyEl.querySelectorAll(".st-hub")) {
        row.addEventListener("click", () => {
          if (typeof setSelected === "function") setSelected(row.getAttribute("data-id"));
        });
      }
    }

    function drawHistogram() {
      if (!histCanvas || !stats) return;
      const dpr = window.devicePixelRatio || 1;
      const cssW = histCanvas.clientWidth || 240;
      const cssH = histCanvas.clientHeight || 70;
      histCanvas.width = Math.round(cssW * dpr);
      histCanvas.height = Math.round(cssH * dpr);
      const ctx = histCanvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      const bins = stats.hist.bins;
      let maxCount = 1;
      for (const c of bins) if (c > maxCount) maxCount = c;
      const pad = 6;
      const bw = (cssW - pad * 2) / bins.length;
      ctx.fillStyle = "#ffb454";
      for (let i = 0; i < bins.length; i++) {
        const h = (bins[i] / maxCount) * (cssH - pad * 2);
        ctx.fillRect(pad + i * bw + 1, cssH - pad - h, Math.max(1, bw - 2), h);
      }
    }

    function toggle() {
      if (!ensureStats()) return; // data not ready yet
      panel.hidden = !panel.hidden;
      if (!panel.hidden) drawHistogram(); // draw while visible so the canvas has a size
    }

    function init() {
      buildPanel();
      btn = document.getElementById("statsBtn");
      if (btn) btn.addEventListener("click", toggle);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { computeStats };
  else global.Stats = { computeStats };
})(typeof window !== "undefined" ? window : globalThis);
