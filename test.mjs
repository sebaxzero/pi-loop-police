// Run: node --test test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Pure logic duplicated from extensions/loop-police.ts — no build step
const THINKING_WINDOW = 80;
const OUTPUT_WINDOW = 100;
const MAX_WINDOW = 4000;
const PARA_MIN_LEN = 40;
const FINGERPRINT_LEN = 60;
const SEMANTIC_THRESHOLD = 3;

function zArray(s) {
  const n = s.length;
  const z = new Int32Array(n);
  if (n === 0) return z;
  z[0] = n;
  for (let i = 1, l = 0, r = 0; i < n; i++) {
    if (i < r) z[i] = Math.min(r - i, z[i - l]);
    while (i + z[i] < n && s.charCodeAt(z[i]) === s.charCodeAt(i + z[i])) z[i]++;
    if (i + z[i] > r) { l = i; r = i + z[i]; }
  }
  return z;
}

function detectRepeatingSuffix(text, minWindow = THINKING_WINDOW) {
  const n = text.length;
  const maxW = Math.min(MAX_WINDOW, Math.floor(n / 2));
  if (minWindow <= 0 || maxW < minWindow) return null;
  const tail = text.slice(Math.max(0, n - 2 * maxW));
  const z = zArray(tail.split("").reverse().join(""));
  for (let w = minWindow; w <= maxW; w++) {
    if (z[w] >= w) return { cleanPrefix: text.slice(0, n - w) };
  }
  return null;
}

function newSemanticState() {
  return { counts: new Map(), scanned: 0, inFence: false };
}

function detectSemanticLoop(text, state) {
  const s = state ?? newSemanticState();
  const delim = /\n\n+/g;
  delim.lastIndex = s.scanned;
  let pos = s.scanned;
  let inFence = s.inFence;
  for (;;) {
    const m = delim.exec(text);
    const end = m ? m.index : text.length;
    const para = text.slice(pos, end);
    const fenceMarks = (para.match(/```/g) ?? []).length;
    if (!inFence && fenceMarks === 0) {
      const trimmed = para.trim();
      if (trimmed.length >= PARA_MIN_LEN) {
        const key = trimmed.slice(0, FINGERPRINT_LEN);
        const count = (s.counts.get(key) ?? 0) + 1;
        if (count >= SEMANTIC_THRESHOLD) return { cleanPrefix: text.slice(0, pos) };
        if (m) s.counts.set(key, count);
      }
    }
    if (!m) return null;
    if (fenceMarks % 2 === 1) inFence = !inFence;
    pos = delim.lastIndex;
    s.scanned = pos;
    s.inFence = inFence;
  }
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

function extractText(message) {
  if (!Array.isArray(message?.content)) return null;
  for (let i = message.content.length - 1; i >= 0; i--) {
    const block = message.content[i];
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return null;
}

function replaceText(message, newText) {
  if (!Array.isArray(message?.content)) return message;
  let lastIdx = -1;
  for (let i = 0; i < message.content.length; i++) {
    if (message.content[i].type === "text") lastIdx = i;
  }
  if (lastIdx === -1) return message;
  const content = message.content.map((block, i) =>
    i === lastIdx ? { ...block, text: newText } : block
  );
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
  if (key.startsWith("MSG_")) return `not settable: ${key} (edit loop-police.json)`;
  if (typeof target[key] === "string") {
    target[key] = val;
    return `${key}="${val}"`;
  }
  const num = Number(val);
  if (val === "" || !Number.isFinite(num)) return `invalid: ${key}=${val}`;
  target[key] = num;
  return `${key}=${num}`;
}

function isExemptTool(name, exemptCfg) {
  const list = String(exemptCfg ?? "");
  if (!list.trim()) return false;
  const target = name.toLowerCase();
  return list.split(",").some((t) => t.trim().toLowerCase() === target);
}

function migrateToolLoopBan(fromFile) {
  if (!fromFile || fromFile.CONFIG_VERSION !== undefined) return null;
  const old = fromFile.TOOL_LOOP_BAN;
  if (old !== 0 && old !== 1) return null;
  return old + 1;
}

const RENAMED_KEYS = {
  MIN_THINKING_WINDOW: { to: "THINKING_WINDOW", oldDefault: 80 },
  MIN_OUTPUT_WINDOW: { to: "OUTPUT_WINDOW", oldDefault: 100 },
  MAX_THINKING_WINDOW: { to: "MAX_WINDOW", oldDefault: 2000 },
  CHECK_STRIDE: { to: "STRIDE", oldDefault: 50 },
  PARA_FINGERPRINT_LEN: { to: "FINGERPRINT_LEN", oldDefault: 60 },
  PARA_LOOP_THRESHOLD: { to: "SEMANTIC_THRESHOLD", oldDefault: 3 },
};

function migrateRenamedKeys(fromFile) {
  const out = {};
  if (!fromFile || (typeof fromFile.CONFIG_VERSION === "number" && fromFile.CONFIG_VERSION >= 3))
    return out;
  for (const [oldKey, { to, oldDefault }] of Object.entries(RENAMED_KEYS)) {
    const val = fromFile[oldKey];
    if (typeof val === "number" && val !== oldDefault && !(to in fromFile)) out[to] = val;
  }
  return out;
}

function fmt(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    key in vars ? String(vars[key]) : whole
  );
}

// Mirrors withSuffix in the extension, with cfg.MSG_SUFFIX passed explicitly.
function withSuffix(msg, suffixCfg) {
  const suffix = String(suffixCfg ?? "").trim();
  return suffix ? `${msg}\n\n${suffix}` : msg;
}

function isReadTool(name) { return /\bread|view|cat\b/i.test(name); }
function isSearchTool(name) { return /grep|search|find|glob|\brg\b/i.test(name); }

function getInputPath(input) {
  if (typeof input !== "object" || !input) return null;
  return input.path ?? input.file_path ?? input.filename ?? input.file ?? input.directory ?? input.dir ?? null;
}

const PATH_KEYS = new Set(["path", "file_path", "filename", "file", "directory", "dir"]);

function getReadRange(input) {
  if (typeof input !== "object" || !input) return "";
  const start = input.offset ?? input.start_line ?? input.startLine ?? null;
  const end = input.limit ?? input.end_line ?? input.endLine ?? null;
  if (start !== null || end !== null) return `${start ?? ""}:${end ?? ""}`;
  const rest = {};
  for (const k of Object.keys(input)) if (!PATH_KEYS.has(k)) rest[k] = input[k];
  return Object.keys(rest).length === 0 ? "" : stableStringify(rest);
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
// Fixtures — phrases must be > THINKING_WINDOW (80 chars)
// ---------------------------------------------------------------------------

const A = "I'm realizing the core issue: the model only allows one active profile per model. ";   // 82
const B = "The most practical approach would be to merge parameters from multiple profiles.   ";  // 82
const C = "However there might be parameter conflicts when two profiles define the same key.   ";  // 83

assert.ok(A.length > THINKING_WINDOW, "fixture A must be > 80 chars");
assert.ok(B.length > THINKING_WINDOW, "fixture B must be > 80 chars");
assert.ok(C.length > THINKING_WINDOW, "fixture C must be > 80 chars");

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

  test("text shorter than THINKING_WINDOW * 2 — no detection", () => {
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

  test("repeating unit longer than MAX_WINDOW is not detected (cap)", () => {
    let unit = "";
    for (let i = 0; unit.length <= MAX_WINDOW; i++) unit += `segment ${i} of unique filler text. `;
    assert.equal(detectRepeatingSuffix(unit + unit), null);
  });

  test("streaming simulation: loop fires before stream ends", () => {
    const fullLoop = A + B + A + B + A + B;
    let detected = false;
    let detectedAt = -1;
    const STRIDE = 50;
    for (let i = STRIDE; i <= fullLoop.length; i += STRIDE) {
      const chunk = fullLoop.slice(0, i);
      if (chunk.length < THINKING_WINDOW * 2) continue;
      if (detectRepeatingSuffix(chunk)) { detected = true; detectedAt = i; break; }
    }
    assert.ok(detected, "loop should be detected before stream ends");
    assert.ok(detectedAt < fullLoop.length, `detection at ${detectedAt} should precede end ${fullLoop.length}`);
  });
});

describe("output text loop detection (detectRepeatingSuffix with OUTPUT_WINDOW)", () => {
  // Real-world repro: a code-analysis phrase (~250 chars) repeated verbatim in
  // the visible response — well above OUTPUT_WINDOW, so the char-level
  // detector must fire on the output text stream.
  const PHRASE =
    "readPersistedSriHashes = try { const cached = await env.CACHE.get(key); return JSON.parse(cached); } catch { return null; } — " +
    "try (1) + catch (1) + cached (1) + JSON.parse (0) + return null (0) = 3. await = 1. env.CACHE.get = 4. Total = 8. cyc=8. Still. ";

  assert.ok(PHRASE.length > OUTPUT_WINDOW, "fixture PHRASE must exceed OUTPUT_WINDOW");

  test("phrase repeated 10x in output → detected", () => {
    assert.notEqual(detectRepeatingSuffix(PHRASE.repeat(10), OUTPUT_WINDOW), null);
  });

  test("detection fires on the second repetition already", () => {
    assert.notEqual(detectRepeatingSuffix(PHRASE.repeat(2), OUTPUT_WINDOW), null);
  });

  test("cleanPrefix trims the trailing repetition", () => {
    const result = detectRepeatingSuffix(PHRASE + PHRASE, OUTPUT_WINDOW);
    assert.equal(result.cleanPrefix, PHRASE);
  });

  test("newline-separated repetitions are still adjacent → detected", () => {
    assert.notEqual(detectRepeatingSuffix((PHRASE + "\n").repeat(5), OUTPUT_WINDOW), null);
  });

  test("single occurrence → no detection", () => {
    assert.equal(detectRepeatingSuffix(PHRASE, OUTPUT_WINDOW), null);
  });

  test("output window is stricter than thinking window (80 < unit < 100 not flagged)", () => {
    const short = "This sentence is over eighty characters long but it stays under one hundred, yes sir!! "; // 87 chars
    assert.ok(short.length > THINKING_WINDOW && short.length < OUTPUT_WINDOW);
    assert.equal(detectRepeatingSuffix(short + short, OUTPUT_WINDOW), null);
    assert.notEqual(detectRepeatingSuffix(short + short, THINKING_WINDOW), null);
  });

  test("unit shorter than OUTPUT_WINDOW still caught once the run is long enough", () => {
    // Real-world repro: "crap > cyc + cog + ..." (67 chars) repeated inline.
    // A single unit is below the 100-char window, but a window of two units
    // (134 chars) also repeats adjacently, so the scan still catches it.
    const unit = "crap > cyc + cog + loc + coupling + complexity + maintainability = ";
    assert.ok(unit.length < OUTPUT_WINDOW);
    assert.equal(detectRepeatingSuffix(unit.repeat(2), OUTPUT_WINDOW), null);
    assert.notEqual(detectRepeatingSuffix(unit.repeat(4), OUTPUT_WINDOW), null);
  });

  test("near-identical (but not verbatim) attempts do not trigger", () => {
    // Different decomposition attempts of the same function are legitimate
    // reasoning, not a loop — only verbatim adjacent repetition fires.
    const attempts = [
      "readPersistedSriHashes with && guard: try (1) + catch (1) + cached (1) + && (1) + JSON.parse (1) = 5. Total = 10. Still.",
      "readPersistedSriHashes with if guard: try (1) + catch (1) + cached (1) + if (1) = 4. Total = 9. cyc=9. Still.",
      "readPersistedSriHashes bare: try (1) + catch (1) + cached (1) = 3. Total = 8. cyc=8. Still.",
    ].join("\n\n");
    assert.equal(detectRepeatingSuffix(attempts, OUTPUT_WINDOW), null);
  });

  test("streaming simulation: output loop fires before stream ends", () => {
    const fullLoop = PHRASE.repeat(10);
    const STRIDE = 50;
    let detectedAt = -1;
    for (let i = STRIDE; i <= fullLoop.length; i += STRIDE) {
      const chunk = fullLoop.slice(0, i);
      if (chunk.length < OUTPUT_WINDOW * 2) continue;
      if (detectRepeatingSuffix(chunk, OUTPUT_WINDOW)) { detectedAt = i; break; }
    }
    assert.ok(detectedAt > 0, "output loop should be detected mid-stream");
    assert.ok(detectedAt < fullLoop.length, `detection at ${detectedAt} should precede end ${fullLoop.length}`);
  });
});

describe("extractText", () => {
  test("returns text block content", () => {
    assert.equal(
      extractText({ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "response" }] }),
      "response"
    );
  });
  test("returns the LAST text block (the one streaming)", () => {
    assert.equal(
      extractText({ role: "assistant", content: [{ type: "text", text: "first" }, { type: "toolCall" }, { type: "text", text: "second" }] }),
      "second"
    );
  });
  test("null when no text block", () => {
    assert.equal(extractText({ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] }), null);
  });
  test("null for string content", () => assert.equal(extractText({ role: "user", content: "text" }), null));
  test("null for null", () => assert.equal(extractText(null), null));
});

describe("replaceText", () => {
  test("replaces the last text block, leaves others", () => {
    const msg = { role: "assistant", content: [{ type: "text", text: "first" }, { type: "text", text: "looping" }] };
    const result = replaceText(msg, "truncated [OUTPUT LOOP]");
    assert.equal(result.content[0].text, "first");
    assert.equal(result.content[1].text, "truncated [OUTPUT LOOP]");
  });

  test("leaves thinking blocks untouched", () => {
    const msg = { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "looping" }] };
    const result = replaceText(msg, "cut");
    assert.equal(result.content[0].thinking, "hmm");
    assert.equal(result.content[1].text, "cut");
  });

  test("does not mutate original", () => {
    const msg = { role: "assistant", content: [{ type: "text", text: "original" }] };
    replaceText(msg, "new");
    assert.equal(msg.content[0].text, "original");
  });

  test("message without text blocks returned unchanged", () => {
    const msg = { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] };
    assert.equal(replaceText(msg, "new"), msg);
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

describe("getReadRange", () => {
  test("offset + limit", () => assert.equal(getReadRange({ path: "/f", offset: 100, limit: 50 }), "100:50"));
  test("start_line + end_line", () => assert.equal(getReadRange({ start_line: 1, end_line: 40 }), "1:40"));
  test("startLine + endLine", () => assert.equal(getReadRange({ startLine: 5, endLine: 9 }), "5:9"));
  test("offset only", () => assert.equal(getReadRange({ offset: 200 }), "200:"));
  test("limit only", () => assert.equal(getReadRange({ limit: 30 }), ":30"));
  test("offset 0 is a range, not absent", () => assert.equal(getReadRange({ offset: 0, limit: 50 }), "0:50"));
  test("no range fields → empty string", () => assert.equal(getReadRange({ path: "/f" }), ""));
  test("null → empty string", () => assert.equal(getReadRange(null), ""));
  // Issue #6: read_symbol-style tools address content by symbol name, not line
  // range — different symbols in the same file must not collide.
  test("different non-range params → different keys", () =>
    assert.notEqual(
      getReadRange({ file_path: "src/flagger.ts", name: "combineScores" }),
      getReadRange({ file_path: "src/flagger.ts", name: "runMLFlagger" })
    ));
  test("same non-range params → same key", () =>
    assert.equal(
      getReadRange({ file_path: "src/flagger.ts", name: "combineScores" }),
      getReadRange({ name: "combineScores", file_path: "src/flagger.ts" })
    ));
  test("non-range params vs path-only differ", () =>
    assert.notEqual(getReadRange({ path: "/f", name: "x" }), getReadRange({ path: "/f" })));
  test("all path-key aliases excluded from fallback key", () =>
    assert.equal(getReadRange({ file: "/f", directory: "/d", filename: "f" }), ""));
  test("distinct offsets give distinct keys", () =>
    assert.notEqual(getReadRange({ offset: 0, limit: 50 }), getReadRange({ offset: 50, limit: 50 })));
  test("same range gives the same key", () =>
    assert.equal(getReadRange({ offset: 50, limit: 50 }), getReadRange({ limit: 50, offset: 50 })));
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

describe("withSuffix (MSG_SUFFIX appended to every recovery message)", () => {
  test("empty suffix (default) → message unchanged", () => {
    assert.equal(withSuffix("⚠️ LOOP", ""), "⚠️ LOOP");
  });

  test("missing suffix (undefined) → message unchanged", () => {
    assert.equal(withSuffix("⚠️ LOOP", undefined), "⚠️ LOOP");
  });

  test("whitespace-only suffix → message unchanged", () => {
    assert.equal(withSuffix("⚠️ LOOP", "   \n "), "⚠️ LOOP");
  });

  test("non-empty suffix appended after a blank line", () => {
    assert.equal(
      withSuffix("⚠️ LOOP", "Consult the advisor: run /advisor before continuing."),
      "⚠️ LOOP\n\nConsult the advisor: run /advisor before continuing."
    );
  });

  test("suffix is trimmed before appending", () => {
    assert.equal(withSuffix("⚠️ LOOP", "  use /advisor  "), "⚠️ LOOP\n\nuse /advisor");
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
    const cfg = { STRIDE: 50 };
    assert.equal(setConfigValue(cfg, "STRIDE=0"), "STRIDE=0");
    assert.equal(cfg.STRIDE, 0);
  });

  test("message (MSG_*) keys are not settable, left unchanged", () => {
    const cfg = { MSG_TOOL_LOOP: "loop!" };
    assert.equal(
      setConfigValue(cfg, "MSG_TOOL_LOOP=5"),
      "not settable: MSG_TOOL_LOOP (edit loop-police.json)"
    );
    assert.equal(cfg.MSG_TOOL_LOOP, "loop!");
  });

  test("TOOL_LOOP_EXEMPT is settable as a string", () => {
    const cfg = { TOOL_LOOP_EXEMPT: "" };
    assert.equal(setConfigValue(cfg, "TOOL_LOOP_EXEMPT=bash,run_tests"), 'TOOL_LOOP_EXEMPT="bash,run_tests"');
    assert.equal(cfg.TOOL_LOOP_EXEMPT, "bash,run_tests");
  });

  test("TOOL_LOOP_EXEMPT can be cleared with an empty value", () => {
    const cfg = { TOOL_LOOP_EXEMPT: "bash" };
    assert.equal(setConfigValue(cfg, "TOOL_LOOP_EXEMPT="), 'TOOL_LOOP_EXEMPT=""');
    assert.equal(cfg.TOOL_LOOP_EXEMPT, "");
  });
});

describe("isExemptTool (TOOL_LOOP_EXEMPT)", () => {
  test("empty list exempts nothing", () => assert.ok(!isExemptTool("bash", "")));
  test("undefined config exempts nothing", () => assert.ok(!isExemptTool("bash", undefined)));
  test("whitespace-only list exempts nothing", () => assert.ok(!isExemptTool("bash", "  ")));
  test("single entry matches", () => assert.ok(isExemptTool("bash", "bash")));
  test("comma list matches any entry", () => assert.ok(isExemptTool("run_tests", "bash,run_tests")));
  test("case-insensitive match", () => assert.ok(isExemptTool("Bash", "bash")));
  test("entries are trimmed", () => assert.ok(isExemptTool("edit", "bash, edit ,read")));
  test("exact name only — no substring match", () => assert.ok(!isExemptTool("bash_run", "bash")));
  test("non-listed tool is not exempt", () => assert.ok(!isExemptTool("grep", "bash,edit")));

  // Mirrors the tool_call hook: exempt calls are recorded but never checked;
  // blocked calls are not recorded (history stays at the looping state).
  function simulate(calls, exempt) {
    const history = [];
    const blocked = [];
    for (const [name, hash] of calls) {
      if (isExemptTool(name, exempt)) { history.push(hash); continue; }
      if (detectSequenceRepeat([...history, hash]) > 0) { blocked.push(hash); continue; }
      history.push(hash);
    }
    return blocked;
  }

  test("exempt tool repeating identically is never blocked", () => {
    const calls = [["bash", "bash:test"], ["bash", "bash:test"], ["bash", "bash:test"]];
    assert.deepEqual(simulate(calls, "bash"), []);
    assert.equal(simulate(calls, "").length, 2); // without exemption both repeats block
  });

  test("exempt calls still break adjacency for other tools", () => {
    // read → bash → read: identical reads separated by an exempt call are
    // allowed, same as before the exemption existed.
    const calls = [["read", "read:/foo"], ["bash", "bash:test"], ["read", "read:/foo"]];
    assert.deepEqual(simulate(calls, "bash"), []);
  });

  test("non-exempt tool looping alongside an exempt one is still blocked", () => {
    const calls = [
      ["bash", "bash:test"], ["read", "read:/foo"],
      ["bash", "bash:test"], ["read", "read:/foo"],
    ];
    assert.deepEqual(simulate(calls, "bash"), ["read:/foo"]);
  });
});

describe("migrateToolLoopBan (pre-1.5.0 config migration)", () => {
  test("old temporary (0) → new temporary (1)", () => {
    assert.equal(migrateToolLoopBan({ TOOL_LOOP_BAN: 0 }), 1);
  });

  test("old permanent (1) → new permanent (2)", () => {
    assert.equal(migrateToolLoopBan({ TOOL_LOOP_BAN: 1 }), 2);
  });

  test("stamped file (any CONFIG_VERSION) is never migrated", () => {
    assert.equal(migrateToolLoopBan({ CONFIG_VERSION: 2, TOOL_LOOP_BAN: 0 }), null);
    assert.equal(migrateToolLoopBan({ CONFIG_VERSION: 1, TOOL_LOOP_BAN: 1 }), null);
  });

  test("missing TOOL_LOOP_BAN → no migration (new default applies)", () => {
    assert.equal(migrateToolLoopBan({ FILE_READ_LIMIT: 6 }), null);
  });

  test("missing/corrupt file (null) → no migration", () => {
    assert.equal(migrateToolLoopBan(null), null);
  });

  test("values outside the old scale are left alone", () => {
    assert.equal(migrateToolLoopBan({ TOOL_LOOP_BAN: 2 }), null);
    assert.equal(migrateToolLoopBan({ TOOL_LOOP_BAN: "1" }), null);
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

describe("zArray", () => {
  test("all-same string: z[i] = n - i", () => {
    assert.deepEqual([...zArray("aaaa")], [4, 3, 2, 1]);
  });
  test("periodic string: full match at the period", () => {
    assert.equal(zArray("abcabc")[3], 3);
  });
  test("no repetition → zeros after z[0]", () => {
    assert.deepEqual([...zArray("abcd")], [4, 0, 0, 0]);
  });
  test("empty string", () => assert.equal(zArray("").length, 0));
});

describe("detectSemanticLoop — output stream (same detector, both streams)", () => {
  const P1 = "The segfault might be related to the ComboBox widget initialization and timing.";
  const P2 = "Actually, no. The set_profiles method is called after the UI is fully built here.";
  const P3 = "OK, I am going in circles. Let me just try running the app to reproduce this.";

  test("cycling paragraphs with varying tails: semantic fires where char-level cannot", () => {
    // The repeats share the fingerprint (first 60 chars) but differ afterward,
    // so no verbatim adjacent repetition exists for detectRepeatingSuffix —
    // this is exactly the case that motivated semantic detection on output.
    const text = [P1 + " First attempt.", P2, P1 + " Second attempt.", P3, P1 + " Third attempt."].join("\n\n");
    assert.equal(detectRepeatingSuffix(text, OUTPUT_WINDOW), null);
    assert.notEqual(detectSemanticLoop(text), null);
  });

  test("repeating unit longer than MAX_WINDOW: semantic still catches it", () => {
    // Char-level is capped at MAX_WINDOW; a huge repeating unit is invisible
    // to it, but its paragraphs repeat and the fingerprints catch that.
    let filler = "";
    for (let i = 0; filler.length <= MAX_WINDOW; i++) filler += `unique filler segment number ${i} with enough length to matter. `;
    const unit = P1 + "\n\n" + filler + "\n\n";
    assert.notEqual(detectSemanticLoop(unit.repeat(3)), null);
  });
});

describe("detectSemanticLoop — code fence skipping", () => {
  const P1 = "The segfault might be related to the ComboBox widget initialization and timing.";
  const P2 = "Actually, no. The set_profiles method is called after the UI is fully built here.";
  const P3 = "OK, I am going in circles. Let me just try running the app to reproduce this.";
  const CODE = "```ts\nexport function normalize(input) { return input.trim().toLowerCase(); }\n```";

  test("identical fenced code blocks repeated do not fire (legitimate structure)", () => {
    assert.equal(detectSemanticLoop([CODE, CODE, CODE, CODE].join("\n\n")), null);
  });

  test("paragraphs inside a fence with blank lines are skipped", () => {
    const fenced = "```\n" + P1 + "\n\n" + P1 + "\n\n" + P1 + "\n```";
    assert.equal(detectSemanticLoop(fenced), null);
  });

  test("prose repetition around code blocks still fires", () => {
    const text = [CODE, P1, P2, CODE, P1, P3, P1].join("\n\n");
    assert.notEqual(detectSemanticLoop(text), null);
  });
});

describe("detectSemanticLoop — incremental state (streaming)", () => {
  const P1 = "The segfault might be related to the ComboBox widget initialization and timing.";
  const P2 = "Actually, no. The set_profiles method is called after the UI is fully built here.";
  const P3 = "OK, I am going in circles. Let me just try running the app to reproduce this.";
  const TEXT = [P1, P2, P1, P3, P1].join("\n\n");

  test("stateful streaming fires with the same cleanPrefix as the stateless scan", () => {
    const state = newSemanticState();
    let fired = null;
    for (let i = 50; i <= TEXT.length && !fired; i += 50) {
      fired = detectSemanticLoop(TEXT.slice(0, i), state);
    }
    if (!fired) fired = detectSemanticLoop(TEXT, state);
    assert.notEqual(fired, null);
    assert.equal(fired.cleanPrefix, detectSemanticLoop(TEXT).cleanPrefix);
  });

  test("closed paragraphs are committed and not rescanned", () => {
    const state = newSemanticState();
    const partial = [P1, P2].join("\n\n") + "\n\n";
    assert.equal(detectSemanticLoop(partial, state), null);
    assert.equal(state.scanned, partial.length);
    assert.equal(state.counts.size, 2);
  });

  test("the trailing (still-streaming) paragraph is never committed", () => {
    const state = newSemanticState();
    assert.equal(detectSemanticLoop([P1, P2].join("\n\n"), state), null);
    // P2 is unterminated: only P1 was committed
    assert.equal(state.counts.size, 1);
  });

  test("counts persist across calls: later occurrences complete the loop", () => {
    const state = newSemanticState();
    assert.equal(detectSemanticLoop([P1, P2].join("\n\n") + "\n\n", state), null);
    assert.notEqual(detectSemanticLoop(TEXT, state), null);
  });

  test("fence state carries across calls", () => {
    const state = newSemanticState();
    const open = "```\n" + P1 + "\n\n";
    assert.equal(detectSemanticLoop(open, state), null);
    assert.ok(state.inFence);
    // Everything until the closing fence is skipped, even repeated prose
    assert.equal(detectSemanticLoop(open + [P1, P1, P1].join("\n\n"), state), null);
  });
});

describe("migrateRenamedKeys (pre-1.8.0 config migration)", () => {
  test("customized old value is carried to the new key", () => {
    assert.deepEqual(migrateRenamedKeys({ CONFIG_VERSION: 2, MIN_THINKING_WINDOW: 120 }), {
      THINKING_WINDOW: 120,
    });
  });

  test("value left at the old default is dropped (new default applies)", () => {
    assert.deepEqual(migrateRenamedKeys({ CONFIG_VERSION: 2, MAX_THINKING_WINDOW: 2000 }), {});
  });

  test("all renamed keys migrate together", () => {
    assert.deepEqual(
      migrateRenamedKeys({
        CONFIG_VERSION: 2,
        MIN_THINKING_WINDOW: 100,
        MIN_OUTPUT_WINDOW: 200,
        MAX_THINKING_WINDOW: 3000,
        CHECK_STRIDE: 25,
        PARA_FINGERPRINT_LEN: 80,
        PARA_LOOP_THRESHOLD: 4,
      }),
      {
        THINKING_WINDOW: 100,
        OUTPUT_WINDOW: 200,
        MAX_WINDOW: 3000,
        STRIDE: 25,
        FINGERPRINT_LEN: 80,
        SEMANTIC_THRESHOLD: 4,
      }
    );
  });

  test("file already stamped with CONFIG_VERSION 3 is never migrated", () => {
    assert.deepEqual(migrateRenamedKeys({ CONFIG_VERSION: 3, MIN_THINKING_WINDOW: 120 }), {});
  });

  test("an explicit new-name entry wins over the old key", () => {
    assert.deepEqual(
      migrateRenamedKeys({ CONFIG_VERSION: 2, MIN_THINKING_WINDOW: 120, THINKING_WINDOW: 90 }),
      {}
    );
  });

  test("pre-1.5.0 file (no CONFIG_VERSION) is migrated too", () => {
    assert.deepEqual(migrateRenamedKeys({ CHECK_STRIDE: 30 }), { STRIDE: 30 });
  });

  test("missing/corrupt file (null) → nothing to migrate", () => {
    assert.deepEqual(migrateRenamedKeys(null), {});
  });

  test("non-numeric old value is ignored", () => {
    assert.deepEqual(migrateRenamedKeys({ CONFIG_VERSION: 2, CHECK_STRIDE: "30" }), {});
  });
});

// Duplicated from extensions/loop-police.ts — detection hook helpers
function splitHookCmd(cmd) {
  const parts = cmd.trim().split(/\s+/).filter(Boolean);
  return parts.length === 0 ? null : { command: parts[0], args: parts.slice(1) };
}

function buildDetectionPayload(event, details, info) {
  return { event, timestamp: new Date().toISOString(), ...info, details };
}

describe("splitHookCmd (HOOK_CMD parsing)", () => {
  test("blank config disables the hook", () => {
    assert.equal(splitHookCmd(""), null);
    assert.equal(splitHookCmd("   "), null);
  });

  test("bare executable → no fixed args", () => {
    assert.deepEqual(splitHookCmd("/home/user/hook.sh"), {
      command: "/home/user/hook.sh",
      args: [],
    });
  });

  test("interpreter + script split into command and fixed args", () => {
    assert.deepEqual(splitHookCmd("node /path/to/hook.mjs"), {
      command: "node",
      args: ["/path/to/hook.mjs"],
    });
    assert.deepEqual(splitHookCmd("python C:\hooks\loop.py --flag"), {
      command: "python",
      args: ["C:\hooks\loop.py", "--flag"],
    });
  });

  test("surrounding and repeated whitespace is collapsed", () => {
    assert.deepEqual(splitHookCmd("  node   hook.mjs  "), {
      command: "node",
      args: ["hook.mjs"],
    });
  });
});

describe("buildDetectionPayload (hook payload shape)", () => {
  const info = {
    model: { id: "qwen3", name: "Qwen3", provider: "ollama" },
    sessionId: "abc123",
    sessionFile: "/sessions/abc123.jsonl",
    cwd: "/work",
    turnIndex: 7,
    consecutiveLoops: 2,
  };

  test("payload carries event, info fields, and details verbatim", () => {
    const p = buildDetectionPayload("tool_loop", { toolName: "bash", windowSize: 3 }, info);
    assert.equal(p.event, "tool_loop");
    assert.deepEqual(p.model, info.model);
    assert.equal(p.sessionId, "abc123");
    assert.equal(p.sessionFile, "/sessions/abc123.jsonl");
    assert.equal(p.cwd, "/work");
    assert.equal(p.turnIndex, 7);
    assert.equal(p.consecutiveLoops, 2);
    assert.deepEqual(p.details, { toolName: "bash", windowSize: 3 });
  });

  test("timestamp is a valid ISO date", () => {
    const p = buildDetectionPayload("stagnation", {}, info);
    assert.ok(!Number.isNaN(Date.parse(p.timestamp)));
  });

  test("model may be null (no model selected)", () => {
    const p = buildDetectionPayload("thinking_loop", {}, { ...info, model: null });
    assert.equal(p.model, null);
  });

  test("payload round-trips through JSON (argv delivery)", () => {
    const p = buildDetectionPayload("search_spiral", { pattern: 'a"b\nc', paths: 3 }, info);
    assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
  });
});
