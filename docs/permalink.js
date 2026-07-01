// Shareable permalinks. A tiny, isolated layer that reflects the current view
// into location.hash and restores it on load. It changes no existing behavior:
// it only reads the app/teach globals to build a hash, and calls the existing
// functions (setSimMode, setSelected, pokeAt, Teach.activateTool) to put a state
// back. Loaded as a classic script after teach.js, so it shares their scope.
//
// Hash shape (all fields optional, unknown ones ignored):
//   #n=AVAL&sim=1&poke=AVAL&tool=trace&from=ALML&to=VA01&reach=3&circuit=touch_reflex

(function (global) {
  "use strict";

  const TOOLS = ["lesson", "trace", "reach"]; // accordion tools worth sharing

  // The canonical, DOM-free state the whole layer round-trips.
  function blank() {
    return { n: null, sim: false, poke: null, tool: "none", from: null, to: null, reachN: null, circuit: null };
  }

  // --- pure: state <-> hash (the only part the self-check exercises) ----------

  function encodeState(s) {
    const enc = encodeURIComponent;
    const parts = [];
    if (s.n) parts.push("n=" + enc(s.n));
    if (s.sim) parts.push("sim=1");
    if (s.poke) parts.push("poke=" + enc(s.poke));
    if (s.tool && s.tool !== "none") parts.push("tool=" + enc(s.tool));
    if (s.from) parts.push("from=" + enc(s.from));
    if (s.to) parts.push("to=" + enc(s.to));
    if (s.reachN != null) parts.push("reach=" + s.reachN);
    if (s.circuit) parts.push("circuit=" + enc(s.circuit));
    return parts.length ? "#" + parts.join("&") : "";
  }

  // Never throws on any input. Anything unrecognized is dropped and the field
  // keeps its safe default, so a mangled hash decodes to a usable state.
  function decodeState(hash) {
    const s = blank();
    if (typeof hash !== "string") return s;
    const body = hash.charAt(0) === "#" ? hash.slice(1) : hash;
    if (!body) return s;
    for (const pair of body.split("&")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const key = eq < 0 ? pair : pair.slice(0, eq);
      const rawVal = eq < 0 ? "" : pair.slice(eq + 1);
      let val;
      try { val = decodeURIComponent(rawVal); } catch (_) { val = rawVal; } // bad %-escape never throws
      switch (key) {
        case "n": if (val) s.n = val; break;
        case "sim": s.sim = val === "1" || val === "true"; break;
        case "poke": if (val) s.poke = val; break;
        case "tool":
          if (val === "oscilloscope") s.tool = "none"; // the card is implied by n=
          else if (TOOLS.indexOf(val) >= 0) s.tool = val;
          break;
        case "from": if (val) s.from = val; break;
        case "to": if (val) s.to = val; break;
        case "reach": {
          const n = parseInt(val, 10);
          if (n >= 1 && n <= 5) s.reachN = n;
          break;
        }
        case "circuit": if (val) s.circuit = val; break;
        // unknown keys: ignored on purpose
      }
    }
    return s;
  }

  // --- browser wiring (skipped entirely under Node) --------------------------

  if (typeof document !== "undefined") {
    let restoring = false;
    let lastHash = null;
    let syncTimer = null;

    // Read the live app + teach globals into a state object.
    function collect() {
      const s = blank();
      if (typeof selectedNeuron !== "undefined" && selectedNeuron) s.n = selectedNeuron.name;
      if (typeof simMode !== "undefined") s.sim = !!simMode;
      // In Simulate a selected neuron is always the one that was poked (clicks in
      // sim mode poke then select), so this needs no extra global.
      if (s.sim && s.n) s.poke = s.n;
      const t = typeof Teach !== "undefined" && Teach.toolState ? Teach.toolState() : null;
      if (t) {
        if (TOOLS.indexOf(t.tool) >= 0) s.tool = t.tool;
        if (t.from) s.from = t.from;
        if (t.to) s.to = t.to;
        if (t.reachN != null) s.reachN = t.reachN;
        if (t.circuit) s.circuit = t.circuit;
      }
      return s;
    }

    // Put a decoded state back by driving the existing functions. Wrapped so a
    // hand-mangled link can never break the page.
    function restore(s) {
      try {
        if (s.sim) setSimMode(true); // enters Simulate quiet; does NOT auto-run
        if (s.n) {
          const node = byId.get(s.n);
          if (node) setSelected(node.id);
        }
        // The one thing allowed to auto-run: a poked neuron.
        if (s.poke && simMode && sim) {
          const k = sim.net.index.get(s.poke);
          if (k !== undefined) {
            pokeAt(k);
            setSelected(s.poke);
          }
        }
        if (TOOLS.indexOf(s.tool) >= 0 && typeof Teach !== "undefined" && Teach.activateTool) {
          Teach.activateTool(s);
        }
      } catch (_) {
        // ignore: a bad shared link should leave a working default page
      }
    }

    // Write the current state into the hash with replaceState, so sharing does
    // not spam the back button. Only touches the URL when the hash changed.
    function sync() {
      const hash = encodeState(collect());
      if (hash === lastHash) return;
      lastHash = hash;
      history.replaceState(null, "", location.pathname + location.search + hash);
    }

    function scheduleSync() {
      if (restoring || syncTimer) return;
      syncTimer = setTimeout(() => { syncTimer = null; sync(); }, 300);
    }

    function flash(btn, msg) {
      if (!btn._label) btn._label = btn.textContent;
      btn.textContent = msg;
      clearTimeout(btn._t);
      btn._t = setTimeout(() => { btn.textContent = btn._label; }, 1200);
    }

    function copyLink(btn) {
      sync(); // make sure the URL reflects the current view first
      const url = location.href;
      const done = () => flash(btn, "link copied");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, () => legacyCopy(url) ? done() : flash(btn, "copy failed"));
      } else {
        legacyCopy(url) ? done() : flash(btn, "copy failed");
      }
    }

    function legacyCopy(text) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (_) {}
      document.body.removeChild(ta);
      return ok;
    }

    function boot() {
      restoring = true;
      restore(decodeState(location.hash));
      restoring = false;
      lastHash = encodeState(collect()); // canonicalize; drops any junk from the shared hash
      history.replaceState(null, "", location.pathname + location.search + lastHash);

      // Reflect on the interactions that change state. toggle does not bubble, so
      // listen on each tool panel directly; clicks and slider input cover the rest.
      document.addEventListener("click", scheduleSync);
      document.addEventListener("input", scheduleSync);
      for (const id of ["d-sandbox", "d-lesson", "d-trace", "d-reach"]) {
        const el = document.getElementById(id);
        if (el) el.addEventListener("toggle", scheduleSync);
      }

      const copyBtn = document.getElementById("copylink");
      if (copyBtn) copyBtn.addEventListener("click", () => copyLink(copyBtn));
    }

    // Wait until the data has loaded and the app globals exist, then restore once.
    (function waitForApp() {
      if (typeof sim !== "undefined" && sim && typeof byId !== "undefined" && byId.size > 0) boot();
      else setTimeout(waitForApp, 60);
    })();
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { encodeState, decodeState };
  else global.Permalink = { encodeState, decodeState };
})(typeof window !== "undefined" ? window : globalThis);
