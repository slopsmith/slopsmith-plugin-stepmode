# Plan — Step Mode (as built)

## File map

| File          | Lines | Purpose                                                             |
|---------------|-------|---------------------------------------------------------------------|
| `plugin.json` | 7     | Manifest. `id: step_mode`, version `0.1.0`, declares `screen.js`.   |
| `screen.js`   | 638   | Toggle button, state machine, RAF loop, listeners, HUD, idempotency. IIFE. |
| `README.md`   | 54    | User docs and interop notes.                                        |
| `CLAUDE.md`   | 4     | SPECKIT preamble.                                                   |

## State machine

```
   STATE_IDLE
       │ user clicks toggle (enabled = true)
       ▼
   STATE_WATCHING ─── RAF tick ──► event reached?
       │  no                         │
       │                             yes (audio.currentTime ≥ event.t - PAUSE_LOOKAHEAD_SEC)
       │                             ▼
       │                       audio.pause()
       │                       show HUD
       │                             │
       │                             ▼
       │                       STATE_PAUSED ──► hit | Space ──► audio.play()
       │                                                              │
       └──────────────── advance cursor ◄─────────────────────────────┘

   any state ─── seeked / arrangement:changed ──► resetCursor()
   any state ─── toggle off (enabled = false) ──► STATE_IDLE
```

## Key constants

```js
const PAUSE_LOOKAHEAD_SEC = 0.05;   // pause 50 ms before the note attack
const EVENT_MISSED_SEC    = 0.5;    // catch-up window for RAF hitches
```

## Event sources

| Source                                  | Reaction                                                  |
|-----------------------------------------|------------------------------------------------------------|
| RAF tick                                | scan from `nextEventIdx`; pause if threshold crossed       |
| `audio.seeked`                          | call `resetCursor()` to re-bind `nextEventIdx`             |
| `arrangement:changed` (window)          | invalidate `chartCacheKey`; rebuild on next tick           |
| `notedetect:hit` (window CustomEvent)   | when paused, match `(s,f)` against `waitingFor.notes`      |
| `keydown` Space                         | when paused, advance unconditionally                       |

## DOM

- Toggle button: appended to `#player-controls` next to other plugin buttons.
- HUD (`hudEl`): a small overlay element pinned over the highway showing the
  expected note's string + fret + an "or press Space" hint.

## Idempotency

```js
if (window.__stepModeInstalled) return;
window.__stepModeInstalled = true;
```
Prevents double listener registration on HMR or accidental double `<script>`.

## Interop

- **`slopsmith-plugin-notedetect`**: optional. When installed and emitting
  `notedetect:hit`, Step Mode advances on hit. Without it, only Space works
  (clearly hinted in the HUD copy).
- **`slopsmith-plugin-splitscreen`**: implicit compatibility — Step Mode pauses
  the single shared `<audio>` element that drives all panels' clocks.

## Non-features (intentional)

- No `localStorage`. Toggle resets to OFF on every page load.
- No backend (`routes.py`).
- No CustomEvent dispatched outwards — Step Mode is a pure consumer.

## Risks / drift watchpoints

- **`highway.getNotes()` / `getChords()` shape**: relies on `n.t`, `n.s`,
  `n.f`, `n.mt` for notes; `c.t`, `c.notes[]` for chords. Any rename in core
  breaks chart-event building silently.
- **Notedetect contract**: relies on `(s, f)` integer-equality match. If
  notedetect changes payload to e.g. `(midi, channel)` Step Mode breaks.
- **Audio focus**: if another plugin pauses/resumes the core audio outside
  Step Mode's view, the state machine recovers via the next RAF tick — but a
  paused audio in `STATE_WATCHING` will still trigger Step Mode pause when
  reached.
