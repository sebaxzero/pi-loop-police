---
name: loop-police-help
description: "Reference for pi-loop-police: commands, config keys, and how to persistently edit loop-police.json."
homepage: https://github.com/sebaxzero/pi-loop-police
license: MIT
---

# Loop Police Help

pi-loop-police detects and interrupts infinite thinking-block and tool-call
loops in real time before they exhaust your context window.

## What it detects

- **Thinking loop**: thinking block repeating the same phrases verbatim
- **Semantic loop**: thinking block cycling through the same paragraphs
- **Output loop**: visible response text repeating the same content verbatim
- **Output semantic loop**: visible response cycling through the same paragraphs
- **Stagnation**: thinking across N turns is 85%+ similar (Jaccard)
- **File read loop**: same file + same line range read ≥ FILE_READ_LIMIT times in one session
- **File read ceiling**: same file read ≥ FILE_SCAN_LIMIT times in total, across all line ranges
- **Search spiral**: same pattern searched across ≥ SEARCH_EXPAND_LIMIT paths
- **Tool call loop**: identical sequence of tool calls repeating
- **Consecutive loop**: stream loop aborted N turns in a row (escalated warning)

## Commands

| Command | What it does |
|---------|-------------|
| `/loop-police` | Show current status and config |
| `/loop-police reset` | Clear all loop state (tool history, file reads, stagnation buffer) |
| `/loop-police set KEY=VAL` | Change one or more keys for this session only |

## Config keys

| Key | Default | What it controls |
|-----|---------|-----------------|
| `THINKING_WINDOW` | `80` | Shortest repeating block flagged in the thinking stream (chars) |
| `OUTPUT_WINDOW` | `100` | Shortest repeating block flagged in the response text (chars) |
| `MAX_WINDOW` | `4000` | Longest repeating block checked (char-level, both streams) |
| `STRIDE` | `50` | Check every N new characters during streaming |
| `PARA_MIN_LEN` | `40` | Minimum paragraph length to fingerprint for semantic loop |
| `FINGERPRINT_LEN` | `60` | Characters used as paragraph fingerprint |
| `SEMANTIC_THRESHOLD` | `3` | Same fingerprint N times → semantic loop (thinking and output) |
| `STAGNATION_WINDOW` | `4` | Turns of thinking history to compare |
| `STAGNATION_THRESHOLD` | `0.85` | Jaccard similarity threshold for stagnation |
| `FILE_READ_LIMIT` | `4` | Block reads of the same path + line range at or above this count |
| `FILE_SCAN_LIMIT` | `15` | Block reads of the same path at or above this total count (all ranges) |
| `SEARCH_EXPAND_LIMIT` | `3` | Block search pattern at or above this many paths |
| `CONSECUTIVE_LOOP_LIMIT` | `2` | Escalated warning after N stream-loop aborts in a row (across turns) |
| `TOOL_LOOP_BAN` | `1` | `0` = off; `1` = block identical call only while repeated back-to-back; `2` = ban that exact call for the rest of the session |
| `TOOL_LOOP_EXEMPT` | `""` | Comma-separated tool names exempt from the tool call loop detector (case-insensitive exact match, e.g. `bash,run_tests`); exempt calls are never blocked but still break adjacency for other tools |
| `HOOK_CMD` | `""` | External command run fire-and-forget on every detection with the JSON payload as its last argument (split on whitespace, no shell — e.g. `node /path/hook.mjs`); observational only, never affects detection |
| `HOOK_TIMEOUT_MS` | `5000` | `HOOK_CMD` is killed after this many ms |
| `HOOK_LOG` | `""` | Path to a JSONL file; one payload line appended per detection (relative paths resolve against the session cwd) |

Setting a detector's key to `0` disables it: `THINKING_WINDOW=0` (char thinking loop), `OUTPUT_WINDOW=0` (char output loop), `SEMANTIC_THRESHOLD=0` (semantic loop, both streams), `STAGNATION_WINDOW=0` (stagnation), `FILE_READ_LIMIT=0` (file read loop), `FILE_SCAN_LIMIT=0` (file read ceiling), `SEARCH_EXPAND_LIMIT=0` (search spiral), `CONSECUTIVE_LOOP_LIMIT=0` (escalated warning), `TOOL_LOOP_BAN=0` (tool call loop).

Pre-1.8.0 configs used other names (`MIN_THINKING_WINDOW`, `MIN_OUTPUT_WINDOW`, `MAX_THINKING_WINDOW`, `CHECK_STRIDE`, `PARA_FINGERPRINT_LEN`, `PARA_LOOP_THRESHOLD`) — they are migrated automatically on load.

## Message templates

The recovery messages injected on detection are also config keys (`MSG_*` in
`loop-police.json`) — edit them to tune the wording per model. They are not
settable via `/loop-police set`. `{placeholders}` are filled at runtime:

| Key | Placeholders |
|-----|-------------|
| `MSG_THINKING_LOOP` | — |
| `MSG_SEMANTIC_LOOP` | — |
| `MSG_OUTPUT_LOOP` | — |
| `MSG_OUTPUT_SEMANTIC_LOOP` | — |
| `MSG_CONSECUTIVE_LOOP` | `{count}` |
| `MSG_STAGNATION` | `{window}` `{threshold}` |
| `MSG_FILE_READ_LOOP` | `{path}` `{count}` |
| `MSG_FILE_SCAN_LOOP` | `{path}` `{count}` |
| `MSG_SEARCH_SPIRAL` | `{pattern}` `{paths}` |
| `MSG_TOOL_LOOP` | `{windowSize}` |
| `MSG_SUFFIX` | — (appended to every recovery message; empty by default — use it to point the model at an advisor extension/tool on any detection) |

## Changing config

**Session only** (lost on restart):
```
/loop-police set FILE_READ_LIMIT=6
/loop-police set STAGNATION_WINDOW=6 STAGNATION_THRESHOLD=0.9
```

**Persistent** (survives restarts): edit `loop-police.json` in the extensions directory.

The config lives next to the extension file and is auto-created on first load — look in these locations:

1. **NPM install** (check `~/.pi/agent/npm/package.json`):
   - `~/.pi/agent/npm/node_modules/pi-loop-police/extensions/loop-police.json`
2. **Git install**:
   - `~/.pi/agent/git/github.com/sebaxzero/pi-loop-police/extensions/loop-police.json`
3. **Extensions directory**:
   - `~/.pi/agent/extensions/pi-loop-police/extensions/loop-police.json`
4. **Local install** (in the project, same structure as global but relative):
   - `./.pi/agent/npm/node_modules/pi-loop-police/extensions/loop-police.json` (npm)
   - `./.pi/agent/git/github.com/sebaxzero/pi-loop-police/extensions/loop-police.json` (git)
   - `./.pi/agent/extensions/pi-loop-police/extensions/loop-police.json` (direct)

Example `loop-police.json`:
```json
{
  "FILE_READ_LIMIT": 6,
  "SEARCH_EXPAND_LIMIT": 4
}
```

Only include the keys you want to override — missing keys use the defaults above.

## Detection hooks

Every detection emits a JSON payload (`event`, `timestamp`, `model`, `sessionId`, `sessionFile`, `cwd`, `turnIndex`, `consecutiveLoops`, `details`) to three observer channels, none of which can affect detection or recovery:

- **`loop-police:detection`** on pi's extension event bus — always on; other extensions subscribe with `pi.events.on("loop-police:detection", handler)`.
- **`HOOK_CMD`** — external command per detection, payload as last argument (any language; see `examples/hook.mjs` in the repo).
- **`HOOK_LOG`** — JSONL append per detection; ideal for stats like which model/detector fires most (`jq -r '"\(.model.id) \(.event)"' file | sort | uniq -c`).

The `event` field matches the detector: `thinking_loop`, `semantic_loop`, `output_loop`, `output_semantic_loop`, `stagnation`, `file_read_loop`, `file_scan_loop`, `search_spiral`, `tool_loop`. See the README's "Detection hooks" section for the full payload schema and per-event `details`.
