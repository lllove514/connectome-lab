// Self-check for the two pieces of chat.js that are easy to get wrong: parsing
// the streaming SSE lines and deciding when a question leans on the selection.
// Run: node docs/chat_selfcheck.js  (exits nonzero on any failure)

const { sseDelta, refersToSelection, mdToHtml } = require("./chat.js");

const checks = [];
const check = (name, cond) => checks.push([name, !!cond]);

// SSE frame parsing
check("sse extracts content", sseDelta('data: {"choices":[{"delta":{"content":"Hi"}}]}').text === "Hi");
check("sse marks done", sseDelta("data: [DONE]").done === true);
check("sse ignores comment lines", sseDelta(": keep-alive").text === "" && sseDelta(": keep-alive").done === false);
check("sse tolerates a half frame", sseDelta('data: {"choices":[{"delta"').text === "");
check("sse empty delta is empty", sseDelta('data: {"choices":[{"delta":{}}]}').text === "");

// reference detection: pronouns resolve to the selection, plain questions do not
check("this refers", refersToSelection("What does this neuron do?"));
check("it refers", refersToSelection("why did it fire"));
check("clicking refers", refersToSelection("what am I clicking on"));
check("is this a hub refers", refersToSelection("is this a hub"));
check("gap junction is general", refersToSelection("What is a gap junction?") === false);
check("interneuron does not falsely match it", refersToSelection("what is an interneuron") === false);

// markdown rendering: bold/italic/code become tags, and html is escaped first
check("md bold", mdToHtml("**AWCL is sensory**") === "<strong>AWCL is sensory</strong>");
check("md italic", mdToHtml("a *nose* cell") === "a <em>nose</em> cell");
check("md code", mdToHtml("the `IL2VR` cell") === "the <code>IL2VR</code> cell");
check("md escapes html", mdToHtml("a < b & c").indexOf("&lt; b &amp;") >= 0);
check("md leaves bare asterisk", mdToHtml("3 * 4 = 12").indexOf("<em>") === -1);

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log((ok ? "ok   " : "FAIL ") + name);
if (failed.length) {
  console.error(failed.length + " check(s) failed");
  process.exit(1);
}
console.log("PASS " + checks.length + " checks");
