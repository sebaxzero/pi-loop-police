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
- **Semantic loop**: thinking block cycling through the same reasoning steps
- **Stagnation**: thinking across N turns is 85%+ similar (Jaccard)
- **File read loop**: same file read ≥ FILE_READ_LIMIT times in one turn
- **Search spiral**: same pattern searched across ≥ SEARCH_EXPAND_LIMIT paths
- **Tool call loop**: identical sequence of tool calls repeating

## Commands

| Command | What it does |
|---------|-------------|
| `/loop-police` | Show current status and config |
| `/loop-police reset` | Clear all loop state (tool history, file reads, stagnation buffer) |
| `/loop-police set KEY=VAL` | Change one or more keys for this session only |

## Config keys

| Key | Default | What it controls |
|-----|---------|-----------------|
| `MIN_THINKING_WINDOW` | `80` | Minimum characters before loop detection starts |
| `MAX_THINKING_WINDOW` | `2000` | Maximum window size for repeating-suffix scan |
| `CHECK_STRIDE` | `50` | Check every N new characters during streaming |
| `PARA_MIN_LEN` | `40` | Minimum paragraph length to fingerprint for semantic loop |
| `PARA_FINGERPRINT_LEN` | `60` | Characters used as paragraph fingerprint |
| `PARA_LOOP_THRESHOLD` | `3` | Repetitions before semantic loop is declared |
| `STAGNATION_WINDOW` | `4` | Turns of thinking history to compare |
| `STAGNATION_THRESHOLD` | `0.85` | Jaccard similarity threshold for stagnation |
| `FILE_READ_LIMIT` | `4` | Block file reads at or above this count |
| `SEARCH_EXPAND_LIMIT` | `3` | Block search pattern at or above this many paths |

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
