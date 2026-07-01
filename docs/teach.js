// teach.js is the teaching layer, built around the question "how does a neuron
// fire?". It is a classic script loaded after app.js, so it shares the same
// global scope: it reads app and sim globals directly (sim, nodes, degree,
// transform, selectedNeuron, simParams, simMode, playing, TYPES, Sim) and calls
// app functions by name (setSelected, pokeAt, stepOnce, setSimMode, requestDraw,
// ring, rgba). app.js calls back through the guarded Teach object at the bottom.
//
// The science the panels teach, in plain terms: a neuron holds a voltage called
// its membrane potential. Input pushes that voltage up, and it slowly leaks back
// toward rest when input stops. Once it crosses a threshold the neuron fires a
// spike, drops below rest, and waits out a short refractory period before it can
// fire again. Chemical synapses pass signal one way. Gap junctions pass current
// both ways. A few command interneurons (AVA, AVB, AVD, PVC) sit at the center of
// the wiring and decide whether the worm crawls forward or backward.
//
// The rail is always visible and coexists with Simulate. Live readouts (the
// oscilloscope, the info card state, Step, the sandbox) keep updating while a
// wave runs. Two tools want a still graph instead of a moving wave, so opening
// them switches the mode for you: Trace and Reach drop into Explore, while the
// Lesson turns Simulate on and pokes ALM so you watch the signal travel.

(function () {
  "use strict";

  const SCOPE_LEN = 200; // how many samples of the voltage the oscilloscope keeps
  const PULSE_HOP_MS = 380; // trace pulse: milliseconds to cross one connection

  const state = {
    activeTool: null, // "sandbox" | "lesson" | "trace" | "reach" | null
    trace: null, // { path: number[] } a chain of connections, as node indices
    pulse: null, // { path, t0 } the travelling dot animation
    reachSet: null, // Int32Array of step counts, or null
    reachN: 2,
    emphasizeCommand: false,
    circuit: null, // Set<number> lesson circuit node indices
    circuitId: "touch_reflex", // which circuits.json entry is loaded
    steps: null, // the current circuit's narration steps
    stepSet: null, // Set<number> the neurons the current lesson step is about
    stepIdx: 0,
    scope: { v: new Float32Array(SCOPE_LEN), fired: new Uint8Array(SCOPE_LEN), head: 0, idx: null },
  };
  let rafId = null; // one in-flight animation frame for the trace pulse
  let tracePick = 0; // 0 off, 1 waiting for the source click, 2 waiting for the target
  let traceSrc = null;
  let circuits = null;
  let programmaticOpen = null; // tool key opened by a permalink restore, so its
                               // toggle handler skips the clear it would normally do
  const detailsFor = {}; // tool key -> its <details> element, used by restore

  const COMMAND_IDS = ["AVAL", "AVAR", "AVBL", "AVBR", "AVDL", "AVDR", "PVCL", "PVCR"];

  // A friendly one line description of each neuron type for the info card.
  const TYPE_GLOSS = {
    sensory: "It picks up something from the outside world, like a touch or a smell, and starts a signal.",
    inter: "It sits in the middle of the network, passing signals along and blending them together.",
    motor: "It tells a muscle to move.",
    unknown: "Its exact job is not pinned down in this dataset.",
  };

  // The lesson narration lives in circuits.json now, one entry per circuit, each
  // with its own steps in { text, ids, poke } shape. Steps that need a live wave
  // name a neuron to poke so you can watch the signal move through the circuit.

  const GLOSSARY = {
    "sensory neuron": "A neuron that notices something in the world, like a touch or a smell, and kicks off a signal.",
    "interneuron": "A neuron in the middle of the network that passes signals along and mixes them together.",
    "motor neuron": "A neuron that tells a muscle to move.",
    "chemical synapse": "A one way link where a spike releases a chemical that nudges the next neuron to fire, or to hold back.",
    "gap junction": "A direct electrical bridge between two neurons that passes current both ways. It still carries signal, but the reach and trace tools here only follow chemical links.",
    "membrane potential": "The voltage inside a neuron. It climbs as input arrives and drifts back to rest when things go quiet.",
    "threshold": "The voltage a neuron has to reach before it fires a spike.",
    "refractory period": "A short rest right after a spike when the neuron cannot fire again yet.",
    "integrate-and-fire": "A simple model of a neuron. It adds up its input until it crosses threshold, fires once, then resets.",
    "command interneuron": "One of a few hub neurons, AVA, AVB, AVD, and PVC, that decide whether the worm crawls forward or backward.",
    "connectome": "The full wiring map of a nervous system, every neuron and every link between them.",
    "poke": "Giving one neuron a strong jolt of current to start a wave of activity.",
  };

  const CAP_THR = "Raise the threshold and neurons get harder to set off, so the wave dies out sooner.";
  const CAP_GAIN = "More gain means each spike pushes harder on the next neuron, so the signal travels further.";
  const CAP_LEAK = "More leak means charge drains away faster, so a neuron forgets its input sooner.";

  // DOM handles, filled by build().
  let card, elName, elType, elMeta, elState, scopeCanvas, sctx, toolsEl, glossaryEl, glossaryBtn;
  let sThr, sGain, sLeak, capThr, capGain, capLeak;
  let lessonNarr, lessonStep, lessonPicker, trInfo, trResult, rcN, rcNval, rcCount;

  function nidx(id) { return sim.net.index.get(id); }

  // Turn a list of ids into a Set of node indices, quietly skipping any id that
  // is not in the loaded data so a small typo cannot break a lesson.
  function idxSet(ids) {
    const s = new Set();
    for (const id of ids) {
      const k = nidx(id);
      if (k !== undefined) s.add(k);
    }
    return s;
  }

  // --- build the rail once ----------------------------------------------------

  function build() {
    card = document.getElementById("teach-card");
    toolsEl = document.getElementById("teach-tools");
    glossaryEl = document.getElementById("glossary");
    glossaryBtn = document.getElementById("glossaryBtn");

    card.innerHTML =
      '<div class="t-name" id="t-name"></div>' +
      '<div class="t-type" id="t-type"></div>' +
      '<div class="t-meta" id="t-meta"></div>' +
      '<canvas id="scope" width="560" height="150"></canvas>' +
      '<div class="t-state">Right now it is <span id="t-state">resting</span>.</div>';
    elName = document.getElementById("t-name");
    elType = document.getElementById("t-type");
    elMeta = document.getElementById("t-meta");
    elState = document.getElementById("t-state");
    scopeCanvas = document.getElementById("scope");
    sctx = scopeCanvas.getContext("2d");

    toolsEl.innerHTML =
      '<details id="d-sandbox"><summary>Play with the model</summary><div class="t-body">' +
        '<label>threshold <input type="range" id="s-thr" aria-label="firing threshold" min="0.2" max="2" step="0.05"></label>' +
        '<div class="cap" id="cap-thr"></div>' +
        '<label>gain <input type="range" id="s-gain" aria-label="synaptic gain" min="0.05" max="0.8" step="0.01"></label>' +
        '<div class="cap" id="cap-gain"></div>' +
        '<label>leak <input type="range" id="s-leak" aria-label="membrane leak" min="0.02" max="0.5" step="0.01"></label>' +
        '<div class="cap" id="cap-leak"></div>' +
        '<button id="s-reset" type="button">put it back to normal</button>' +
      '</div></details>' +
      '<details id="d-lesson"><summary>Guided circuits</summary><div class="t-body">' +
        '<div class="t-row" id="lesson-picker" role="group" aria-label="Choose a circuit"></div>' +
        '<div class="t-narr" id="lesson-narr"></div>' +
        '<div class="t-row"><button id="lesson-prev" type="button">back</button>' +
        '<span id="lesson-step"></span><button id="lesson-next" type="button">next</button></div>' +
      '</div></details>' +
      '<details id="d-trace"><summary>Trace a signal</summary><div class="t-body">' +
        '<div class="t-row"><button id="tr-pick" type="button">pick two neurons</button>' +
        '<button id="tr-clear" type="button">clear</button></div>' +
        '<div class="cap" id="tr-info"></div>' +
        '<div class="t-narr" id="tr-result"></div>' +
      '</div></details>' +
      '<details id="d-reach"><summary>How far a signal spreads</summary><div class="t-body">' +
        '<label>steps <input type="range" id="rc-n" aria-label="how many steps out to reach" min="1" max="5" value="2"> <span id="rc-nval">2</span></label>' +
        '<div class="t-narr" id="rc-count"></div>' +
        '<label class="t-check"><input type="checkbox" id="rc-cmd"> highlight the command neurons</label>' +
        '<div class="cap">This counts chemical links only. A real poke also spreads through gap junctions, so a live wave lights up more neurons than this number shows.</div>' +
      '</div></details>';

    wireSandbox();
    wireLesson();
    wireTrace();
    wireReach();
    wireAccordion();
    wireGlossary();
  }

  // --- info card and oscilloscope (tools 1 and 2) ----------------------------

  function onSelect(neuron) {
    if (!sim) return;
    if (tracePick && neuron) { // the trace tool is grabbing the source and target
      if (tracePick === 1) {
        traceSrc = neuron.id;
        tracePick = 2;
        trInfo.textContent = "Starting at " + neuron.id + ". Now click where you want the signal to end up.";
      } else {
        tracePick = 0;
        runTrace(traceSrc, neuron.id);
      }
      renderCard(neuron);
      return;
    }
    resetScope(neuron);
    renderCard(neuron);
    if (state.activeTool === "reach") reachRun(state.reachN);
    drawScope();
  }

  function renderCard(neuron) {
    if (!neuron) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    elName.textContent = neuron.name;
    const t = TYPES[neuron.type] || TYPES.unknown;
    elType.innerHTML =
      '<span style="color:' + t.color + '">' + t.label + " neuron.</span> " +
      (TYPE_GLOSS[neuron.type] || TYPE_GLOSS.unknown);
    const d = degree.get(neuron.id) || { in: 0, out: 0, gap: 0 };
    elMeta.textContent =
      "It belongs to class " + neuron.class + ". It has " + d.in + " chemical inputs, " +
      d.out + " outputs, and " + d.gap + " gap junctions.";
    renderLiveState();
  }

  // A friendly word for the neuron's phase, read straight from the sim each tick.
  function phase(i) {
    if (sim.state.fired[i]) return "firing a spike";
    if (sim.state.refractory[i] > 0) return "resting after a spike";
    if (sim.state.v[i] > 0.02) return "charging up";
    return "resting";
  }

  function renderLiveState() {
    const i = state.scope.idx;
    elState.textContent = i == null ? "resting" : phase(i);
  }

  function resetScope(neuron) {
    state.scope.idx = neuron ? nidx(neuron.id) : null;
    state.scope.v.fill(0);
    state.scope.fired.fill(0);
    state.scope.head = 0;
  }

  // Each tick, record this neuron's voltage and whether it spiked.
  function onTick(simState) {
    const i = state.scope.idx;
    if (i != null) {
      state.scope.v[state.scope.head] = simState.v[i];
      state.scope.fired[state.scope.head] = simState.fired[i];
      state.scope.head = (state.scope.head + 1) % SCOPE_LEN;
    }
    renderLiveState();
    drawScope();
  }

  // The oscilloscope: a scrolling plot of the chosen neuron's voltage over time,
  // with the resting level and the threshold marked, so you can watch the voltage
  // climb, spike, drop below rest, then sit flat while it recovers. The vertical
  // range is recomputed from simParams.threshold every frame, so sliding the
  // threshold up in the sandbox keeps the threshold line in view.
  function drawScope() {
    if (!sctx) return;
    const W = scopeCanvas.width;
    const H = scopeCanvas.height;
    const thr = simParams.threshold;
    const rst = simParams.reset;
    const vmax = Math.max(thr + 0.4, 0.5);
    const vmin = Math.min(rst - 0.2, -0.3);
    const yOf = (v) => H - ((v - vmin) / (vmax - vmin)) * H;

    sctx.fillStyle = "#07090d";
    sctx.fillRect(0, 0, W, H);

    sctx.strokeStyle = "rgba(255,255,255,0.16)";
    sctx.lineWidth = 1;
    sctx.setLineDash([]);
    hline(yOf(0));
    sctx.strokeStyle = "rgba(255,180,84,0.7)";
    sctx.setLineDash([5, 4]);
    hline(yOf(thr));
    sctx.setLineDash([]);

    const i = state.scope.idx;
    if (i != null) {
      sctx.strokeStyle = "rgba(255,225,150,0.9)";
      sctx.lineWidth = 1.5;
      for (let s = 0; s < SCOPE_LEN; s++) {
        const bi = (state.scope.head + s) % SCOPE_LEN;
        if (state.scope.fired[bi]) {
          const x = (s / (SCOPE_LEN - 1)) * W;
          sctx.beginPath();
          sctx.moveTo(x, yOf(thr));
          sctx.lineTo(x, 6);
          sctx.stroke();
        }
      }
      sctx.strokeStyle = "#7ec8ff";
      sctx.lineWidth = 2;
      sctx.beginPath();
      for (let s = 0; s < SCOPE_LEN; s++) {
        const bi = (state.scope.head + s) % SCOPE_LEN;
        const x = (s / (SCOPE_LEN - 1)) * W;
        const y = yOf(state.scope.v[bi]);
        s === 0 ? sctx.moveTo(x, y) : sctx.lineTo(x, y);
      }
      sctx.stroke();
    }

    sctx.fillStyle = "rgba(255,255,255,0.45)";
    sctx.font = "15px ui-monospace, Menlo, monospace";
    sctx.textAlign = "left";
    sctx.fillText("threshold", 8, yOf(thr) - 5);
    sctx.fillText("rest", 8, yOf(0) - 5);
    sctx.fillText("voltage", 8, 20);
    sctx.textAlign = "right";
    sctx.fillText("time", W - 8, H - 8);
    sctx.textAlign = "left";
  }

  function hline(y) {
    sctx.beginPath();
    sctx.moveTo(0, y);
    sctx.lineTo(scopeCanvas.width, y);
    sctx.stroke();
  }

  // --- play with the model (tool 4) ------------------------------------------
  //
  // The sliders change the live simParams copy, never Sim.DEFAULTS, so the saved
  // tuning and the self checks stay put. The leak value stores the fraction of
  // charge a neuron keeps each tick, so the on screen leak slider is its opposite
  // (leakiness is one minus what it keeps): sliding it up drains charge faster,
  // which is what the caption promises.

  function wireSandbox() {
    sThr = document.getElementById("s-thr");
    sGain = document.getElementById("s-gain");
    sLeak = document.getElementById("s-leak");
    capThr = document.getElementById("cap-thr");
    capGain = document.getElementById("cap-gain");
    capLeak = document.getElementById("cap-leak");
    syncSliders();
    sThr.addEventListener("input", () => { simParams.threshold = +sThr.value; caps(); drawScope(); requestDraw(); });
    sGain.addEventListener("input", () => { simParams.gain = +sGain.value; caps(); requestDraw(); });
    sLeak.addEventListener("input", () => { simParams.leak = 1 - +sLeak.value; caps(); requestDraw(); });
    document.getElementById("s-reset").addEventListener("click", () => {
      Object.assign(simParams, Sim.DEFAULTS);
      syncSliders();
      drawScope();
      requestDraw();
    });
  }

  function syncSliders() {
    sThr.value = simParams.threshold;
    sGain.value = simParams.gain;
    sLeak.value = (1 - simParams.leak).toFixed(2);
    caps();
  }

  function caps() {
    capThr.textContent = "Threshold is " + simParams.threshold.toFixed(2) + ". " + CAP_THR;
    capGain.textContent = "Gain is " + simParams.gain.toFixed(2) + ". " + CAP_GAIN;
    capLeak.textContent = "Leak is " + (1 - simParams.leak).toFixed(2) + ". " + CAP_LEAK;
  }

  // --- touch reflex lesson (tool 5) ------------------------------------------

  function wireLesson() {
    lessonNarr = document.getElementById("lesson-narr");
    lessonStep = document.getElementById("lesson-step");
    lessonPicker = document.getElementById("lesson-picker");
    document.getElementById("lesson-prev").addEventListener("click", () => showStep(state.stepIdx - 1));
    document.getElementById("lesson-next").addEventListener("click", () => showStep(state.stepIdx + 1));
  }

  // One button per circuit in circuits.json, in file order, so the extra lessons
  // list themselves with no other wiring.
  function buildPicker() {
    if (!lessonPicker || !circuits) return;
    lessonPicker.innerHTML = "";
    for (const id in circuits) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "lesson-pick" + (id === state.circuitId ? " on" : "");
      b.textContent = circuits[id].name;
      b.dataset.cid = id;
      b.setAttribute("aria-pressed", id === state.circuitId ? "true" : "false");
      b.addEventListener("click", () => selectCircuit(id));
      lessonPicker.appendChild(b);
    }
  }

  // Load one circuit: highlight its neurons, take its narration, and start at step
  // one. idxSet quietly drops any neuron that is not in the data, so a circuit
  // with a missing cell still runs.
  function selectCircuit(id) {
    if (!circuits || !circuits[id]) return;
    state.circuitId = id;
    state.circuit = idxSet(circuits[id].neurons);
    state.steps = circuits[id].steps || [];
    if (lessonPicker) {
      for (const b of lessonPicker.children) {
        const on = b.dataset.cid === id;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      }
    }
    if (!simMode) setSimMode(true);
    showStep(0);
  }

  // Opening the lesson needs a live wave, so it turns Simulate on and loads a
  // circuit (the last one picked, or the first available).
  function lessonOpen() {
    if (!circuits || !Object.keys(circuits).length) {
      lessonNarr.textContent = "The circuits are still loading, give it a second and reopen.";
      return;
    }
    if (!circuits[state.circuitId]) state.circuitId = Object.keys(circuits)[0];
    buildPicker();
    if (!simMode) setSimMode(true);
    selectCircuit(state.circuitId);
  }

  function showStep(i) {
    const steps = state.steps || [];
    if (!steps.length) return;
    state.stepIdx = Math.max(0, Math.min(steps.length - 1, i));
    const st = steps[state.stepIdx];
    lessonNarr.textContent = st.text;
    lessonStep.textContent = state.stepIdx + 1 + " of " + steps.length;
    state.stepSet = idxSet(st.ids);
    if (st.poke) {
      if (!simMode) setSimMode(true);
      const k = nidx(st.poke);
      if (k !== undefined) {
        pokeAt(k);
        setSelected(st.poke); // follow the poked neuron on the oscilloscope
      }
    }
    requestDraw();
  }

  // --- trace a signal (tool 6) -----------------------------------------------

  function wireTrace() {
    trInfo = document.getElementById("tr-info");
    trResult = document.getElementById("tr-result");
    document.getElementById("tr-pick").addEventListener("click", () => {
      tracePick = 1;
      traceSrc = null;
      trResult.textContent = "";
      trInfo.textContent = "Click the neuron you want to start from.";
    });
    document.getElementById("tr-clear").addEventListener("click", clearTrace);
  }

  function runTrace(srcId, tgtId) {
    const s = nidx(srcId);
    const t = nidx(tgtId);
    if (s === undefined || t === undefined) {
      trResult.textContent = "I could not find one of those neurons.";
      return;
    }
    const path = Sim.bfsPath(sim.net, s, t);
    if (!path) {
      state.trace = null;
      state.pulse = null;
      trResult.textContent =
        "There is no one way chemical route from " + srcId + " to " + tgtId + ". The signal cannot get there through synapses.";
      requestDraw();
      return;
    }
    state.trace = { path: path };
    const hops = path.length - 1;
    trResult.textContent =
      path.map((k) => nodes[k].id).join(" → ") + "    (" + hops + " step" + (hops === 1 ? "" : "s") + ")";
    startPulse(path);
  }

  // A dot travels the route one connection at a time. It is a short animation
  // that ends on its own: one frame id at a time, cancelled before any restart,
  // and it repaints through requestDraw, which does nothing while a wave plays.
  function startPulse(path) {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    state.pulse = null;
    // Reduced motion: the path stays highlighted (drawn from state.trace), we just
    // skip the travelling dot.
    if (path.length < 2 || (typeof reduceMotion !== "undefined" && reduceMotion)) { requestDraw(); return; }
    state.pulse = { path: path, t0: performance.now() };
    const frame = () => {
      const done = performance.now() - state.pulse.t0 >= (path.length - 1) * PULSE_HOP_MS;
      requestDraw();
      if (done) {
        state.pulse = null;
        rafId = null;
      } else {
        rafId = requestAnimationFrame(frame);
      }
    };
    rafId = requestAnimationFrame(frame);
  }

  function clearTrace() {
    state.trace = null;
    state.pulse = null;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    tracePick = 0;
    traceSrc = null;
    trResult.textContent = "";
    trInfo.textContent = "Pick a start neuron, then an end neuron, and I will find the shortest chain of connections between them.";
    requestDraw();
  }

  // --- how far a signal spreads (tool 7) -------------------------------------

  function wireReach() {
    rcN = document.getElementById("rc-n");
    rcNval = document.getElementById("rc-nval");
    rcCount = document.getElementById("rc-count");
    rcN.addEventListener("input", () => {
      rcNval.textContent = rcN.value;
      reachRun(+rcN.value);
    });
    document.getElementById("rc-cmd").addEventListener("change", (e) => {
      state.emphasizeCommand = e.target.checked;
      requestDraw();
    });
  }

  function reachRun(n) {
    state.reachN = n;
    if (!selectedNeuron) {
      state.reachSet = null;
      rcCount.textContent = "Click a neuron first, then slide to choose how many steps out to look.";
      requestDraw();
      return;
    }
    state.reachSet = Sim.reach(sim.net, nidx(selectedNeuron.id), n);
    let count = 0;
    for (let k = 0; k < sim.net.n; k++) if (state.reachSet[k] > 0) count++;
    rcCount.textContent =
      "Starting at " + selectedNeuron.id + ", a signal can reach " + count + " neuron" + (count === 1 ? "" : "s") +
      " within " + n + " step" + (n === 1 ? "" : "s") + ".";
    requestDraw();
  }

  // --- glossary (tool 8) -----------------------------------------------------

  function wireGlossary() {
    let html = "<h3>What these words mean</h3><dl>";
    for (const term in GLOSSARY) html += "<dt>" + term + "</dt><dd>" + GLOSSARY[term] + "</dd>";
    glossaryEl.innerHTML = html + "</dl>";
    glossaryBtn.addEventListener("click", () => {
      glossaryEl.hidden = !glossaryEl.hidden;
      glossaryBtn.setAttribute("aria-expanded", glossaryEl.hidden ? "false" : "true");
    });
  }

  // --- accordion: one tool open at a time, and each sets the mode it wants ----

  function wireAccordion() {
    const panels = [
      ["sandbox", document.getElementById("d-sandbox")],
      ["lesson", document.getElementById("d-lesson")],
      ["trace", document.getElementById("d-trace")],
      ["reach", document.getElementById("d-reach")],
    ];
    for (const [key, el] of panels) {
      detailsFor[key] = el;
      el.addEventListener("toggle", () => {
        if (programmaticOpen === key) { programmaticOpen = null; return; } // opened by a permalink restore
        if (el.open) {
          state.activeTool = key;
          for (const [, other] of panels) if (other !== el && other.open) other.open = false;
          clearHighlights();
          onToolOpen(key);
        } else if (state.activeTool === key) {
          state.activeTool = null;
          clearHighlights();
          requestDraw();
        }
      });
    }
  }

  // Each tool asks for the mode it needs so it never fights the running sim.
  // Trace and reach want a still, highlighted graph, so they drop into Explore.
  // The lesson wants a live wave, so it turns Simulate on (inside lessonOpen).
  // The sandbox is happy either way and leaves the mode alone.
  function onToolOpen(key) {
    if (key === "lesson") {
      lessonOpen();
    } else if (key === "reach") {
      if (simMode) setSimMode(false);
      reachRun(state.reachN);
    } else if (key === "trace") {
      if (simMode) setSimMode(false);
      clearTrace();
    }
  }

  // Drop every highlight the overlay might paint, used when tools switch or close.
  function clearHighlights() {
    state.trace = null;
    state.reachSet = null;
    state.circuit = null;
    state.stepSet = null;
    state.emphasizeCommand = false;
    state.pulse = null;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    tracePick = 0;
  }

  // --- overlay on the main graph (drawn last in app's draw(), wiped each frame)

  function drawOverlay(ctx) {
    if (!sim) return;
    if (!selectedNeuron && !state.trace && !state.reachSet && !state.circuit && !state.pulse) return;

    if (state.activeTool === "reach" && state.reachSet) {
      const span = Math.max(1, state.reachN);
      for (let k = 0; k < sim.net.n; k++) {
        const d = state.reachSet[k];
        if (d > 0) ring(nodes[k], 5, rgba("#4be0c0", 1 - ((d - 1) / span) * 0.6), 1.6);
      }
    }

    if (state.activeTool === "lesson" && state.circuit) {
      for (const k of state.circuit) ring(nodes[k], 5, "rgba(120,160,255,0.45)", 1.4);
      if (state.stepSet) for (const k of state.stepSet) ring(nodes[k], 6.5, "#9ecbff", 2);
    }

    if (state.trace) {
      const p = state.trace.path;
      ctx.strokeStyle = "rgba(255,210,120,0.85)";
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.beginPath();
      for (let j = 0; j < p.length; j++) {
        const n = nodes[p[j]];
        j === 0 ? ctx.moveTo(n.sx, n.sy) : ctx.lineTo(n.sx, n.sy);
      }
      ctx.stroke();
      for (const k of p) ring(nodes[k], 5.5, "#ffd27f", 1.8);
    }

    if (state.emphasizeCommand) {
      for (const id of COMMAND_IDS) {
        const k = nidx(id);
        if (k !== undefined) ring(nodes[k], 7.5, "#ff8f5a", 2);
      }
    }

    if (state.pulse) drawPulse(ctx);

    if (selectedNeuron) ring(selectedNeuron, 8, "#ffffff", 2); // the chosen neuron, brightest, last
  }

  function drawPulse(ctx) {
    const p = state.pulse.path;
    const elapsed = performance.now() - state.pulse.t0;
    const hop = Math.floor(elapsed / PULSE_HOP_MS);
    if (hop >= p.length - 1) return;
    const frac = (elapsed - hop * PULSE_HOP_MS) / PULSE_HOP_MS;
    const a = nodes[p[hop]];
    const b = nodes[p[hop + 1]];
    const x = a.sx + (b.sx - a.sx) * frac;
    const y = a.sy + (b.sy - a.sy) * frac;
    ctx.fillStyle = "rgba(255,242,192,0.35)";
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff2c0";
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- permalink support: read and rebuild the shareable tool state ----------
  //
  // Both reuse the same private runners the accordion and sliders already use, so
  // there is no second copy of the tool logic. toolState() reports what is on
  // screen; activateTool() puts it back. Neither affects normal interaction.

  function toolState() {
    const open = state.activeTool && state.activeTool !== "sandbox" ? state.activeTool : null;
    const s = { tool: open || (selectedNeuron ? "oscilloscope" : "none") };
    if (state.activeTool === "trace" && state.trace) {
      const p = state.trace.path;
      s.from = nodes[p[0]].id;
      s.to = nodes[p[p.length - 1]].id;
    }
    if (state.activeTool === "reach") s.reachN = state.reachN;
    if (state.activeTool === "lesson") s.circuit = state.circuitId;
    return s;
  }

  function activateTool(t) {
    const key = t.tool;
    if (key !== "lesson" && key !== "trace" && key !== "reach") return; // oscilloscope/none: the card alone
    const el = detailsFor[key];
    if (el && !el.open) { programmaticOpen = key; el.open = true; } // show it, suppress its clear
    state.activeTool = key;
    if (key === "lesson") {
      lessonOpen();
    } else if (key === "reach") {
      if (simMode) setSimMode(false);
      const n = t.reachN != null ? +t.reachN : state.reachN;
      if (rcN) { rcN.value = n; rcNval.textContent = n; }
      reachRun(n);
    } else if (key === "trace") {
      if (simMode) setSimMode(false);
      if (t.from && t.to) runTrace(t.from, t.to);
    }
  }

  function init() {
    build();
    fetch("circuits.json")
      .then((r) => r.json())
      .then((c) => { circuits = c; })
      .catch(() => { circuits = {}; });
  }

  window.Teach = { onSelect: onSelect, onTick: onTick, drawOverlay: drawOverlay, toolState: toolState, activateTool: activateTool };
  init();
})();
