// Round-trips several states through encodeState -> decodeState and asserts they
// come back unchanged, including an empty state and malformed hashes that must
// decode to a safe default without throwing.
//
//   node docs/permalink_selfcheck.js
//
// Exits 0 on PASS, 1 on FAIL.

const assert = require("assert");
const { encodeState, decodeState } = require("./permalink.js");

function state(o) {
  return Object.assign(
    { n: null, sim: false, poke: null, tool: "none", from: null, to: null, reachN: null, circuit: null },
    o
  );
}

let ok = true;
function report(name, pass, extra) {
  if (!pass) ok = false;
  console.log((pass ? "ok   " : "FAIL ") + name + (extra ? "  " + extra : ""));
}

// --- round-trip: encode then decode must equal the original ------------------

const cases = [
  ["empty", state({})],
  ["selected only", state({ n: "AVAL" })],
  ["explore selection", state({ n: "PVCL" })],
  ["sim + poke", state({ n: "AVAL", sim: true, poke: "AVAL" })],
  ["trace", state({ n: "ALML", tool: "trace", from: "ALML", to: "VA01" })],
  ["reach", state({ n: "AVAL", tool: "reach", reachN: 3 })],
  ["lesson", state({ sim: true, tool: "lesson", circuit: "touch_reflex" })],
];

for (const [name, st] of cases) {
  const hash = encodeState(st);
  let back;
  try {
    back = decodeState(hash);
    assert.deepStrictEqual(back, st);
    report(name, true, hash || "(empty)");
  } catch (e) {
    report(name, false, "encoded=" + hash + " got=" + JSON.stringify(back));
  }
}

// --- malformed input: must never throw, must give a safe default -------------

const junk = [
  "#n=%E0%A4%A", // truncated percent-escape
  "#=&%&&reach=&tool=", // empty keys and values
  "not even a hash",
  "#reach=99&sim=maybe&tool=bogus&stray", // out-of-range, unknown values and keys
  "#%%%%",
  "",
  null,
  undefined,
];

for (const h of junk) {
  let r;
  try {
    r = decodeState(h);
  } catch (e) {
    report("malformed " + JSON.stringify(h), false, "threw: " + e.message);
    continue;
  }
  const shapeOk = r && typeof r === "object" && r.tool === "none" && r.sim === false && r.reachN === null;
  report("malformed " + JSON.stringify(h), shapeOk);
}

// pure garbage should decode to exactly the empty default
try {
  assert.deepStrictEqual(decodeState("#=&%&&reach=&tool="), state({}));
  report("garbage decodes to default", true);
} catch (e) {
  report("garbage decodes to default", false, e.message);
}

console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
