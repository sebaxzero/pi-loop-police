# pi-loop-police

[![test](https://github.com/sebaxzero/pi-loop-police/actions/workflows/test.yml/badge.svg)](https://github.com/sebaxzero/pi-loop-police/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/pi-loop-police)](https://www.npmjs.com/package/pi-loop-police)

A [pi](https://pi.dev) extension that detects and breaks infinite loops in real time — before they waste your context window.

Small reasoning models (Qwen, DeepSeek, etc.) are prone to three kinds of loops:

1. **Thinking block loop** — the model repeats the same phrases inside its `<think>` block over and over until the thinking quota is exhausted.
2. **Output text loop** — the same thing in the visible response: the model repeats a phrase or block verbatim in the answer itself, outside the thinking block.
3. **Tool call loop** — the model calls the same sequence of tools identically across turns, cycling indefinitely until the global context runs out.

Loop Police catches them **mid-stream** (not after the fact), aborts the looping output, trims it from context, and injects a recovery message so the model can continue with a fresh perspective.

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

## How it works

### Thinking loop detection (two layers, mid-stream)

**Layer 1 — character-level:** Every 50 streamed characters, the extension checks whether the last ≥ 80 characters of the thinking block appear verbatim immediately before them (exact adjacent repetition). This catches the fastest, most common form of loop mid-stream.

**Layer 2 — semantic-level:** Simultaneously, the thinking text is split into paragraphs and each paragraph is fingerprinted by its first 60 characters. If the same fingerprint appears 3 or more times, the model is cycling through the same reasoning steps even if the wording varies slightly between passes.

On match (either layer):

- `ctx.abort()` stops the stream immediately.
- `message_end` trims the repeated portion and replaces it with `[THINKING LOOP — truncated by loop-police]` or `[SEMANTIC LOOP — truncated by loop-police]`.
- A recovery message is injected into context and triggers a new turn.

### Output text loop detection (mid-stream)

The same character-level check runs on the **visible response text** (the `text` content blocks) as it streams, with its own minimum window (`MIN_OUTPUT_WINDOW`, default 100 — slightly stricter than thinking, since answers legitimately contain more structure). When the last ≥ 100 characters of the response repeat verbatim immediately before themselves, the stream is aborted, the repeated portion is replaced with `[OUTPUT LOOP — truncated by loop-police]`, and a recovery message (`MSG_OUTPUT_LOOP`) triggers a new turn.

### Cross-turn reasoning stagnation

After each clean (non-aborted) turn, the thinking text is stored. When the last N turns (default: 4) all have Jaccard word-set similarity ≥ 85% with their neighbor, the model is spinning without progress even though no single turn tripped the within-turn detectors. A recovery message is injected and the stagnation window is cleared.

### File read repetition

Before each tool call, if the tool name looks like a file-read (`read`, `view`, `cat`, etc.) and the same path has been read 4 or more times, the call is blocked and a recovery message is injected.

### Search expansion spiral

Before each search tool call (`grep`, `search`, `find`, `glob`, `rg`, etc.), the extension tracks how many distinct paths a given search pattern has been applied to. When the same pattern reaches 3 or more different paths, the call is blocked — the model is widening its search rather than acting on what it already found.

### Tool call sequence loop

Before each tool executes, the extension hashes `toolName + stableStringify(args)` and appends it to a flat history. It then checks whether the last *W* calls are identical to the *W* calls immediately before them. On match, the repeated call is **blocked in place** — it does not run, and the recovery message is handed straight back as that tool's result, in the same turn. No new turn is started, and other (different) tools stay available, so the model is forced to pivot immediately instead of re-issuing the same call.

Because detection requires *adjacent* repetition, an interleaved different action breaks it: `build → edit → build` does not trip, so legitimate re-runs after real changes are fine. As long as the model keeps repeating the identical call back-to-back, it keeps getting blocked.

Set `TOOL_LOOP_BAN: 2` to make blocks **permanent per call**: once a specific call loops, that exact call stays blocked for the rest of the session no matter what (stronger against stubborn models, but it will also block legitimate later re-runs of the same command). `TOOL_LOOP_BAN: 0` disables the detector entirely.

To exempt specific tools from this detector, set `TOOL_LOOP_EXEMPT` to a comma-separated list of tool names (case-insensitive, exact match), e.g. `"bash,run_tests"`. Exempt tools are never blocked or banned — useful when identical back-to-back calls are legitimate for a given tool (polling a build, re-running a flaky test). Their calls still enter the history, so they keep breaking adjacency for other tools exactly as any different call does. Unlike message templates, `TOOL_LOOP_EXEMPT` is settable live: `/loop-police set TOOL_LOOP_EXEMPT=bash,run_tests` (no spaces in the list; clear it with `TOOL_LOOP_EXEMPT=`).

> **Upgrading from < 1.5.0**: the `TOOL_LOOP_BAN` scale shifted by one (old `0` = temporary → new `1`, old `1` = permanent → new `2`; `0` now means off). Migration is automatic: a `loop-police.json` without a `CONFIG_VERSION` stamp is recognized as pre-1.5.0, its `TOOL_LOOP_BAN` is bumped by one to preserve the behavior you had, and the file is stamped so this happens exactly once.

Detection is exact — only identical repetitions trigger it, not similar ones.

## Command

```
/loop-police                   — show current detection state and all config values
/loop-police reset             — clear all state (useful if a false positive fires)
/loop-police set KEY=VAL       — tune a config value live, no restart needed
/loop-police set KEY=VAL KEY=VAL ...  — set multiple values at once
```

Example: `/loop-police set FILE_READ_LIMIT=6 STAGNATION_WINDOW=5`

## Configuration

Persistent configuration lives in `extensions/loop-police.json` (auto-created on first load with defaults). You can ask the agent to edit it directly, or tune values live with `/loop-police set KEY=VAL`.

Defaults:

```typescript
MIN_THINKING_WINDOW: 80     // shortest repeating phrase to flag in thinking (chars)
MAX_THINKING_WINDOW: 2000   // longest phrase checked (thinking and output)
MIN_OUTPUT_WINDOW: 100      // shortest repeating phrase to flag in the response text
CHECK_STRIDE: 50            // re-run detection every N new streamed chars
PARA_MIN_LEN: 40            // shortest paragraph to fingerprint
PARA_FINGERPRINT_LEN: 60    // chars used as paragraph identity key
PARA_LOOP_THRESHOLD: 3      // same paragraph fingerprint N times → semantic loop
STAGNATION_WINDOW: 4        // turns of similar thinking → stagnation
STAGNATION_THRESHOLD: 0.85  // Jaccard similarity threshold for stagnation
FILE_READ_LIMIT: 4          // reads of same file path before blocking
SEARCH_EXPAND_LIMIT: 3      // unique paths for same search pattern before blocking
CONSECUTIVE_LOOP_LIMIT: 2   // consecutive looped turns before escalating the message
TOOL_LOOP_BAN: 1            // 0 = off
                            // 1 = block identical call only while repeated back-to-back
                            // 2 = ban that exact call for the rest of the session
TOOL_LOOP_EXEMPT: ""        // comma-separated tool names exempt from the tool
                            // call loop detector (case-insensitive exact match)
```

Increase `MIN_THINKING_WINDOW` or `PARA_LOOP_THRESHOLD` if you get false positives on thinking loops. Increase `MIN_OUTPUT_WINDOW` (or set it to `0`) if your responses legitimately contain long verbatim repetition — e.g. generated code with identical adjacent blocks. Increase `FILE_READ_LIMIT` for projects where legitimately re-reading files is common.

### Disabling individual detectors

Setting a detector's key to `0` turns that detector off entirely:

| Key = 0 | Disables |
|---------|----------|
| `MIN_THINKING_WINDOW=0` | character-level thinking loop |
| `PARA_LOOP_THRESHOLD=0` | semantic (paragraph) loop |
| `MIN_OUTPUT_WINDOW=0` | output text loop |
| `STAGNATION_WINDOW=0` | cross-turn stagnation |
| `FILE_READ_LIMIT=0` | file read loop |
| `SEARCH_EXPAND_LIMIT=0` | search expansion spiral |
| `CONSECUTIVE_LOOP_LIMIT=0` | escalated consecutive-loop message |
| `TOOL_LOOP_BAN=0` | tool call sequence loop |

### Customizing recovery messages

The text injected when a loop is detected is configurable — some models respond better to different phrasing. These live alongside the numeric config in `loop-police.json` as `MSG_*` keys:

| Key | Fired when | Placeholders |
|-----|-----------|--------------|
| `MSG_THINKING_LOOP` | character-level thinking loop | — |
| `MSG_SEMANTIC_LOOP` | semantic (paragraph) thinking loop | — |
| `MSG_OUTPUT_LOOP` | character-level loop in the response text | — |
| `MSG_CONSECUTIVE_LOOP` | `CONSECUTIVE_LOOP_LIMIT` looped turns in a row | `{count}` |
| `MSG_STAGNATION` | cross-turn reasoning stagnation | `{window}` `{threshold}` |
| `MSG_FILE_READ_LOOP` | same file read too many times | `{path}` `{count}` |
| `MSG_SEARCH_SPIRAL` | search pattern spread across too many paths | `{pattern}` `{paths}` |
| `MSG_TOOL_LOOP` | identical tool-call sequence repeating | `{windowSize}` |
| `MSG_SUFFIX` | appended to **every** message above (empty by default) | — |

`{placeholder}` tokens are substituted at runtime; unknown tokens are left as-is so a typo stays visible. Messages are edited in `loop-police.json` only — `/loop-police set` handles numeric keys (plus `TOOL_LOOP_EXEMPT`) and will refuse a `MSG_*` key.

`MSG_SUFFIX` is for instructions that should ride along with every detection without rewriting each template — the typical use is pointing the model at an advisor extension or tool to consult once a loop is caught:

```json
{
  "MSG_SUFFIX": "Before continuing, consult the advisor extension: run /advisor with a one-line summary of what you were stuck on."
}
```

## Skills

Two skills ship with the extension:

- **loop-police-help** — reference card: commands, config keys, and where the persistent `loop-police.json` lives for each install type.
- **loop-police-postmortem** — asks the agent to analyze the loop-police detections in the current session: reconstruct what triggered each firing, classify it (justified / false positive / justified-but-ineffective), and recommend config changes where tuning could have avoided it — as a `/loop-police set` line plus a `loop-police.json` snippet. Trigger it with things like *"why did loop-police fire?"*, *"was that a false positive?"*, or *"do a loop post-mortem"*.

## Compatibility

Designed for OpenAI-compatible reasoning models (Qwen3, DeepSeek-R1, etc.) used via pi. Pi normalizes all provider thinking formats to `{ type: "thinking", thinking: string }` content blocks, so this extension works regardless of the underlying provider.

Works alongside [pi-canary](https://github.com/sebaxzero/pi-canary), which silently verifies agent context awareness using hidden canary tokens. When loop-police aborts a turn, pi-canary yields gracefully and does not fire its own recovery.

## Tests

```bash
node --test test.mjs
```

All detectors' pure logic is covered by a dependency-free suite — no build
step, plain Node. CI runs it on every push and pull request.

## Releasing

Bump `version` in `package.json`, commit, tag `vX.Y.Z`, and push the tag —
the publish workflow runs the tests and publishes to npm.

## License

MIT

---

Built with [Claude](https://claude.ai).
