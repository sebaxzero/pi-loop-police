# pi-loop-police

[![test](https://github.com/sebaxzero/pi-loop-police/actions/workflows/test.yml/badge.svg)](https://github.com/sebaxzero/pi-loop-police/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/pi-loop-police)](https://www.npmjs.com/package/pi-loop-police)

A [pi](https://pi.dev) extension that detects and breaks infinite loops in real time — before they waste your context window.

Small reasoning models (Qwen, DeepSeek, etc.) are prone to two kinds of loops:

1. **Thinking block loop** — the model repeats the same phrases inside its `<think>` block over and over until the thinking quota is exhausted.
2. **Tool call loop** — the model calls the same sequence of tools identically across turns, cycling indefinitely until the global context runs out.

Loop Police catches both **mid-stream** (not after the fact), aborts the looping output, trims it from context, and injects a recovery message so the model can continue with a fresh perspective.

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

### Cross-turn reasoning stagnation

After each clean (non-aborted) turn, the thinking text is stored. When the last N turns (default: 4) all have Jaccard word-set similarity ≥ 85% with their neighbor, the model is spinning without progress even though no single turn tripped the within-turn detectors. A recovery message is injected and the stagnation window is cleared.

### File read repetition

Before each tool call, if the tool name looks like a file-read (`read`, `view`, `cat`, etc.) and the same path has been read 4 or more times, the call is blocked and a recovery message is injected.

### Search expansion spiral

Before each search tool call (`grep`, `search`, `find`, `glob`, `rg`, etc.), the extension tracks how many distinct paths a given search pattern has been applied to. When the same pattern reaches 3 or more different paths, the call is blocked — the model is widening its search rather than acting on what it already found.

### Tool call sequence loop

Before each tool executes, the extension hashes `toolName + stableStringify(args)` and appends it to a flat history. It then checks whether the last *W* calls are identical to the *W* calls immediately before them. On match, the repeated call is **blocked in place** — it does not run, and the recovery message is handed straight back as that tool's result, in the same turn. No new turn is started, and other (different) tools stay available, so the model is forced to pivot immediately instead of re-issuing the same call.

Because detection requires *adjacent* repetition, an interleaved different action breaks it: `build → edit → build` does not trip, so legitimate re-runs after real changes are fine. As long as the model keeps repeating the identical call back-to-back, it keeps getting blocked.

Set `TOOL_LOOP_BAN: 1` to make blocks **permanent per call**: once a specific call loops, that exact call stays blocked for the rest of the session no matter what (stronger against stubborn models, but it will also block legitimate later re-runs of the same command).

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
MIN_THINKING_WINDOW: 80     // shortest repeating phrase to flag (chars)
MAX_THINKING_WINDOW: 2000   // longest phrase checked
CHECK_STRIDE: 50            // re-run detection every N new streamed chars
PARA_MIN_LEN: 40            // shortest paragraph to fingerprint
PARA_FINGERPRINT_LEN: 60    // chars used as paragraph identity key
PARA_LOOP_THRESHOLD: 3      // same paragraph fingerprint N times → semantic loop
STAGNATION_WINDOW: 4        // turns of similar thinking → stagnation
STAGNATION_THRESHOLD: 0.85  // Jaccard similarity threshold for stagnation
FILE_READ_LIMIT: 4          // reads of same file path before blocking
SEARCH_EXPAND_LIMIT: 3      // unique paths for same search pattern before blocking
CONSECUTIVE_LOOP_LIMIT: 2   // consecutive looped turns before escalating the message
TOOL_LOOP_BAN: 0            // 0 = block identical call only while repeated back-to-back
                            // 1 = ban that exact call for the rest of the session
```

Increase `MIN_THINKING_WINDOW` or `PARA_LOOP_THRESHOLD` if you get false positives on thinking loops. Increase `FILE_READ_LIMIT` for projects where legitimately re-reading files is common.

### Customizing recovery messages

The text injected when a loop is detected is configurable — some models respond better to different phrasing. These live alongside the numeric config in `loop-police.json` as `MSG_*` keys:

| Key | Fired when | Placeholders |
|-----|-----------|--------------|
| `MSG_THINKING_LOOP` | character-level thinking loop | — |
| `MSG_SEMANTIC_LOOP` | semantic (paragraph) thinking loop | — |
| `MSG_CONSECUTIVE_LOOP` | `CONSECUTIVE_LOOP_LIMIT` looped turns in a row | `{count}` |
| `MSG_STAGNATION` | cross-turn reasoning stagnation | `{window}` `{threshold}` |
| `MSG_FILE_READ_LOOP` | same file read too many times | `{path}` `{count}` |
| `MSG_SEARCH_SPIRAL` | search pattern spread across too many paths | `{pattern}` `{paths}` |
| `MSG_TOOL_LOOP` | identical tool-call sequence repeating | `{windowSize}` |

`{placeholder}` tokens are substituted at runtime; unknown tokens are left as-is so a typo stays visible. Messages are edited in `loop-police.json` only — `/loop-police set` handles numeric keys and will refuse a `MSG_*` key.

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
