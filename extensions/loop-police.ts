import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Config lives next to the extension file: ./extensions/loop-police.json
// Auto-created on first load with defaults; travels with the extension.
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(EXT_DIR, "loop-police.json");

// Setting a detector's key to 0 disables that detector entirely:
//   THINKING_WINDOW=0        → character-level thinking loop off
//   OUTPUT_WINDOW=0          → character-level output loop off
//   SEMANTIC_THRESHOLD=0     → semantic (paragraph) loop off, both streams
//   STAGNATION_WINDOW=0      → cross-turn stagnation off
//   FILE_READ_LIMIT=0        → file read loop off
//   FILE_SCAN_LIMIT=0        → per-file total read ceiling off
//   SEARCH_EXPAND_LIMIT=0    → search expansion spiral off
//   CONSECUTIVE_LOOP_LIMIT=0 → escalated consecutive-loop message off
//   TOOL_LOOP_BAN=0          → tool call sequence loop off
const NUMERIC_DEFAULTS = {
  THINKING_WINDOW: 80,
  OUTPUT_WINDOW: 100,
  MAX_WINDOW: 4000,
  STRIDE: 50,
  PARA_MIN_LEN: 40,
  FINGERPRINT_LEN: 60,
  SEMANTIC_THRESHOLD: 3,
  STAGNATION_WINDOW: 4,
  STAGNATION_THRESHOLD: 0.85,
  FILE_READ_LIMIT: 4, //  reads of the same path + line range (offset/limit)
  FILE_SCAN_LIMIT: 15, // total reads of the same path across ALL line ranges
  SEARCH_EXPAND_LIMIT: 3,
  CONSECUTIVE_LOOP_LIMIT: 2,
  TOOL_LOOP_BAN: 1, // 0 = detector off;
  //                   1 = block identical call only while repeated back-to-back;
  //                   2 = ban that exact call for the rest of the session
};

// Tool names exempt from the tool call sequence loop detector, comma-separated
// and case-insensitive (e.g. "bash,run_tests"). Exempt calls are never blocked
// or banned, but they ARE still recorded in the history, so they keep breaking
// adjacency for other tools exactly as any different call does.
const STRING_DEFAULTS = {
  TOOL_LOOP_EXEMPT: "",
};

// Recovery messages injected into the agent when a loop is detected. Edit these
// in loop-police.json to tune the wording per model — some models respond
// better to different phrasing. Placeholders in {braces} are filled at runtime:
//   MSG_CONSECUTIVE_LOOP → {count}
//   MSG_STAGNATION       → {window} {threshold}
//   MSG_FILE_READ_LOOP   → {path} {count}
//   MSG_FILE_SCAN_LOOP   → {path} {count}
//   MSG_SEARCH_SPIRAL    → {pattern} {paths}
//   MSG_TOOL_LOOP        → {windowSize}
// MSG_SUFFIX, when non-empty, is appended (after a blank line) to EVERY
// recovery message — use it to point the model at an advisor, e.g.
// "Consult the advisor extension: run /advisor before continuing."
const MESSAGE_DEFAULTS = {
  MSG_THINKING_LOOP:
    "⚠️ THINKING LOOP DETECTED: Your thinking block was repeating the same phrases verbatim and has been truncated. Re-examine your approach and continue with the task.",
  MSG_SEMANTIC_LOOP:
    "⚠️ SEMANTIC LOOP DETECTED: Your thinking block was cycling through the same reasoning steps repeatedly. The repeated section has been truncated. Step back and try a completely different approach.",
  MSG_OUTPUT_LOOP:
    "⚠️ OUTPUT LOOP DETECTED: Your response text was repeating the same content verbatim and has been truncated. Do NOT re-emit the repeated content — continue from where the response was cut, or wrap up with a concise conclusion.",
  MSG_OUTPUT_SEMANTIC_LOOP:
    "⚠️ OUTPUT SEMANTIC LOOP DETECTED: Your response text was cycling through the same paragraphs repeatedly. The repeated section has been truncated. Do NOT re-emit the repeated content — continue past it or wrap up with a concise conclusion.",
  MSG_CONSECUTIVE_LOOP:
    "⚠️ CONSECUTIVE LOOP ({count}x): You have entered a loop {count} times in a row and loop-police has aborted your output each time. Stop — provide a direct, concise answer or ask for clarification.",
  MSG_STAGNATION:
    "⚠️ REASONING STAGNATION: Your thinking across the last {window} turns has been {threshold}%+ similar — you are not making progress. Stop and try a fundamentally different approach.",
  MSG_FILE_READ_LOOP:
    '⚠️ FILE READ LOOP: "{path}" has been read {count} times with the same line range. Reading it again will not yield new information — use what you already know and move forward.',
  MSG_FILE_SCAN_LOOP:
    '⚠️ FILE READ CEILING: "{path}" has been read {count} times in total, counting every line range. Paging through it further is not converging — use a targeted search (grep) or what you already read, and move forward.',
  MSG_SEARCH_SPIRAL:
    '⚠️ SEARCH EXPANSION SPIRAL: Pattern "{pattern}" has been searched in {paths} different locations. Broadening the scope further will not help — reconsider what you are looking for.',
  MSG_TOOL_LOOP:
    "⚠️ TOOL CALL LOOP: The same sequence of {windowSize} tool call(s) is repeating identically and has been blocked — this exact call did NOT run and will keep being blocked if you repeat it. It produced no new result last time and won't now. Change your approach: try a different command, or use what you already learned to move forward.",
  MSG_SUFFIX: "",
};

const DEFAULTS = { ...NUMERIC_DEFAULTS, ...STRING_DEFAULTS, ...MESSAGE_DEFAULTS };

// Stamped into loop-police.json. Files written before 1.5.0 lack it, which is
// how migrateToolLoopBan() recognizes the old TOOL_LOOP_BAN scale; files
// stamped below 3 still use the pre-1.8.0 key names (see RENAMED_KEYS).
const CONFIG_VERSION = 3;

// 1.8.0 (CONFIG_VERSION 3) renamed the stream-detector keys to conventional
// terms. migrateRenamedKeys() carries customized values over to the new names;
// values left at the old default are dropped so the new defaults apply (that
// is how existing installs pick up the larger MAX_WINDOW).
const RENAMED_KEYS: Record<string, { to: string; oldDefault: number }> = {
  MIN_THINKING_WINDOW: { to: "THINKING_WINDOW", oldDefault: 80 },
  MIN_OUTPUT_WINDOW: { to: "OUTPUT_WINDOW", oldDefault: 100 },
  MAX_THINKING_WINDOW: { to: "MAX_WINDOW", oldDefault: 2000 },
  CHECK_STRIDE: { to: "STRIDE", oldDefault: 50 },
  PARA_FINGERPRINT_LEN: { to: "FINGERPRINT_LEN", oldDefault: 60 },
  PARA_LOOP_THRESHOLD: { to: "SEMANTIC_THRESHOLD", oldDefault: 3 },
};

const cfg: typeof DEFAULTS & Record<string, number | string> = (() => {
  // Read the existing config (null = missing or unreadable/corrupt).
  let fromFile: Record<string, unknown> | null = null;
  try {
    if (existsSync(CONFIG_PATH)) fromFile = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    fromFile = null; // corrupt JSON — leave the file untouched, use defaults
  }
  const merged = { ...DEFAULTS, ...(fromFile ?? {}) } as typeof DEFAULTS &
    Record<string, number | string>;

  // Pre-1.5.0 configs used a shifted TOOL_LOOP_BAN scale (0 = temporary,
  // 1 = permanent); 1.5.0 inserted 0 = off below it. Bump the stored value by
  // one so the old behavior is preserved, then stamp the file so this runs
  // exactly once.
  const migratedBan = migrateToolLoopBan(fromFile);
  if (migratedBan !== null) merged.TOOL_LOOP_BAN = migratedBan;

  // Pre-1.8.0 configs used the old stream-detector key names. Carry customized
  // values to the new keys, then drop the old keys so they are not written back.
  Object.assign(merged, migrateRenamedKeys(fromFile));
  for (const oldKey of Object.keys(RENAMED_KEYS)) delete (merged as any)[oldKey];

  const stampNeeded = fromFile !== null && fromFile.CONFIG_VERSION !== CONFIG_VERSION;
  merged.CONFIG_VERSION = CONFIG_VERSION;

  // Write the file when it is absent, or backfill it when an upgrade added new
  // keys the on-disk file is missing — so users can discover and edit them.
  // Never overwrite a file that failed to parse (fromFile === null && exists).
  const fileExists = existsSync(CONFIG_PATH);
  const backfillNeeded =
    fromFile !== null && Object.keys(DEFAULTS).some((k) => !(k in fromFile));
  if (!fileExists || backfillNeeded || stampNeeded) {
    try {
      writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", "utf-8");
    } catch {
      // If we can't write (e.g. permissions), just use defaults in memory
    }
  }
  return merged;
})();

export default function (pi: ExtensionAPI) {
  let streamAborted = false;
  let cleanStreamPrefix: string | null = null;
  let lastCheckedLen = 0;
  let lastCheckedOutputLen = 0;
  let loopStream: "thinking" | "output" = "thinking";
  let loopKind: "character" | "semantic" = "character";
  let thinkingSem = newSemanticState();
  let outputSem = newSemanticState();
  let toolHistory: string[] = [];
  let bannedCalls = new Set<string>();
  let thinkingHistory: string[] = [];
  let fileReadRanges = new Map<string, number>(); // "path range" → reads of that exact range
  let fileReadTotals = new Map<string, number>(); // path → total reads across all ranges
  let searchPatternPaths = new Map<string, Set<string>>();
  let consecutiveLoopCount = 0;

  // Per-stream detector state: stride checkpoints + incremental semantic scan.
  // Reset whenever a new assistant message (or a new block) starts streaming.
  function resetStreamState() {
    lastCheckedLen = 0;
    lastCheckedOutputLen = 0;
    thinkingSem = newSemanticState();
    outputSem = newSemanticState();
  }

  function reset() {
    streamAborted = false;
    cleanStreamPrefix = null;
    resetStreamState();
    loopStream = "thinking";
    loopKind = "character";
    toolHistory = [];
    bannedCalls = new Set();
    thinkingHistory = [];
    fileReadRanges = new Map();
    fileReadTotals = new Map();
    searchPatternPaths = new Map();
    consecutiveLoopCount = 0;
  }

  pi.on("agent_start", reset);

  pi.on("turn_start", () => {
    resetStreamState();
    streamAborted = false;
    cleanStreamPrefix = null;
    loopStream = "thinking";
    loopKind = "character";
    // NOTE: consecutiveLoopCount is intentionally NOT reset here. Recovery
    // turns fire turn_start, so resetting would defeat cross-turn escalation.
    // It is cleared on a clean (non-aborted) turn in message_end instead.
    // toolHistory / bannedCalls also persist across turns (reset on agent_start).
  });

  // Only aborts here; message_end decides which recovery message to send
  // (escalated vs. normal) so a single turn is triggered, not two.
  function abortStream(cleanPrefix: string, ctx: { abort(): void }) {
    streamAborted = true;
    cleanStreamPrefix = cleanPrefix;
    consecutiveLoopCount++;
    ctx.abort();
  }

  pi.on("message_update", (event, ctx) => {
    if (streamAborted || event.message.role !== "assistant") return;
    const semanticOn = cfg.SEMANTIC_THRESHOLD > 0;

    // Thinking stream: character-level + semantic
    if (cfg.THINKING_WINDOW > 0 || semanticOn) {
      const thinking = extractThinking(event.message);
      if (thinking) {
        // Shrinking text means a new thinking block started streaming (next
        // message in the same turn) — restart this stream's detector state.
        if (thinking.length < lastCheckedLen) {
          lastCheckedLen = 0;
          thinkingSem = newSemanticState();
        }
        if (thinking.length >= lastCheckedLen + cfg.STRIDE) {
          lastCheckedLen = thinking.length;
          let kind: "character" | "semantic" = "character";
          let repeat =
            cfg.THINKING_WINDOW > 0 ? detectRepeatingSuffix(thinking, cfg.THINKING_WINDOW) : null;
          if (!repeat && semanticOn) {
            repeat = detectSemanticLoop(thinking, thinkingSem);
            if (repeat) kind = "semantic";
          }
          if (repeat) {
            loopStream = "thinking";
            loopKind = kind;
            return abortStream(repeat.cleanPrefix, ctx);
          }
        }
      }
    }

    // Output stream: the same two detectors on the visible response (the last
    // text block streams too — a phrase or paragraph repeating in the answer).
    if (cfg.OUTPUT_WINDOW > 0 || semanticOn) {
      const output = extractText(event.message);
      if (output) {
        if (output.length < lastCheckedOutputLen) {
          lastCheckedOutputLen = 0;
          outputSem = newSemanticState();
        }
        if (output.length >= lastCheckedOutputLen + cfg.STRIDE) {
          lastCheckedOutputLen = output.length;
          let kind: "character" | "semantic" = "character";
          let repeat =
            cfg.OUTPUT_WINDOW > 0 ? detectRepeatingSuffix(output, cfg.OUTPUT_WINDOW) : null;
          if (!repeat && semanticOn) {
            repeat = detectSemanticLoop(output, outputSem);
            if (repeat) kind = "semantic";
          }
          if (repeat) {
            loopStream = "output";
            loopKind = kind;
            abortStream(repeat.cleanPrefix, ctx);
          }
        }
      }
    }
  });

  pi.on("message_end", (event, _ctx) => {
    if (event.message.role !== "assistant") return;

    if (streamAborted) {
      const prefix = cleanStreamPrefix ?? "";
      streamAborted = false;
      cleanStreamPrefix = null;
      resetStreamState();

      const label =
        loopStream === "output"
          ? loopKind === "semantic"
            ? "[SEMANTIC OUTPUT LOOP — truncated by loop-police]"
            : "[OUTPUT LOOP — truncated by loop-police]"
          : loopKind === "semantic"
            ? "[SEMANTIC LOOP — truncated by loop-police]"
            : "[THINKING LOOP — truncated by loop-police]";
      const advice =
        cfg.CONSECUTIVE_LOOP_LIMIT > 0 && consecutiveLoopCount >= cfg.CONSECUTIVE_LOOP_LIMIT
          ? fmt(cfg.MSG_CONSECUTIVE_LOOP, { count: consecutiveLoopCount })
          : loopStream === "output"
            ? String(loopKind === "semantic" ? cfg.MSG_OUTPUT_SEMANTIC_LOOP : cfg.MSG_OUTPUT_LOOP)
            : String(loopKind === "semantic" ? cfg.MSG_SEMANTIC_LOOP : cfg.MSG_THINKING_LOOP);

      const cleaned =
        loopStream === "output"
          ? replaceText(event.message, `${prefix}\n\n${label}`)
          : replaceThinking(event.message, `${prefix}\n\n${label}`);
      pi.sendMessage(
        { customType: "loop-police", content: withSuffix(advice), display: true },
        { triggerTurn: true }
      );
      return { message: cleaned };
    }

    // Clean message — restart the per-stream detector state so the next
    // assistant message in this turn starts fresh (lengths reset to zero), and
    // clear the consecutive-loop escalation counter: the model is progressing.
    resetStreamState();
    consecutiveLoopCount = 0;

    // Cross-turn stagnation: only run on clean (non-aborted) turns
    if (cfg.STAGNATION_WINDOW <= 0) return;
    const thinking = extractThinking(event.message);
    if (thinking) {
      thinkingHistory.push(thinking);
      if (thinkingHistory.length > cfg.STAGNATION_WINDOW) thinkingHistory.shift();

      if (thinkingHistory.length >= cfg.STAGNATION_WINDOW) {
        const stagnant = thinkingHistory.every(
          (t, i) => i === 0 || jaccard(thinkingHistory[i - 1], t) >= cfg.STAGNATION_THRESHOLD
        );
        if (stagnant) {
          thinkingHistory = [];
          pi.sendMessage(
            {
              customType: "loop-police",
              content: withSuffix(
                fmt(cfg.MSG_STAGNATION, {
                  window: cfg.STAGNATION_WINDOW,
                  threshold: Math.round(cfg.STAGNATION_THRESHOLD * 100),
                })
              ),
              display: true,
            },
            { triggerTurn: true }
          );
        }
      }
    }
  });

  pi.on("tool_call", (event, ctx) => {
    // File read repetition. FILE_READ_LIMIT counts reads of the same path AND
    // the same line range (offset/limit), so paging through a large file in
    // chunks is not a loop — each chunk yields new information. FILE_SCAN_LIMIT
    // is a generous per-path ceiling across all ranges, catching the model that
    // keeps re-scanning one file with ever-different offsets.
    if ((cfg.FILE_READ_LIMIT > 0 || cfg.FILE_SCAN_LIMIT > 0) && isReadTool(event.toolName)) {
      const path = getInputPath(event.input);
      if (path) {
        const rangeKey = `${path} ${getReadRange(event.input)}`;
        const count = (fileReadRanges.get(rangeKey) ?? 0) + 1;
        fileReadRanges.set(rangeKey, count);
        const total = (fileReadTotals.get(path) ?? 0) + 1;
        fileReadTotals.set(path, total);
        if (cfg.FILE_READ_LIMIT > 0 && count >= cfg.FILE_READ_LIMIT) {
          ctx.ui.notify(`⚠️ FILE READ LOOP: "${path}" read ${count}x (same range) — blocked`, "warning");
          pi.sendMessage(
            {
              customType: "loop-police",
              content: withSuffix(fmt(cfg.MSG_FILE_READ_LOOP, { path, count })),
              display: true,
            },
            { triggerTurn: true }
          );
          return { block: true, reason: `loop-police: file read ${count}x — ${path}` };
        }
        if (cfg.FILE_SCAN_LIMIT > 0 && total >= cfg.FILE_SCAN_LIMIT) {
          ctx.ui.notify(`⚠️ FILE READ CEILING: "${path}" read ${total}x total — blocked`, "warning");
          pi.sendMessage(
            {
              customType: "loop-police",
              content: withSuffix(fmt(cfg.MSG_FILE_SCAN_LOOP, { path, count: total })),
              display: true,
            },
            { triggerTurn: true }
          );
          return { block: true, reason: `loop-police: file read ${total}x total — ${path}` };
        }
      }
    }

    // Search expansion spiral
    if (cfg.SEARCH_EXPAND_LIMIT > 0 && isSearchTool(event.toolName)) {
      const pattern = getSearchPattern(event.input);
      if (pattern) {
        const searchPath = getInputPath(event.input) ?? "*";
        const paths = searchPatternPaths.get(pattern) ?? new Set<string>();
        paths.add(searchPath);
        searchPatternPaths.set(pattern, paths);
        if (paths.size >= cfg.SEARCH_EXPAND_LIMIT) {
          ctx.ui.notify(`⚠️ SEARCH SPIRAL: "${pattern}" across ${paths.size} paths — blocked`, "warning");
          pi.sendMessage(
            {
              customType: "loop-police",
              content: withSuffix(fmt(cfg.MSG_SEARCH_SPIRAL, { pattern, paths: paths.size })),
              display: true,
            },
            { triggerTurn: true }
          );
          return { block: true, reason: `loop-police: search spiral "${pattern}" ×${paths.size} paths` };
        }
      }
    }

    // Tool call sequence loop — block the repeated call *in place* and hand the
    // warning back as the tool result, so the model must pivot within the same
    // turn. No new turn, and other (different) tools are left available.
    if (cfg.TOOL_LOOP_BAN <= 0) return;
    const hash = hashToolCall(event.toolName, event.input);

    // Exempt tools (TOOL_LOOP_EXEMPT) are never checked or blocked, but their
    // calls still enter the history so they break adjacency for other tools.
    if (isExemptTool(event.toolName, cfg.TOOL_LOOP_EXEMPT)) {
      toolHistory.push(hash);
      return;
    }

    // Permanent-ban mode (TOOL_LOOP_BAN=2): once a call has looped, that exact
    // call stays blocked for the rest of the session, no matter what.
    if (cfg.TOOL_LOOP_BAN >= 2 && bannedCalls.has(hash)) {
      ctx.ui.notify(`⚠️ TOOL LOOP: identical call blocked (banned)`, "warning");
      return { block: true, reason: withSuffix(fmt(cfg.MSG_TOOL_LOOP, { windowSize: 1 })) };
    }

    const windowSize = detectSequenceRepeat([...toolHistory, hash]);
    if (windowSize > 0) {
      if (cfg.TOOL_LOOP_BAN >= 2) bannedCalls.add(hash);
      ctx.ui.notify(`⚠️ TOOL LOOP: ${windowSize}-call sequence repeating — blocked`, "warning");
      // Do NOT record the blocked call: toolHistory stays at the looping state
      // so a renewed identical attempt trips the detector again in place. The
      // moment the model does something different, adjacency breaks and the
      // call is allowed again (safe for build/test/lint re-runs).
      return { block: true, reason: withSuffix(fmt(cfg.MSG_TOOL_LOOP, { windowSize })) };
    }

    toolHistory.push(hash);
  });

  pi.registerCommand("loop-police", {
    description: "Show status; /loop-police reset; /loop-police set KEY=VAL [KEY=VAL ...]",
    handler: (args, ctx) => {
      const trimmed = args?.trim() ?? "";

      if (trimmed === "reset") {
        reset();
        ctx.ui.notify("Loop Police: state reset", "info");
        return;
      }

      if (trimmed.startsWith("set ")) {
        const results = trimmed
          .slice(4)
          .trim()
          .split(/\s+/)
          .map((pair) => setConfigValue(cfg, pair));
        ctx.ui.notify(`Loop Police: ${results.join(", ")}`, "info");
        return;
      }

      ctx.ui.notify(
        [
          "Loop Police status",
          `  stream aborted:      ${streamAborted}`,
          `  tool history:        ${toolHistory.length} calls`,
          `  banned calls:        ${bannedCalls.size}`,
          `  stagnation history:  ${thinkingHistory.length}/${cfg.STAGNATION_WINDOW} turns`,
          `  file reads tracked:  ${fileReadTotals.size} paths (${fileReadRanges.size} ranges)`,
          `  search patterns:     ${searchPatternPaths.size} patterns`,
          `  consecutive loops:   ${consecutiveLoopCount}/${cfg.CONSECUTIVE_LOOP_LIMIT}`,
          "",
          "  config (set KEY=VAL to change):",
          ...Object.keys(NUMERIC_DEFAULTS).map((k) => `    ${k}=${cfg[k]}`),
          ...Object.keys(STRING_DEFAULTS).map((k) => `    ${k}="${cfg[k]}"`),
          "",
          "  messages (edit loop-police.json to customize):",
          ...Object.keys(MESSAGE_DEFAULTS).map((k) => `    ${k}`),
        ].join("\n"),
        "info"
      );
    },
  });

  pi.registerMessageRenderer("loop-police", (message, _opts, theme) =>
    new Text(theme.fg("warning", String(message.content)), 0, 0)
  );
}

// helpers

// Fill {placeholder} tokens in a message template. Unknown tokens are left as-is
// so a typo in a user-edited template is visible rather than silently dropped.
function fmt(template: string | number, vars: Record<string, string | number>): string {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    key in vars ? String(vars[key]) : whole
  );
}

// Append MSG_SUFFIX (if configured) to a recovery message. Every detector's
// message passes through here, so one JSON key adds advisor instructions to
// all of them without rewriting each MSG_* template.
function withSuffix(msg: string): string {
  const suffix = String(cfg.MSG_SUFFIX ?? "").trim();
  return suffix ? `${msg}\n\n${suffix}` : msg;
}

// Parse and apply a single "KEY=VAL" assignment against `target`, mutating it
// on success. Returns a human-readable status string for the notification.
// Rejects unknown keys and non-finite values (e.g. "3px", "", "abc") so a bad
// input never silently writes NaN into a threshold and disables a detector.
// Message templates (MSG_*) are rejected here by design — they are edited in
// loop-police.json, not via /loop-police set. Non-message string keys
// (TOOL_LOOP_EXEMPT) are assigned verbatim.
function setConfigValue(target: Record<string, number | string>, pair: string): string {
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

// Returns the TOOL_LOOP_BAN value translated to the ≥1.5.0 scale, or null when
// no migration applies. Only files without a CONFIG_VERSION stamp (written
// before 1.5.0) are migrated, and only the two values the old scale had:
// old 0 (temporary) → 1, old 1 (permanent) → 2.
function migrateToolLoopBan(fromFile: Record<string, unknown> | null): number | null {
  if (!fromFile || fromFile.CONFIG_VERSION !== undefined) return null;
  const old = fromFile.TOOL_LOOP_BAN;
  if (old !== 0 && old !== 1) return null;
  return old + 1;
}

// Returns the { newKey: value } assignments produced by renaming pre-1.8.0
// config keys. Applies only to files not yet stamped with CONFIG_VERSION 3.
// Only customized values (different from the old default) are carried over,
// and never over an explicit new-name entry already present in the file.
function migrateRenamedKeys(fromFile: Record<string, unknown> | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!fromFile || (typeof fromFile.CONFIG_VERSION === "number" && fromFile.CONFIG_VERSION >= 3))
    return out;
  for (const [oldKey, { to, oldDefault }] of Object.entries(RENAMED_KEYS)) {
    const val = fromFile[oldKey];
    if (typeof val === "number" && val !== oldDefault && !(to in fromFile)) out[to] = val;
  }
  return out;
}

function jaccard(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 1 : inter / union;
}

// True when `name` appears in the comma-separated TOOL_LOOP_EXEMPT list
// (case-insensitive, entries trimmed). An empty list exempts nothing.
function isExemptTool(name: string, exemptCfg: string | number): boolean {
  const list = String(exemptCfg ?? "");
  if (!list.trim()) return false;
  const target = name.toLowerCase();
  return list.split(",").some((t) => t.trim().toLowerCase() === target);
}

function isReadTool(name: string): boolean {
  return /\bread|view|cat\b/i.test(name);
}

function isSearchTool(name: string): boolean {
  return /grep|search|find|glob|\brg\b/i.test(name);
}

function getInputPath(input: unknown): string | null {
  if (typeof input !== "object" || !input) return null;
  const inp = input as any;
  return inp.path ?? inp.file_path ?? inp.filename ?? inp.file ?? inp.directory ?? inp.dir ?? null;
}

// Normalizes the line range of a read call to a "start:end" string ("" when
// the tool has no range fields — then every read of the path is "the same
// range"). Field names cover the common read-tool schemas (offset/limit,
// start_line/end_line, startLine/endLine).
function getReadRange(input: unknown): string {
  if (typeof input !== "object" || !input) return "";
  const inp = input as any;
  const start = inp.offset ?? inp.start_line ?? inp.startLine ?? null;
  const end = inp.limit ?? inp.end_line ?? inp.endLine ?? null;
  return start === null && end === null ? "" : `${start ?? ""}:${end ?? ""}`;
}

function getSearchPattern(input: unknown): string | null {
  if (typeof input !== "object" || !input) return null;
  const inp = input as any;
  return inp.pattern ?? inp.query ?? inp.regex ?? inp.search ?? inp.term ?? null;
}

function extractThinking(message: any): string | null {
  if (!Array.isArray(message?.content)) return null;
  for (const block of message.content) {
    if (block.type === "thinking" && typeof block.thinking === "string")
      return block.thinking;
  }
  return null;
}

// Output text helpers target the LAST text block: streaming always appends to
// the newest block, so that is the one that can be looping.
function extractText(message: any): string | null {
  if (!Array.isArray(message?.content)) return null;
  for (let i = message.content.length - 1; i >= 0; i--) {
    const block = message.content[i];
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return null;
}

function replaceText(message: any, newText: string): any {
  if (!Array.isArray(message?.content)) return message;
  let lastIdx = -1;
  for (let i = 0; i < message.content.length; i++) {
    if (message.content[i].type === "text") lastIdx = i;
  }
  if (lastIdx === -1) return message;
  const content = message.content.map((block: any, i: number) =>
    i === lastIdx ? { ...block, text: newText } : block
  );
  return { ...message, content };
}

function replaceThinking(message: any, newText: string): any {
  if (!Array.isArray(message?.content)) return message;
  let done = false;
  const content = message.content.map((block: any) => {
    if (done || block.type !== "thinking") return block;
    done = true;
    return { ...block, thinking: newText };
  });
  return { ...message, content };
}

// Incremental scan state for detectSemanticLoop: fingerprint counts of the
// paragraphs already processed, the absolute offset where the next unprocessed
// paragraph starts, and whether that offset sits inside a ``` code fence.
type SemanticState = { counts: Map<string, number>; scanned: number; inFence: boolean };

function newSemanticState(): SemanticState {
  return { counts: new Map(), scanned: 0, inFence: false };
}

// Semantic loop: paragraphs (blank-line separated) are fingerprinted by their
// first FINGERPRINT_LEN chars; a fingerprint seen SEMANTIC_THRESHOLD times
// means the model is cycling through the same content even when wording
// drifts after the fingerprint or other text sits between repeats. Paragraphs
// inside (or containing) ``` code fences are skipped — repeated code
// structure is legitimate, especially in output text.
// With `state` the scan is incremental across stream checkpoints: paragraphs
// closed by a blank line are counted once and never re-scanned; the trailing,
// still-streaming paragraph is re-checked every call but never committed.
function detectSemanticLoop(text: string, state?: SemanticState): { cleanPrefix: string } | null {
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

// Z-array: z[i] = length of the longest common prefix of s and s.slice(i).
function zArray(s: string): Int32Array {
  const n = s.length;
  const z = new Int32Array(n);
  if (n === 0) return z;
  z[0] = n;
  for (let i = 1, l = 0, r = 0; i < n; i++) {
    if (i < r) z[i] = Math.min(r - i, z[i - l]);
    while (i + z[i] < n && s.charCodeAt(z[i]) === s.charCodeAt(i + z[i])) z[i]++;
    if (i + z[i] > r) {
      l = i;
      r = i + z[i];
    }
  }
  return z;
}

// Character-level loop: the text ends in two adjacent identical copies of a
// block of minWindow..MAX_WINDOW chars. Computed as a Z-array over the
// reversed tail — z[w] >= w means the last w chars equal the w chars right
// before them — one O(tail) pass instead of the old O(MAX_WINDOW²) scan, and
// it still finds the smallest repeating block. Only the last 2×MAX_WINDOW
// chars are examined, so MAX_WINDOW caps the size of the repeating block.
// minWindow is THINKING_WINDOW for thinking, OUTPUT_WINDOW for output text.
function detectRepeatingSuffix(text: string, minWindow: number): { cleanPrefix: string } | null {
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

function detectSequenceRepeat(history: string[]): number {
  const n = history.length;
  for (let w = 1; w <= Math.floor(n / 2); w++) {
    const tail = history.slice(n - w);
    const prev = history.slice(n - w * 2, n - w);
    if (prev.length === w && tail.every((v, i) => v === prev[i])) return w;
  }
  return 0;
}

function hashToolCall(toolName: string, input: unknown): string {
  return `${toolName}:${stableStringify(input)}`;
}

function stableStringify(val: unknown): string {
  if (val === null || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map(stableStringify).join(",")}]`;
  const keys = Object.keys(val as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((val as any)[k])}`).join(",")}}`;
}
