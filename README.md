<h1 align="center">CONNECTOME LAB</h1>

<p align="center">
  <a href="https://lllove514.github.io/connectome-lab/"><img alt="Live demo" src="https://img.shields.io/badge/Live%20Demo-ffb454?style=for-the-badge&labelColor=0a0c10"></a>
  <img alt="Vanilla JS" src="https://img.shields.io/badge/Vanilla%20JS-4aa3ff?style=for-the-badge&labelColor=0a0c10">
  <img alt="No build step" src="https://img.shields.io/badge/No%20build%20step-ff6b8a?style=for-the-badge&labelColor=0a0c10">
  <a href="./LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/License-MIT-ffb454?style=for-the-badge&labelColor=0a0c10"></a>
</p>

**Connectome Lab** puts the entire C. elegans connectome, the 302-neuron nervous system of a worm, in your browser. Click a neuron and watch it fire.

<p align="center"><img src="./doc/demo.gif" alt="demo" width="720"></p>
<img width="2594" height="1476" alt="connectome-02-poke" src="https://github.com/user-attachments/assets/1ecfb615-5c75-4cd9-8050-9ace782aafd1" />

<img width="1470" height="800" alt="Screenshot 2026-07-01 at 8 26 58 AM" src="https://github.com/user-attachments/assets/f17988c2-9a4b-4837-a6fc-b2b0c08e7d31" />

### What it is

C. elegans is the only animal we've mapped neuron by neuron. All 302 of them, plus every
connection between them, sitting in a public dataset. I'd read about it for a while and wanted
to poke at the actual thing instead of looking at diagrams, so I put the real wiring in the
browser and made it run.

Click a neuron and it fires. The signal travels through the real synapses from the 2019 dataset
using a leaky integrate-and-fire model, and you can watch it spread and fade. Getting that to
look right took me longer than the rest of it. Too much current and the whole worm lights up and
stays on. Too little and it dies at the first cell. There's a panel on the side that explains
what's happening while it happens, and a tutor you can ask about the neuron you clicked.

It's vanilla JS and an HTML canvas. No React, no build step, nothing to install.

### Features

- The full graph of all 302 neurons, colored by type, with the real chemical synapses and gap
  junctions.
- A leaky integrate-and-fire simulation on those synapses. Poke a neuron and watch it spread and
  settle.
- A teaching panel with an oscilloscope of the selected neuron's voltage, a step button, sliders
  for threshold, gain, and leak, guided walkthroughs of a few circuits (the gentle touch reflex,
  tap withdrawal, chemotaxis, and egg laying), signal tracing between two neurons, an N-hop reach
  view, and a glossary.
- A Compare mode that puts the real connectome next to a randomly-wired network of the same size,
  running the same model on both. The random network has the same 302 neurons, the same number of
  connections, and the same connection strengths, just wired to random partners. Poke a neuron and
  you poke the same one on both sides, then watch a readout of how far and how hard the signal
  spreads through each. Same poke, same model, different wiring, different behavior.
- A tutor that knows which neuron you've selected and what the sim is doing, so a question like
  "why did this one fire" gets answered about that specific neuron.
- A muscle layer you can turn on. It draws the 95 body-wall muscles and the motor neuron
  connections to them, lights the muscles when their motor neurons fire, and shows how much dorsal
  versus ventral muscle is active.
- Keyboard shortcuts and a command palette (Cmd or Ctrl K) for finding a neuron or a tool without
  the mouse.
- Shareable links. The URL keeps track of what you've selected and which tool is open, so a copied
  link reopens the same view.
- A record button that captures a poke as a looping GIF and saves it.
- A network stats panel with the neuron and connection counts, the average connections per neuron,
  the top hub neurons, and a small degree histogram.

### Try it

Live: https://lllove514.github.io/connectome-lab/

Two ways to run it:

- Open the link. The graph, the sim, and the teaching tools run in your browser. The tutor works
  too, using my key through a proxy, so you don't need one.
- Clone the repo and run it yourself. For the tutor you paste your own DeepSeek key into the
  panel, and it stays in memory.

### Run it locally

```
git clone https://github.com/lllove514/connectome-lab.git
cd connectome-lab

# optional: rebuild the data from source.
# the committed docs/connectome.json is already built, so you can skip this.
python3 -m venv .venv && source .venv/bin/activate
pip install requests
python data/build_connectome.py

# serve the site
python -m http.server 8000 --directory docs
```

Then open http://localhost:8000.

To keep a local tutor key without pasting it every refresh, drop a `docs/config.local.js` with `window.LOCAL_DEEPSEEK_KEY = "sk-..."`. It's gitignored and only loaded on localhost.

### How it works

A Python script (`data/build_connectome.py`) pulls the Cook et al. connectome, keeps the neurons, splits chemical wiring from gap junctions, tags each cell sensory/inter/motor, pulls out the body-wall muscles and the motor neuron connections to them, runs a force-directed layout, and writes `docs/connectome.json`. That's the only build step and it's already run, the JSON is committed.

The front end is vanilla JS and Canvas 2D. One file holds the LIF simulation and the graph math, including one shared data-to-screen transform so a click always lands on the neuron under the cursor. The others do rendering and interaction, the teaching layer, the tutor, and the smaller tools like permalinks, the command palette, the stats panel, the muscle layer, and GIF export. The simulation and the path/reach analysis all run in the browser.

The tutor sends an OpenAI-shaped request to DeepSeek. On the live site it routes through a small Cloudflare Worker (`proxy/`) that holds the key server-side, so nothing to paste. Run it locally and it talks to DeepSeek directly with your own key, kept in memory.

### Tips

- click a neuron to select it. in Simulate mode a click also pokes it and kicks off a wave.
- hit Simulate, then Play or Step. Step advances one tick at a time so you can watch the signal move cell to cell from the start.
- the rail on the right has the oscilloscope, the sandbox sliders, the lessons, trace, and reach. the ? button opens the glossary.
- ask the tutor about the selected neuron. "what does this do", "why did it fire", "what does it connect to" all resolve to whatever you've got selected.
- turn on show muscles to watch the body-wall muscles light up when their motor neurons fire.
- press ? for the keyboard shortcuts, or Cmd or Ctrl K for the command palette. copy link grabs a link to the exact view you're on.

### Data & credits

Connectome data from Cook et al., "Whole-animal connectomes of both Caenorhabditis elegans sexes," Nature 571, 63-71 (2019). Owned and published by the Emmons Lab at the Albert Einstein College of Medicine, via WormWiring. Circuit memberships and the glossary come from WormAtlas.

There's no explicit open-data license on the source, so the data is used here under academic citation, for non-commercial educational use. For anything beyond that, ask the Emmons Lab. Full attribution is in `DATA.md`.

### License

MIT, for the code. See [`LICENSE`](./LICENSE). It doesn't cover the connectome data, see above.
