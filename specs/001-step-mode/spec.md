# Spec — Step Mode (`step_mode`)

> Retrospective spec for shipped v0.1.0. The implementation in `screen.js` is
> the source of truth.

## Summary

Rocksmith-1-style practice mode. The highway freezes a configurable lookahead
before each chart event (note or chord) and waits for the player to either hit
the correct note (via `notedetect:hit`) or press **Space**. Implements
[slopsmith#52](https://github.com/byrongamatos/slopsmith/issues/52).

## User stories

### US-1 — Toggle Step Mode on
**Given** a song is loaded on the highway,
**When** I click the **Step** button injected into `#player-controls`,
**Then** Step Mode becomes active. The button changes to its on-state styling
and the plugin enters `STATE_WATCHING`.

### US-2 — Pause at the next note
**Given** Step Mode is active and audio is playing,
**When** `audio.currentTime` reaches `event.t - 0.05 s` (the
`PAUSE_LOOKAHEAD_SEC` window),
**Then** the audio is paused, `STATE_PAUSED` is entered, and a "Waiting for…"
HUD appears with the expected note (string + fret).

### US-3 — Advance via note detection
**Given** Step Mode is paused and `slopsmith-plugin-notedetect` is active,
**When** a `notedetect:hit` CustomEvent dispatches whose `(s, f)` matches one
of the waiting event's notes,
**Then** the HUD dismisses, the cursor advances to the next event, and audio
resumes at the user's current `playbackRate`.

### US-4 — Advance via Space
**Given** Step Mode is paused,
**When** I press **Space**,
**Then** advance immediately, regardless of whether note detection registered
a hit. Space's normal play/pause behaviour is unaffected when Step Mode is off
or actively watching (not paused).

### US-5 — Toggle off
**Given** Step Mode is on,
**When** I click **Step** again,
**Then** the plugin returns to `STATE_IDLE`. If audio was paused waiting on a
note, it remains paused (the user can resume manually). The HUD is removed.

### US-6 — Hint text reflects detection availability
**Given** notedetect is not installed or is disabled,
**Then** the HUD's hint reads "Press Space" only.
**Given** notedetect is active,
**Then** the HUD reads "Play the note or press Space".
[NEEDS CLARIFICATION] How is notedetect "active" detected — by the presence of
the listener, the plugin script, or a runtime flag?

### US-7 — Seek-aware
**Given** Step Mode is on and the user seeks via the player's seek bar,
**Then** the cursor (`nextEventIdx`) re-resolves to the first event ≥ the new
`audio.currentTime` via `resetCursor`. No spurious pause occurs from a stale
cursor.

### US-8 — Chord matching (v1)
**Given** a chord event is the next waiting event,
**When** any one of its non-muted notes registers a `notedetect:hit`,
**Then** the event is treated as played and step-mode advances.

### US-9 — Splitscreen safety
Step Mode operates on the single shared `<audio>` element and the primary
highway. Multiple highway panels share that clock, so Step Mode's pause is
consistent across panels by construction.

## Functional requirements

| ID    | Requirement                                                                 | Source                          |
|-------|------------------------------------------------------------------------------|---------------------------------|
| FR-1  | Inject a **Step** toggle button into `#player-controls`.                    | `screen.js` `btn` injection     |
| FR-2  | Build a unified, sorted `chartEvents` list of single notes + chords by combining `highway.getNotes()` and `highway.getChords()`. Skip muted notes (`mt` flag). | `screen.js` `rebuildChartEvents` |
| FR-3  | Pause `<audio>` at `event.t - PAUSE_LOOKAHEAD_SEC (0.05 s)`.                | `screen.js`                     |
| FR-4  | Render a HUD overlay listing string/fret for the waiting event.             | `screen.js` `hudEl`             |
| FR-5  | Listen for `notedetect:hit` events and advance when (s, f) matches.         | `screen.js` `notedetect:hit`    |
| FR-6  | Listen for `keydown` Space; advance when paused.                            | `screen.js` keydown             |
| FR-7  | Catch up missed events: any event the playhead has crossed by ≤ `EVENT_MISSED_SEC (0.5 s)` is still treated as current. | `screen.js`                     |
| FR-8  | Reset cursor on `seeked` and `arrangement:changed`.                         | `screen.js` listeners           |
| FR-9  | Idempotency: `window.__stepModeInstalled` guards re-evaluation.             | `screen.js` top                 |
| FR-10 | Player-screen scoping: HUD and listeners only act when the player tab is active (`#player.active`). | `screen.js` `isPlayerActive`    |
| FR-11 | Re-build `chartEvents` lazily when `notes.length + chords.length` changes (`chartCacheKey`). | `screen.js`                     |
| FR-12 | No persistence; state resets on every load and on every screen change.      | constitution §V                 |

## Non-functional

- Pause-trigger latency: one `requestAnimationFrame` tick after the trigger threshold.
- No memory growth across songs (single sorted list, replaced on cache miss).
- No DOM mutations outside `#player-controls` and the HUD root.

## Out of scope

- Persistent "how many notes have I played so far" counter.
- Stricter chord matching (all-notes-required) — see constitution §VI.
- Custom lookahead per user (currently a constant).

## Open clarifications

- [NEEDS CLARIFICATION] How does Step Mode determine whether notedetect is
  "active" for hint copy?
- [NEEDS CLARIFICATION] Should Step Mode optionally restart audio at a fixed
  ramp-up (a few hundred ms before the next event) for tighter rhythmic
  practice? Today resume is instant.
- [NEEDS CLARIFICATION] Should the HUD also show fret-hand fingering or chord
  name when known, or stay minimal?
