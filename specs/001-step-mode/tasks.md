# Tasks — Step Mode

Status legend: `DONE` (shipped in v0.1.0), `OPEN` (not yet implemented), `[P]` (parallelisable).

## US-1 / US-5 — Toggle on / off
- [DONE] Inject **Step** button into `#player-controls`.
- [DONE] Visual on/off state via class swap.
- [DONE] Toggle drives `enabled` flag and state-machine entry.

## US-2 — Pause at next note
- [DONE] RAF loop scans `chartEvents` from `nextEventIdx`.
- [DONE] Pause window = `event.t - PAUSE_LOOKAHEAD_SEC`.
- [DONE] HUD overlay rendered with string/fret on pause.

## US-3 — Hit-based advance
- [DONE] `notedetect:hit` listener.
- [DONE] Match `(s, f)` against `waitingFor.notes`.
- [DONE] Resume audio on advance; cursor moves to next event.

## US-4 — Space advance
- [DONE] `keydown` Space listener.
- [DONE] Active only while `STATE_PAUSED` (does not steal Space when watching/idle).

## US-6 — HUD hint copy
- [DONE] Hint text differentiates "Press Space" vs "Play the note or press Space".
- [OPEN] Formalise notedetect "is active" detection (Q6).

## US-7 — Seek-aware
- [DONE] `audio.seeked` listener calls `resetCursor()`.
- [DONE] `arrangement:changed` listener invalidates `chartCacheKey`.

## US-8 — Chord matching
- [DONE] Any-note-matches policy in v1 (constitution §VI).
- [OPEN] [P] Optional strict-all-notes mode behind a setting.

## US-9 — Splitscreen safety
- [DONE] Inherited via shared `<audio>` element (no extra code needed).

## Cross-cutting
- [DONE] Idempotency guard (`__stepModeInstalled`).
- [DONE] Cleanup on screen change to non-player.
- [DONE] Skip muted notes (`n.mt`) when building events.
- [DONE] Catch-up window for RAF hitches (`EVENT_MISSED_SEC`).
- [OPEN] [P] Persist toggle state across sessions (currently always-OFF on load).
- [OPEN] [P] Ramp-up before resume for rhythmic practice (Q-3).
- [OPEN] Unit tests for `rebuildChartEvents` (pure function over note arrays).
