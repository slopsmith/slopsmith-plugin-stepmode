# Step Mode — Constitution

## Inheritance

Slopsmith's core plugin contract governs everything in this repo (manifest,
`window.playSong`, `highway.getNotes()` / `getChords()`, the shared
`<audio id="audio">` element). This constitution lists Step Mode's own
non-negotiables.

## Core Principles

### I. Pause via the shared `<audio>`, not a private clock
Step Mode pauses and resumes by calling `pause()` / `play()` on the core
`<audio>` element. It MUST NOT keep its own playback clock or fork
`highway.getTime()`. This guarantees splitscreen, lyrics-sync, and any future
A/V offset calibration apply consistently.

### II. Speed-slider preservation
Pause / resume MUST preserve `HTMLAudioElement.playbackRate`. The browser
already does this; Step Mode must not re-set rate on resume (no surprise jumps
back to 1.0×).

### III. Space is the universal escape hatch
Whether or not `slopsmith-plugin-notedetect` is installed and active,
**Space** while paused MUST advance past the current event. This unlocks the
plugin for users without note detection (acoustic, headphones, broken mic) and
for unreachable frets.

### IV. Single-instance global guard
The script installs idempotency guards on `window` (`__stepModeInstalled`).
A second evaluation (HMR, accidental double `<script>` injection) MUST exit
early. Without it, duplicate keydown / `notedetect:hit` listeners would
double-advance.

### V. No persistence, no telemetry
Step Mode is entirely client-side and ephemeral. No `localStorage`, no server
calls, no events of its own dispatched on the document. State machine resets
on every song load and every screen change.

### VI. Forgiving chord matching (v1)
A chord counts as "played" when ANY one of its notes registers as a
`notedetect:hit`. Strict all-notes-required matching is deliberately deferred
— pitch detection isn't perfect and string sustain varies.

## Governance

Amendments must update this file together with `specs/001-step-mode/plan.md`
and the README. Behavioural changes that loosen the chord-match policy require
synchronised README + clarify update so users know what to expect.

**Version**: 1.0.0 | **Ratified**: 2026-05-09 | **Last Amended**: 2026-05-09
