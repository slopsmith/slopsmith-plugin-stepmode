# Analyze — Step Mode

## Coverage

| Area               | Spec | Plan | Code         | Notes                                      |
|--------------------|------|------|--------------|--------------------------------------------|
| Toggle UI          | ✅   | ✅   | `screen.js`  | Class swap                                 |
| State machine      | ✅   | ✅   | `screen.js`  | IDLE / WATCHING / PAUSED                   |
| Chart events       | ✅   | ✅   | `screen.js`  | Notes + chords merged & sorted             |
| Pause trigger      | ✅   | ✅   | `screen.js`  | `audio.currentTime ≥ event.t - 0.05`       |
| Catch-up window    | ✅   | ✅   | `screen.js`  | 0.5 s for RAF hitches                      |
| Hit advance        | ✅   | ✅   | `screen.js`  | `notedetect:hit` listener                  |
| Space advance      | ✅   | ✅   | `screen.js`  | Universal escape hatch                     |
| Seek/arrangement   | ✅   | ✅   | `screen.js`  | `resetCursor` on both                      |
| Splitscreen        | ✅   | ✅   | (implicit)   | Inherits from shared `<audio>`             |
| Tests              | ❌   | ❌   | —            | No automated tests                         |

## Drift

- README claims "speed slider preserved automatically" — true; relies on
  browser preserving `playbackRate` across pause/play. No code action needed.
- README claims chord-handling behaviour — matches code (any-note advances).
- README mentions "speed slider preservation" and "no telemetry, no events,
  no server calls" — code matches.

## Gaps

1. **Notedetect "active" detection** is informal (Q6). Without a published
   `isActive` API on notedetect, hint copy may diverge from runtime.
2. **No persistence** — frequent users may want Step Mode to remember its on
   state per song or globally. Currently always OFF on load.
3. **No measurement of practice quality** — Step Mode could surface "advanced
   via hit" vs "advanced via Space" stats; today nothing is captured.
4. **No tests** for `rebuildChartEvents` or the cursor-walk logic, despite both
   being pure-ish and easily unit-testable.
5. **Chord stricter mode** is requested in the README ("can be revisited if
   users want a stricter all-notes-required option") but not implemented.

## Recommendations

- **Publish a notedetect `isActive` flag** (or `window.notedetect.enabled`) so
  Step Mode can render its hint copy deterministically.
- **Add unit tests** for the chart-event builder against synthetic
  `getNotes()`/`getChords()` outputs — easy first wins.
- **Per-song or per-session toggle persistence** behind a `localStorage`
  key, default off.
- **Optional strict-chord mode** behind a settings toggle (constitution §VI
  permits a future setting).
- **Diagnostic overlay** (`?stepmode_debug=1`) showing cursor index, event
  count, and the current pause window — would shorten support cycles.
