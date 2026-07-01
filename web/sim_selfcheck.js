// Node self-check for the LIF core and the shared transform. Reuses sim.js — no
// duplicated math — and is written to FAIL on the regressions we hit: runaway
// saturation, a plateau instead of a decaying wave, a silent network that
// spontaneously fires, non-determinism, NaNs, pokes that fizzle to one dot, and
// the letterbox coordinate bug where fringe clicks missed on a non-square canvas.
//
//   node web/sim_selfcheck.js
//
// Exits 0 on PASS, 1 on FAIL.

const fs = require("fs");
const path = require("path");
const Sim = require("./sim.js");

const TICKS = 250;
const p = Sim.DEFAULTS;

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "connectome.json"), "utf8"));
const net = Sim.buildNetwork(data);
const nodes = data.nodes;

// --- Dynamics ----------------------------------------------------------------

function run(seedIndex) {
  const state = Sim.createState(net.n);
  if (seedIndex >= 0) Sim.poke(state, seedIndex, p.poke);
  const counts = [];
  let badValue = false;
  for (let t = 0; t < TICKS; t++) {
    Sim.step(net, state, p);
    let fired = 0;
    for (let i = 0; i < net.n; i++) {
      if (state.fired[i]) fired++;
      if (!Number.isFinite(state.v[i])) badValue = true;
    }
    counts.push(fired);
  }
  const peak = Math.max(...counts);
  const tail = counts.slice(-40);
  const tailAvg = tail.reduce((a, b) => a + b, 0) / tail.length;
  return { counts, peak, peakTick: counts.indexOf(peak), tailAvg, badValue };
}

let seed = net.index.get("ALML");
if (seed === undefined) seed = nodes.findIndex((nd) => nd.type === "sensory");

const poked = run(seed);
const quiet = run(-1);
const repeat = run(seed);

const peakFrac = poked.peak / net.n;
const tailFrac = poked.tailAvg / net.n;
const quietTotal = quiet.counts.reduce((a, b) => a + b, 0);
const deterministic = poked.counts.every((c, i) => c === repeat.counts[i]);

const SEEDS = ["ALML", "ASHL", "AWCL", "AFDL", "ADLL", "ADFL"];
const ignition = SEEDS.map((id) => {
  const idx = net.index.get(id);
  if (idx === undefined) return { id, ok: false, peak: 0 };
  const r = run(idx);
  return { id, peak: r.peak, ok: r.peak >= 10 && r.peak >= 5 * (r.tailAvg || 0.0001) };
});
const ignited = ignition.filter((s) => s.ok).length;

// --- Transform round-trip: EVERY node at MULTIPLE canvas sizes ----------------
//
// For each node: forward-transform its data position to the screen, run the real
// hit-test on that screen point, and require it returns that same node; also
// require toData inverts toScreen. The letterbox bug only showed on non-square
// canvases, so we include a wide one and a tall one, plus the extreme outlier.

const SIZES = [[1600, 900], [1600, 600], [600, 1000]];
const outlier = nodes.reduce((a, b) => (b.x + b.y < a.x + a.y ? b : a)); // top-left-most
const roundTrip = SIZES.map(([w, h]) => {
  const t = Sim.makeTransform(nodes, w, h);
  let hitFail = 0;
  let invFail = 0;
  let outlierOk = false;
  for (let i = 0; i < nodes.length; i++) {
    const s = Sim.toScreen(t, nodes[i].x, nodes[i].y);
    if (Sim.pickNearest(t, nodes, s.x, s.y, 14) !== i) hitFail++;
    const d = Sim.toData(t, s.x, s.y);
    if (Math.abs(d.x - nodes[i].x) > 1e-9 || Math.abs(d.y - nodes[i].y) > 1e-9) invFail++;
    if (nodes[i] === outlier) {
      outlierOk = Sim.pickNearest(t, nodes, s.x, s.y, 14) === i;
    }
  }
  return { w, h, hitFail, invFail, outlierOk, total: nodes.length };
});
const allRoundTrip = roundTrip.every((r) => r.hitFail === 0 && r.invFail === 0 && r.outlierOk);

// --- Report ------------------------------------------------------------------

const seedName = nodes[seed].id;
console.log(`LIF self-check — poked ${seedName}, ${TICKS} ticks over ${net.n} neurons`);
console.log(`  peak firing        : ${poked.peak} neurons (${(peakFrac * 100).toFixed(1)}%) at tick ${poked.peakTick}`);
console.log(`  steady-state firing: ${tailFrac === 0 ? "0" : (tailFrac * 100).toFixed(2) + "%"} (mean of last 40 ticks)`);
console.log(`  quiet-in spikes    : ${quietTotal}`);
console.log(`  deterministic      : ${deterministic}`);
console.log(`  finite potentials  : ${poked.badValue ? "no — NaN/Infinity" : "yes"}`);
console.log(`  ignition           : ${ignited}/${SEEDS.length} seeds -> ${ignition.map((s) => s.id + "(" + s.peak + ")").join(" ")}`);
console.log(`  outlier node       : ${outlier.id} at data (${outlier.x.toFixed(3)}, ${outlier.y.toFixed(3)})`);
console.log(`  round-trip (all ${nodes.length} nodes):`);
for (const r of roundTrip) {
  console.log(
    `    ${r.w}x${r.h}: ${r.total - r.hitFail}/${r.total} hit self, inverse-fail ${r.invFail}, outlier ${r.outlierOk ? "ok" : "MISS"}`
  );
}
console.log(`  wave (first 24)    : ${poked.counts.slice(0, 24).join(" ")}`);

const checks = [
  { name: "wave rises then falls (peak >> steady state, peak not at t0)", ok: poked.peak >= 10 && poked.peakTick >= 3 && poked.peak >= 5 * poked.tailAvg },
  { name: "no runaway saturation (steady-state firing < 5%)", ok: tailFrac < 0.05 },
  { name: "quiet in -> quiet out (no poke, no seed => no spikes)", ok: quietTotal === 0 },
  { name: "deterministic across two identical runs", ok: deterministic },
  { name: "no NaN/Infinity in membrane potentials", ok: !poked.badValue },
  { name: "every tested sensory seed ignites a wave (not one dot)", ok: ignited === SEEDS.length },
  { name: "every node round-trips to itself at all canvas sizes (incl. wide/tall/outlier)", ok: allRoundTrip },
];

let ok = true;
for (const c of checks) {
  console.log(`  [${c.ok ? "PASS" : "FAIL"}] ${c.name}`);
  ok = ok && c.ok;
}

console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
