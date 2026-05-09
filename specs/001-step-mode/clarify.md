# Clarifications — Step Mode

## Q1 — Why pause 50 ms before the chart event?
**Resolved.** `PAUSE_LOOKAHEAD_SEC = 0.05`. Smaller risks audible truncation
of the note's attack; larger feels sluggish. Chosen empirically (see comment
in `screen.js`).

## Q2 — Why the 500 ms catch-up window?
**Resolved.** `EVENT_MISSED_SEC = 0.5`. RAF hitches (GC, background tab,
heavy chart render on neighbour plugins) can jump `audio.currentTime` 200–500
ms between ticks. Without this, an event whose entire pause window was
straddled would be silently skipped. 0.5 s is comfortably above typical
hitches and well under seek granularity (seeks are handled separately via
`onSeeked` + `resetCursor`).

## Q3 — How are duplicate evaluations prevented?
**Resolved.** Top-of-file `window.__stepModeInstalled` flag — a second eval
exits before installing duplicate listeners. Pattern landed alongside the
notedetect post-#17 fix; both plugins follow the same convention.

## Q4 — Why is `audio.currentTime` the timing source instead of `highway.getTime()`?
**Resolved.** `getTime()` may apply layered offsets in the future (A/V
calibration, splitscreen panel-local time). Step Mode wants its pause trigger
to align with what the user *hears*, which is the shared `<audio>` element's
clock. Constitution §I formalises this.

## Q5 — How are chord events represented in `chartEvents`?
**Resolved.** Each event is `{t, notes: [{s, f}, …]}`. Solo notes have a
single-element `notes` array. Muted notes (`mt`) are dropped before the event
is appended. Chord with all notes muted is skipped.

## Q6 — How does Step Mode know notedetect is active?
**Open.** Today the hint copy probably toggles based on whether a `notedetect:hit`
has ever fired on the page, or whether `window.notedetect` exists (verify in
code). A formal `isActive` API on notedetect would make this contract explicit.

## Q7 — What about non-pitch events (palm mutes, slides without rearticulation)?
**Resolved (implicitly).** Muted notes are skipped at chart-build time. Slides
that share the same `(s, f)` as a previous note still register as separate
events at distinct `t`. Edge cases for tap-only lines or sustains haven't been
formally evaluated.

## Q8 — Is there a way to skip a long sustain instead of waiting for it?
**Resolved.** Yes — Space always advances, even on sustain. The README calls
this out explicitly.
