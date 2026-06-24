# pi-loop-police

A [pi](https://pi.dev) extension that detects and breaks infinite loops in real time — before they waste your context window.

Small reasoning models (Qwen, DeepSeek, etc.) are prone to two kinds of loops:

1. **Thinking block loop** — the model repeats the same phrases inside its `<think>` block over and over until the thinking quota is exhausted.
2. **Tool call loop** — the model calls the same sequence of tools identically across turns, cycling indefinitely until the global context runs out.

Loop Police catches both **mid-stream** (not after the fact), aborts the looping output, trims it from context, and injects a recovery message so the model can continue with a fresh perspective.

## Install

```bash
pi install git:github.com/sebaxzero/pi-loop-police.git
```

Or try it without installing:

```bash
pi -e git:github.com/sebaxzero/pi-loop-police.git
```

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

Before each tool executes, the extension hashes `toolName + stableStringify(args)` and appends it to a flat history. It then checks whether the last *W* calls are identical to the *W* calls immediately before them. On match:

- The repeated call is blocked (`{ block: true }`).
- A recovery message is injected explaining that the sequence is repeating and asking the model to reconsider.

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

All values are tunable at runtime via `/loop-police set KEY=VAL`. Defaults:

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
```

Increase `MIN_THINKING_WINDOW` or `PARA_LOOP_THRESHOLD` if you get false positives on thinking loops. Increase `FILE_READ_LIMIT` for projects where legitimately re-reading files is common.

## Compatibility

Designed for OpenAI-compatible reasoning models (Qwen3, DeepSeek-R1, etc.) used via pi. Pi normalizes all provider thinking formats to `{ type: "thinking", thinking: string }` content blocks, so this extension works regardless of the underlying provider.

Works alongside [pi-canary](https://github.com/sebaxzero/pi-canary), which silently verifies agent context awareness using hidden canary tokens. When loop-police aborts a turn, pi-canary yields gracefully and does not fire its own recovery.

## License

MIT

---

Built with [Claude](https://claude.ai).
