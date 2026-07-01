// Node self-check for the teaching layer's graph code. Reuses sim.js (no
// duplicated math), loads connectome.json + circuits.json, and asserts the
// directed-BFS path, the N-hop reach, the reflex circuit's ids, and that the
// command interneurons really are wiring hubs.
//
//   node web/teach_selfcheck.js
//
// Exits 0 on PASS, 1 on FAIL. Fixtures are verified against the committed data:
// ALML -> AVAL is reachable; CANL has zero chemical in-degree (unreachable).

const fs = require("fs");
const path = require("path");
const Sim = require("./sim.js");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "connectome.json"), "utf8"));
const circuits = JSON.parse(fs.readFileSync(path.join(__dirname, "circuits.json"), "utf8"));
const net = Sim.buildNetwork(data);
const idx = (id) => net.index.get(id);

// Every consecutive pair in a returned path must be a real chemical synapse.
function edgesValid(p) {
  for (let j = 0; j + 1 < p.length; j++) {
    const out = net.chemOut[p[j]];
    let found = false;
    for (let k = 0; k < out.length; k += 2) if (out[k] === p[j + 1]) { found = true; break; }
    if (!found) return false;
  }
  return true;
}

// Total degree (chemical in + out + gap) inline — one caller, no Sim.degrees.
function totalDegrees() {
  const deg = new Array(net.n).fill(0);
  for (let u = 0; u < net.n; u++) {
    deg[u] += net.chemOut[u].length / 2; // out
    deg[u] += net.gapAdj[u].length / 2; // gap (symmetric, counted once per node)
    const out = net.chemOut[u];
    for (let k = 0; k < out.length; k += 2) deg[out[k]] += 1; // in
  }
  return deg;
}

// --- fixtures ---
const SRC = "ALML";
const TGT_OK = "AVAL";
const TGT_NONE = "CANL";
const COMMAND = ["AVAL", "AVAR", "AVBL", "AVBR", "AVDL", "AVDR", "PVCL", "PVCR"];

const pathOk = Sim.bfsPath(net, idx(SRC), idx(TGT_OK));
const pathNone = Sim.bfsPath(net, idx(SRC), idx(TGT_NONE));
const selfPath = Sim.bfsPath(net, idx(SRC), idx(SRC));

const reachCounts = [];
for (let n = 1; n <= 5; n++) {
  const dist = Sim.reach(net, idx(SRC), n);
  let c = 0;
  for (let k = 0; k < net.n; k++) if (dist[k] > 0) c++;
  reachCounts.push(c);
}
const monotonic = reachCounts.every((c, i) => i === 0 || c >= reachCounts[i - 1]);

// circuit ids resolve
const missing = [];
for (const cid in circuits) {
  for (const id of circuits[cid].neurons) if (idx(id) === undefined) missing.push(cid + ":" + id);
}

// command hubs among the highest-degree neurons
const deg = totalDegrees();
const order = Array.from({ length: net.n }, (_, i) => i).sort((a, b) => deg[b] - deg[a]);
const rankOf = {};
order.forEach((nodeIdx, rank) => { rankOf[data.nodes[nodeIdx].id] = rank + 1; });
const commandRanks = COMMAND.map((id) => rankOf[id]);
const commandTop15 = commandRanks.every((r) => r <= 15);

console.log("teach self-check — " + net.n + " neurons");
console.log("  bfsPath " + SRC + "->" + TGT_OK + " : " +
  (pathOk ? pathOk.map((k) => data.nodes[k].id).join(" -> ") + "  (" + (pathOk.length - 1) + " synapses)" : "null"));
console.log("  bfsPath " + SRC + "->" + TGT_NONE + " : " + (pathNone === null ? "null (unreachable, correct)" : "UNEXPECTED PATH"));
console.log("  N-hop reach counts (N=1..5) : " + reachCounts.join(", "));
console.log("  circuit ids missing          : " + (missing.length ? missing.join(", ") : "none"));
console.log("  command-hub ranks            : " + COMMAND.map((id, i) => id + "#" + commandRanks[i]).join(" "));

const checks = [
  { name: "bfsPath finds a real directed path for a connected pair", ok: Array.isArray(pathOk) && pathOk.length >= 2 && pathOk[0] === idx(SRC) && pathOk[pathOk.length - 1] === idx(TGT_OK) && edgesValid(pathOk) },
  { name: "bfsPath returns null for an unreachable target (CANL)", ok: pathNone === null },
  { name: "bfsPath of a node to itself is [self]", ok: Array.isArray(selfPath) && selfPath.length === 1 && selfPath[0] === idx(SRC) },
  { name: "N-hop reach grows monotonically and expands (count[1] < count[5])", ok: monotonic && reachCounts[0] < reachCounts[4] },
  { name: "every reflex-circuit id resolves to a real node", ok: missing.length === 0 },
  { name: "every command interneuron ranks in the top 15 by total degree", ok: commandTop15 },
];

let ok = true;
for (const c of checks) {
  console.log("  [" + (c.ok ? "PASS" : "FAIL") + "] " + c.name);
  ok = ok && c.ok;
}
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
