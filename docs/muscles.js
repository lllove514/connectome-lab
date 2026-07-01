// Muscle / output layer. A separate, off-by-default mode entered from the
// "Explore the network" features. When on, it draws the 95 body-wall muscles as a
// small, tidy body chart: four longitudinal rows (dorsal left, dorsal right,
// ventral left, ventral right), head to tail. A muscle lights up when its
// presynaptic motor neurons fire. It reads the same sim activation the neuron
// render uses and never feeds back into the LIF math, so the 302-neuron graph is
// unchanged.
//
// This is the rebuild of the old layer. The old version drew every motor to
// muscle edge every frame (a full-canvas fan of lines) and two full-width dot
// rows, which was messy and slow. This one draws no per-edge lines at all: it
// aggregates each muscle's presynaptic firing into one activation value and fills
// a compact grid of cells. The frame cost is ~95 small rectangles.
//
// Loaded as a classic script after app.js, so it shares the globals (muscles,
// neuromuscular, nodes, sim, view, requestDraw, rgba, mix, reduceMotion). app.js
// calls Muscles.draw(ctx) as the last line of draw() when not in Compare mode.

(function () {
  "use strict";

  const MUSCLE_COLOR = "#d98a5b"; // warm muscle tone, distinct from the neuron types
  const COLS = 24; // body-wall muscles run positions 1 (head) to 24 (tail)

  // The four longitudinal rows, top to bottom in the chart. Dorsal on top,
  // ventral below, matching how the worm's body-wall muscles are arranged.
  const ROWS = [
    { side: "dorsal", row: "left", label: "dorsal L" },
    { side: "dorsal", row: "right", label: "dorsal R" },
    { side: "ventral", row: "left", label: "ventral L" },
    { side: "ventral", row: "right", label: "ventral R" },
  ];

  let enabled = false;
  let presyn = null; // per muscle: array of neuron indices that drive it
  let place = null; // per muscle: { row, col } slot in the chart
  let btn, readoutEl;

  // Map each muscle to the row/column of the chart and to the neuron-graph indices
  // of the motor neurons that drive it. Built once, the first time we draw.
  function build() {
    const rowOf = (m) => ROWS.findIndex((r) => r.side === m.side && r.row === m.row);
    place = muscles.map((m) => ({
      row: rowOf(m),
      col: Math.min(COLS, Math.max(1, m.pos)) - 1,
    }));

    presyn = muscles.map(() => []);
    const muscleAt = new Map();
    muscles.forEach((m, i) => muscleAt.set(m.id, i));
    for (const e of neuromuscular) {
      const mi = muscleAt.get(e.target);
      const ni = sim.net.index.get(e.source);
      if (mi === undefined || ni === undefined) continue; // skip anything not in the data
      presyn[mi].push(ni);
    }
  }

  // A muscle's activation is the summed glow of its presynaptic motor neurons,
  // clamped to 1. It rises when they fire and fades with their afterglow.
  function activations() {
    const out = new Float32Array(muscles.length);
    if (!sim) return out;
    const a = sim.activation;
    for (let mi = 0; mi < muscles.length; mi++) {
      let s = 0;
      const ps = presyn[mi];
      for (let k = 0; k < ps.length; k++) s += a[ps[k]];
      out[mi] = s > 1 ? 1 : s;
    }
    return out;
  }

  // The chart is a compact box centered near the top of the view, over the graph.
  // It carries its own dark background so it reads as a contained instrument.
  function box() {
    const w = Math.min(440, Math.max(280, view.w * 0.46));
    const rowH = 18;
    const top = 30; // title strip
    const h = top + ROWS.length * rowH + 12;
    return {
      x: Math.round((view.w - w) / 2),
      y: 66,
      w: w,
      h: h,
      padL: 62, // room for the row labels
      top: top,
      rowH: rowH,
    };
  }

  function draw(ctx) {
    if (!enabled || !muscles.length || !sim) return;
    if (!presyn) build();
    const act = activations();
    const b = box();
    const calm = typeof reduceMotion !== "undefined" && reduceMotion;

    // Contained panel background.
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(12,16,22,0.9)";
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);

    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "11px ui-monospace, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.fillText("Body-wall muscles", b.x + 12, b.y + 18);
    ctx.textAlign = "right";
    ctx.fillText("head", b.x + b.padL + 2, b.y + 18);
    ctx.fillText("tail", b.x + b.w - 8, b.y + 18);

    const gridX = b.x + b.padL;
    const gridW = b.x + b.w - 10 - gridX;
    const cellW = gridW / COLS;
    const cellPad = Math.min(2, cellW * 0.18);

    // A thin divider between the dorsal pair (top) and the ventral pair (bottom).
    const midY = b.y + b.top + 2 * b.rowH + 1;
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.moveTo(gridX, midY);
    ctx.lineTo(b.x + b.w - 10, midY);
    ctx.stroke();

    // Row labels.
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.textAlign = "left";
    for (let r = 0; r < ROWS.length; r++) {
      const cy = b.y + b.top + r * b.rowH + b.rowH / 2 + 3;
      ctx.fillText(ROWS[r].label, b.x + 10, cy);
    }

    // Muscle cells: one small rectangle per muscle, warming as its drivers fire.
    for (let mi = 0; mi < muscles.length; mi++) {
      const pl = place[mi];
      if (pl.row < 0) continue;
      const av = act[mi];
      const cx = gridX + pl.col * cellW + cellPad;
      const cy = b.y + b.top + pl.row * b.rowH + 3;
      const cw = cellW - cellPad * 2;
      const ch = b.rowH - 6;
      ctx.globalAlpha = calm ? 0.5 + av * 0.3 : 0.42 + av * 0.58;
      ctx.fillStyle = !calm && av > 0.4 ? mix(MUSCLE_COLOR, "#fff1c4", ((av - 0.4) / 0.6) * 0.8) : MUSCLE_COLOR;
      ctx.fillRect(cx, cy, cw, ch);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";

    updateReadout(act);
  }

  // Aggregate dorsal vs ventral activation so you can read which way the worm
  // would bend, in the feature's own readout line.
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
      readoutEl.textContent = "Poke a neuron and run the sim to see the muscles light up.";
      return;
    }
    const lean = dPct > vPct + 5 ? "The worm would bend dorsally." : vPct > dPct + 5 ? "The worm would bend ventrally." : "Dorsal and ventral are about even.";
    readoutEl.textContent = "Dorsal muscles " + dPct + "% active, ventral " + vPct + "%. " + lean;
  }

  function setEnabled(on) {
    enabled = on;
    if (btn) {
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      const s = btn.querySelector(".feat-state");
      if (s) s.textContent = on ? "on" : "off";
    }
    if (readoutEl) {
      readoutEl.hidden = !on;
      if (on) readoutEl.textContent = "Poke a neuron and run the sim to see the muscles light up.";
      else readoutEl.textContent = "";
    }
    if (typeof requestDraw === "function") requestDraw(); // repaint now if paused
  }

  function init() {
    btn = document.getElementById("muscleToggle");
    readoutEl = document.getElementById("musclestat");
    if (!btn) return;
    btn.addEventListener("click", () => setEnabled(!enabled));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.Muscles = { draw: draw };
})();
