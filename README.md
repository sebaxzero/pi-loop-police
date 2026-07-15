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
| **File read loop** | the same file path + line range is read 4 times | tool call blocked |
| **File read ceiling** | the same file path is read 15 times total, across all ranges | tool call blocked |
| **Search spiral** | the same pattern is searched in 3 different locations | tool call blocked |
| **Tool call loop** | an identical sequence of tool calls repeats back-to-back | tool call blocked in place |

### Streaming loops (thinking and output)

Both streams — the thinking block and the visible response — run the same two detectors as the text arrives, re-checked every 50 new characters (`STRIDE`):

- **Character-level**: fires when the text ends in two adjacent, verbatim copies of a block between `THINKING_WINDOW`/`OUTPUT_WINDOW` (80/100) and `MAX_WINDOW` (4000) characters — the model is re-emitting the same content word for word. Detection is a single O(length) pass, so it stays cheap even on very long streams.
- **Semantic**: every paragraph is fingerprinted by its first `FINGERPRINT_LEN` (60) characters; when the same fingerprint shows up `SEMANTIC_THRESHOLD` (3) times, the model is cycling through the same reasoning even if the wording drifts between passes or other text sits in between. Paragraphs inside ``` code fences are skipped — repeated code structure is legitimate, especially in answers.

The semantic layer is what catches loops early: repeats rarely stay perfectly verbatim, so the character-level check alone can take many extra cycles (or never fire if the repeating unit is huge). With both layers, a loop is typically caught on its third repetition regardless of how the wording mutates.

On detection the stream is aborted immediately, the repeated portion is replaced with a marker — `[THINKING LOOP — truncated by loop-police]`, `[SEMANTIC LOOP — …]`, `[OUTPUT LOOP — …]` or `[SEMANTIC OUTPUT LOOP — …]` — and a recovery message is injected that starts a new turn. If the model loops several turns in a row, the message escalates (`CONSECUTIVE_LOOP_LIMIT`).

### Cross-turn stagnation

Some models never loop within a turn but still spin their wheels: each turn's thinking is a light rephrasing of the previous one. After each clean turn the thinking text is stored; when the last `STAGNATION_WINDOW` (4) turns are all ≥ `STAGNATION_THRESHOLD` (85%) word-similar to their neighbor, a recovery message tells the model to change approach.

### File read repetition

If a tool call looks like a file read (`read`, `view`, `cat`, …) and the same path **with the same line range** (`offset`/`limit`, `start_line`/`end_line`, …) has already been read `FILE_READ_LIMIT` (4) times, the call is blocked — re-reading the same range will not produce new information. Paging through a large file in chunks is *not* a loop: each distinct range gets its own counter, so legitimate chunked reads never trip this detector.

A second, generous ceiling covers the pathological complement: `FILE_SCAN_LIMIT` (15) blocks once the same path has been read that many times **in total across all ranges** — the model that keeps re-scanning one file with ever-different offsets instead of searching it. Raise either limit for workflows where heavy re-reading is legitimate, or run `/loop-police reset` to clear the counters mid-session.

### Search expansion spiral

Tracks how many distinct paths each search pattern (`grep`, `glob`, `find`, …) has been applied to. At `SEARCH_EXPAND_LIMIT` (3) different locations for the same pattern, the call is blocked: the model is widening its search instead of acting on what it already found.

### Tool call sequence loop

Each tool call is hashed (`name` + arguments) into a history, and the extension checks whether the last *W* calls exactly repeat the *W* calls before them — any cycle length, not just single calls. On match, the repeated call is **blocked in place**: it does not run, and the recovery message is handed back as that tool's result in the same turn, so the model must pivot immediately while every *other* tool stays available.

Because detection requires *adjacent* repetition, an interleaved different action breaks it: `build → edit → build` never trips, so legitimate re-runs after real changes are fine.

Two knobs adjust this detector:

- `TOOL_LOOP_BAN: 2` makes blocks **permanent per call** — once a specific call loops, that exact call stays blocked for the rest of the session (stronger against stubborn models, but it also blocks legitimate later re-runs). `1` (default) blocks only while the call is repeated back-to-back; `0` disables the detector.
- `TOOL_LOOP_EXEMPT` — comma-separated tool names (case-insensitive) that are never blocked, e.g. `"bash,run_tests"` for polling a build or re-running a flaky test. Exempt calls still enter the history, so they keep breaking adjacency for other tools.

## Commands

```
/loop-police                          — show current detection state and all config values
/loop-police reset                    — clear all state (useful if a false positive fires)
/loop-police set KEY=VAL [KEY=VAL …]  — tune config values live, no restart needed
```

Example: `/loop-police set FILE_READ_LIMIT=6 STAGNATION_WINDOW=5`

Changes made with `set` last for the session; persistent changes go in `loop-police.json` (see below).

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
FILE_READ_LIMIT: 4          // reads of the same file path + line range before blocking
FILE_SCAN_LIMIT: 15         // total reads of the same path (all ranges) before blocking
SEARCH_EXPAND_LIMIT: 3      // distinct paths for the same search pattern before blocking
CONSECUTIVE_LOOP_LIMIT: 2   // looped turns in a row before the message escalates
TOOL_LOOP_BAN: 1            // 0 = off · 1 = block while repeated back-to-back · 2 = session ban
TOOL_LOOP_EXEMPT: ""        // tool names exempt from the tool call loop detector
```

Tuning rules of thumb:

- False positives on thinking/output loops → raise `THINKING_WINDOW`/`OUTPUT_WINDOW` (char-level) or `SEMANTIC_THRESHOLD`/`FINGERPRINT_LEN` (semantic).
- Structured answers with legitimately similar paragraph openings (checklists, per-file reports) → raise `FINGERPRINT_LEN` so fingerprints capture more of each paragraph.
- Projects where re-reading files is normal → raise `FILE_READ_LIMIT` (same range) or `FILE_SCAN_LIMIT` (total per file); monorepos → raise `SEARCH_EXPAND_LIMIT`.
- Loops caught too late → lower `SEMANTIC_THRESHOLD` to 2 (more sensitive, more false-positive prone).

### Disabling individual detectors

Setting a detector's key to `0` turns it off entirely:

| Key = 0 | Disables |
|---------|----------|
| `THINKING_WINDOW=0` | character-level thinking loop |
| `OUTPUT_WINDOW=0` | character-level output loop |
| `SEMANTIC_THRESHOLD=0` | semantic loop (thinking **and** output) |
| `STAGNATION_WINDOW=0` | cross-turn stagnation |
| `FILE_READ_LIMIT=0` | file read loop |
| `FILE_SCAN_LIMIT=0` | file read ceiling |
| `SEARCH_EXPAND_LIMIT=0` | search expansion spiral |
| `CONSECUTIVE_LOOP_LIMIT=0` | escalated consecutive-loop message |
| `TOOL_LOOP_BAN=0` | tool call sequence loop |

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
| `MSG_FILE_READ_LOOP` | same file + line range read too many times | `{path}` `{count}` |
| `MSG_FILE_SCAN_LOOP` | same file read too many times in total (all ranges) | `{path}` `{count}` |
| `MSG_SEARCH_SPIRAL` | search pattern spread across too many paths | `{pattern}` `{paths}` |
| `MSG_TOOL_LOOP` | identical tool-call sequence repeating | `{windowSize}` |
| `MSG_SUFFIX` | appended to **every** message above (empty by default) | — |

`{placeholder}` tokens are substituted at runtime; unknown tokens are left as-is so a typo stays visible. Messages are edited in `loop-police.json` only — `/loop-police set` handles numeric keys (plus `TOOL_LOOP_EXEMPT`) and will refuse a `MSG_*` key.

`MSG_SUFFIX` rides along with every detection without rewriting each template — the typical use is pointing the model at an advisor extension or tool to consult once a loop is caught:

```json
{
  "MSG_SUFFIX": "Before continuing, consult the advisor extension: run /advisor with a one-line summary of what you were stuck on."
}
```

## Skills

Two skills ship with the extension:

- **loop-police-help** — reference card: commands, config keys, and where the persistent `loop-police.json` lives for each install type.
- **loop-police-postmortem** — asks the agent to analyze the loop-police detections in the current session: reconstruct what triggered each firing, classify it (justified / false positive / justified-but-ineffective), and recommend config changes where tuning could have avoided it. Trigger it with things like *"why did loop-police fire?"*, *"was that a false positive?"*, or *"do a loop post-mortem"*.

## Upgrading

Config migrations are automatic — your customized values are preserved and the file is re-stamped, once:

- **From < 1.8.0**: the stream-detector keys were renamed (`MIN_THINKING_WINDOW` → `THINKING_WINDOW`, `MIN_OUTPUT_WINDOW` → `OUTPUT_WINDOW`, `MAX_THINKING_WINDOW` → `MAX_WINDOW`, `CHECK_STRIDE` → `STRIDE`, `PARA_FINGERPRINT_LEN` → `FINGERPRINT_LEN`, `PARA_LOOP_THRESHOLD` → `SEMANTIC_THRESHOLD`). Customized values are carried over to the new names; values you never touched pick up the new defaults (notably `MAX_WINDOW` grew from 2000 to 4000).
- **From < 1.5.0**: the `TOOL_LOOP_BAN` scale shifted by one (old `0` = temporary → new `1`, old `1` = permanent → new `2`; `0` now means off). The stored value is bumped to preserve the behavior you had.

## Compatibility

Designed for OpenAI-compatible reasoning models (Qwen3, DeepSeek-R1, etc.) used via pi. Pi normalizes all provider thinking formats to `{ type: "thinking", thinking: string }` content blocks, so this extension works regardless of the underlying provider.

Works alongside [pi-canary](https://github.com/sebaxzero/pi-canary), which silently verifies agent context awareness using hidden canary tokens. When loop-police aborts a turn, pi-canary yields gracefully and does not fire its own recovery.

## License

MIT
