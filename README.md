# pi-loop-police

[![npm](https://img.shields.io/npm/v/pi-loop-police)](https://www.npmjs.com/package/pi-loop-police)

A [pi](https://pi.dev) extension that detects and breaks infinite loops in real time — before they waste your context window.

Reasoning models (especially small local ones like Qwen or DeepSeek) get stuck in characteristic ways: repeating the same phrases inside the thinking block, re-emitting the same paragraph in the visible answer, re-reading the same file over and over, or cycling through an identical sequence of tool calls until the context runs out. Loop Police watches for all of it **as it happens**: it aborts looping output mid-stream, trims the repetition out of your context, and injects a recovery message so the model continues with a fresh perspective — you keep the tokens the loop would have burned.

## Install

From npm:

```bash
pi install npm:pi-loop-police
```

Or from git:

```bash
pi install git:github.com/sebaxzero/pi-loop-police.git
```

Add `-l` to either form to install project-locally (adds to `.pi/settings.json` only).

No dependencies, no build step, nothing to configure — it starts protecting the session as soon as it loads. Everything below is optional tuning.

## What it detects

Nine detectors, all enabled out of the box:

| Detector | Fires when | What happens |
|----------|-----------|--------------|
| **Thinking loop** | the thinking block ends in the same ≥ 80 chars twice in a row | stream aborted, repetition truncated, recovery message |
| **Semantic loop** | the same paragraph appears 3 times in the thinking block | same |
| **Output loop** | the visible answer ends in the same ≥ 100 chars twice in a row | same |
| **Output semantic loop** | the same paragraph appears 3 times in the visible answer | same |
| **Stagnation** | thinking across the last 4 turns is ≥ 85% similar | recovery message |
| **File read ceiling** | the same file path is read 20 times total (only reads that actually ran count) | tool call blocked |
| **Search spiral** | the same pattern is searched in 3 different locations | tool call blocked |
| **Tool call loop** | an identical sequence of tool calls repeats back-to-back | tool call blocked in place |
| **Re-derived reasoning** | right after any detection, the model's thinking re-derives the same reasoning that led to it (≥ 85% similar) | reasoning trimmed from context, recovery message |

### Streaming loops (thinking and output)

Both streams — the thinking block and the visible response — run the same two detectors as the text arrives, re-checked every 50 new characters (`STRIDE`):

- **Character-level**: fires when the text ends in two adjacent, verbatim copies of a block between `THINKING_WINDOW`/`OUTPUT_WINDOW` (80/100) and `MAX_WINDOW` (4000) characters — the model is re-emitting the same content word for word. Detection is a single O(length) pass, so it stays cheap even on very long streams.
- **Semantic**: every paragraph is fingerprinted by its first `FINGERPRINT_LEN` (60) characters; when the same fingerprint shows up `SEMANTIC_THRESHOLD` (3) times, the model is cycling through the same reasoning even if the wording drifts between passes or other text sits in between. Paragraphs inside ``` code fences are skipped — repeated code structure is legitimate, especially in answers.

The semantic layer is what catches loops early: repeats rarely stay perfectly verbatim, so the character-level check alone can take many extra cycles (or never fire if the repeating unit is huge). With both layers, a loop is typically caught on its third repetition regardless of how the wording mutates.

On detection the stream is aborted immediately, the repeated portion is replaced with a marker — `[THINKING LOOP — truncated by loop-police]`, `[SEMANTIC LOOP — …]`, `[OUTPUT LOOP — …]` or `[SEMANTIC OUTPUT LOOP — …]` — and a recovery message is injected that starts a new turn. If the model loops several turns in a row, the message escalates (`CONSECUTIVE_LOOP_LIMIT`).

### Cross-turn stagnation

Some models never loop within a turn but still spin their wheels: each turn's thinking is a light rephrasing of the previous one. After each clean turn the thinking text is stored; when the last `STAGNATION_WINDOW` (4) turns are all ≥ `STAGNATION_THRESHOLD` (85%) word-similar to their neighbor, a recovery message tells the model to change approach.

### File read ceiling

Identical re-reads are the tool call sequence detector's job (below): reading the same file with the same arguments again is just a repeated tool call, blocked in place on the second back-to-back attempt. What remains for a dedicated file detector is the per-path complement: if a tool call looks like a file read (`read`, `view`, `cat`, …), `FILE_SCAN_LIMIT` (20) blocks once the same path has been read that many times **in total across all line ranges** — the model that keeps coming back to one file with ever-different offsets instead of searching it.

Only reads that **actually ran** count toward the ceiling. A call blocked by any detector never reached the file, so it does not spend the budget and never inflates the reported count. That keeps the legitimate reference pattern safe by construction: read a hot file, edit something else, re-read it, edit again — the interleaved different work means the sequence detector never fires, and each pass costs exactly one real read out of 20. Raise the limit for workflows where heavy re-reading is legitimate, or run `/loop-police reset` to clear the counters mid-session.

### Search expansion spiral

Tracks how many distinct paths each search pattern (`grep`, `glob`, `find`, …) has been applied to. At `SEARCH_EXPAND_LIMIT` (3) different locations for the same pattern, the call is blocked: the model is widening its search instead of acting on what it already found.

### Tool call sequence loop

Each tool call is hashed (`name` + arguments) into a history, and the extension checks whether the last *W* calls exactly repeat the *W* calls before them — any cycle length, not just single calls. On match, the repeated call is **blocked in place**: it does not run, and the recovery message is handed back as that tool's result in the same turn, so the model must pivot immediately while every *other* tool stays available.

Because detection requires *adjacent* repetition, an interleaved different action breaks it: `build → edit → build` never trips, so legitimate re-runs after real changes are fine.

Two knobs adjust this detector:

- `TOOL_LOOP_BAN: 2` makes blocks **permanent per call** — once a specific call loops, that exact call stays blocked for the rest of the session (stronger against stubborn models, but it also blocks legitimate later re-runs). `1` (default) blocks only while the call is repeated back-to-back; `0` disables the detector.
- `TOOL_LOOP_EXEMPT` — comma-separated tool names (case-insensitive) that are never blocked, e.g. `"bash,run_tests"` for polling a build or re-running a flaky test. Exempt calls still enter the history, so they keep breaking adjacency for other tools.

### Re-derived reasoning guard

Blocking an action doesn't remove the reasoning that produced it. Larger models read a block message and pivot; small models re-read their own stale plan in context, arrive at the same conclusion, and try the exact same thing again — block, re-derive, retry, forever.

So after **any** detection fires, the guard watches the model's next message: if its thinking is ≥ `REDERIVE_THRESHOLD` (85%) Jaccard-similar to the reasoning that led to the detection, that thinking is **excised from context** — replaced with `[REDERIVED REASONING — trimmed by loop-police: …]` — and a recovery message tells the model not to reconstruct it and to take a different action, delegate, or ask the user. The guard stays armed after a trim, so re-deriving the same plan again escalates to a `⚠️ STUCK ({count}x)` message instead of cycling silently. Genuinely different reasoning disarms it.

This is the fix for the "stuck on reasoning loops" failure mode ([#8](https://github.com/sebaxzero/pi-loop-police/issues/8)): interrupting the *action* is not enough for small models — the reasoning itself has to go.

## Commands

```
/loop-police                          — show current detection state and all config values
/loop-police reset                    — clear all state (useful if a false positive fires)
/loop-police set KEY=VAL [KEY=VAL …]  — tune config values live, no restart needed
/loop-police save                     — write the current config to loop-police.json
```

Example: `/loop-police set FILE_SCAN_LIMIT=30 STAGNATION_WINDOW=5`

Changes made with `set` last for the session; `save` persists them to `loop-police.json` (see below).

## Configuration

Persistent configuration lives in `extensions/loop-police.json` next to the installed extension (auto-created on first load). You can ask the agent to edit it, or tune values live with `/loop-police set`.

```typescript
THINKING_WINDOW: 80         // char-level: shortest repeating block flagged in thinking
OUTPUT_WINDOW: 100          // char-level: shortest repeating block flagged in the response
MAX_WINDOW: 4000            // char-level: longest repeating block checked (both streams)
STRIDE: 50                  // re-run stream detection every N new characters
PARA_MIN_LEN: 40            // semantic: shorter paragraphs are ignored
FINGERPRINT_LEN: 60         // semantic: chars used as paragraph identity key
SEMANTIC_THRESHOLD: 3       // semantic: same fingerprint N times → loop (both streams)
STAGNATION_WINDOW: 4        // turns of similar thinking → stagnation
STAGNATION_THRESHOLD: 0.85  // similarity threshold for stagnation (Jaccard)
FILE_SCAN_LIMIT: 20         // real (non-blocked) reads of the same path before blocking
SEARCH_EXPAND_LIMIT: 3      // distinct paths for the same search pattern before blocking
CONSECUTIVE_LOOP_LIMIT: 2   // looped turns in a row before the message escalates
TOOL_LOOP_BAN: 1            // 0 = off · 1 = block while repeated back-to-back · 2 = session ban
TOOL_LOOP_EXEMPT: ""        // tool names exempt from the tool call loop detector
REDERIVE_THRESHOLD: 0.85    // post-detection thinking this similar to the blocked plan is trimmed
HOOK_CMD: ""                // external command run on every detection (see Detection hooks)
HOOK_TIMEOUT_MS: 5000       // HOOK_CMD is killed after this many ms
HOOK_LOG: ""                // JSONL file appended on every detection (see Detection hooks)
```

Tuning rules of thumb:

- False positives on thinking/output loops → raise `THINKING_WINDOW`/`OUTPUT_WINDOW` (char-level) or `SEMANTIC_THRESHOLD`/`FINGERPRINT_LEN` (semantic).
- Structured answers with legitimately similar paragraph openings (checklists, per-file reports) → raise `FINGERPRINT_LEN` so fingerprints capture more of each paragraph.
- Projects where re-reading files is normal → raise `FILE_SCAN_LIMIT` (total per file); monorepos → raise `SEARCH_EXPAND_LIMIT`.
- Loops caught too late → lower `SEMANTIC_THRESHOLD` to 2 (more sensitive, more false-positive prone).

### Disabling individual detectors

Setting a detector's key to `0` turns it off entirely:

| Key = 0 | Disables |
|---------|----------|
| `THINKING_WINDOW=0` | character-level thinking loop |
| `OUTPUT_WINDOW=0` | character-level output loop |
| `SEMANTIC_THRESHOLD=0` | semantic loop (thinking **and** output) |
| `STAGNATION_WINDOW=0` | cross-turn stagnation |
| `FILE_SCAN_LIMIT=0` | file read ceiling |
| `SEARCH_EXPAND_LIMIT=0` | search expansion spiral |
| `CONSECUTIVE_LOOP_LIMIT=0` | escalated consecutive-loop message |
| `TOOL_LOOP_BAN=0` | tool call sequence loop |
| `REDERIVE_THRESHOLD=0` | re-derived reasoning guard |

### Customizing recovery messages

The text injected when a loop is detected is configurable — some models respond better to different phrasing. These live alongside the numeric config in `loop-police.json` as `MSG_*` keys:

| Key | Fired when | Placeholders |
|-----|-----------|--------------|
| `MSG_THINKING_LOOP` | character-level thinking loop | — |
| `MSG_SEMANTIC_LOOP` | semantic thinking loop | — |
| `MSG_OUTPUT_LOOP` | character-level output loop | — |
| `MSG_OUTPUT_SEMANTIC_LOOP` | semantic output loop | — |
| `MSG_CONSECUTIVE_LOOP` | `CONSECUTIVE_LOOP_LIMIT` looped turns in a row | `{count}` |
| `MSG_STAGNATION` | cross-turn reasoning stagnation | `{window}` `{threshold}` |
| `MSG_FILE_SCAN_LOOP` | same file read too many times in total (all ranges) | `{path}` `{count}` |
| `MSG_SEARCH_SPIRAL` | search pattern spread across too many paths | `{pattern}` `{paths}` |
| `MSG_TOOL_LOOP` | identical tool-call sequence repeating | `{windowSize}` |
| `MSG_REDERIVED` | post-detection reasoning re-derived and trimmed | — |
| `MSG_STUCK` | the same blocked plan re-derived `{count}` times in a row | `{count}` |
| `MSG_SUFFIX` | appended to **every** message above (empty by default) | — |

`{placeholder}` tokens are substituted at runtime; unknown tokens are left as-is so a typo stays visible. Messages are edited in `loop-police.json` only — `/loop-police set` handles numeric keys (plus `TOOL_LOOP_EXEMPT`) and will refuse a `MSG_*` key.

`MSG_SUFFIX` rides along with every detection without rewriting each template — the typical use is pointing the model at an advisor extension or tool to consult once a loop is caught:

```json
{
  "MSG_SUFFIX": "Before continuing, consult the advisor extension: run /advisor with a one-line summary of what you were stuck on."
}
```

## Detection hooks

Every detection also emits a structured payload to up to three observer channels, so you can build notifications, debugging artifacts, or analytics on top of loop-police without touching it. All three are purely observational: they can never block, delay, or alter detection and recovery.

The payload:

```json
{
  "event": "tool_loop",
  "timestamp": "2026-07-17T14:03:22.123Z",
  "model": { "id": "qwen3:14b", "name": "Qwen3 14B", "provider": "ollama" },
  "sessionId": "…",
  "sessionFile": "/path/to/session.jsonl",
  "cwd": "/path/to/project",
  "turnIndex": 12,
  "consecutiveLoops": 0,
  "details": { "toolName": "bash", "windowSize": 3, "banned": false }
}
```

`event` is one of `thinking_loop`, `semantic_loop`, `output_loop`, `output_semantic_loop`, `stagnation`, `file_scan_loop`, `search_spiral`, `tool_loop`, `rederived_reasoning`. `model` is `null` when no model is selected. `details` is event-specific: the stream loops carry `{ stream, kind, escalated }` (`escalated: true` when the consecutive-loop message fired), `stagnation` carries `{ window, threshold }`, `file_scan_loop` `{ toolName, path, count }`, `search_spiral` `{ toolName, pattern, paths }`, `tool_loop` `{ toolName, windowSize, banned }`, and `rederived_reasoning` `{ streak }`. The payload carries metadata only — never the thinking text or tool arguments; a hook that wants the transcript can read it from `sessionFile`.

### `HOOK_CMD` — run an external command

```
/loop-police set HOOK_CMD=node /path/to/hook.mjs
```

The command runs fire-and-forget on every detection with the JSON payload as its **last argument**, and is killed after `HOOK_TIMEOUT_MS` (5000). It is spawned directly without a shell — the JSON arrives verbatim no matter what it contains, and `HOOK_CMD` is split on whitespace into executable + fixed arguments (so interpreter forms like `python C:\hooks\loop.py` work everywhere; paths containing spaces are not supported). Exit code and output are ignored, but a failing hook shows a one-time warning per session so you notice while developing one.

Any language works:

```bash
#!/bin/bash                       # notify.sh — HOOK_CMD=/path/to/notify.sh
event=$(echo "$1" | jq -r .event)
notify-send "loop-police" "$event detected"
```

[`examples/hook.mjs`](examples/hook.mjs) is a ready-to-use hook that shows a desktop notification using only what the OS ships — a Windows toast, macOS `osascript`, or Linux `notify-send`; no npm packages, no external services. Copy it and point `HOOK_CMD` at it. Optionally set `LOOP_POLICE_NTFY_TOPIC` to also push to a phone via [ntfy.sh](https://ntfy.sh).

### `HOOK_LOG` — statistics with zero code

```
/loop-police set HOOK_LOG=/home/user/.pi/loop-stats.jsonl
```

Appends one payload line per detection (relative paths resolve against the session cwd). Point every project at the same absolute path and the answer to "which model and which detector fire the most" is a one-liner:

```bash
jq -r '"\(.model.id // "?") \(.event)"' loop-stats.jsonl | sort | uniq -c | sort -rn
```

`sessionId` and `turnIndex` in each line let you trace any detection back to the exact chat and turn; `sessionFile` points at the full transcript.

### `loop-police:detection` — the extension event bus

Other pi extensions can subscribe in-process, no config needed — loop-police always emits on pi's shared bus:

```typescript
pi.events.on("loop-police:detection", (payload) => { /* … */ });
```

This is the richest integration point: a listening extension has the full `ExtensionAPI`, so it can switch models, show UI, or send messages — things an external process cannot. [`examples/listener-extension.ts`](examples/listener-extension.ts) is a complete example that keeps a per-session loop counter in the status bar; copy it into your pi extensions directory to use it.

### Examples

- [pi-input-bar](https://github.com/sebaxzero/pi-input-bar) — subscribes to `loop-police:detection` and shows a per-session summary in the input editor's top border (`⚠ 10 loops (tool 7, think 3)`), grouped by detector family. Nothing is shown until a loop is caught, and the subscription is a no-op when loop-police isn't installed — a good template for optional integrations.

## Skills

Two skills ship with the extension:

- **loop-police-help** — reference card: commands, config keys, and where the persistent `loop-police.json` lives for each install type.
- **loop-police-postmortem** — asks the agent to analyze the loop-police detections in the current session: reconstruct what triggered each firing, classify it (justified / false positive / justified-but-ineffective), and recommend config changes where tuning could have avoided it. Trigger it with things like *"why did loop-police fire?"*, *"was that a false positive?"*, or *"do a loop post-mortem"*.

## Upgrading

Config migrations are automatic — your customized values are preserved and the file is re-stamped, once:

- **From < 1.12.0**: the same-range file read detector was removed — identical re-reads are blocked by the tool call sequence detector instead, and the ceiling now counts only reads that actually ran. `FILE_READ_LIMIT` and `MSG_FILE_READ_LOOP` are dropped from stored configs; a `FILE_SCAN_LIMIT` you never customized picks up the new default (15 → 20).
- **From < 1.8.0**: the stream-detector keys were renamed (`MIN_THINKING_WINDOW` → `THINKING_WINDOW`, `MIN_OUTPUT_WINDOW` → `OUTPUT_WINDOW`, `MAX_THINKING_WINDOW` → `MAX_WINDOW`, `CHECK_STRIDE` → `STRIDE`, `PARA_FINGERPRINT_LEN` → `FINGERPRINT_LEN`, `PARA_LOOP_THRESHOLD` → `SEMANTIC_THRESHOLD`). Customized values are carried over to the new names; values you never touched pick up the new defaults (notably `MAX_WINDOW` grew from 2000 to 4000).
- **From < 1.5.0**: the `TOOL_LOOP_BAN` scale shifted by one (old `0` = temporary → new `1`, old `1` = permanent → new `2`; `0` now means off). The stored value is bumped to preserve the behavior you had.

## Compatibility

Designed for OpenAI-compatible reasoning models (Qwen3, DeepSeek-R1, etc.) used via pi. Pi normalizes all provider thinking formats to `{ type: "thinking", thinking: string }` content blocks, so this extension works regardless of the underlying provider.

Works alongside [pi-canary](https://github.com/sebaxzero/pi-canary), which silently verifies agent context awareness using hidden canary tokens. When loop-police aborts a turn, pi-canary yields gracefully and does not fire its own recovery.

## License

MIT
