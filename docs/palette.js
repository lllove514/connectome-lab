// Keyboard shortcuts and a small command palette. Additive and isolated: it only
// reads the app/teach globals and calls the existing functions (or clicks the
// existing buttons), so no mouse behavior changes. Loaded as a classic script
// after the others, so it shares their scope.
//
// Single keys (ignored while typing in any field):
//   space play/pause · s step · e Explore/Simulate · / search · g glossary
//   ? help · esc clear selection and close overlays
// Command palette: Cmd/Ctrl+K.

(function (global) {
  "use strict";

  const SHORTCUTS = [
    ["Space", "Play or pause the simulation"],
    ["s", "Step one tick"],
    ["e", "Switch between Explore and Simulate"],
    ["/", "Focus the neuron search box"],
    ["g", "Open the glossary"],
    ["?", "Show this help"],
    ["Esc", "Clear the selection and close overlays"],
    ["Cmd or Ctrl + K", "Open the command palette"],
  ];

  // --- small reused helpers (safe to define under Node; only touch the DOM when
  //     called, which only happens in the browser) -----------------------------

  function clickId(id) {
    const el = document.getElementById(id);
    if (el) el.click(); // reuse the wired button handler, including its disabled state
  }

  function openGlossary() {
    const el = document.getElementById("glossary");
    if (el) el.hidden = false;
  }

  // "Show the oscilloscope" means the plain voltage view, so close any teaching
  // tool that is hijacking the graph. Closing fires its own toggle handler, the
  // same as the user clicking the accordion shut.
  function showOscilloscope() {
    document.querySelectorAll("#teach-tools details[open]").forEach((d) => { d.open = false; });
  }

  function pokeNeuron(id) {
    if (typeof sim === "undefined" || !sim) return;
    const k = sim.net.index.get(id);
    if (k === undefined) return;
    if (!simMode) setSimMode(true); // poking lives in Simulate; enter it first
    pokeAt(k);
    setSelected(id);
  }

  // --- pure: the command registry and the neuron filter (self-checked) --------

  // The fixed actions. Data only: each is { id, label, run }, run wired to the
  // existing functions/buttons. Building this needs no DOM, so the self-check can
  // assert the registry is well formed.
  function buildCommands() {
    return [
      { id: "sim", label: "Toggle Explore and Simulate", run: () => clickId("simToggle") },
      { id: "play", label: "Play or pause the simulation", run: () => clickId("play") },
      { id: "step", label: "Step one tick", run: () => clickId("step") },
      { id: "oscilloscope", label: "Show the oscilloscope", run: showOscilloscope },
      { id: "lesson", label: "Open the touch reflex lesson", run: () => Teach.activateTool({ tool: "lesson" }) },
      { id: "trace", label: "Open trace a signal", run: () => Teach.activateTool({ tool: "trace" }) },
      { id: "reach", label: "Open how far a signal spreads", run: () => Teach.activateTool({ tool: "reach" }) },
      { id: "glossary", label: "Open the glossary", run: openGlossary },
      { id: "copy", label: "Copy the share link", run: () => clickId("copylink") },
    ];
  }

  // Filter the neuron list by a query: names that start with it first, then names
  // that merely contain it, capped at `limit`. Empty query returns nothing (the
  // palette shows actions instead of all 302 neurons).
  function filterNeurons(list, query, limit) {
    const q = (query || "").trim().toLowerCase();
    const cap = limit || 40;
    if (!q) return [];
    const starts = [];
    const contains = [];
    for (const n of list) {
      const name = n.name.toLowerCase();
      if (name.startsWith(q)) starts.push(n);
      else if (name.indexOf(q) >= 0) contains.push(n);
    }
    return starts.concat(contains).slice(0, cap);
  }

  // --- browser wiring (skipped under Node) ------------------------------------

  if (typeof document !== "undefined") {
    let commands = [];
    let paletteEl, boxEl, inputEl, listEl, helpEl;
    let paletteOpen = false;
    let lastFocus = null; // element to return focus to when an overlay closes
    let items = [];
    let active = 0;

    function isTyping(e) {
      const el = (e && e.target) || document.activeElement;
      if (!el) return false;
      return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
    }

    function focusSearch() {
      const s = document.getElementById("search");
      if (s) { s.focus(); s.select(); }
    }

    function restoreFocus() {
      if (lastFocus && lastFocus.focus) lastFocus.focus();
      lastFocus = null;
    }

    function openHelp() {
      if (!helpEl) return;
      lastFocus = document.activeElement;
      helpEl.hidden = false;
      const c = document.getElementById("help-close");
      if (c) c.focus(); // move focus into the dialog for keyboard users
    }

    function closeHelp() {
      if (!helpEl || helpEl.hidden) return;
      helpEl.hidden = true;
      restoreFocus();
    }

    function closeGlossary() {
      const gl = document.getElementById("glossary");
      if (!gl || gl.hidden) return false;
      gl.hidden = true;
      const gb = document.getElementById("glossaryBtn");
      if (gb) gb.setAttribute("aria-expanded", "false");
      return true;
    }

    // Escape closes whatever overlay is open, in a sensible order, then falls back
    // to clearing the selection.
    function onEscape() {
      if (paletteOpen) { closePalette(); return; }
      if (helpEl && !helpEl.hidden) { closeHelp(); return; }
      if (closeGlossary()) return;
      const st = document.getElementById("stats");
      if (st && !st.hidden) { st.hidden = true; return; }
      if (typeof setSelected === "function") setSelected(null); // clear selection + its ring
    }

    // --- palette ---

    function currentItems(query) {
      const q = query.trim().toLowerCase();
      const acts = q ? commands.filter((c) => c.label.toLowerCase().indexOf(q) >= 0) : commands.slice();
      const neurons = filterNeurons(nodes, q, 40).map((n) => ({
        id: "poke:" + n.id,
        label: "Poke " + n.name,
        hint: (TYPES[n.type] || TYPES.unknown).label,
        run: () => pokeNeuron(n.id),
      }));
      return acts.concat(neurons);
    }

    function render() {
      items = currentItems(inputEl.value);
      if (active >= items.length) active = items.length ? items.length - 1 : 0;
      listEl.innerHTML = "";
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "pal-empty";
        empty.textContent = "No matches.";
        listEl.appendChild(empty);
        inputEl.setAttribute("aria-activedescendant", "");
        return;
      }
      items.forEach((it, i) => {
        const row = document.createElement("div");
        row.className = "pal-item" + (i === active ? " active" : "");
        const label = document.createElement("span");
        label.className = "pal-label";
        label.textContent = it.label;
        row.appendChild(label);
        if (it.hint) {
          const hint = document.createElement("span");
          hint.className = "pal-hint";
          hint.textContent = it.hint;
          row.appendChild(hint);
        }
        row.id = "pal-opt-" + i;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", i === active ? "true" : "false");
        row.addEventListener("mousemove", () => { if (active !== i) { active = i; paint(); } });
        row.addEventListener("click", () => { active = i; runHighlighted(); });
        listEl.appendChild(row);
      });
      inputEl.setAttribute("aria-activedescendant", items.length ? "pal-opt-" + active : "");
    }

    function paint() {
      const rows = listEl.querySelectorAll(".pal-item");
      rows.forEach((r, i) => {
        const on = i === active;
        r.classList.toggle("active", on);
        r.setAttribute("aria-selected", on ? "true" : "false");
      });
      const cur = rows[active];
      if (cur) {
        cur.scrollIntoView({ block: "nearest" });
        inputEl.setAttribute("aria-activedescendant", cur.id);
      }
    }

    function move(d) {
      if (!items.length) return;
      active = (active + d + items.length) % items.length;
      paint();
    }

    function runHighlighted() {
      const it = items[active];
      if (!it) return;
      closePalette();
      try { it.run(); } catch (_) { /* a broken action should not break the page */ }
    }

    function openPalette() {
      paletteOpen = true;
      lastFocus = document.activeElement;
      paletteEl.hidden = false;
      inputEl.value = "";
      active = 0;
      render();
      inputEl.focus();
    }

    function closePalette() {
      paletteOpen = false;
      paletteEl.hidden = true;
      inputEl.setAttribute("aria-activedescendant", "");
      restoreFocus();
    }

    function buildPalette() {
      paletteEl = document.createElement("div");
      paletteEl.id = "palette";
      paletteEl.hidden = true;
      paletteEl.setAttribute("role", "dialog");
      paletteEl.setAttribute("aria-modal", "true");
      paletteEl.setAttribute("aria-label", "Command palette");
      paletteEl.innerHTML =
        '<div id="palette-box">' +
        '<input id="palette-input" type="text" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" aria-label="Type a command or a neuron name" autocomplete="off" spellcheck="false" placeholder="type a command or a neuron name">' +
        '<div id="palette-list" role="listbox" aria-label="Commands and neurons"></div>' +
        "</div>";
      document.body.appendChild(paletteEl);
      boxEl = document.getElementById("palette-box");
      inputEl = document.getElementById("palette-input");
      listEl = document.getElementById("palette-list");
      inputEl.addEventListener("input", () => { active = 0; render(); });
      // Click the dim backdrop (outside the box) to close.
      paletteEl.addEventListener("mousedown", (e) => { if (!boxEl.contains(e.target)) closePalette(); });
    }

    function buildHelp() {
      helpEl = document.createElement("div");
      helpEl.id = "help";
      helpEl.hidden = true;
      helpEl.setAttribute("role", "dialog");
      helpEl.setAttribute("aria-modal", "true");
      helpEl.setAttribute("aria-label", "Keyboard shortcuts");
      let dl = "";
      for (const [key, desc] of SHORTCUTS) dl += "<dt>" + key + "</dt><dd>" + desc + "</dd>";
      helpEl.innerHTML =
        '<div id="help-box"><h3>Keyboard shortcuts</h3><dl>' + dl + "</dl>" +
        '<button id="help-close" type="button">close</button></div>';
      document.body.appendChild(helpEl);
      document.getElementById("help-close").addEventListener("click", closeHelp);
      helpEl.addEventListener("mousedown", (e) => { if (e.target === helpEl) closeHelp(); });
    }

    function onKeydown(e) {
      // Cmd/Ctrl+K toggles the palette from anywhere.
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        paletteOpen ? closePalette() : openPalette();
        return;
      }
      if (paletteOpen) {
        if (e.key === "Escape") { e.preventDefault(); closePalette(); }
        else if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
        else if (e.key === "Enter") { e.preventDefault(); runHighlighted(); }
        return; // other keys type into the palette input
      }
      if (e.key === "Escape") { onEscape(); return; } // works even from a focused field
      if (isTyping(e)) return; // ignore single keys while typing in search/tutor/etc.
      if (e.metaKey || e.ctrlKey || e.altKey) return; // leave other chords alone

      switch (e.key) {
        case " ": e.preventDefault(); clickId("play"); break;
        case "s": case "S": clickId("step"); break;
        case "e": case "E": clickId("simToggle"); break;
        case "/": e.preventDefault(); focusSearch(); break;
        case "g": case "G": openGlossary(); break;
        case "?": e.preventDefault(); openHelp(); break;
      }
    }

    function init() {
      commands = buildCommands();
      buildPalette();
      buildHelp();
      window.addEventListener("keydown", onKeydown);
      const sc = document.getElementById("shortcutsBtn");
      if (sc) sc.addEventListener("click", openHelp);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { buildCommands, filterNeurons };
  else global.Palette = { buildCommands, filterNeurons };
})(typeof window !== "undefined" ? window : globalThis);
