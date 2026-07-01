<h1 align="center">CONNECTOME LAB</h1>

<p align="center">
  <a href="https://lllove514.github.io/connectome-lab/"><img alt="Live demo" src="https://img.shields.io/badge/Live%20Demo-ffb454?style=for-the-badge&labelColor=0a0c10"></a>
  <img alt="Vanilla JS" src="https://img.shields.io/badge/Vanilla%20JS-4aa3ff?style=for-the-badge&labelColor=0a0c10">
  <img alt="No build step" src="https://img.shields.io/badge/No%20build%20step-ff6b8a?style=for-the-badge&labelColor=0a0c10">
  <img alt="License MIT" src="https://img.shields.io/badge/License-MIT-ffb454?style=for-the-badge&labelColor=0a0c10">
</p>

**Connectome Lab** is an interactive map of the C. elegans connectome, the whole 302-neuron nervous system of a worm, that you can poke and watch fire in the browser.

<p align="center"><img src="./doc/demo.gif" alt="demo" width="720"></p>

### What it is

The C. elegans nervous system is the only one that's been mapped cell by cell, every neuron and every wire. That's 302 neurons and a few thousand synapses, small enough to hold in your head and still do something. I wanted to see it move, not as a static diagram, so I built this.

You get the real wiring from Cook et al. 2019 laid out on a canvas. Click a neuron and it dumps current in, then a simple spiking model pushes the signal through the actual synapses and you watch the wave spread and die out. There's a teaching rail on the side that explains what you're looking at, and a tutor you can ask.

No framework, no build step. It's plain JavaScript drawing to a canvas.

### Features

- interactive graph of all 302 neurons, colored by type, with the real chemical synapses and gap junctions
- leaky integrate-and-fire simulation running on those synapses, poke a neuron and watch it propagate then settle
- teaching rail: an oscilloscope of the selected neuron's membrane voltage, step mode, a sandbox to tune threshold/gain/leak, a guided touch-reflex lesson, signal tracing (shortest path), N-hop reach, and a glossary
- context-aware AI tutor that reads whichever neuron you've selected and the live sim state, so "why did this fire" means something

### Try it

Live: https://lllove514.github.io/connectome-lab/

Two ways to use it:

- just open the link. the graph, the simulation, and the teaching tools all run client-side, nothing to install.
- want the tutor? it needs a DeepSeek key. paste your own into the tutor panel, it stays in memory and is never saved. or clone the repo and run it with your key.

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

A Python script (`data/build_connectome.py`) pulls the Cook et al. connectome, keeps the neurons, splits chemical wiring from gap junctions, tags each cell sensory/inter/motor, runs a force-directed layout, and writes `docs/connectome.json`. That's the only build step and it's already run, the JSON is committed.

The front end is vanilla JS and Canvas 2D. One file holds the LIF simulation and the graph math, including one shared data-to-screen transform so a click always lands on the neuron under the cursor. The others do rendering and interaction, the teaching layer, and the tutor. The simulation and the path/reach analysis all run in the browser.

The tutor sends an OpenAI-shaped request to DeepSeek. On the live site it routes through a small Cloudflare Worker (`proxy/`) that holds the key server-side, so nothing to paste. Run it locally and it talks to DeepSeek directly with your own key, kept in memory.

### Tips

- click a neuron to select it. in Simulate mode a click also pokes it and kicks off a wave.
- hit Simulate, then Play or Step. Step advances one tick at a time so you can watch the signal move cell to cell from the start.
- the rail on the right has the oscilloscope, the sandbox sliders, the lesson, trace, and reach. the ? button opens the glossary.
- ask the tutor about the selected neuron. "what does this do", "why did it fire", "what does it connect to" all resolve to whatever you've got selected.

### Data & credits

Connectome data from Cook et al., "Whole-animal connectomes of both Caenorhabditis elegans sexes," Nature 571, 63-71 (2019). Owned and published by the Emmons Lab at the Albert Einstein College of Medicine, via WormWiring. Circuit memberships and the glossary come from WormAtlas.

There's no explicit open-data license on the source, so the data is used here under academic citation, for non-commercial educational use. For anything beyond that, ask the Emmons Lab. Full attribution is in `DATA.md`.

### License

MIT, for the code. It doesn't cover the connectome data, see above.
