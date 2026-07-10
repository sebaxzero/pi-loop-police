---
name: loop-police-postmortem
description: "Post-mortem analysis of loop-police detections in the current session: reconstruct what triggered each firing, classify it as justified / false positive / ineffective, and recommend concrete config changes (KEY=VAL + loop-police.json snippet) where tuning could have avoided it. Use when the user asks why loop-police fired, whether a detection was a false positive, how to tune loop-police, or for a loop post-mortem."
homepage: https://github.com/sebaxzero/pi-loop-police
license: MIT
---

# Loop Police Post-Mortem

Analyze every loop-police detection visible in the current session, decide
whether each one was right to fire, and produce a tuning recommendation the
user can apply. Ground every claim in evidence from the conversation — never
guess what "probably" happened, and never recommend a change you cannot tie
to a specific incident.

## Phase 1 — Collect evidence

Scan the conversation history for loop-police fingerprints. Each detector
leaves a distinct trace:

| Detector | Trace in the session |
|----------|---------------------|
| Thinking loop (character) | assistant thinking ending in `[THINKING LOOP — truncated by loop-police]` + a warning message starting `⚠️ THINKING LOOP DETECTED` |
| Semantic loop | thinking ending in `[SEMANTIC LOOP — truncated by loop-police]` + `⚠️ SEMANTIC LOOP DETECTED` |
| Consecutive loop (escalation) | `⚠️ CONSECUTIVE LOOP ({count}x)` warning |
| Stagnation | `⚠️ REASONING STAGNATION` warning |
| File read loop | blocked tool call whose result/reason contains `loop-police: file read {count}x — {path}` + `⚠️ FILE READ LOOP` warning |
| Search spiral | blocked call with `loop-police: search spiral "{pattern}"` + `⚠️ SEARCH EXPANSION SPIRAL` warning |
| Tool call loop | blocked call whose result is the `⚠️ TOOL CALL LOOP` message (`{windowSize}`-call sequence) — no separate warning turn |

Note: the user may have customized the `MSG_*` templates, so match on the
block-reason prefixes (`loop-police: ...`) and the truncation labels first;
they are not configurable.

Then determine the **active config**. Read `loop-police.json` next to the
extension file — check, in order:

1. `~/.pi/agent/npm/node_modules/pi-loop-police/extensions/loop-police.json`
2. `~/.pi/agent/git/github.com/sebaxzero/pi-loop-police/extensions/loop-police.json`
3. `~/.pi/agent/extensions/pi-loop-police/extensions/loop-police.json`
4. The same three paths under the project's `./.pi/agent/` (local install)

If none is readable, use the defaults: `MIN_THINKING_WINDOW=80`,
`MAX_THINKING_WINDOW=2000`, `CHECK_STRIDE=50`, `PARA_MIN_LEN=40`,
`PARA_FINGERPRINT_LEN=60`, `PARA_LOOP_THRESHOLD=3`, `STAGNATION_WINDOW=4`,
`STAGNATION_THRESHOLD=0.85`, `FILE_READ_LIMIT=4`, `SEARCH_EXPAND_LIMIT=3`,
`CONSECUTIVE_LOOP_LIMIT=2`, `TOOL_LOOP_BAN=1`. A value of `0` on
`MIN_THINKING_WINDOW`, `PARA_LOOP_THRESHOLD`, `STAGNATION_WINDOW`,
`FILE_READ_LIMIT`, `SEARCH_EXPAND_LIMIT`, `CONSECUTIVE_LOOP_LIMIT` or
`TOOL_LOOP_BAN` means that detector is disabled — a disabled detector cannot
have fired, so skip it. Keep in mind the session may
also carry `/loop-police set` overrides the JSON does not show — if the user
ran one earlier in this conversation, it wins.

If **no detection is found**, say so and stop — do not invent tuning advice
for a session where nothing fired.

## Phase 2 — Reconstruct each incident

For every firing, in chronological order, answer three questions from the
surrounding context:

1. **What was the agent doing just before?** (the task, the last few tool
   calls, what it was trying to figure out)
2. **What exactly repeated?** For thinking loops the repeated tail was
   deleted from context, so infer it from the surviving prefix and the label.
   For file/search/tool blocks the path, pattern, or call is in the reason
   string.
3. **What happened after?** Did the recovery message work (the agent pivoted
   and made progress), did the same detector fire again on the same target,
   or did the agent route around the block (e.g. re-read the file via a
   different tool)?

## Phase 3 — Classify

Give each incident exactly one verdict:

- **Justified** — a real loop; the detection saved context. No config change.
- **False positive** — the behavior was legitimate and the config throttled
  it too early. This is the "avoidable by configuration" case.
- **Justified but ineffective** — a real loop, but the recovery message did
  not land: the same detector re-fired on the same target, or a
  `CONSECUTIVE LOOP` escalation appeared. The fix is message wording or
  escalation tuning, not thresholds.

Evidence patterns for **false positives**, per detector:

- **File read loop**: the file was *edited between reads* (edit → re-read
  cycles are legitimate), or a large file was read in *chunks with different
  offsets* (the counter is per-path and ignores offsets). Also remember the
  counter only resets on `agent_start` / `/loop-police reset` — in a long
  session, 4 reads of a hot file spread over hours is normal, not a loop.
- **Search spiral**: the same pattern across several paths was *systematic
  exploration* where each result was acted on (different findings each time),
  e.g. checking every package in a monorepo for the same symbol.
- **Tool call loop**: legitimate *polling* (re-running a status/build/watch
  command while waiting on external state) or an identical re-run that was
  actually wanted. Detection fires on the 2nd identical back-to-back call —
  there is no threshold key for this one.
- **Semantic loop**: structured output where paragraphs legitimately start
  identically (numbered checklists, per-file reports, table-like blocks) —
  the first `PARA_FINGERPRINT_LEN` chars collide without real repetition.
- **Character thinking loop**: repeated boilerplate the model quotes
  verbatim more than once (code blocks, error messages, long identifiers) —
  rare at the default 80-char window, plausible below it.
- **Stagnation**: a genuinely repetitive batch task (applying the same
  change to N files) where similar thinking across turns *is* progress.

## Phase 4 — Recommend

Map each non-justified verdict to a config change:

| Verdict on | Change |
|------------|--------|
| File read FP | raise `FILE_READ_LIMIT` (4 → 6–8); for edit-heavy sessions also mention `/loop-police reset` as the zero-config fix |
| Search spiral FP | raise `SEARCH_EXPAND_LIMIT` (3 → 5) — monorepos and multi-package repos usually need this |
| Tool loop FP (polling) | no threshold key exists; recommend the agent interleave a different call between polls, or `/loop-police reset`; do NOT recommend raising `TOOL_LOOP_BAN` here (and only suggest `TOOL_LOOP_BAN=0` — detector off — if the user explicitly wants it gone) |
| Tool loop ineffective (model keeps re-issuing the blocked call) | `TOOL_LOOP_BAN=2` |
| Semantic FP | raise `PARA_LOOP_THRESHOLD` (3 → 4–5) and/or `PARA_FINGERPRINT_LEN` (60 → 100); raise `PARA_MIN_LEN` if short bullets collided |
| Character FP | raise `MIN_THINKING_WINDOW` (80 → 120–160) |
| Stagnation FP | raise `STAGNATION_THRESHOLD` (0.85 → 0.90–0.95) or `STAGNATION_WINDOW` (4 → 6) |
| Thinking loop ineffective / `CONSECUTIVE LOOP` seen | reword `MSG_THINKING_LOOP` / `MSG_SEMANTIC_LOOP` for this model (shorter, more imperative, name the alternative action); or lower `CONSECUTIVE_LOOP_LIMIT` to escalate sooner |
| Loops detected *late* (long truncated prefix already wasted) | lower `MIN_THINKING_WINDOW`, or lower `PARA_LOOP_THRESHOLD` if the semantic layer caught what the character layer missed |

Rules:

- **One notch at a time.** Suggest the next reasonable value, not a 10×
  jump, and never a value that effectively disables a detector.
- **Only change what fired.** No speculative tuning of detectors with no
  incidents.
- **Repeated same-verdict incidents strengthen the case**; a single
  ambiguous incident gets a "watch it, here's the command if it recurs"
  instead of a firm recommendation.
- When rewording `MSG_*` templates, keep the runtime `{placeholders}` intact.

## Report format

1. **Summary** — one paragraph: how many detections, how much they saved or
   cost (estimate truncated/blocked volume), overall verdict on the config.
2. **Incidents** — one short block each: detector, what happened, verdict,
   evidence.
3. **Recommended config** — only if at least one incident warrants it:
   - Session-only: a single `/loop-police set KEY=VAL [KEY=VAL ...]` line
     (numeric keys only).
   - Persistent: a minimal `loop-police.json` snippet with just the changed
     keys (this is also where `MSG_*` rewording goes).
4. Offer to apply the persistent change by editing `loop-police.json`
   directly (you located it in Phase 1) — but only edit it if the user says
   yes.
