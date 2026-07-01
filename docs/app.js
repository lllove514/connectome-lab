// Connectome Lab — draws the precomputed C. elegans graph on a canvas and runs
// the leaky integrate-and-fire simulation (sim.js) on top of it.
//
// Positions come baked into connectome.json (built by data/build_connectome.py),
// so there is no layout physics here. In explore mode we redraw only on
// interaction — hover, click, search, resize. In simulate mode the clock is the
// interaction: each LIF tick advances the network and repaints one frame, and the
// clock auto-pauses once the wave has died so a settled network costs nothing.
//
// One transform object (Sim.makeTransform) is computed per resize and shared by
// the renderer (data->screen) and the hit-test (its exact inverse), so a click
// always lands on the neuron drawn under the cursor at any canvas shape.

const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");
const tooltip = document.getElementById("tooltip");
const legend = document.getElementById("legend");
const search = document.getElementById("search");

const simToggleBtn = document.getElementById("simToggle");
const playBtn = document.getElementById("play");
const stepBtn = document.getElementById("step");
const speedSlider = document.getElementById("speed");
const hint = document.getElementById("hint");
const debugChk = document.getElementById("debug");
const debugOut = document.getElementById("debugout");

const TYPES = {
  sensory: { label: "Sensory", color: "#ffb454" },
  inter: { label: "Interneuron", color: "#56b6f2" },
  motor: { label: "Motor", color: "#ff6b8b" },
  unknown: { label: "Unknown", color: "#6b7280" },
};

const CHEM_COLOR = "#7f8ea3"; // chemical synapses (directed)
const GAP_COLOR = "#3fb6a8"; // gap junctions (electrical, undirected)
const PICK_RADIUS = 14; // CSS px within which the cursor grabs a node (forgiving)
const TAU = Math.PI * 2;

const GLOW_DECAY = 0.75; // per-tick fade of a neuron's afterglow (visual only)
const ACTIVE_EDGE_MIN = 0.2; // draw a neuron's outgoing edges once it glows this bright
const SETTLE_GLOW = 0.02; // below this, with nothing firing, the wave has ended

let nodes = [];
let chemical = [];
let gap = [];
let muscles = []; // body-wall muscle output layer, kept separate from the neuron graph
let neuromuscular = []; // motor neuron -> muscle junctions
const byId = new Map();
const neighbors = new Map(); // id -> Set of directly connected ids
const degree = new Map(); // id -> {in, out, gap}

const view = { w: 0, h: 0 }; // canvas size in CSS pixels
let transform = null; // the single data<->screen map, rebuilt on resize
let hoverId = null;
let selectedId = null;
let selectedNeuron = null; // the last-clicked neuron (any mode), a shared source of truth
let matches = new Set();

// Simulation state (built once the data arrives).
let sim = null; // { net, state, activation }
let simParams = Object.assign({}, Sim.DEFAULTS); // live-tunable copy; Sim.DEFAULTS stays pristine
let simMode = false;
let playing = false;
let manual = false; // manual stepping mode: on after Pause/Step, off after Play
let simTimer = null;
let simSpeed = Number(speedSlider.value); // ticks per second

// Honor prefers-reduced-motion (also protects photosensitive users): when set,
// the firing render is calmed to steady color changes instead of bright flashes,
// and the trace pulse and muscle flashing (teach.js, muscles.js read this flag)
// are toned down. Updated live if the user flips the OS setting.
let reduceMotion = false;
const motionQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
if (motionQuery) {
  reduceMotion = motionQuery.matches;
  const onMotionChange = () => { reduceMotion = motionQuery.matches; if (!playing) draw(); };
  if (motionQuery.addEventListener) motionQuery.addEventListener("change", onMotionChange);
  else if (motionQuery.addListener) motionQuery.addListener(onMotionChange); // older Safari
}

fetch("connectome.json")
  .then((r) => {
    if (!r.ok) throw new Error(r.status + " " + r.statusText);
    return r.json();
  })
  .then(init)
  .catch((err) => showError("Could not load connectome.json. Run data/build_connectome.py first.\n" + err));

function init(data) {
  nodes = data.nodes;
  chemical = data.chemical;
  gap = data.gap;
  muscles = data.muscles || [];
  neuromuscular = data.neuromuscular || [];

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

  sim = {
    net: Sim.buildNetwork(data),
    state: Sim.createState(nodes.length),
    activation: new Float32Array(nodes.length),
  };

  buildLegend();
  resize();

  // Refit on any canvas size change: a ResizeObserver catches every case (window
  // resize, zoom, devtools docking, retina dpr change), coalesced to one refit
  // per frame so a drag-resize does not thrash. resize() recomputes the backing
  // store AND the shared transform, so the graph refits and hit-testing stays
  // exact. A plain window listener backs it up where ResizeObserver is missing.
  let refitPending = false;
  const refit = () => {
    if (refitPending) return;
    refitPending = true;
    requestAnimationFrame(() => {
      refitPending = false;
      resize();
      draw();
    });
  };
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(refit).observe(canvas);
  window.addEventListener("resize", refit);

  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("mouseleave", () => setHover(null));
  canvas.addEventListener("click", onClick);
  search.addEventListener("input", onSearch);

  simToggleBtn.addEventListener("click", () => setSimMode(!simMode));
  playBtn.addEventListener("click", () => {
    if (playing) { pause(); manual = true; } // Pause: take manual control
    else { manual = false; play(); } // Play: hand control back to the clock
  });
  stepBtn.addEventListener("click", stepOnce);
  speedSlider.addEventListener("input", () => {
    simSpeed = Number(speedSlider.value); // tickLoop reads this each step, so it adapts live
  });
  debugChk.addEventListener("change", () => {
    debugOut.hidden = !debugChk.checked;
  });
}

// --- Teaching-layer bridge ----------------------------------------------------

// Call an optional teach.js hook if it is loaded, so app.js runs standalone too.
function teachHook(name, ...args) {
  if (typeof Teach !== "undefined" && Teach[name]) Teach[name](...args);
}

// Single writer for the selection. Keeps selectedId (drives explore highlighting)
// and selectedNeuron (the shared source of truth read by every teaching tool and
// the future AI panel) in lockstep, and notifies the teaching layer.
function setSelected(id) {
  selectedId = id;
  selectedNeuron = id ? byId.get(id) : null;
  teachHook("onSelect", selectedNeuron);
  requestDraw();
}

function requestDraw() {
  if (!playing) draw(); // while playing, the next tick repaints anyway
}

// Advance the simulation exactly one tick, the Step control. Pauses first, so
// stepping always leaves you in manual control to watch the signal move neuron
// by neuron. Additive: casual use never needs it, since a poke still auto-runs.
function stepOnce() {
  if (!sim) return;
  manual = true; // stepping is manual control, so later pokes load without auto-running
  pause();
  Sim.step(sim.net, sim.state, simParams);
  updateGlow();
  draw();
  teachHook("onTick", sim.state, sim.activation);
}

// Fold this tick's spikes into the visual glow (bright on fire, else fade) and
// report the activity level so the caller can tell when the wave has settled.
function updateGlow() {
  const fired = sim.state.fired;
  const act = sim.activation;
  let firedCount = 0;
  let maxGlow = 0;
  for (let i = 0; i < sim.net.n; i++) {
    if (fired[i]) {
      act[i] = 1;
      firedCount++;
    } else {
      act[i] *= GLOW_DECAY;
    }
    if (act[i] > maxGlow) maxGlow = act[i];
  }
  return { firedCount, maxGlow };
}

// Reserve space around the fixed panels so nodes never render underneath them.
// The panels live in two columns — title + tutor on the left, teaching rail on
// the right — so we reserve those columns (plus a strip for the bottom-centre
// legend) and fit the graph into the band between. Widths are measured live, so
// this tracks the panels as they shrink on narrow windows.
const EDGE = 12; // base breathing room at the viewport edge
const PANEL_GAP = 8; // clearance between a panel and the nearest node (makeTransform adds 28 more)
const LEGEND_CLEARANCE = 64; // strip kept free at the bottom for the centre legend
const MIN_BAND_W = 150; // never let the graph band shrink below this many CSS px
const MIN_BAND_H = 130;

function panelInset() {
  const W = view.w, H = view.h;
  const reachRight = (id) => {
    const el = document.getElementById(id);
    const r = el && el.getBoundingClientRect();
    return r && r.width ? r.right : 0; // panel's right edge from the left, 0 if not laid out
  };
  const reachIn = (id) => {
    const el = document.getElementById(id);
    const r = el && el.getBoundingClientRect();
    return r && r.width ? W - r.left : 0; // how far the panel reaches in from the right edge
  };

  // Reserve the two panel columns: title + tutor on the left, teaching rail on
  // the right, plus a bottom strip for the centre legend.
  let left = Math.max(reachRight("ui"), reachRight("tutor")) + PANEL_GAP;
  let right = reachIn("teach") + PANEL_GAP;
  let top = EDGE, bottom = LEGEND_CLEARANCE;

  // If the full reservation would crush the graph (very narrow/short windows),
  // shrink it proportionally so the whole graph still fits and stays centered.
  // The panels then overlap the graph, but they are translucent and pass clicks
  // through, so neurons under them stay visible and pokable.
  const fit = (a, b, span, minBand) =>
    a + b > span - minBand && a + b > 0 ? (span - minBand) / (a + b) : 1;
  const kx = fit(left, right, W, MIN_BAND_W);
  const ky = fit(top, bottom, H, MIN_BAND_H);
  return { left: Math.max(0, left * kx), right: Math.max(0, right * kx), top: top * ky, bottom: bottom * ky };
}

// Rebuild the shared transform from the data bounds and the current canvas CSS
// size, then cache each node's screen position for fast edge drawing. Backing
// store is CSS-size * dpr; the context is scaled by dpr once so all drawing (and
// the transform) happens in CSS pixels. Called on load and every resize, so the
// graph always refills the current canvas and stays clear of the panels.
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
  transform = Sim.makeTransform(nodes, w, h, panelInset());
  for (const n of nodes) {
    const s = Sim.toScreen(transform, n.x, n.y);
    n.sx = s.x;
    n.sy = s.y;
  }
}

function draw() {
  ctx.fillStyle = "#0a0c10";
  ctx.fillRect(0, 0, view.w, view.h);
  if (simMode && sim) drawSim();
  else drawExplore();
  teachHook("drawOverlay", ctx); // teaching highlights paint on top, wiped next frame
  if (typeof Muscles !== "undefined" && Muscles.draw) Muscles.draw(ctx); // optional muscle layer, off by default
}

// --- Explore mode: static graph with selection + search highlighting ---------

function drawExplore() {
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
    ctx.arc(n.sx, n.sy, r, 0, TAU);
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

// --- Simulate mode: LIF activity, firing flashes, fading afterglow ------------

function drawSim() {
  const act = sim.activation;
  const net = sim.net;

  // Faint static wiring for context.
  drawEdges(chemical, CHEM_COLOR, false, false);
  drawEdges(gap, GAP_COLOR, true, false);

  // Live current: light up the wiring carrying the wave from neurons that just
  // fired or are still glowing. Chemical synapses are solid; gap junctions are
  // dashed, so a neuron that spreads only electrically (its chemical out-degree
  // is zero) still visibly drives its neighbours.
  ctx.lineWidth = 0.9;
  for (let i = 0; i < net.n; i++) {
    const a = act[i];
    if (a <= ACTIVE_EDGE_MIN) continue;
    const src = nodes[i];
    const chem = net.chemOut[i];
    ctx.strokeStyle = rgba("#ffd27f", a * (reduceMotion ? 0.18 : 0.4));
    ctx.beginPath();
    for (let k = 0; k < chem.length; k += 2) {
      const tgt = nodes[chem[k]];
      ctx.moveTo(src.sx, src.sy);
      ctx.lineTo(tgt.sx, tgt.sy);
    }
    ctx.stroke();
  }
  ctx.setLineDash([2, 3]);
  for (let i = 0; i < net.n; i++) {
    const a = act[i];
    if (a <= ACTIVE_EDGE_MIN) continue;
    const src = nodes[i];
    const gaps = net.gapAdj[i];
    ctx.strokeStyle = rgba(GAP_COLOR, a * (reduceMotion ? 0.22 : 0.5));
    ctx.beginPath();
    for (let k = 0; k < gaps.length; k += 2) {
      const tgt = nodes[gaps[k]];
      ctx.moveTo(src.sx, src.sy);
      ctx.lineTo(tgt.sx, tgt.sy);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Nodes: dim at rest; a soft glow + gently brightened core as activation rises.
  // Two things stop a busy tick from blooming to white. The glow is warm amber
  // (little white content) drawn at a low per-node alpha, so overlapping halos
  // build into a bright cluster instead of stacking additively into a white
  // sheet. And the flash is eased (a*a), so a lone spike is a soft pulse, not a
  // blast — while the core never reaches pure white, keeping firing cells and the
  // afterglow trail distinct along the wavefront.
  for (let i = 0; i < net.n; i++) {
    const n = nodes[i];
    const a = act[i];
    const base = (TYPES[n.type] || TYPES.unknown).color;
    const ease = a * a; // soften: gentle at low activation, full only at a fresh spike

    // The halo is the main source of frame-to-frame brightness swing, so skip it
    // entirely under reduced motion.
    if (a > 0.04 && !reduceMotion) {
      ctx.globalAlpha = 0.03 + ease * 0.12; // <= ~0.15 per node caps additive buildup
      ctx.fillStyle = "#ffb14d"; // warm amber, not near-white
      ctx.beginPath();
      ctx.arc(n.sx, n.sy, 1.6 + a * 3, 0, TAU); // smaller halo => less overlap
      ctx.fill();
    }

    // Reduced motion: a smaller, steadier size and opacity change, and no white
    // hot flash, so activity reads as a calm brightening in the cell's own color.
    const r = 2.4 + a * (reduceMotion ? 0.7 : 1.6);
    ctx.globalAlpha = reduceMotion ? 0.4 + a * 0.35 : 0.28 + a * 0.62;
    ctx.fillStyle = !reduceMotion && a > 0.5 ? mix(base, "#fff1c4", ((a - 0.5) / 0.5) * 0.7) : base;
    ctx.beginPath();
    ctx.arc(n.sx, n.sy, r, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;

    if (n.id === hoverId) ring(n, r + 2.5, "#ffffff", 1.5);
  }
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
  ctx.arc(n.sx, n.sy, r, 0, TAU);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

// --- Simulation control -------------------------------------------------------

function setSimMode(on) {
  simMode = on;
  simToggleBtn.classList.toggle("on", on);
  simToggleBtn.setAttribute("aria-pressed", on ? "true" : "false");
  simToggleBtn.textContent = on ? "Explore" : "Simulate";
  speedSlider.disabled = !on;

  for (const el of [playBtn, stepBtn]) el.disabled = !on;
  if (on) {
    setSelected(null); // leave explore highlighting behind (and notify teach)
    matches = new Set();
    manual = false; // fresh into Simulate: casual clicks auto-run
    hint.textContent = "Click any neuron to send a wave through it. Use Pause or Step to slow it down.";
    pause();
    clearSim(); // enter QUIET, the user starts the wave by clicking a neuron
  } else {
    pause();
    hint.textContent = "";
  }
  draw();
}

// Zero everything: potentials, refractory timers, firing, queued input, the
// inhibition pool (all fresh in createState) and the visual glow.
function clearSim() {
  sim.state = Sim.createState(sim.net.n);
  sim.activation.fill(0);
}

// Clicking a neuron drives the clock; it auto-pauses when the wave settles, so
// there is no manual play/pause control — these just run and stop the loop.
function play() {
  if (playing) return;
  playing = true;
  playBtn.textContent = "Pause";
  tickLoop();
}

function pause() {
  playing = false;
  playBtn.textContent = "Play";
  clearTimeout(simTimer);
}

// Self-scheduling clock: re-reads simSpeed each step so the slider takes effect
// immediately, and stops itself once the network has gone quiet (nothing firing,
// glow faded) so a settled sim isn't repainting forever.
function tickLoop() {
  if (!playing) return;
  Sim.step(sim.net, sim.state, simParams);
  const { firedCount, maxGlow } = updateGlow();
  draw();
  teachHook("onTick", sim.state, sim.activation); // runs even on the settling tick

  if (firedCount === 0 && maxGlow < SETTLE_GLOW) {
    pause(); // wave has died out — auto-pause
    return;
  }
  simTimer = setTimeout(tickLoop, 1000 / simSpeed);
}

// Fire a fresh wave from a neuron: clear whatever was firing, poke, and run — so
// each click replaces the last wave instead of piling on.
function pokeAt(index) {
  clearSim();
  Sim.poke(sim.state, index, simParams.poke);
  sim.activation[index] = 1;
  // A poke auto-runs, except in manual mode (after Pause or Step): then it just
  // loads the stimulus and stays paused, so you can Step it forward from tick 0.
  !playing && !manual ? play() : draw();
}

// --- Pointer + search ---------------------------------------------------------

// Mouse event -> canvas CSS coordinates. Subtract the canvas's own bounding-rect
// offset only; do NOT scale by devicePixelRatio — dpr scales the drawing backing
// store, not the input. The result is the space Sim.toScreen draws nodes in.
function eventXY(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function pick(px, py) {
  const i = Sim.pickNearest(transform, nodes, px, py, PICK_RADIUS);
  return i < 0 ? null : nodes[i];
}

function onMove(e) {
  const { x, y } = eventXY(e);
  const n = pick(x, y);
  setHover(n ? n.id : null);
  canvas.style.cursor = n ? "pointer" : "default";
  showDebug(x, y, n);
  if (n) {
    const d = degree.get(n.id);
    const total = d.in + d.out + d.gap;
    tooltip.innerHTML =
      `<span class="name">${n.name}</span> &middot; ${(TYPES[n.type] || TYPES.unknown).label}<br>` +
      `${total} connections <span class="dim">&nbsp;in ${d.in} &middot; out ${d.out} &middot; gap ${d.gap}</span>`;
    tooltip.hidden = false;
    const tx = Math.min(e.clientX + 14, view.w - tooltip.offsetWidth - 8);
    const ty = Math.min(e.clientY + 14, view.h - tooltip.offsetHeight - 8);
    tooltip.style.left = tx + "px";
    tooltip.style.top = ty + "px";
  } else {
    tooltip.hidden = true;
  }
}

function setHover(id) {
  if (id === hoverId) return;
  hoverId = id;
  if (!playing) draw(); // while playing, the next tick repaints anyway
}

function onClick(e) {
  const { x, y } = eventXY(e);
  const n = pick(x, y);
  showDebug(x, y, n);

  if (simMode) {
    if (n) {
      pokeAt(sim.net.index.get(n.id)); // poke the clicked neuron; a miss does nothing
      setSelected(n.id); // firing also updates the info card + oscilloscope
    }
    return;
  }

  // Explore mode: a click selects exactly one neuron (replacing any previous
  // selection and clearing search highlights); a miss clears everything.
  matches = new Set();
  search.value = "";
  setSelected(n ? n.id : null);
}

// Case-insensitive prefix match; highlight every hit and focus the first.
function onSearch() {
  const q = search.value.trim().toLowerCase();
  matches = new Set();
  if (q) {
    for (const n of nodes) {
      if (n.name.toLowerCase().startsWith(q)) matches.add(n.id);
    }
    if (!simMode) {
      const first = nodes.find((n) => matches.has(n.id));
      setSelected(first ? first.id : null);
    }
  } else if (!simMode) {
    setSelected(null);
  }
  if (!playing) draw();
}

// On-screen readout (behind the debug toggle): the click's CSS coords, the data
// coords they map to, and the neuron picked there. Use it to confirm a click
// lands on the neuron under the cursor.
function showDebug(px, py, node) {
  if (!debugChk.checked) return;
  const d = Sim.toData(transform, px, py);
  debugOut.textContent =
    `css (${px.toFixed(0)}, ${py.toFixed(0)})  ` +
    `data (${d.x.toFixed(3)}, ${d.y.toFixed(3)})  ` +
    `→ ${node ? node.id : "none"}`;
}

// --- Small helpers ------------------------------------------------------------

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

function mix(hexA, hexB, t) {
  const a = parseInt(hexA.slice(1), 16);
  const b = parseInt(hexB.slice(1), 16);
  const r = Math.round((a >> 16 & 255) + ((b >> 16 & 255) - (a >> 16 & 255)) * t);
  const g = Math.round((a >> 8 & 255) + ((b >> 8 & 255) - (a >> 8 & 255)) * t);
  const bl = Math.round((a & 255) + ((b & 255) - (a & 255)) * t);
  return `rgb(${r}, ${g}, ${bl})`;
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
