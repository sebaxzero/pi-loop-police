import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Loaded from sibling JSON at startup; /set overrides for the current session only
const cfg = (() => {
  const defaults = {
    MIN_THINKING_WINDOW: 80,
    MAX_THINKING_WINDOW: 2000,
    CHECK_STRIDE: 50,
    PARA_MIN_LEN: 40,
    PARA_FINGERPRINT_LEN: 60,
    PARA_LOOP_THRESHOLD: 3,
    STAGNATION_WINDOW: 4,
    STAGNATION_THRESHOLD: 0.85,
    FILE_READ_LIMIT: 4,
    SEARCH_EXPAND_LIMIT: 3,
  };
  try {
    const extDir = dirname(fileURLToPath(import.meta.url));
    return { ...defaults, ...JSON.parse(readFileSync(join(extDir, "loop-police.json"), "utf-8")) };
  } catch {
    return defaults;
  }
})();

export default function (pi: ExtensionAPI) {
  let thinkingAborted = false;
  let cleanThinkingPrefix: string | null = null;
  let lastCheckedLen = 0;
  let loopType: "character" | "semantic" = "character";
  let toolHistory: string[] = [];
  let toolLoopTriggered = false;
  let thinkingHistory: string[] = [];
  let fileReadCounts = new Map<string, number>();
  let searchPatternPaths = new Map<string, Set<string>>();

  function reset() {
    thinkingAborted = false;
    cleanThinkingPrefix = null;
    lastCheckedLen = 0;
    loopType = "character";
    toolHistory = [];
    toolLoopTriggered = false;
    thinkingHistory = [];
    fileReadCounts = new Map();
    searchPatternPaths = new Map();
  }

  pi.on("agent_start", reset);

  pi.on("turn_start", () => {
    lastCheckedLen = 0;
    thinkingAborted = false;
    cleanThinkingPrefix = null;
    loopType = "character";
    toolLoopTriggered = false; // allow recovery turns to use tools
  });

  pi.on("message_update", (event, ctx) => {
    if (thinkingAborted || event.message.role !== "assistant") return;
    const thinking = extractThinking(event.message);
    if (!thinking || thinking.length < lastCheckedLen + cfg.CHECK_STRIDE) return;
    lastCheckedLen = thinking.length;
    if (thinking.length < cfg.MIN_THINKING_WINDOW * 2) return;

    let repeat = detectRepeatingSuffix(thinking);
    if (repeat) {
      loopType = "character";
    } else {
      repeat = detectSemanticLoop(thinking);
      if (repeat) loopType = "semantic";
    }
    if (!repeat) return;

    thinkingAborted = true;
    cleanThinkingPrefix = repeat.cleanPrefix;
    ctx.abort();
  });

  pi.on("message_end", (event, _ctx) => {
    if (event.message.role !== "assistant") return;

    if (thinkingAborted) {
      const prefix = cleanThinkingPrefix ?? "";
      thinkingAborted = false;
      cleanThinkingPrefix = null;
      lastCheckedLen = 0;

      const isSemantic = loopType === "semantic";
      const label = isSemantic
        ? "[SEMANTIC LOOP — truncated by loop-police]"
        : "[THINKING LOOP — truncated by loop-police]";
      const advice = isSemantic
        ? "⚠️ SEMANTIC LOOP DETECTED: Your thinking block was cycling through the same reasoning steps repeatedly. The repeated section has been truncated. Step back and try a completely different approach."
        : "⚠️ THINKING LOOP DETECTED: Your thinking block was repeating the same phrases verbatim and has been truncated. Re-examine your approach and continue with the task.";

      const cleaned = replaceThinking(event.message, `${prefix}\n\n${label}`);
      pi.sendMessage(
        { customType: "loop-police", content: advice, display: true },
        { triggerTurn: true }
      );
      return { message: cleaned };
    }

    // Cross-turn stagnation: only run on clean (non-aborted) turns
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
              content: `⚠️ REASONING STAGNATION: Your thinking across the last ${cfg.STAGNATION_WINDOW} turns has been ${Math.round(cfg.STAGNATION_THRESHOLD * 100)}%+ similar — you are not making progress. Stop and try a fundamentally different approach.`,
              display: true,
            },
            { triggerTurn: true }
          );
        }
      }
    }
  });

  pi.on("tool_call", (event, ctx) => {
    // File read repetition
    if (isReadTool(event.toolName)) {
      const path = getInputPath(event.input);
      if (path) {
        const count = (fileReadCounts.get(path) ?? 0) + 1;
        fileReadCounts.set(path, count);
        if (count >= cfg.FILE_READ_LIMIT) {
          ctx.ui.notify(`⚠️ FILE READ LOOP: "${path}" read ${count}x — blocked`, "warning");
          pi.sendMessage(
            {
              customType: "loop-police",
              content: `⚠️ FILE READ LOOP: "${path}" has been read ${count} times. Reading it again will not yield new information — use what you already know and move forward.`,
              display: true,
            },
            { triggerTurn: true }
          );
          return { block: true, reason: `loop-police: file read ${count}x — ${path}` };
        }
      }
    }

    // Search expansion spiral
    if (isSearchTool(event.toolName)) {
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
              content: `⚠️ SEARCH EXPANSION SPIRAL: Pattern "${pattern}" has been searched in ${paths.size} different locations. Broadening the scope further will not help — reconsider what you are looking for.`,
              display: true,
            },
            { triggerTurn: true }
          );
          return { block: true, reason: `loop-police: search spiral "${pattern}" ×${paths.size} paths` };
        }
      }
    }

    // Tool call sequence loop
    if (toolLoopTriggered) {
      return { block: true, reason: "loop-police: still in tool call loop" };
    }

    const hash = hashToolCall(event.toolName, event.input);
    const candidate = [...toolHistory, hash];
    const windowSize = detectSequenceRepeat(candidate);

    if (windowSize > 0) {
      toolLoopTriggered = true;
      ctx.ui.notify(`⚠️ TOOL LOOP: ${windowSize}-call sequence repeating — blocked`, "warning");
      pi.sendMessage(
        {
          customType: "loop-police",
          content: `⚠️ TOOL CALL LOOP: The same sequence of ${windowSize} tool call(s) is repeating identically. The repeated call has been blocked — your current strategy is not working, reconsider your approach entirely.`,
          display: true,
        },
        { triggerTurn: true }
      );
      return { block: true, reason: `loop-police: ${windowSize}-call sequence repeating` };
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
        const results: string[] = [];
        for (const pair of trimmed.slice(4).trim().split(/\s+/)) {
          const eq = pair.indexOf("=");
          const key = pair.slice(0, eq);
          const val = pair.slice(eq + 1);
          if (eq > 0 && key in cfg && val !== "") {
            (cfg as any)[key] = parseFloat(val);
            results.push(`${key}=${(cfg as any)[key]}`);
          } else {
            results.push(`unknown: ${key}`);
          }
        }
        ctx.ui.notify(`Loop Police: ${results.join(", ")}`, "info");
        return;
      }

      ctx.ui.notify(
        [
          "Loop Police status",
          `  thinking aborted:    ${thinkingAborted}`,
          `  tool history:        ${toolHistory.length} calls`,
          `  tool loop triggered: ${toolLoopTriggered}`,
          `  stagnation history:  ${thinkingHistory.length}/${cfg.STAGNATION_WINDOW} turns`,
          `  file reads tracked:  ${fileReadCounts.size} paths`,
          `  search patterns:     ${searchPatternPaths.size} patterns`,
          "",
          "  config (set KEY=VAL to change):",
          ...Object.entries(cfg).map(([k, v]) => `    ${k}=${v}`),
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

function jaccard(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 1 : inter / union;
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

function detectSemanticLoop(text: string): { cleanPrefix: string } | null {
  const counts = new Map<string, number>();
  let searchFrom = 0;
  for (const para of text.split(/\n\n+/)) {
    const paraStart = text.indexOf(para, searchFrom);
    if (paraStart === -1) continue;
    searchFrom = paraStart + para.length;
    const trimmed = para.trim();
    if (trimmed.length >= cfg.PARA_MIN_LEN) {
      const key = trimmed.slice(0, cfg.PARA_FINGERPRINT_LEN);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count >= cfg.PARA_LOOP_THRESHOLD) {
        return { cleanPrefix: text.slice(0, paraStart) };
      }
    }
  }
  return null;
}

function detectRepeatingSuffix(text: string): { cleanPrefix: string } | null {
  const n = text.length;
  const limit = Math.min(cfg.MAX_THINKING_WINDOW, Math.floor(n / 2));
  for (let w = cfg.MIN_THINKING_WINDOW; w <= limit; w++) {
    const tail = text.slice(n - w);
    const prev = text.slice(n - 2 * w, n - w);
    if (prev.length === w && tail === prev) {
      return { cleanPrefix: text.slice(0, n - w) };
    }
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
