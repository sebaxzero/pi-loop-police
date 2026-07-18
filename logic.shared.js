/*
 * logic.shared.js — pure detection logic mirrored from extensions/loop-police.ts,
 * parameterized by a mutable `cfg` object, plus the hook simulations used by the
 * playground. Single copy shared by test.mjs (Node, CJS require) and
 * playground.html (browser, plain <script src> — works over file://).
 *
 * Dual-load contract: wrapped in an IIFE so nothing leaks into the browser's
 * global lexical scope; exposes one object as `module.exports` under Node and
 * as `globalThis.LoopPoliceLogic` in the browser.
 */
(() => {
  "use strict";

  const DEFAULTS = {
    THINKING_WINDOW: 80,
    OUTPUT_WINDOW: 100,
    MAX_WINDOW: 4000,
    STRIDE: 50,
    PARA_MIN_LEN: 40,
    FINGERPRINT_LEN: 60,
    SEMANTIC_THRESHOLD: 3,
    STAGNATION_WINDOW: 4,
    STAGNATION_THRESHOLD: 0.85,
    FILE_READ_LIMIT: 4,
    SEARCH_EXPAND_LIMIT: 3,
    CONSECUTIVE_LOOP_LIMIT: 2,
    TOOL_LOOP_BAN: 1,
    TOOL_LOOP_EXEMPT: "",
  };

  const CFG_HELP = {
    THINKING_WINDOW: "loop char en thinking: tamaño mínimo de la unidad repetida",
    OUTPUT_WINDOW: "loop char en output: tamaño mínimo de la unidad repetida",
    MAX_WINDOW: "tope del tamaño de unidad repetida (char, thinking y output)",
    STRIDE: "cada cuántos chars nuevos se re-chequea el stream",
    PARA_MIN_LEN: "loop semántico: párrafos más cortos se ignoran",
    FINGERPRINT_LEN: "chars iniciales del párrafo usados como huella",
    SEMANTIC_THRESHOLD: "veces que una huella debe aparecer para disparar (thinking y output)",
    STAGNATION_WINDOW: "turnos consecutivos comparados",
    STAGNATION_THRESHOLD: "similitud Jaccard mínima entre turnos adyacentes",
    FILE_READ_LIMIT: "lecturas del mismo path antes de bloquear",
    SEARCH_EXPAND_LIMIT: "paths distintos para el mismo patrón antes de bloquear",
    CONSECUTIVE_LOOP_LIMIT: "loops seguidos antes del mensaje escalado",
    TOOL_LOOP_BAN: "0=off · 1=bloqueo adyacente · 2=ban de sesión",
    TOOL_LOOP_EXEMPT: "tools exentas del sequence loop (coma-separadas)",
  };

  // Mutated in place (Object.assign) so every closure sees the same object.
  const cfg = { ...DEFAULTS };

  // --- detectors (mirrored from loop-police.ts) ---

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

  function detectRepeatingSuffix(text, minWindow = cfg.THINKING_WINDOW) {
    const n = text.length;
    const maxW = Math.min(cfg.MAX_WINDOW, Math.floor(n / 2));
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
        if (trimmed.length >= cfg.PARA_MIN_LEN) {
          const key = trimmed.slice(0, cfg.FINGERPRINT_LEN);
          const count = (s.counts.get(key) ?? 0) + 1;
          if (count >= cfg.SEMANTIC_THRESHOLD) return { cleanPrefix: text.slice(0, pos) };
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

  function jaccard(a, b) {
    const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
    const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
    let inter = 0;
    for (const w of setA) if (setB.has(w)) inter++;
    const union = setA.size + setB.size - inter;
    return union === 0 ? 1 : inter / union;
  }

  // ponytail: local helper that mirrors the stagnation check in message_end
  function isStagnant(history, window, threshold) {
    if (history.length < window) return false;
    const recent = history.slice(-window);
    return recent.every((t, i) => i === 0 || jaccard(recent[i - 1], t) >= threshold);
  }

  function isExemptTool(name, exemptCfg) {
    const list = String(exemptCfg ?? "");
    if (!list.trim()) return false;
    const target = name.toLowerCase();
    return list.split(",").some((t) => t.trim().toLowerCase() === target);
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

  function splitHookCmd(cmd) {
    const parts = cmd.trim().split(/\s+/).filter(Boolean);
    return parts.length === 0 ? null : { command: parts[0], args: parts.slice(1) };
  }

  function buildDetectionPayload(event, details, info) {
    return { event, timestamp: new Date().toISOString(), ...info, details };
  }

  // --- simulations (reproduce the hooks with the current cfg; playground-only) ---

  // message_update: char + semantic over one stream (thinking or output),
  // checking every STRIDE chars with incremental semantic state, as in production.
  function simulateStream(text, minWindow) {
    const charOn = minWindow > 0;
    const semOn = cfg.SEMANTIC_THRESHOLD > 0;
    if (!charOn && !semOn) return { fired: null, disabled: true };
    const semState = newSemanticState();
    let lastCheckedLen = 0;
    const checkpoints = [];
    for (let i = 1; i <= text.length; i++) {
      if (i < lastCheckedLen + cfg.STRIDE) continue;
      lastCheckedLen = i;
      const chunk = text.slice(0, i);
      checkpoints.push(i);
      let repeat = charOn ? detectRepeatingSuffix(chunk, minWindow) : null;
      let type = "character";
      if (!repeat && semOn) {
        repeat = detectSemanticLoop(chunk, semState);
        if (repeat) type = "semantic";
      }
      if (repeat) return { fired: type, at: i, cleanPrefix: repeat.cleanPrefix, checkpoints };
    }
    return { fired: null, checkpoints };
  }

  // message_update, thinking block.
  function simulateThinkingStream(text) {
    return simulateStream(text, cfg.THINKING_WINDOW);
  }

  // message_update, last text block (the visible response).
  function simulateOutputStream(text) {
    return simulateStream(text, cfg.OUTPUT_WINDOW);
  }

  // message_end (clean turns): sliding window + history cleared on fire.
  function simulateStagnation(turns) {
    if (cfg.STAGNATION_WINDOW <= 0) return { disabled: true, events: [] };
    let history = [];
    const events = [];
    turns.forEach((t, idx) => {
      history.push(t);
      if (history.length > cfg.STAGNATION_WINDOW) history.shift();
      const sim = idx > 0 ? jaccard(turns[idx - 1], t) : null;
      let fired = false;
      if (history.length >= cfg.STAGNATION_WINDOW) {
        const stagnant = history.every(
          (x, i) => i === 0 || jaccard(history[i - 1], x) >= cfg.STAGNATION_THRESHOLD
        );
        if (stagnant) { fired = true; history = []; }
      }
      events.push({ idx, sim, fired, historyLen: fired ? 0 : history.length });
    });
    return { disabled: false, events };
  }

  // Full tool_call hook, in the same order as production.
  function simulateToolCalls(calls) {
    const fileReadCounts = new Map();
    const searchPatternPaths = new Map();
    const toolHistory = [];
    const bannedCalls = new Set();
    const rows = [];

    for (const call of calls) {
      const row = { name: call.name, raw: call.raw, verdict: "allowed", why: "" };
      rows.push(row);

      if (cfg.FILE_READ_LIMIT > 0 && isReadTool(call.name)) {
        const path = getInputPath(call.input);
        if (path) {
          const count = (fileReadCounts.get(path) ?? 0) + 1;
          fileReadCounts.set(path, count);
          if (count >= cfg.FILE_READ_LIMIT) {
            row.verdict = "blocked";
            row.why = `FILE READ LOOP: "${path}" leído ${count}×`;
            continue;
          }
          row.why = `read #${count} de "${path}"`;
        }
      }

      if (cfg.SEARCH_EXPAND_LIMIT > 0 && isSearchTool(call.name)) {
        const pattern = getSearchPattern(call.input);
        if (pattern) {
          const searchPath = getInputPath(call.input) ?? "*";
          const paths = searchPatternPaths.get(pattern) ?? new Set();
          paths.add(searchPath);
          searchPatternPaths.set(pattern, paths);
          if (paths.size >= cfg.SEARCH_EXPAND_LIMIT) {
            row.verdict = "blocked";
            row.why = `SEARCH SPIRAL: "${pattern}" en ${paths.size} paths`;
            continue;
          }
          row.why = `patrón "${pattern}" · ${paths.size} path(s)`;
        }
      }

      if (cfg.TOOL_LOOP_BAN <= 0) continue;
      const hash = hashToolCall(call.name, call.input);

      if (isExemptTool(call.name, cfg.TOOL_LOOP_EXEMPT)) {
        toolHistory.push(hash);
        row.why = (row.why ? row.why + " · " : "") + "exenta (registrada en historial)";
        continue;
      }

      if (cfg.TOOL_LOOP_BAN >= 2 && bannedCalls.has(hash)) {
        row.verdict = "blocked";
        row.why = "TOOL LOOP: llamada baneada de por vida (BAN=2)";
        continue;
      }

      const windowSize = detectSequenceRepeat([...toolHistory, hash]);
      if (windowSize > 0) {
        if (cfg.TOOL_LOOP_BAN >= 2) bannedCalls.add(hash);
        row.verdict = "blocked";
        row.why = `TOOL LOOP: secuencia de ${windowSize} llamada(s) repetida — no se registra en historial`;
        continue;
      }

      toolHistory.push(hash);
    }
    return rows;
  }

  const api = {
    DEFAULTS, CFG_HELP, cfg,
    zArray, detectRepeatingSuffix, newSemanticState, detectSemanticLoop,
    detectSequenceRepeat, jaccard, isStagnant, isExemptTool, isReadTool,
    isSearchTool, getInputPath, getReadRange, getSearchPattern,
    extractThinking, replaceThinking, extractText, replaceText,
    stableStringify, hashToolCall, fmt, withSuffix, setConfigValue,
    migrateToolLoopBan, migrateRenamedKeys, splitHookCmd, buildDetectionPayload,
    simulateStream, simulateThinkingStream, simulateOutputStream,
    simulateStagnation, simulateToolCalls,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.LoopPoliceLogic = api;
})();
