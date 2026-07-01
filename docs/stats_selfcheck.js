// Cross-checks the shared computeStats against an independent recomputation of
// the same numbers from connectome.json, and confirms the top hubs include the
// command interneurons.
//
//   node docs/stats_selfcheck.js
//
// Exits 0 on PASS, 1 on FAIL.

const fs = require("fs");
const path = require("path");
const { computeStats } = require("./stats.js");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "connectome.json"), "utf8"));
const s = computeStats(data);

// --- independent recomputation (deliberately different style) -----------------

const n = data.nodes.length;
const typeCount = { sensory: 0, inter: 0, motor: 0, unknown: 0 };
const deg = {};
for (const nd of data.nodes) {
  typeCount[typeCount.hasOwnProperty(nd.type) ? nd.type : "unknown"] += 1;
  deg[nd.id] = 0;
}
for (const e of data.chemical) {
  if (e.source in deg) deg[e.source] += 1;
  if (e.target in deg) deg[e.target] += 1;
}
for (const e of data.gap) {
  if (e.source in deg) deg[e.source] += 1;
  if (e.target in deg) deg[e.target] += 1;
}
const totalDeg = Object.values(deg).reduce((a, b) => a + b, 0);
const meanIndep = totalDeg / n;
const hubsIndep = Object.keys(deg)
  .map((id) => ({ id: id, degree: deg[id] }))
  .sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  .slice(0, 8);

// --- assertions ---------------------------------------------------------------

let ok = true;
function check(name, pass, extra) {
  if (!pass) ok = false;
  console.log((pass ? "ok   " : "FAIL ") + name + (extra ? "  " + extra : ""));
}

check("total neurons match", s.total === n, s.total + " vs " + n);
check("type counts match",
  s.types.sensory === typeCount.sensory && s.types.inter === typeCount.inter &&
  s.types.motor === typeCount.motor && s.types.unknown === typeCount.unknown,
  JSON.stringify(s.types));
check("type counts sum to total", s.types.sensory + s.types.inter + s.types.motor + s.types.unknown === n);
check("chemical synapse count matches", s.chem === data.chemical.length, String(s.chem));
check("gap junction count matches", s.gap === data.gap.length, String(s.gap));
check("mean connections match", Math.abs(s.mean - meanIndep) < 1e-9, s.mean.toFixed(3));

const hubsMatch = s.hubs.length === hubsIndep.length &&
  s.hubs.every((h, i) => h.id === hubsIndep[i].id && h.degree === hubsIndep[i].degree);
check("top 8 hubs match (id and degree, in order)", hubsMatch,
  s.hubs.map((h) => h.id + ":" + h.degree).join(" "));

const COMMAND = ["AVAL", "AVAR", "AVBL", "AVBR", "PVCL", "PVCR"];
const hubIds = s.hubs.map((h) => h.id);
const foundCommand = COMMAND.filter((id) => hubIds.indexOf(id) >= 0);
check("hubs include command interneurons", foundCommand.length > 0, "found " + foundCommand.join(", "));

const histSum = s.hist.bins.reduce((a, b) => a + b, 0);
check("histogram bins cover every neuron", histSum === n, histSum + " vs " + n);

console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
