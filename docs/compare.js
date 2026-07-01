// Compare mode — the real connectome next to a randomly-wired network of the
// same size, running the SAME spiking model on both. The point is honest and
// simple: a real nervous system is not wired at random, and if you put it beside
// a random network with the same number of neurons, the same number of
// connections, and the same connection strengths, you can watch the wiring
// matter. Same poke, same model, different partners, different behaviour.
//
// This is an isolated mode. The normal single-network view is untouched: app.js
// only delegates to Compare.draw / Compare.onClick while Compare.active is true.
// Both sides reuse Sim (buildNetwork, createState, poke, step, DEFAULTS) and the
// one shared transform, so the LIF math is never forked — the only difference
// between the two networks is who connects to whom.
//
// The pure parts (buildArtificial, the seeded PRNG, the disc layout) are exported
// for Node so compare_selfcheck.js builds the exact same artificial network.

(function (global) {
  "use strict";

  // Small seeded PRNG (mulberry32). Deterministic, so the artificial network is
  // reproducible: the browser and the Node self-check build byte-for-byte the
  // same rewiring from the same seed. Not Math.random, on purpose.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Build a network the same size as the real one that differs ONLY in topology.
  // It keeps the same nodes (same order, so node index i means the same neuron on
  // both sides), the same number of chemical and gap edges, and the SAME multiset
  // of edge weights — every real weight is kept, only its endpoints are reassigned
  // to a random pair. No self-loops, no duplicate edges. It is not trained, not an
  // RNN, not a brain: it is a randomly-wired network of the same size.
  function buildArtificial(data, seed) {
    const nodes = data.nodes;
    const n = nodes.length;
    const rand = mulberry32(seed >>> 0);
    const randInt = (m) => Math.floor(rand() * m);

    // Directed edges (chemical): distinct ordered pairs s -> t, s != t.
    function rewireDirected(list) {
      const used = new Set();
      const out = [];
      for (const e of list) {
        let s, t, key;
        do {
          s = randInt(n);
          t = randInt(n);
          key = s * n + t;
        } while (s === t || used.has(key));
        used.add(key);
        out.push({ source: nodes[s].id, target: nodes[t].id, weight: e.weight });
      }
      return out;
    }

    // Undirected edges (gap): distinct unordered pairs a - b, a != b.
    function rewireUndirected(list) {
      const used = new Set();
      const out = [];
      for (const e of list) {
        let a, b, key;
        do {
          a = randInt(n);
          b = randInt(n);
          const lo = a < b ? a : b;
          const hi = a < b ? b : a;
          key = lo * n + hi;
        } while (a === b || used.has(key));
        used.add(key);
        out.push({ source: nodes[a].id, target: nodes[b].id, weight: e.weight });
      }
      return out;
    }

    return {
      nodes: nodes, // same neurons, same order — keeps index i aligned across both nets
      chemical: rewireDirected(data.chemical),
      gap: rewireUndirected(data.gap),
    };
  }

  // Deterministic sunflower (phyllotaxis) disc layout for the artificial side:
  // cheap, no physics, and it reads as clearly not the worm's body. Returns unit
  // positions the shared transform then fits into the right-hand panel.
  function discLayout(n) {
    const golden = Math.PI * (3 - Math.sqrt(5)); // ~2.39996 rad between successive points
    const pos = [];
    for (let i = 0; i < n; i++) {
      const r = Math.sqrt((i + 0.5) / n);
      const a = i * golden;
      pos.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
    }
    return pos;
  }

  const SEED = 1234567; // fixed so the random network is the same every load

  const api = { mulberry32, buildArtificial, discLayout, SEED, active: false };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return; // Node self-check wants only the pure parts, never the DOM controller
  }
  global.Compare = api;

  // --- browser controller ------------------------------------------------------
  if (typeof document === "undefined") return;

  let panels = null; // [ real, random ]
  let playing = false;
  let timer = null;
  let lastW = 0, lastH = 0;
  const FALLBACK_SPEED = 20; // ticks per second if the shared speed slider is missing
  const tickMs = () => 1000 / (typeof simSpeed !== "undefined" && simSpeed ? simSpeed : FALLBACK_SPEED);

  const EDGE = 16; // outer margin
  const GAP = 18; // gap between the two panels at the centre line
  const LABEL_H = 26; // top strip kept for each panel's label
  const STRIP_H = 168; // bottom strip reserved for the readout (see #compare height)

  let stripEl, readReal, readRand, toggleBtn, sharedPlay;

  const el = (id) => document.getElementById(id);
  const reduced = () => typeof reduceMotion !== "undefined" && reduceMotion;

  // Compare owns the whole canvas, so hide the tutor and the legend while it runs.
  // The right rail stays visible, so its "Compare" feature button reads as active
  // and gives you the way out.
  const CHROME = ["tutor", "legend"];

  // Reflect a tier-3 feature toggle's on/off state on its button.
  function setFeatState(btn, on) {
    if (!btn) return;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    const s = btn.querySelector(".feat-state");
    if (s) s.textContent = on ? "on" : "off";
  }

  function makePanel(key, net, renderNodes) {
    return {
      key: key,
      net: net,
      nodes: renderNodes, // {x, y, type, sx, sy}, own screen coords per panel
      state: Sim.createState(net.n),
      activation: new Float32Array(net.n),
      transform: null,
      seedIdx: -1,
      reachDist: null, // hop distance from the seed over this net's own wiring
      firing: 0,
      peak: 0,
      spread: 0,
    };
  }

  function enter() {
    if (api.active) return;
    if (typeof sim === "undefined" || !sim) return; // data not loaded yet
    api.active = true;

    if (typeof pause === "function") pause(); // stop the single-network clock

    // Real side reuses the already-built network; only fresh sim state is made,
    // so the normal view's sim.state is never touched.
    const data = { nodes: nodes, chemical: chemical, gap: gap };
    const art = buildArtificial(data, SEED);
    const artNet = Sim.buildNetwork(art);

    const realRender = nodes.map((nd) => ({ x: nd.x, y: nd.y, type: nd.type, sx: 0, sy: 0 }));
    const disc = discLayout(nodes.length);
    const randRender = nodes.map((nd, i) => ({ x: disc[i].x, y: disc[i].y, type: nd.type, sx: 0, sy: 0 }));

    panels = [makePanel("real", sim.net, realRender), makePanel("random", artNet, randRender)];

    setChrome(true);
    stripEl.hidden = false;
    setFeatState(toggleBtn, true);
    // Take over the shared playback controls: enable them, disable the
    // Explore/Simulate toggle (it has no meaning while comparing).
    if (typeof setPlaybackEnabled === "function") setPlaybackEnabled(true);
    const st = el("simToggle");
    if (st) st.disabled = true;
    if (sharedPlay) sharedPlay.textContent = "Play";
    lastW = lastH = 0; // force a fresh layout on the next draw
    updateReadouts();
    redraw();
  }

  function exit() {
    if (!api.active) return;
    stopLoop();
    api.active = false;
    panels = null;
    setChrome(false);
    stripEl.hidden = true;
    setFeatState(toggleBtn, false);
    // Hand the shared controls back to the single-network sim.
    const st = el("simToggle");
    if (st) st.disabled = false;
    if (typeof setPlaybackEnabled === "function") setPlaybackEnabled(typeof simMode !== "undefined" && simMode);
    redraw(); // repaint the normal view (api.active is false now, so app.draw owns it)
  }

  function setChrome(hide) {
    for (const id of CHROME) {
      const e = el(id);
      if (e) e.style.display = hide ? "none" : "";
    }
  }

  // --- layout: one shared transform per panel, fitted into its half -----------

  function layout() {
    const W = view.w, H = view.h;
    const half = W / 2;
    layoutPanel(panels[0], { left: EDGE, right: W - half + GAP, top: LABEL_H, bottom: STRIP_H });
    layoutPanel(panels[1], { left: half + GAP, right: EDGE, top: LABEL_H, bottom: STRIP_H });
    lastW = W;
    lastH = H;
  }

  function layoutPanel(p, inset) {
    p.transform = Sim.makeTransform(p.nodes, view.w, view.h, inset);
    for (const nd of p.nodes) {
      const s = Sim.toScreen(p.transform, nd.x, nd.y);
      nd.sx = s.x;
      nd.sy = s.y;
    }
  }

  // --- rendering: same look as the single-network sim, per panel --------------

  function draw(ctx) {
    const W = view.w, H = view.h;
    ctx.fillStyle = "#0a0c10";
    ctx.fillRect(0, 0, W, H);
    if (!panels) return;
    if (W !== lastW || H !== lastH) layout();

    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(W / 2, LABEL_H);
    ctx.lineTo(W / 2, H - STRIP_H);
    ctx.stroke();

    drawPanel(ctx, panels[0], "Real connectome", W * 0.25);
    drawPanel(ctx, panels[1], "Randomly wired, same size", W * 0.75);
  }

  function drawPanel(ctx, p, label, labelX) {
    const rm = reduced();
    const net = p.net, N = net.n, act = p.activation, rn = p.nodes;

    // Faint static wiring for context (one batched path).
    ctx.lineWidth = 0.7;
    ctx.strokeStyle = rgba("#7f8ea3", 0.06);
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const chem = net.chemOut[i];
      const s = rn[i];
      for (let k = 0; k < chem.length; k += 2) {
        const t = rn[chem[k]];
        ctx.moveTo(s.sx, s.sy);
        ctx.lineTo(t.sx, t.sy);
      }
    }
    ctx.stroke();

    // Live wiring carrying the wave from neurons that just fired or still glow.
    ctx.lineWidth = 0.9;
    for (let i = 0; i < N; i++) {
      const a = act[i];
      if (a <= 0.2) continue;
      const s = rn[i];
      const chem = net.chemOut[i];
      ctx.strokeStyle = rgba("#ffd27f", a * (rm ? 0.18 : 0.4));
      ctx.beginPath();
      for (let k = 0; k < chem.length; k += 2) {
        const t = rn[chem[k]];
        ctx.moveTo(s.sx, s.sy);
        ctx.lineTo(t.sx, t.sy);
      }
      ctx.stroke();
    }

    // Nodes: dim at rest, a soft amber glow as activation rises. Same easing and
    // alpha caps as the single-network renderer so a busy tick never blooms white.
    for (let i = 0; i < N; i++) {
      const nd = rn[i];
      const a = act[i];
      const base = (TYPES[nd.type] || TYPES.unknown).color;
      if (a > 0.04 && !rm) {
        ctx.globalAlpha = 0.03 + a * a * 0.12;
        ctx.fillStyle = "#ffb14d";
        ctx.beginPath();
        ctx.arc(nd.sx, nd.sy, 1.4 + a * 2.6, 0, TAU);
        ctx.fill();
      }
      const r = 2.0 + a * (rm ? 0.6 : 1.4);
      ctx.globalAlpha = rm ? 0.4 + a * 0.35 : 0.3 + a * 0.6;
      ctx.fillStyle = base;
      ctx.beginPath();
      ctx.arc(nd.sx, nd.sy, r, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = "#8a93a3";
    ctx.font = "12px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.fillText(label, labelX, 16);
    ctx.textAlign = "start";
  }

  // Repaint through app.draw so the single pipeline owns the canvas; while active
  // it early-returns straight into Compare.draw (see app.js).
  function redraw() {
    if (typeof globalThis.draw === "function") globalThis.draw();
  }

  // --- interaction: click either side, poke the same neuron on both -----------

  function onClick(x, y) {
    if (!panels) return;
    const p = x < view.w / 2 ? panels[0] : panels[1];
    const i = Sim.pickNearest(p.transform, p.nodes, x, y, PICK_RADIUS);
    if (i >= 0) pokeBoth(i);
  }

  function pokeBoth(i) {
    for (const p of panels) {
      p.state = Sim.createState(p.net.n);
      p.activation.fill(0);
      Sim.poke(p.state, i, Sim.DEFAULTS.poke);
      p.activation[i] = 1;
      p.seedIdx = i;
      p.reachDist = Sim.reach(p.net, i, p.net.n); // hops from the seed over this wiring
      p.firing = 0;
      p.peak = 0;
      p.spread = 0;
    }
    updateReadouts();
    startLoop();
  }

  // Fold this tick's spikes into the glow and update the live readout numbers.
  // Returns whether the panel is still active (firing or glowing above settle).
  function glowPanel(p) {
    const fired = p.state.fired, act = p.activation, N = p.net.n;
    let firing = 0, maxGlow = 0;
    for (let i = 0; i < N; i++) {
      if (fired[i]) {
        act[i] = 1;
        firing++;
        if (p.reachDist && p.reachDist[i] >= 0 && p.reachDist[i] > p.spread) p.spread = p.reachDist[i];
      } else {
        act[i] *= 0.75;
      }
      if (act[i] > maxGlow) maxGlow = act[i];
    }
    p.firing = firing;
    if (firing > p.peak) p.peak = firing;
    return firing > 0 || maxGlow >= 0.02;
  }

  function tick() {
    if (!playing) return;
    let live = false;
    for (const p of panels) {
      Sim.step(p.net, p.state, Sim.DEFAULTS);
      if (glowPanel(p)) live = true;
    }
    updateReadouts();
    redraw();
    if (!live) {
      stopLoop();
      return;
    }
    timer = setTimeout(tick, tickMs()); // honor the shared speed slider
  }

  function stepBoth() {
    if (!panels) return;
    stopLoop();
    for (const p of panels) {
      Sim.step(p.net, p.state, Sim.DEFAULTS);
      glowPanel(p);
    }
    updateReadouts();
    redraw();
  }

  function reset() {
    if (!panels) return;
    stopLoop();
    for (const p of panels) {
      p.state = Sim.createState(p.net.n);
      p.activation.fill(0);
      p.seedIdx = -1;
      p.reachDist = null;
      p.firing = 0;
      p.peak = 0;
      p.spread = 0;
    }
    updateReadouts();
    redraw();
  }

  function startLoop() {
    if (playing) return;
    playing = true;
    if (sharedPlay) sharedPlay.textContent = "Pause";
    tick();
  }

  function stopLoop() {
    playing = false;
    if (sharedPlay) sharedPlay.textContent = "Play";
    clearTimeout(timer);
  }

  // The shared Play/Step/Reset buttons route here while Compare is active (app.js).
  function playPause() {
    if (playing) stopLoop();
    else if (poked()) startLoop();
  }

  function poked() {
    return panels && panels.some((p) => p.seedIdx >= 0);
  }

  // --- readout strip ----------------------------------------------------------

  function fmt(p) {
    return (
      "firing now: <b>" + p.firing + "</b><br>" +
      "peak firing: <b>" + p.peak + "</b><br>" +
      "reached: <b>" + p.spread + "</b> hops from the poke"
    );
  }

  function updateReadouts() {
    if (!readReal || !panels) return;
    readReal.innerHTML = fmt(panels[0]);
    readRand.innerHTML = fmt(panels[1]);
  }

  function init() {
    stripEl = el("compare");
    readReal = el("cmp-read-real");
    readRand = el("cmp-read-rand");
    toggleBtn = el("compareToggle");
    sharedPlay = el("play");

    if (toggleBtn) toggleBtn.addEventListener("click", () => (api.active ? exit() : enter()));
  }

  api.enter = enter;
  api.exit = exit;
  api.draw = draw;
  api.onClick = onClick;
  api.playPause = playPause; // shared Play button, while Compare.active
  api.step = stepBoth; // shared Step button
  api.reset = reset; // shared Reset button

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})(typeof window !== "undefined" ? window : globalThis);
