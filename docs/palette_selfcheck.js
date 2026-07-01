// Checks the command palette's data layer: the command registry is well formed
// (every command has an id, a label, and a callable action) and the neuron
// filter narrows the real 302-neuron list correctly.
//
//   node docs/palette_selfcheck.js
//
// Exits 0 on PASS, 1 on FAIL.

const fs = require("fs");
const path = require("path");
const { buildCommands, filterNeurons } = require("./palette.js");

const nodes = JSON.parse(fs.readFileSync(path.join(__dirname, "connectome.json"), "utf8")).nodes;

let ok = true;
function check(name, pass, extra) {
  if (!pass) ok = false;
  console.log((pass ? "ok   " : "FAIL ") + name + (extra ? "  " + extra : ""));
}

// --- command registry --------------------------------------------------------

const cmds = buildCommands();
check("registry is a non-empty array", Array.isArray(cmds) && cmds.length > 0, cmds.length + " commands");

let wellFormed = true;
const ids = new Set();
for (const c of cmds) {
  if (!c || typeof c.id !== "string" || !c.id) wellFormed = false;
  if (!c || typeof c.label !== "string" || !c.label.trim()) wellFormed = false;
  if (!c || typeof c.run !== "function") wellFormed = false;
  if (c && c.id) ids.add(c.id);
}
check("every command has id, non-empty label, callable run", wellFormed);
check("command ids are unique", ids.size === cmds.length);

const need = ["sim", "play", "step", "lesson", "trace", "reach", "glossary", "copy"];
check("registry covers the expected actions", need.every((id) => ids.has(id)),
  "missing: " + need.filter((id) => !ids.has(id)).join(", "));

// --- neuron filter -----------------------------------------------------------

check("empty query returns nothing", filterNeurons(nodes, "", 40).length === 0);
check("whitespace query returns nothing", filterNeurons(nodes, "   ", 40).length === 0);

const aval = filterNeurons(nodes, "AVAL", 40);
check("exact name is found", aval.some((n) => n.name === "AVAL"), aval.map((n) => n.name).join(","));

const av = filterNeurons(nodes, "AV", 40);
check("all results match the query", av.every((n) => n.name.toLowerCase().indexOf("av") >= 0));
check("prefix matches come first", av.length > 0 && av[0].name.toLowerCase().startsWith("av"));

check("filter is case-insensitive", filterNeurons(nodes, "aval", 40).length === filterNeurons(nodes, "AVAL", 40).length);
check("limit is respected", filterNeurons(nodes, "a", 5).length <= 5);
check("no-match query returns empty", filterNeurons(nodes, "zzzzz", 40).length === 0);

// substring-only match (not a prefix) still shows up
const sub = filterNeurons(nodes, "01", 400);
check("substring matches are included", sub.length > 0 && sub.every((n) => n.name.indexOf("01") >= 0));

console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
