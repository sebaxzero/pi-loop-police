# AGENTS.md

Guidance for coding agents (and humans) working on **pi-loop-police**, a
[pi](https://github.com/badlogic/pi-mono) extension that detects and interrupts
infinite thinking/tool-call loops in real time. `CLAUDE.md` points here — this
is the single source of truth.

## Layout

```
extensions/
  index.ts           — re-exports the extension (pi's entry point)
  loop-police.ts     — ALL extension logic, single file, no build step
  loop-police.json   — persistent config, auto-created from DEFAULTS on first load
skills/
  loop-police-help/SKILL.md        — user-facing reference (commands, keys, messages)
  loop-police-postmortem/SKILL.md  — guided analysis of detections in a session
examples/hook.mjs    — sample HOOK_CMD script (desktop notification)
package.json         — pi entry points under "pi": { "extensions", "skills" }
```

No dependencies, no build: pi loads the `.ts` file directly (type stripping).
Keep it that way — do not add npm dependencies or a compile step.

## How it works

The extension exports a default function receiving pi's `ExtensionAPI` and wires
nine detectors into four lifecycle hooks:

| Hook | Detectors |
|------|-----------|
| `message_update` (streaming) | character-level + semantic loop, on both the thinking stream and the visible output — `ctx.abort()` on match |
| `message_end` | truncates the aborted stream and injects the recovery message; cross-turn stagnation (Jaccard over thinking history); re-derived reasoning guard (trims post-detection thinking that re-derives the blocked plan) |
| `tool_call` | tool call sequence loop (exact window repetition, checked first), file read ceiling, search expansion spiral — `{ block: true }` on match |
| `agent_start` / `turn_start` | state reset (all state is closure-local per session; only per-stream state resets on `turn_start`) |

On detection, recovery text is either handed back as the blocked tool's result
(in-place, same turn) or injected via `pi.sendMessage(..., { triggerTurn: true })`.
Every detection also fans out a JSON payload to three observer channels
(`loop-police:detection` bus event, `HOOK_CMD`, `HOOK_LOG`) — see
`buildDetectionPayload()`. **This payload shape is public API**: external hooks
and other extensions (e.g. pi-input-bar) parse it; never rename its fields or
existing `event` names.

Pure logic (detection algorithms, config migration, string helpers) lives at the
bottom of `loop-police.ts` as plain functions with no pi imports; the wiring
lives inside the default export. Keep that separation.

## Config

`loop-police.json` next to the extension file, merged over `DEFAULTS` at load.
Conventions:

- Numeric keys in `NUMERIC_DEFAULTS`, strings in `STRING_DEFAULTS`, recovery
  message templates in `MESSAGE_DEFAULTS` (`MSG_*`, with `{placeholder}` tokens
  filled by `fmt()`).
- **`0` disables a detector** — every detector must honor its key being 0.
- New keys are backfilled into existing JSON files automatically (the load IIFE
  writes the file when defaults are missing) — adding a key needs no migration.
- Renaming or removing a key DOES need a migration: bump `CONFIG_VERSION` and
  follow the pattern of `migrateRenamedKeys()` / `migrateRemovedKeys()`
  (customized values survive, stale defaults pick up the new default).
- `/loop-police set KEY=VAL` mutates the in-memory config (session-only);
  `/loop-police save` persists it. `MSG_*` keys are deliberately not settable
  via `set` — they are edited in the JSON.

## Adding or changing a detector — checklist

1. State as closure variables, cleared in `reset()` (and `turn_start` only if
   per-turn). Blocked/aborted work must never feed other detectors' counters
   (e.g. blocked reads don't count toward the file ceiling).
2. Config key(s) in `NUMERIC_DEFAULTS` with a `0 = off` path, listed in the
   disable-comment at the top of the file.
3. Recovery template in `MESSAGE_DEFAULTS`, routed through `withSuffix()`, with
   placeholders documented in the comment block above `MESSAGE_DEFAULTS`.
4. `emitDetection(ctx, "<event_name>", details)` on every firing — pick a
   stable snake_case event name; it becomes public API.
5. `ctx.ui.notify(...)` warning so the user sees it in the TUI.
6. Update **all** the docs, they are read independently of each other:
   - `README.md`: detector count + table, its own section, config listing,
     disable table, `MSG_*` table, payload `event`/`details` docs.
   - `skills/loop-police-help/SKILL.md`: detection list, key table, disable
     line, `MSG_*` table, event list.
   - `skills/loop-police-postmortem/SKILL.md`: trace-fingerprint table,
     defaults list, false-positive patterns, recommendation table.
7. If the detection leaves a marker in the transcript (truncation label, block
   reason), keep its exact wording stable — the postmortem skill greps for it.

## Testing

Tests are **deliberately local-only**: `test.mjs`, `logic.shared.js`,
`suite.shared.js` and `playground.html` are gitignored and CI runs no tests
(GitHub Actions minutes are reserved for the tag-triggered `publish.yml`).
The shared files hold one copy of the pure-logic functions and the full suite,
consumed by both `node --test test.mjs` and the browser playground. If you are
contributing without them, validate at minimum that the file still parses and
loads: `node -e "import('./extensions/loop-police.ts')"` failing only with
`ERR_MODULE_NOT_FOUND` for `@earendil-works/...` means the file itself is fine.
Behavioral verification happens in a real pi session (install the extension
from your branch and force a loop).

## Contributing

- Issues and PRs at <https://github.com/sebaxzero/pi-loop-police>. For behavior
  changes, open an issue first describing the failure mode you are targeting —
  loop detection is heuristic and thresholds are tuned against real sessions.
- Keep changes surgical: one detector/concern per PR, matching the existing
  code style (single file, comment-dense around non-obvious invariants).
- Anything user-visible (keys, messages, events, markers) ships with the doc
  updates from the checklist above in the same PR.
- Releases: maintainer bumps `package.json` version, tags `vX.Y.Z`, and
  `publish.yml` publishes. Do not bump versions in PRs.
