// Connectome Lab — draws the precomputed C. elegans graph on a canvas.
// Positions come baked into connectome.json (built by data/build_connectome.py),
// so there is no physics here: we only redraw in response to hover, click,
// search, and resize — never on a timer.

const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");
const tooltip = document.getElementById("tooltip");
const legend = document.getElementById("legend");
const search = document.getElementById("search");

const TYPES = {
  sensory: { label: "Sensory", color: "#ffb454" },
  inter: { label: "Interneuron", color: "#56b6f2" },
  motor: { label: "Motor", color: "#ff6b8b" },
  unknown: { label: "Unknown", color: "#6b7280" },
};

const CHEM_COLOR = "#7f8ea3"; // chemical synapses (directed)
const GAP_COLOR = "#3fb6a8"; // gap junctions (electrical, undirected)
const PICK_RADIUS = 12; // px within which the cursor grabs a node

let nodes = [];
let chemical = [];
let gap = [];
const byId = new Map();
const neighbors = new Map(); // id -> Set of directly connected ids
const degree = new Map(); // id -> {in, out, gap}

const view = { w: 0, h: 0 }; // CSS-pixel size; node screen coords cached on each node
let hoverId = null;
let selectedId = null;
let matches = new Set();

fetch("connectome.json")
  .then((r) => {
    if (!r.ok) throw new Error(r.status + " " + r.statusText);
    return r.json();
  })
  .then(init)
  .catch((err) => showError("Could not load connectome.json — run data/build_connectome.py first.\n" + err));

function init(data) {
  nodes = data.nodes;
  chemical = data.chemical;
  gap = data.gap;

  for (const n of nodes) {
    byId.set(n.id, n);
    neighbors.set(n.id, new Set());
    degree.set(n.id, { in: 0, out: 0, gap: 0 });
  }
  for (const e of chemical) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    neighbors.get(e.source).add(e.target);
    neighbors.get(e.target).add(e.source);
    degree.get(e.source).out++;
    degree.get(e.target).in++;
  }
  for (const e of gap) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    neighbors.get(e.source).add(e.target);
    neighbors.get(e.target).add(e.source);
    degree.get(e.source).gap++;
    degree.get(e.target).gap++;
  }

  buildLegend();
  resize();

  window.addEventListener("resize", () => {
    resize();
    draw();
  });
  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("mouseleave", () => setHover(null));
  canvas.addEventListener("click", onClick);
  search.addEventListener("input", onSearch);
}

// Map normalized 0..1 layout coords into a centered square so the graph keeps
// its aspect ratio on any window shape, and cache each node's screen position.
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels, sharp on retina

  view.w = w;
  view.h = h;
  const side = Math.min(w, h) * 0.9;
  const ox = (w - side) / 2;
  const oy = (h - side) / 2;
  for (const n of nodes) {
    n.sx = ox + n.x * side;
    n.sy = oy + n.y * side;
  }
}

function draw() {
  ctx.fillStyle = "#0a0c10";
  ctx.fillRect(0, 0, view.w, view.h);

  const focus = selectedId !== null;
  const nbr = focus ? neighbors.get(selectedId) : null;

  drawEdges(chemical, CHEM_COLOR, false, focus);
  drawEdges(gap, GAP_COLOR, true, focus);

  for (const n of nodes) {
    const lit = !focus || n.id === selectedId || nbr.has(n.id);
    ctx.globalAlpha = lit ? 1 : 0.12;
    let r = 3;
    if (n.id === selectedId) r = 5.5;
    else if (focus && lit) r = 3.8;

    ctx.beginPath();
    ctx.arc(n.sx, n.sy, r, 0, Math.PI * 2);
    ctx.fillStyle = (TYPES[n.type] || TYPES.unknown).color;
    ctx.fill();

    if (matches.has(n.id)) ring(n, r + 2.5, "#ffffff", 1.5);
    if (n.id === hoverId) ring(n, r + 2.5, "#ffffff", 1.5);
    ctx.globalAlpha = 1;
  }
}

// Each edge group is drawn as at most two batched paths (dim + bright) so the
// few thousand lines cost only a couple of stroke() calls, not one per edge.
function drawEdges(list, color, dashed, focus) {
  ctx.lineWidth = 0.8;
  ctx.setLineDash(dashed ? [2, 3] : []);

  if (!focus) {
    ctx.strokeStyle = rgba(color, dashed ? 0.09 : 0.07);
    ctx.beginPath();
    for (const e of list) trace(e);
    ctx.stroke();
  } else {
    ctx.strokeStyle = rgba(color, 0.025);
    ctx.beginPath();
    for (const e of list) {
      if (e.source !== selectedId && e.target !== selectedId) trace(e);
    }
    ctx.stroke();

    ctx.strokeStyle = rgba(color, 0.6);
    ctx.beginPath();
    for (const e of list) {
      if (e.source === selectedId || e.target === selectedId) trace(e);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function trace(e) {
  const a = byId.get(e.source);
  const b = byId.get(e.target);
  if (!a || !b) return;
  ctx.moveTo(a.sx, a.sy);
  ctx.lineTo(b.sx, b.sy);
}

function ring(n, r, color, width) {
  ctx.beginPath();
  ctx.arc(n.sx, n.sy, r, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

// Nearest node within PICK_RADIUS; linear scan is plenty for ~300 nodes.
function pick(mx, my) {
  let best = null;
  let bestD = PICK_RADIUS * PICK_RADIUS;
  for (const n of nodes) {
    const dx = mx - n.sx;
    const dy = my - n.sy;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

function onMove(e) {
  const n = pick(e.clientX, e.clientY);
  setHover(n ? n.id : null);
  canvas.style.cursor = n ? "pointer" : "default";
  if (n) {
    const d = degree.get(n.id);
    const total = d.in + d.out + d.gap;
    tooltip.innerHTML =
      `<span class="name">${n.name}</span> &middot; ${(TYPES[n.type] || TYPES.unknown).label}<br>` +
      `${total} connections <span class="dim">&nbsp;in ${d.in} &middot; out ${d.out} &middot; gap ${d.gap}</span>`;
    tooltip.hidden = false;
    const x = Math.min(e.clientX + 14, view.w - tooltip.offsetWidth - 8);
    const y = Math.min(e.clientY + 14, view.h - tooltip.offsetHeight - 8);
    tooltip.style.left = x + "px";
    tooltip.style.top = y + "px";
  } else {
    tooltip.hidden = true;
  }
}

function setHover(id) {
  if (id === hoverId) return;
  hoverId = id;
  draw();
}

function onClick(e) {
  const n = pick(e.clientX, e.clientY);
  if (n) {
    selectedId = n.id;
  } else {
    selectedId = null;
    matches = new Set();
    search.value = "";
  }
  draw();
}

// Case-insensitive prefix match; highlight every hit and focus the first.
function onSearch() {
  const q = search.value.trim().toLowerCase();
  matches = new Set();
  if (q) {
    for (const n of nodes) {
      if (n.name.toLowerCase().startsWith(q)) matches.add(n.id);
    }
    const first = nodes.find((n) => matches.has(n.id));
    selectedId = first ? first.id : null;
  } else {
    selectedId = null;
  }
  draw();
}

function buildLegend() {
  legend.innerHTML = "";
  for (const t of Object.values(TYPES)) {
    const row = document.createElement("div");
    row.className = "row";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = t.color;
    row.appendChild(dot);
    row.appendChild(document.createTextNode(t.label));
    legend.appendChild(row);
  }
}

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function showError(msg) {
  resizeBlank();
  ctx.fillStyle = "#0a0c10";
  ctx.fillRect(0, 0, view.w, view.h);
  ctx.fillStyle = "#8a93a3";
  ctx.font = "13px ui-monospace, Menlo, monospace";
  ctx.textAlign = "center";
  msg.split("\n").forEach((line, i) => {
    ctx.fillText(line, view.w / 2, view.h / 2 + i * 20);
  });
}

function resizeBlank() {
  const dpr = window.devicePixelRatio || 1;
  view.w = window.innerWidth;
  view.h = window.innerHeight;
  canvas.width = Math.round(view.w * dpr);
  canvas.height = Math.round(view.h * dpr);
  canvas.style.width = view.w + "px";
  canvas.style.height = view.h + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
