// Run: node --test test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Pure logic duplicated from extensions/loop-police.ts — no build step
const MIN_THINKING_WINDOW = 80;
const MAX_THINKING_WINDOW = 2000;
const PARA_MIN_LEN = 40;
const PARA_FINGERPRINT_LEN = 60;
const PARA_LOOP_THRESHOLD = 3;

function detectRepeatingSuffix(text) {
  const n = text.length;
  const limit = Math.min(MAX_THINKING_WINDOW, Math.floor(n / 2));
  for (let w = MIN_THINKING_WINDOW; w <= limit; w++) {
    const tail = text.slice(n - w);
    const prev = text.slice(n - 2 * w, n - w);
    if (prev.length === w && tail === prev) return { cleanPrefix: text.slice(0, n - w) };
  }
  return null;
}

function detectSemanticLoop(text) {
  const counts = new Map();
  let searchFrom = 0;
  for (const para of text.split(/\n\n+/)) {
    const paraStart = text.indexOf(para, searchFrom);
    if (paraStart === -1) continue;
    searchFrom = paraStart + para.length;
    const trimmed = para.trim();
    if (trimmed.length >= PARA_MIN_LEN) {
      const key = trimmed.slice(0, PARA_FINGERPRINT_LEN);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count >= PARA_LOOP_THRESHOLD) return { cleanPrefix: text.slice(0, paraStart) };
    }
  }
  return null;
}

function detectSequenceRepeat(history) {
  const n = history.length;
  for (let w = 1; w <= Math.floor(n / 2); w++) {
    const tail = history.slice(n - w);
    const prev = history.slice(n - w * 2, n - w);
    if (prev.length === w && tail.every((v, i) => v === prev[i])) return w;
  }
  return 0;
}

function extractThinking(message) {
  if (!Array.isArray(message?.content)) return null;
  for (const block of message.content)
    if (block.type === "thinking" && typeof block.thinking === "string") return block.thinking;
  return null;
}

function replaceThinking(message, newText) {
  if (!Array.isArray(message?.content)) return message;
  let done = false;
  const content = message.content.map((block) => {
    if (done || block.type !== "thinking") return block;
    done = true;
    return { ...block, thinking: newText };
  });
  return { ...message, content };
}

function stableStringify(val) {
  if (val === null || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map(stableStringify).join(",")}]`;
  const keys = Object.keys(val).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(val[k])}`).join(",")}}`;
}

function hashToolCall(toolName, input) {
  return `${toolName}:${stableStringify(input)}`;
}

function jaccard(a, b) {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 1 : inter / union;
}

function setConfigValue(target, pair) {
  const eq = pair.indexOf("=");
  if (eq <= 0) return `unknown: ${pair}`;
  const key = pair.slice(0, eq);
  const val = pair.slice(eq + 1);
  if (!(key in target)) return `unknown: ${key}`;
  if (typeof target[key] === "string") return `not settable: ${key} (edit loop-police.json)`;
  const num = Number(val);
  if (val === "" || !Number.isFinite(num)) return `invalid: ${key}=${val}`;
  target[key] = num;
  return `${key}=${num}`;
}

function fmt(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    key in vars ? String(vars[key]) : whole
  );
}

function isReadTool(name) { return /\bread|view|cat\b/i.test(name); }
function isSearchTool(name) { return /grep|search|find|glob|\brg\b/i.test(name); }

function getInputPath(input) {
  if (typeof input !== "object" || !input) return null;
  return input.path ?? input.file_path ?? input.filename ?? input.file ?? input.directory ?? input.dir ?? null;
}

function getSearchPattern(input) {
  if (typeof input !== "object" || !input) return null;
  return input.pattern ?? input.query ?? input.regex ?? input.search ?? input.term ?? null;
}

// ponytail: local helper that mirrors the stagnation check in message_end
function isStagnant(history, window, threshold) {
  if (history.length < window) return false;
  const recent = history.slice(-window);
  return recent.every((t, i) => i === 0 || jaccard(recent[i - 1], t) >= threshold);
}

// ---------------------------------------------------------------------------
// Fixtures — phrases must be > MIN_THINKING_WINDOW (80 chars)
// ---------------------------------------------------------------------------

const A = "I'm realizing the core issue: the model only allows one active profile per model. ";   // 82
const B = "The most practical approach would be to merge parameters from multiple profiles.   ";  // 82
const C = "However there might be parameter conflicts when two profiles define the same key.   ";  // 83

assert.ok(A.length > MIN_THINKING_WINDOW, "fixture A must be > 80 chars");
assert.ok(B.length > MIN_THINKING_WINDOW, "fixture B must be > 80 chars");
assert.ok(C.length > MIN_THINKING_WINDOW, "fixture C must be > 80 chars");

// Semantic loop fixtures — must be > PARA_MIN_LEN (40 chars)
const P1 = "The segfault might be related to the ComboBox widget initialization and timing.";
const P2 = "Actually, no. The set_profiles method is called after the UI is fully built here.";
const P3 = "OK, I am going in circles. Let me just try running the app to reproduce this.";
const P4 = "Let me check if there is an issue with the way I am creating the ComboBox widget.";

assert.ok(P1.length > PARA_MIN_LEN, "fixture P1 must be > PARA_MIN_LEN");
assert.ok(P2.length > PARA_MIN_LEN, "fixture P2 must be > PARA_MIN_LEN");
assert.ok(P3.length > PARA_MIN_LEN, "fixture P3 must be > PARA_MIN_LEN");
assert.ok(P4.length > PARA_MIN_LEN, "fixture P4 must be > PARA_MIN_LEN");

// ---------------------------------------------------------------------------

describe("detectRepeatingSuffix", () => {
  test("unique text — no loop", () => {
    assert.equal(detectRepeatingSuffix(A + B + C), null);
  });

  test("text shorter than MIN_THINKING_WINDOW * 2 — no detection", () => {
    assert.equal(detectRepeatingSuffix(A), null);
  });

  test("detects A+B+A+B loop", () => {
    assert.notEqual(detectRepeatingSuffix(A + B + A + B), null);
  });

  test("cleanPrefix for A+B+A+B is A+B", () => {
    assert.equal(detectRepeatingSuffix(A + B + A + B).cleanPrefix, A + B);
  });

  test("half-cycle A+B+A does not trigger", () => {
    assert.equal(detectRepeatingSuffix(A + B + A), null);
  });

  test("non-adjacent A+B+C+A+B does not trigger (C breaks adjacency)", () => {
    assert.equal(detectRepeatingSuffix(A + B + C + A + B), null);
  });

  test("three-cycle A+B+A+B+A+B still detects", () => {
    assert.notEqual(detectRepeatingSuffix(A + B + A + B + A + B), null);
  });

  test("no false positive: similar but not identical phrases", () => {
    const A1 = "I'm realizing the core issue: the model only allows one active profile per model. ";
    const A2 = "I'm realizing the core issue: the model only allows one active profile per MODEL. ";
    assert.equal(detectRepeatingSuffix(A1 + B + A2 + B), null);
  });

  test("repeating unit longer than MAX_THINKING_WINDOW is not detected (cap)", () => {
    let unit = "";
    for (let i = 0; unit.length <= MAX_THINKING_WINDOW; i++) unit += `segment ${i} of unique filler text. `;
    assert.equal(detectRepeatingSuffix(unit + unit), null);
  });

  test("streaming simulation: loop fires before stream ends", () => {
    const fullLoop = A + B + A + B + A + B;
    let detected = false;
    let detectedAt = -1;
    const CHECK_STRIDE = 50;
    for (let i = CHECK_STRIDE; i <= fullLoop.length; i += CHECK_STRIDE) {
      const chunk = fullLoop.slice(0, i);
      if (chunk.length < MIN_THINKING_WINDOW * 2) continue;
      if (detectRepeatingSuffix(chunk)) { detected = true; detectedAt = i; break; }
    }
    assert.ok(detected, "loop should be detected before stream ends");
    assert.ok(detectedAt < fullLoop.length, `detection at ${detectedAt} should precede end ${fullLoop.length}`);
  });
});

describe("detectSequenceRepeat", () => {
  test("empty history — no loop", () => assert.equal(detectSequenceRepeat([]), 0));
  test("single call — no loop", () => assert.equal(detectSequenceRepeat(["h1"]), 0));
  test("two different calls — no loop", () => assert.equal(detectSequenceRepeat(["h1", "h2"]), 0));
  test("same call twice → window 1", () => assert.equal(detectSequenceRepeat(["h1", "h1"]), 1));
  test("two-call sequence repeated → window 2", () => assert.equal(detectSequenceRepeat(["h1", "h2", "h1", "h2"]), 2));
  test("three-call sequence repeated → window 3", () => assert.equal(detectSequenceRepeat(["h1", "h2", "h3", "h1", "h2", "h3"]), 3));
  test("partial second repetition — no detection yet", () => assert.equal(detectSequenceRepeat(["h1", "h2", "h3", "h1", "h2"]), 0));
  test("unrelated prefix before loop — still detects", () => assert.equal(detectSequenceRepeat(["x", "y", "h1", "h2", "h1", "h2"]), 2));

  test("detection fires on the call that completes the repeat", () => {
    const partial = ["h1", "h2", "h3", "h1", "h2"];
    assert.equal(detectSequenceRepeat(partial), 0);
    assert.equal(detectSequenceRepeat([...partial, "h3"]), 3);
  });

  test("tool call loop simulation: blocks before third cycle", () => {
    const history = [];
    const sequence = ["read:/foo", "bash:ls", "read:/bar"];
    let blocked = false;
    let blockAt = null;
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const call of sequence) {
        const candidate = [...history, call];
        const w = detectSequenceRepeat(candidate);
        if (w > 0) { blocked = true; blockAt = call; break; }
        history.push(call);
      }
      if (blocked) break;
    }
    assert.ok(blocked, "loop should be blocked");
    assert.equal(blockAt, sequence[sequence.length - 1]);
  });
});

describe("extractThinking", () => {
  test("returns thinking text", () => {
    assert.equal(
      extractThinking({ role: "assistant", content: [{ type: "thinking", thinking: "my thought" }, { type: "text", text: "response" }] }),
      "my thought"
    );
  });
  test("null when no thinking block", () => {
    assert.equal(extractThinking({ role: "assistant", content: [{ type: "text", text: "response" }] }), null);
  });
  test("null for string content", () => assert.equal(extractThinking({ role: "user", content: "text" }), null));
  test("null for null", () => assert.equal(extractThinking(null), null));
});

describe("replaceThinking", () => {
  test("replaces thinking, leaves other blocks", () => {
    const msg = { role: "assistant", content: [{ type: "thinking", thinking: "original" }, { type: "text", text: "response" }] };
    const result = replaceThinking(msg, "truncated [LOOP]");
    assert.equal(result.content[0].thinking, "truncated [LOOP]");
    assert.equal(result.content[1].text, "response");
  });

  test("does not mutate original", () => {
    const msg = { role: "assistant", content: [{ type: "thinking", thinking: "original" }] };
    replaceThinking(msg, "new");
    assert.equal(msg.content[0].thinking, "original");
  });

  test("only replaces first thinking block", () => {
    const msg = { role: "assistant", content: [{ type: "thinking", thinking: "first" }, { type: "thinking", thinking: "second" }] };
    const result = replaceThinking(msg, "replaced");
    assert.equal(result.content[0].thinking, "replaced");
    assert.equal(result.content[1].thinking, "second");
  });
});

describe("hashToolCall", () => {
  test("same tool + args → same hash", () => {
    assert.equal(hashToolCall("read", { path: "/foo", limit: 100 }), hashToolCall("read", { path: "/foo", limit: 100 }));
  });
  test("different key order → same hash (stable stringify)", () => {
    assert.equal(hashToolCall("read", { limit: 100, path: "/foo" }), hashToolCall("read", { path: "/foo", limit: 100 }));
  });
  test("different tool name → different hash", () => {
    assert.notEqual(hashToolCall("read", { path: "/foo" }), hashToolCall("bash", { path: "/foo" }));
  });
  test("different args → different hash", () => {
    assert.notEqual(hashToolCall("read", { path: "/foo" }), hashToolCall("read", { path: "/bar" }));
  });
  test("nested objects sorted stably", () => {
    assert.equal(hashToolCall("tool", { b: 2, a: { y: 1, x: 0 } }), hashToolCall("tool", { a: { x: 0, y: 1 }, b: 2 }));
  });
  test("null input", () => {
    assert.equal(hashToolCall("tool", null), hashToolCall("tool", null));
  });
  test("array order matters (arrays are not sorted)", () => {
    assert.notEqual(hashToolCall("t", { files: [1, 2] }), hashToolCall("t", { files: [2, 1] }));
  });
  test("array and object with same entries differ", () => {
    assert.notEqual(hashToolCall("t", { a: ["x"] }), hashToolCall("t", { a: { 0: "x" } }));
  });
});

describe("detectSemanticLoop", () => {
  test("all unique paragraphs — no loop", () => {
    assert.equal(detectSemanticLoop([P1, P2, P3, P4].join("\n\n")), null);
  });
  test("paragraph appearing twice — no detection (threshold is 3)", () => {
    assert.equal(detectSemanticLoop([P1, P2, P1, P4].join("\n\n")), null);
  });
  test("paragraph appearing 3 times → detected", () => {
    assert.notEqual(detectSemanticLoop([P1, P2, P1, P3, P1].join("\n\n")), null);
  });
  test("cleanPrefix is everything before the 3rd occurrence", () => {
    const text = [P1, P2, P1, P3, P1].join("\n\n");
    assert.equal(detectSemanticLoop(text).cleanPrefix, [P1, P2, P1, P3].join("\n\n") + "\n\n");
  });
  test("short paragraphs (< PARA_MIN_LEN) are ignored", () => {
    assert.equal(detectSemanticLoop(["OK.", "OK.", "OK.", P1].join("\n\n")), null);
  });
  test("near-identical paragraphs share fingerprint (same first 60 chars)", () => {
    const P1a = "The segfault might be related to the ComboBox widget initialization timing.";
    const P1b = "The segfault might be related to the ComboBox widget initialization timing issues.";
    assert.notEqual(detectSemanticLoop([P1a, P2, P1b, P3, P1a].join("\n\n")), null);
  });
  test("real-world reasoning cycle triggers detection", () => {
    const segments = [
      "Actually, I think the issue might be related to the ComboBox widget. Let me check if there is an issue with the way I am creating the ComboBox.",
      "Wait, I just realized something. The ComboBox is created in the __init__ method, and it is added to the layout. But set_profiles is called later.",
      "Actually, no. The set_profiles method is called in _refresh_profiles, which is called after the UI is fully built. So that should not be an issue.",
      "OK, I am going in circles. Let me just try to run the app again and see if the segfault happens consistently. If it does, I will need to investigate.",
      "Actually, I think the issue might be related to the ComboBox widget. Let me check if there is an issue with the way I am creating the ComboBox.",
      "Wait, I just realized something. The ComboBox is created in the __init__ method, and it is added to the layout. But set_profiles is called later.",
      "Actually, no. The set_profiles method is called in _refresh_profiles, which is called after the UI is fully built. So that should not be an issue.",
      "OK, I am going in circles. Let me just try to run the app again and see if the segfault happens consistently. If it does, I will need to investigate.",
      "Actually, I think the issue might be related to the ComboBox widget. Let me check if there is an issue with the way I am creating the ComboBox.",
    ];
    assert.notEqual(detectSemanticLoop(segments.join("\n\n")), null);
  });
});

describe("jaccard", () => {
  test("identical strings → 1", () => assert.equal(jaccard("hello world", "hello world"), 1));
  test("completely disjoint → 0", () => assert.equal(jaccard("foo bar", "baz qux"), 0));
  test("empty vs empty → 1 (no union)", () => assert.equal(jaccard("", ""), 1));
  test("case insensitive", () => assert.equal(jaccard("Hello World", "hello world"), 1));

  test("50% overlap: {a,b} vs {b,c} → 1/3", () => {
    assert.ok(Math.abs(jaccard("a b", "b c") - 1 / 3) < 0.001);
  });

  test("above 0.85 for near-identical thinking (one word changed)", () => {
    const a = "I need to find where the bug is. Let me check the file structure first.";
    const b = "I need to find where the bug is. Let me check the file structure again.";
    assert.ok(jaccard(a, b) >= 0.85);
  });

  test("below 0.85 for clearly different thinking", () => {
    const a = "The problem is in the database layer, I should check the query execution plan.";
    const b = "Let me try a completely different approach using the REST API endpoint directly.";
    assert.ok(jaccard(a, b) < 0.85);
  });

  test("extra whitespace is ignored", () => {
    assert.equal(jaccard("  hello   world  ", "hello world"), 1);
  });

  test("single shared word out of many → low score", () => {
    // "the" shared, everything else different
    const a = "the quick brown fox jumps over lazy dog";
    const b = "the slow white cat sits under tall tree";
    assert.ok(jaccard(a, b) < 0.3);
  });
});

describe("isReadTool", () => {
  test("read → true", () => assert.ok(isReadTool("read")));
  test("read_file → true", () => assert.ok(isReadTool("read_file")));
  test("view_file → true", () => assert.ok(isReadTool("view_file")));
  test("cat → true", () => assert.ok(isReadTool("cat")));
  test("Read (uppercase) → true", () => assert.ok(isReadTool("Read")));
  test("write_file → false", () => assert.ok(!isReadTool("write_file")));
  test("grep → false", () => assert.ok(!isReadTool("grep")));
  test("bash → false", () => assert.ok(!isReadTool("bash")));
  test("spread → false (read not at word boundary)", () => assert.ok(!isReadTool("spread")));
  test("concatenate → false (cat not at word boundary)", () => assert.ok(!isReadTool("concatenate")));
});

describe("isSearchTool", () => {
  test("grep → true", () => assert.ok(isSearchTool("grep")));
  test("search_files → true", () => assert.ok(isSearchTool("search_files")));
  test("find_files → true", () => assert.ok(isSearchTool("find_files")));
  test("glob → true", () => assert.ok(isSearchTool("glob")));
  test("rg → true", () => assert.ok(isSearchTool("rg")));
  test("Grep (uppercase) → true", () => assert.ok(isSearchTool("Grep")));
  test("read_file → false", () => assert.ok(!isSearchTool("read_file")));
  test("bash → false", () => assert.ok(!isSearchTool("bash")));
  test("write_file → false", () => assert.ok(!isSearchTool("write_file")));
  test("args → false (rg not at word boundary)", () => assert.ok(!isSearchTool("args")));
});

describe("getInputPath", () => {
  test("path field", () => assert.equal(getInputPath({ path: "/foo" }), "/foo"));
  test("file_path field", () => assert.equal(getInputPath({ file_path: "/bar" }), "/bar"));
  test("filename field", () => assert.equal(getInputPath({ filename: "x.ts" }), "x.ts"));
  test("file field", () => assert.equal(getInputPath({ file: "y.py" }), "y.py"));
  test("directory field", () => assert.equal(getInputPath({ directory: "/src" }), "/src"));
  test("dir field", () => assert.equal(getInputPath({ dir: "/lib" }), "/lib"));
  test("path takes precedence over file_path", () => assert.equal(getInputPath({ path: "/a", file_path: "/b" }), "/a"));
  test("empty object → null", () => assert.equal(getInputPath({}), null));
  test("null → null", () => assert.equal(getInputPath(null), null));
  test("string → null", () => assert.equal(getInputPath("not-an-object"), null));
  test("array → null", () => assert.equal(getInputPath(["/foo"]), null));
});

describe("getSearchPattern", () => {
  test("pattern field", () => assert.equal(getSearchPattern({ pattern: "foo" }), "foo"));
  test("query field", () => assert.equal(getSearchPattern({ query: "bar" }), "bar"));
  test("regex field", () => assert.equal(getSearchPattern({ regex: "\\d+" }), "\\d+"));
  test("search field", () => assert.equal(getSearchPattern({ search: "baz" }), "baz"));
  test("term field", () => assert.equal(getSearchPattern({ term: "qux" }), "qux"));
  test("pattern takes precedence over query", () => assert.equal(getSearchPattern({ pattern: "a", query: "b" }), "a"));
  test("empty object → null", () => assert.equal(getSearchPattern({}), null));
  test("null → null", () => assert.equal(getSearchPattern(null), null));
});

describe("stagnation detection", () => {
  const THRESHOLD = 0.85;
  const WINDOW = 4;

  test("fewer turns than window → no stagnation", () => {
    const t = "I need to find where the bug is. Let me check the file structure and understand.";
    assert.ok(!isStagnant([t, t, t], WINDOW, THRESHOLD));
  });

  test("identical thinking for N turns → stagnation", () => {
    const t = "I need to check the file structure and understand the dependencies before proceeding further with the fix.";
    assert.ok(isStagnant([t, t, t, t], WINDOW, THRESHOLD));
  });

  test("one clearly different turn breaks stagnation", () => {
    const t = "I need to check the file structure and understand the dependencies before proceeding further.";
    const diff = "Let me try a completely different approach and look at the API documentation instead of the source code.";
    assert.ok(!isStagnant([t, t, diff, t], WINDOW, THRESHOLD));
  });

  test("near-identical thinking (minor word change each turn) still stagnates", () => {
    const a = "I need to find where the bug is. Let me check the file structure first and understand the codebase.";
    const b = "I need to find where the bug is. Let me check the file structure again and understand the codebase.";
    const c = "I need to find where the bug is. Let me check the file structure now and understand the codebase.";
    const d = "I need to find where the bug is. Let me check the file structure carefully and understand the codebase.";
    assert.ok(isStagnant([a, b, c, d], WINDOW, THRESHOLD));
  });

  test("stagnation only checks the last WINDOW turns", () => {
    const t = "I need to check the file structure and understand the dependencies before proceeding further.";
    const diff = "Let me try something completely new and approach the problem from a totally different angle.";
    // history: [diff, diff, t, t, t, t] — last 4 are all t → stagnant
    assert.ok(isStagnant([diff, diff, t, t, t, t], WINDOW, THRESHOLD));
  });

  test("clears after stagnation: fresh window is clean", () => {
    const t = "I need to check the file structure and understand the dependencies before proceeding further.";
    const diff = "Let me try something completely new and approach the problem from a totally different angle.";
    // After stagnation is detected and history is cleared, 1 new turn is not stagnant
    assert.ok(!isStagnant([diff], WINDOW, THRESHOLD));
  });
});

describe("setConfigValue", () => {
  test("valid integer assignment mutates and reports", () => {
    const cfg = { FILE_READ_LIMIT: 4 };
    assert.equal(setConfigValue(cfg, "FILE_READ_LIMIT=6"), "FILE_READ_LIMIT=6");
    assert.equal(cfg.FILE_READ_LIMIT, 6);
  });

  test("valid float assignment", () => {
    const cfg = { STAGNATION_THRESHOLD: 0.85 };
    assert.equal(setConfigValue(cfg, "STAGNATION_THRESHOLD=0.9"), "STAGNATION_THRESHOLD=0.9");
    assert.equal(cfg.STAGNATION_THRESHOLD, 0.9);
  });

  test("unknown key is rejected without mutation", () => {
    const cfg = { FILE_READ_LIMIT: 4 };
    assert.equal(setConfigValue(cfg, "NOPE=3"), "unknown: NOPE");
    assert.deepEqual(cfg, { FILE_READ_LIMIT: 4 });
  });

  test("missing '=' is rejected, echoes the full pair", () => {
    const cfg = { FILE_READ_LIMIT: 4 };
    // No '=' → the whole token is echoed, not a truncated key.
    assert.equal(setConfigValue(cfg, "FILE_READ_LIMIT"), "unknown: FILE_READ_LIMIT");
    assert.equal(cfg.FILE_READ_LIMIT, 4);
  });

  test("leading '=' (empty key) is rejected, echoes the full pair", () => {
    const cfg = { FILE_READ_LIMIT: 4 };
    assert.equal(setConfigValue(cfg, "=5"), "unknown: =5");
  });

  test("non-numeric value is rejected, no NaN written", () => {
    const cfg = { FILE_READ_LIMIT: 4 };
    assert.equal(setConfigValue(cfg, "FILE_READ_LIMIT=abc"), "invalid: FILE_READ_LIMIT=abc");
    assert.equal(cfg.FILE_READ_LIMIT, 4);
  });

  test("trailing garbage is rejected (Number, not parseFloat)", () => {
    const cfg = { FILE_READ_LIMIT: 4 };
    assert.equal(setConfigValue(cfg, "FILE_READ_LIMIT=3px"), "invalid: FILE_READ_LIMIT=3px");
    assert.equal(cfg.FILE_READ_LIMIT, 4);
  });

  test("empty value is rejected", () => {
    const cfg = { FILE_READ_LIMIT: 4 };
    assert.equal(setConfigValue(cfg, "FILE_READ_LIMIT="), "invalid: FILE_READ_LIMIT=");
    assert.equal(cfg.FILE_READ_LIMIT, 4);
  });

  test("Infinity is rejected as non-finite", () => {
    const cfg = { FILE_READ_LIMIT: 4 };
    assert.equal(setConfigValue(cfg, "FILE_READ_LIMIT=Infinity"), "invalid: FILE_READ_LIMIT=Infinity");
    assert.equal(cfg.FILE_READ_LIMIT, 4);
  });

  test("negative and zero values are allowed (finite numbers)", () => {
    const cfg = { CHECK_STRIDE: 50 };
    assert.equal(setConfigValue(cfg, "CHECK_STRIDE=0"), "CHECK_STRIDE=0");
    assert.equal(cfg.CHECK_STRIDE, 0);
  });

  test("string (message) keys are not settable, left unchanged", () => {
    const cfg = { MSG_TOOL_LOOP: "loop!" };
    assert.equal(
      setConfigValue(cfg, "MSG_TOOL_LOOP=5"),
      "not settable: MSG_TOOL_LOOP (edit loop-police.json)"
    );
    assert.equal(cfg.MSG_TOOL_LOOP, "loop!");
  });
});

describe("fmt (message template interpolation)", () => {
  test("fills a single placeholder", () => {
    assert.equal(fmt("read {count} times", { count: 4 }), "read 4 times");
  });

  test("fills multiple distinct placeholders", () => {
    assert.equal(
      fmt('"{path}" read {count}x', { path: "/a", count: 3 }),
      '"/a" read 3x',
    );
  });

  test("same placeholder repeated is filled each time", () => {
    assert.equal(fmt("{count}/{count}", { count: 2 }), "2/2");
  });

  test("unknown placeholder is left verbatim (visible typo)", () => {
    assert.equal(fmt("hi {nope}", { count: 1 }), "hi {nope}");
  });

  test("no placeholders → returned unchanged", () => {
    assert.equal(fmt("plain message", { count: 1 }), "plain message");
  });

  test("coerces non-string template to string", () => {
    assert.equal(fmt(42, {}), "42");
  });

  test("string values interpolate too", () => {
    assert.equal(fmt("pattern {pattern}", { pattern: "GL" }), "pattern GL");
  });
});
