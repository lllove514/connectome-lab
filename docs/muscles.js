// Muscle / output layer. A separate, off-by-default layer drawn on top of the
// neuron graph: the 95 body-wall muscles and the motor neuron to muscle
// junctions that drive them. It reads the same sim activation the neuron render
// uses and the same transform-derived node positions, and it never feeds back
// into the LIF math. Muscles light up from their presynaptic neurons' firing.
//
// Loaded as a classic script after app.js, so it shares the globals (muscles,
// neuromuscular, nodes, sim, view, requestDraw, rgba, mix). app.js calls
// Muscles.draw(ctx) as the last line of draw() only if this file is present.

(function () {
  "use strict";

  const MUSCLE_COLOR = "#d98a5b"; // warm muscle tone, distinct from the neuron types
  const MAXPOS = 24; // body-wall muscles run positions 1 (head) to 24 (tail)
  const BAND_GAP = 30; // how far the muscle rows sit outside the neuron cluster
  const ROW_GAP = 9; // left/right rows offset within a band

  let enabled = false;
  let presyn = null; // per muscle: array of { i: neuron index, w: weight }
  let toggle, readoutEl;

  // Map each muscle to the neuron-graph indices of the motor neurons that drive
  // it. Built once, the first time the layer is drawn (sim is ready by then).
  function build() {
    presyn = muscles.map(() => []);
    const muscleAt = new Map();
    muscles.forEach((m, i) => muscleAt.set(m.id, i));
    for (const e of neuromuscular) {
      const mi = muscleAt.get(e.target);
      const ni = sim.net.index.get(e.source);
      if (mi === undefined || ni === undefined) continue; // skip anything not in the data
      presyn[mi].push({ i: ni, w: e.weight || 1 });
    }
  }

  // Screen bounds of the neuron cluster, so the muscle rows hug the graph.
  function graphBounds() {
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (const n of nodes) {
      if (n.sx < minx) minx = n.sx;
      if (n.sx > maxx) maxx = n.sx;
      if (n.sy < miny) miny = n.sy;
      if (n.sy > maxy) maxy = n.sy;
    }
    return { minx, maxx, miny, maxy };
  }

  // Two rows: dorsal muscles above the cluster, ventral below, ordered head to
  // tail across the width. Recomputed each frame so it tracks resize and pan.
  function layout() {
    const b = graphBounds();
    const span = Math.max(1, b.maxx - b.minx);
    const topY = Math.max(22, b.miny - BAND_GAP);
    const botY = Math.min(view.h - 22, b.maxy + BAND_GAP);
    return muscles.map((m) => {
      const t = (Math.min(MAXPOS, Math.max(1, m.pos)) - 1) / (MAXPOS - 1);
      const x = b.minx + t * span;
      const y = m.side === "dorsal"
        ? topY - (m.row === "right" ? ROW_GAP : 0)
        : botY + (m.row === "right" ? ROW_GAP : 0);
      return { x, y };
    });
  }

  // A muscle's activation is the summed glow of its presynaptic neurons, clamped.
  // It rises when those motor neurons fire and fades with their afterglow.
  function activations() {
    const out = new Float32Array(muscles.length);
    if (!sim) return out;
    const a = sim.activation;
    for (let mi = 0; mi < muscles.length; mi++) {
      let s = 0;
      for (const p of presyn[mi]) s += a[p.i];
      out[mi] = s > 1 ? 1 : s;
    }
    return out;
  }

  function draw(ctx) {
    if (!enabled || !muscles.length || !sim) return;
    if (!presyn) build();
    const pos = layout();
    const act = activations();

    // Faint static wiring so the connections are visible even at rest.
    ctx.lineWidth = 0.7;
    ctx.setLineDash([]);
    ctx.strokeStyle = rgba(MUSCLE_COLOR, 0.05);
    ctx.beginPath();
    for (let mi = 0; mi < muscles.length; mi++) {
      const m = pos[mi];
      for (const p of presyn[mi]) {
        const n = nodes[p.i];
        ctx.moveTo(n.sx, n.sy);
        ctx.lineTo(m.x, m.y);
      }
    }
    ctx.stroke();

    // Brighten the junctions the wave is currently crossing.
    for (let mi = 0; mi < muscles.length; mi++) {
      if (act[mi] <= 0.05) continue;
      const m = pos[mi];
      ctx.strokeStyle = rgba("#ffd27f", act[mi] * 0.5);
      ctx.beginPath();
      for (const p of presyn[mi]) {
        if (sim.activation[p.i] <= 0.05) continue;
        const n = nodes[p.i];
        ctx.moveTo(n.sx, n.sy);
        ctx.lineTo(m.x, m.y);
      }
      ctx.stroke();
    }

    // Muscle cells: dim at rest, warming as their drivers fire.
    for (let mi = 0; mi < muscles.length; mi++) {
      const m = pos[mi];
      const av = act[mi];
      const r = 2.6 + av * 2;
      ctx.globalAlpha = 0.5 + av * 0.5;
      ctx.fillStyle = av > 0.4 ? mix(MUSCLE_COLOR, "#fff1c4", ((av - 0.4) / 0.6) * 0.8) : MUSCLE_COLOR;
      ctx.beginPath();
      ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    updateReadout(act);
  }

  function updateReadout(act) {
    if (!readoutEl) return;
    let dSum = 0, dN = 0, vSum = 0, vN = 0;
    for (let mi = 0; mi < muscles.length; mi++) {
      if (muscles[mi].side === "dorsal") { dSum += act[mi]; dN++; }
      else { vSum += act[mi]; vN++; }
    }
    const dPct = dN ? Math.round((dSum / dN) * 100) : 0;
    const vPct = vN ? Math.round((vSum / vN) * 100) : 0;
    if (dPct === 0 && vPct === 0) {
      readoutEl.textContent = "Muscles on. Poke a neuron and run the sim to see them light up.";
      return;
    }
    const lean = dPct > vPct + 5 ? "Dorsal is leading." : vPct > dPct + 5 ? "Ventral is leading." : "About even.";
    readoutEl.textContent = "Dorsal muscles " + dPct + "% active, ventral " + vPct + "% active. " + lean;
  }

  function init() {
    toggle = document.getElementById("muscleToggle");
    readoutEl = document.getElementById("musclestat");
    if (!toggle) return;
    toggle.addEventListener("change", () => {
      enabled = toggle.checked;
      if (readoutEl) {
        readoutEl.hidden = !enabled;
        if (!enabled) readoutEl.textContent = "";
      }
      requestDraw(); // repaint now if paused; a running sim repaints on its own
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.Muscles = { draw: draw };
})();
