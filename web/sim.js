// Leaky integrate-and-fire (LIF) dynamics over the C. elegans connectome, plus
// the single data<->screen transform.
//
// This file is pure — no DOM — so the exact same step() and the exact same
// coordinate math run in the browser (app.js) and in Node (sim_selfcheck.js).
// The UMD shim at the bottom exports it either way; nothing here touches the page.
//
// The LIF neuron is the simplest spiking model that still behaves like a cell:
// a membrane potential v leaks back toward its resting value every tick, sums
// the synaptic current arriving from neurons that just spiked, and fires a spike
// of its own once v crosses a threshold — after which it resets below rest and
// sits out a short refractory period. Rest is 0 throughout.
//
// One poke should behave like a real evoked response: activity spreads outward,
// peaks, and then dies back to silence. Two things make it decay instead of
// locking on: the network gain is kept sub-critical (a spike triggers, on
// average, fewer than one downstream spike), and a global inhibitory pool
// charges up with population activity and leaks away — negative feedback that
// caps a burst and lets the wave fade, the way pervasive GABAergic tone keeps a
// real circuit from seizing.

(function (global) {
  "use strict";

  // Tunable constants, fit against the real connectome (median synapse weight 3,
  // strongest ALM output weight 5, gap weights up to ~400). threshold sits below
  // 1 so a single spike over a moderate synapse recruits its target — that is
  // what makes a poke reliably ignite a wave from most neurons — while gain stays
  // low enough, and the inhibitory pool strong enough, that the wave still peaks
  // modestly and decays to silence rather than saturating.
  const DEFAULTS = {
    leak: 0.82, // fraction of v retained each tick (membrane's exponential decay)
    threshold: 0.7, // v at or above this fires a spike
    gain: 0.3, // volts injected per unit synaptic weight from a presynaptic spike
    gapCoefficient: 0.06, // extra scaling on electrical (gap-junction) current
    refractoryTicks: 8, // ticks a neuron stays silent after firing
    reset: -1.0, // v set below rest right after a spike (hyperpolarization)
    inhStrength: 5.0, // how hard population firing charges the global inhibitory pool
    inhDecay: 0.88, // per-tick retention of that inhibition (it leaks away)
    poke: 5.0, // strength of a manual poke — strongly suprathreshold, fires next tick
  };

  // Flatten the connectome into packed [targetIndex, weight, ...] arrays keyed by
  // source index, so a tick never has to touch strings or hash maps. Node indices
  // follow data.nodes order, which both callers preserve.
  function buildNetwork(data) {
    const nodes = data.nodes;
    const n = nodes.length;
    const index = new Map();
    for (let i = 0; i < n; i++) index.set(nodes[i].id, i);

    const chemOut = Array.from({ length: n }, () => []);
    for (const e of data.chemical) {
      const s = index.get(e.source);
      const t = index.get(e.target);
      if (s === undefined || t === undefined) continue;
      chemOut[s].push(t, e.weight); // directed: current flows presynaptic -> postsynaptic
    }

    const gapAdj = Array.from({ length: n }, () => []);
    for (const e of data.gap) {
      const a = index.get(e.source);
      const b = index.get(e.target);
      if (a === undefined || b === undefined) continue;
      gapAdj[a].push(b, e.weight); // electrical synapses conduct both ways, so
      gapAdj[b].push(a, e.weight); // store the pair in both directions
    }

    return { n, index, nodes, chemOut, gapAdj };
  }

  function createState(n) {
    return {
      v: new Float64Array(n), // membrane potential, rest = 0
      refractory: new Int32Array(n), // ticks left before the neuron can fire again
      fired: new Uint8Array(n), // spiked on the current tick
      firedPrev: new Uint8Array(n), // spiked on the previous tick (drives the current)
      input: new Float64Array(n), // scratch: synaptic current summed this tick
      inh: 0, // global inhibitory pool (feedback that quenches bursts)
    };
  }

  // A poke is an experimenter's electrode: dump enough charge in to guarantee the
  // neuron crosses threshold on the next step and seeds a wave.
  function poke(state, i, amount) {
    state.v[i] += amount;
  }

  // Advance the whole network one tick. Mutates state in place; after it returns,
  // state.fired[i] tells the caller which neurons spiked (what the graph lights up).
  function step(net, state, p) {
    const n = net.n;
    const { v, refractory, fired, firedPrev, input } = state;
    input.fill(0);

    // 1) Neurons that fired last tick release their current now. A spike is an
    //    all-or-nothing event, so the presynaptic v no longer matters — only that
    //    it fired — which is why we read firedPrev, not v.
    for (let i = 0; i < n; i++) {
      if (!firedPrev[i]) continue;
      const chem = net.chemOut[i];
      for (let k = 0; k < chem.length; k += 2) {
        input[chem[k]] += chem[k + 1] * p.gain;
      }
      const gaps = net.gapAdj[i];
      for (let k = 0; k < gaps.length; k += 2) {
        input[gaps[k]] += gaps[k + 1] * p.gain * p.gapCoefficient;
      }
    }

    // 2) Leak-integrate-and-fire each neuron, held down by the current level of
    //    global inhibition. inh is the same for every cell (a shared pool), so a
    //    busy tick raises everyone's effective threshold on the next one.
    const inh = state.inh;
    let firedCount = 0;
    for (let i = 0; i < n; i++) {
      if (refractory[i] > 0) {
        refractory[i] -= 1; // still recovering: it leaks but cannot integrate or fire
        v[i] *= p.leak;
        fired[i] = 0;
        continue;
      }
      v[i] = v[i] * p.leak + input[i] - inh; // decay, add current, subtract inhibition
      if (v[i] >= p.threshold) {
        fired[i] = 1;
        v[i] = p.reset; // spike, then drop below rest
        refractory[i] = p.refractoryTicks;
        firedCount++;
      } else {
        fired[i] = 0;
      }
    }

    // 3) Charge the inhibitory pool from this tick's population activity and let
    //    it leak. This is the negative feedback that turns a runaway into a wave.
    state.inh = inh * p.inhDecay + p.inhStrength * (firedCount / n);

    // 4) This tick's spikes become next tick's drive.
    firedPrev.set(fired);
  }

  // --- The one data <-> screen transform ---------------------------------------
  //
  // Node positions are normalized, but we do not assume they fill 0..1: we fit
  // their actual bounding box (min/max over the nodes) into the current canvas in
  // CSS pixels, with one uniform scale on both axes (so the graph keeps its shape)
  // and equal centering (so it is letterboxed, never squashed).
  //
  // makeTransform returns a single {scale, offsetX, offsetY}. Everything downstream
  // reads that one object: toScreen is forward (data -> screen), toData is its exact
  // algebraic inverse (screen -> data), and pickNearest uses the same forward map to
  // place nodes before measuring distance. Because there is only one object, the
  // renderer and the hit-test cannot drift apart on any canvas shape.

  function makeTransform(nodes, cssW, cssH) {
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (const n of nodes) {
      if (n.x < minx) minx = n.x;
      if (n.x > maxx) maxx = n.x;
      if (n.y < miny) miny = n.y;
      if (n.y > maxy) maxy = n.y;
    }
    const pad = 28; // CSS-px margin so fringe nodes are not jammed against the edge
    const dataW = maxx - minx || 1;
    const dataH = maxy - miny || 1;
    const scale = Math.min((cssW - 2 * pad) / dataW, (cssH - 2 * pad) / dataH);
    // Center the scaled bounding box: pull minx*scale back to the left padding edge.
    const offsetX = (cssW - dataW * scale) / 2 - minx * scale;
    const offsetY = (cssH - dataH * scale) / 2 - miny * scale;
    return { scale, offsetX, offsetY };
  }

  function toScreen(t, nx, ny) {
    return { x: t.offsetX + nx * t.scale, y: t.offsetY + ny * t.scale };
  }

  function toData(t, px, py) {
    return { x: (px - t.offsetX) / t.scale, y: (py - t.offsetY) / t.scale };
  }

  // Index of the node nearest (px, py) in canvas CSS pixels, or -1 if none is
  // within `radius`. The click must already be in canvas space (its bounding-rect
  // offset removed, and NOT multiplied by devicePixelRatio).
  function pickNearest(t, nodes, px, py, radius) {
    let best = -1;
    let bestD = radius * radius;
    for (let i = 0; i < nodes.length; i++) {
      const sx = t.offsetX + nodes[i].x * t.scale;
      const sy = t.offsetY + nodes[i].y * t.scale;
      const dx = px - sx;
      const dy = py - sy;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  // --- Graph analysis over the wiring (shared with the teaching layer) ---------
  //
  // These walk the DIRECTED chemical graph only (net.chemOut). A "signal path" is
  // a chain of chemical synapses; gap junctions are electrical and bidirectional,
  // a different kind of coupling, so they are deliberately not traversed here.

  // Shortest directed chemical path as node indices [src..tgt] (inclusive), or
  // null if tgt is unreachable. Unweighted BFS: length-1 counts synapses crossed.
  function bfsPath(net, srcIdx, tgtIdx) {
    if (srcIdx === tgtIdx) return [srcIdx];
    const prev = new Int32Array(net.n).fill(-1);
    const seen = new Uint8Array(net.n);
    seen[srcIdx] = 1;
    let frontier = [srcIdx];
    while (frontier.length) {
      const next = [];
      for (const u of frontier) {
        const out = net.chemOut[u];
        for (let k = 0; k < out.length; k += 2) {
          const v = out[k];
          if (seen[v]) continue;
          seen[v] = 1;
          prev[v] = u;
          if (v === tgtIdx) {
            const path = [];
            for (let c = tgtIdx; c !== -1; c = prev[c]) path.push(c);
            path.reverse();
            return path;
          }
          next.push(v);
        }
      }
      frontier = next;
    }
    return null;
  }

  // Hop distance from src over directed chemical synapses, BFS truncated at
  // maxHops. dist[i] = hops to reach neuron i (0 at src), or -1 if not reached.
  function reach(net, srcIdx, maxHops) {
    const dist = new Int32Array(net.n).fill(-1);
    dist[srcIdx] = 0;
    let frontier = [srcIdx];
    for (let hop = 1; hop <= maxHops && frontier.length; hop++) {
      const next = [];
      for (const u of frontier) {
        const out = net.chemOut[u];
        for (let k = 0; k < out.length; k += 2) {
          const v = out[k];
          if (dist[v] !== -1) continue;
          dist[v] = hop;
          next.push(v);
        }
      }
      frontier = next;
    }
    return dist;
  }

  const Sim = {
    DEFAULTS,
    buildNetwork,
    createState,
    poke,
    step,
    makeTransform,
    toScreen,
    toData,
    pickNearest,
    bfsPath,
    reach,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = Sim;
  else global.Sim = Sim;
})(typeof globalThis !== "undefined" ? globalThis : this);
