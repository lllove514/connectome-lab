// Records a poke as a looping GIF, entirely in the browser. Hand-rolling an LZW
// GIF encoder is fiddly and off topic for this project, so a small vendored
// encoder (vendor/gif.js, MIT, see vendor/README.md) is the pragmatic choice.
//
// Additive and isolated: it does not touch the sim math or the render. It reuses
// the existing pokeAt and stepOnce, reads the same #view canvas the app draws to,
// steps the wave one tick per animation frame while grabbing a downscaled frame
// each time, and hands the frames to gif.js, whose worker encodes off the main
// thread so the page never freezes.

(function () {
  "use strict";

  const MAX_FRAMES = 120; // hard cap so a stubborn wave cannot make a giant file
  const FRAME_DELAY = 60; // ms per GIF frame (about 16 fps)
  const TARGET_W = 640; // downscale the retina canvas to at most this wide
  const BG = "#0a0c10"; // the same dark background app.js paints

  let recording = false;
  let btn, statusEl;

  function status(msg) {
    if (statusEl) statusEl.textContent = msg || "";
  }

  // Settled means nothing fired this tick and the afterglow has faded, matching
  // the app's own auto-pause test. Read-only: it never mutates sim state.
  function settled() {
    const st = sim.state;
    const act = sim.activation;
    let maxGlow = 0;
    for (let i = 0; i < sim.net.n; i++) {
      if (st.fired[i]) return false;
      if (act[i] > maxGlow) maxGlow = act[i];
    }
    return maxGlow < SETTLE_GLOW;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function record() {
    if (recording) return;
    if (typeof GIF === "undefined") { status("encoder did not load"); return; }
    if (typeof sim === "undefined" || !sim) { status("still loading"); return; }

    const neuron = typeof selectedNeuron !== "undefined" ? selectedNeuron : null;
    if (!neuron) { status("select a neuron first, then record"); return; }

    if (!simMode) setSimMode(true); // recording a wave needs Simulate
    setSelected(neuron.id); // reselect in case the mode switch cleared it
    const idx = sim.net.index.get(neuron.id);
    if (idx === undefined) { status("could not find that neuron"); return; }

    recording = true;
    if (btn) btn.disabled = true;
    status("recording...");

    // Downscaled output, keeping the canvas aspect so the wave is not stretched.
    const outW = Math.max(1, Math.min(TARGET_W, Math.round(view.w)));
    const outH = Math.max(1, Math.round((outW * view.h) / view.w));
    const off = document.createElement("canvas");
    off.width = outW;
    off.height = outH;
    const octx = off.getContext("2d");

    const gif = new GIF({
      workers: 2,
      quality: 10,
      repeat: 0, // loop forever
      background: BG,
      width: outW,
      height: outH,
      workerScript: "vendor/gif.worker.js",
    });

    function grab() {
      octx.fillStyle = BG;
      octx.fillRect(0, 0, outW, outH);
      octx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, outW, outH);
      gif.addFrame(off, { copy: true, delay: FRAME_DELAY });
    }

    // Load the poke at tick 0 without auto-running the clock, then step the wave
    // one tick per frame, grabbing each. manual is restored afterwards.
    const prevManual = manual;
    pause();
    manual = true;
    pokeAt(idx);
    grab(); // frame 0: the poke

    let frames = 1;
    function stepFrame() {
      stepOnce(); // reuse the app's single-tick advance (it draws the frame)
      grab();
      frames++;
      if (frames >= MAX_FRAMES || settled()) finish();
      else requestAnimationFrame(stepFrame);
    }

    function finish() {
      manual = prevManual;
      status("encoding...");
      gif.on("progress", (p) => status("encoding " + Math.round(p * 100) + "%"));
      gif.on("finished", (blob) => {
        downloadBlob(blob, "connectome-" + neuron.name + ".gif");
        status("saved");
        recording = false;
        if (btn) btn.disabled = false;
        setTimeout(() => { if (!recording) status(""); }, 4000);
      });
      gif.render();
    }

    requestAnimationFrame(stepFrame);
  }

  function init() {
    btn = document.getElementById("recgif");
    statusEl = document.getElementById("recstatus");
    if (btn) btn.addEventListener("click", record);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
