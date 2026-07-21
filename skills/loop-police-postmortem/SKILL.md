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
| Output loop | assistant response text ending in `[OUTPUT LOOP — truncated by loop-police]` + `⚠️ OUTPUT LOOP DETECTED` |
| Output semantic loop | response text ending in `[SEMANTIC OUTPUT LOOP — truncated by loop-police]` + `⚠️ OUTPUT SEMANTIC LOOP DETECTED` |
| Consecutive loop (escalation) | `⚠️ CONSECUTIVE LOOP ({count}x)` warning |
| Stagnation | `⚠️ REASONING STAGNATION` warning |
| File read ceiling | blocked call with `loop-police: file read {count}x total — {path}` + `⚠️ FILE READ CEILING` warning (sessions from < 1.12.0 may also show the removed same-range detector: `loop-police: file read {count}x — {path}` + `⚠️ FILE READ LOOP`) |
| Redundant re-read | blocked call whose result is the `⚠️ REDUNDANT RE-READ` message (`{count}` of the last `{window}` reads were repeats) — in place, no separate warning turn |
| Search spiral | blocked call with `loop-police: search spiral "{pattern}"` + `⚠️ SEARCH EXPANSION SPIRAL` warning |
| Tool call loop | blocked call whose result is the `⚠️ TOOL CALL LOOP` message (`{windowSize}`-call sequence) — no separate warning turn |
| Re-derived reasoning | assistant thinking replaced entirely by `[REDERIVED REASONING — trimmed by loop-police: …]` + a `⚠️ REDERIVED REASONING` warning, or `⚠️ STUCK ({count}x)` when it repeated |

Note: the user may have customized the `MSG_*` templates, so match on the
block-reason prefixes (`loop-police: ...`) and the truncation labels first;
they are not configurable.

Then determine the **active config**. Read `loop-police.json` next to the
extension file — check, in order:

1. `~/.pi/agent/npm/node_modules/pi-loop-police/extensions/loop-police.json`
2. `~/.pi/agent/git/github.com/sebaxzero/pi-loop-police/extensions/loop-police.json`
3. `~/.pi/agent/extensions/pi-loop-police/extensions/loop-police.json`
4. The same three paths under the project's `./.pi/agent/` (local install)

If none is readable, use the defaults: `THINKING_WINDOW=80`,
`OUTPUT_WINDOW=100`, `MAX_WINDOW=4000`, `STRIDE=50`, `PARA_MIN_LEN=40`,
`FINGERPRINT_LEN=60`, `SEMANTIC_THRESHOLD=3`, `STAGNATION_WINDOW=4`,
`STAGNATION_THRESHOLD=0.85`, `FILE_SCAN_LIMIT=20`, `REREAD_WINDOW=10`,
`REREAD_RATIO=0.4`, `SEARCH_EXPAND_LIMIT=3`,
`CONSECUTIVE_LOOP_LIMIT=2`, `TOOL_LOOP_BAN=1`, `REDERIVE_THRESHOLD=0.85`. (Configs written before 1.8.0
may still show the old names `MIN_THINKING_WINDOW`, `MIN_OUTPUT_WINDOW`,
`MAX_THINKING_WINDOW`, `CHECK_STRIDE`, `PARA_FINGERPRINT_LEN`,
`PARA_LOOP_THRESHOLD` — they map 1:1 onto the new ones and are migrated
automatically on next load.) A value of `0` on
`THINKING_WINDOW`, `OUTPUT_WINDOW`, `SEMANTIC_THRESHOLD`, `STAGNATION_WINDOW`,
`FILE_SCAN_LIMIT`, `REREAD_WINDOW`, `SEARCH_EXPAND_LIMIT`, `CONSECUTIVE_LOOP_LIMIT`,
`TOOL_LOOP_BAN` or `REDERIVE_THRESHOLD` means that detector is disabled — a disabled detector cannot
have fired, so skip it (`SEMANTIC_THRESHOLD=0` disables the semantic detector
on both streams). Keep in mind the session may
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

- **File read ceiling**: a genuinely huge file legitimately paged end to end
  in more than `FILE_SCAN_LIMIT` chunks, or a hot file re-read (with edits in
  between) many times over a very long session. Only reads that actually ran
  count — calls blocked by any detector never inflate it — and the counter
  only resets on `agent_start` / `/loop-police reset`. Identical back-to-back
  re-reads are the tool call loop's case, not this detector's.
- **Redundant re-read**: legitimate re-reads of files that genuinely never
  changed — paging back into a file too large to hold in context, or
  repeatedly consulting a reference file without ever editing it. Any re-read
  of an unchanged path counts as redundant (only an edit/write to that path
  makes the next read fresh), so check whether each re-read led to new action
  (legitimate) or the model was visibly losing track of what it had covered
  (justified firing).
- **Search spiral**: the same pattern across several paths was *systematic
  exploration* where each result was acted on (different findings each time),
  e.g. checking every package in a monorepo for the same symbol.
- **Tool call loop**: legitimate *polling* (re-running a status/build/watch
  command while waiting on external state) or an identical re-run that was
  actually wanted. Detection fires on the 2nd identical back-to-back call —
  there is no threshold key for this one.
- **Semantic loop** (thinking or output): structured text where paragraphs
  legitimately start identically (numbered checklists, per-file reports,
  table-like blocks) — the first `FINGERPRINT_LEN` chars collide without real
  repetition. Note that fenced code blocks are already skipped by the
  detector, so repeated code alone cannot be the cause.
- **Character thinking loop**: repeated boilerplate the model quotes
  verbatim more than once (code blocks, error messages, long identifiers) —
  rare at the default 80-char window, plausible below it.
- **Output loop**: the response legitimately contained long verbatim
  repetition — generated code with identical adjacent blocks, or the user
  explicitly asked for repeated content.
- **Stagnation**: a genuinely repetitive batch task (applying the same
  change to N files) where similar thinking across turns *is* progress.
- **Re-derived reasoning**: after a justified block, the model's next
  thinking legitimately had to restate the situation (e.g. summarizing the
  blocker to the user) and collided with the similarity threshold — check
  whether the trimmed message was actually a pivot, not a retry.

## Phase 4 — Recommend

Map each non-justified verdict to a config change:

| Verdict on | Change |
|------------|--------|
| File read ceiling FP | raise `FILE_SCAN_LIMIT` (20 → 30–40); for very large files also suggest targeted greps instead of paging; for edit-heavy sessions also mention `/loop-police reset` as the zero-config fix |
| Redundant re-read FP | raise `REREAD_RATIO` (0.4 → 0.5–0.6); for huge files also suggest targeted greps instead of paging back in; `REREAD_WINDOW=0` only if the user explicitly wants it off |
| Search spiral FP | raise `SEARCH_EXPAND_LIMIT` (3 → 5) — monorepos and multi-package repos usually need this |
| Tool loop FP (polling) | no threshold key exists; recommend the agent interleave a different call between polls, or `/loop-police reset`; do NOT recommend raising `TOOL_LOOP_BAN` here (and only suggest `TOOL_LOOP_BAN=0` — detector off — if the user explicitly wants it gone) |
| Tool loop ineffective (model keeps re-issuing the blocked call) | `TOOL_LOOP_BAN=2` |
| Semantic FP (thinking or output) | raise `SEMANTIC_THRESHOLD` (3 → 4–5) and/or `FINGERPRINT_LEN` (60 → 100); raise `PARA_MIN_LEN` if short bullets collided |
| Character FP | raise `THINKING_WINDOW` (80 → 120–160) |
| Output loop FP | raise `OUTPUT_WINDOW` (100 → 200–400); `OUTPUT_WINDOW=0` only if the user explicitly wants it off |
| Stagnation FP | raise `STAGNATION_THRESHOLD` (0.85 → 0.90–0.95) or `STAGNATION_WINDOW` (4 → 6) |
| Re-derived reasoning FP | raise `REDERIVE_THRESHOLD` (0.85 → 0.90–0.95); `REDERIVE_THRESHOLD=0` only if the user explicitly wants the guard off |
| Re-derived reasoning ineffective (`⚠️ STUCK` keeps escalating) | reword `MSG_STUCK` for this model; the model may simply be too small to pivot — suggest the user intervene or switch models |
| Stream loop ineffective / `CONSECUTIVE LOOP` seen | reword the corresponding `MSG_*` template for this model (shorter, more imperative, name the alternative action); or lower `CONSECUTIVE_LOOP_LIMIT` to escalate sooner |
| Loops detected *late* (long truncated prefix already wasted) | lower `THINKING_WINDOW`/`OUTPUT_WINDOW`, or lower `SEMANTIC_THRESHOLD` if the semantic layer caught what the character layer missed |

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
