# Slopsmith Step Mode Plugin

Rocksmith-1-style practice mode for [Slopsmith](https://github.com/byrongamatos/slopsmith) — the highway freezes at each chart note until you play it (or press Space). Lets you work through fast solos at your own pace, focusing on the pattern rather than the timing.

Implements [slopsmith#52](https://github.com/byrongamatos/slopsmith/issues/52).

## Install

```bash
cd plugins
git clone https://github.com/byrongamatos/slopsmith-plugin-stepmode.git step_mode
# restart Slopsmith
```

## How It Works

1. Load a song, click **Step** in the player controls to turn Step Mode on
2. Playback proceeds normally until just before each chart note, then pauses
3. A "Waiting for…" overlay appears showing the expected note
4. Play the note (with [Note Detection](https://github.com/byrongamatos/slopsmith-plugin-notedetect) active) — or press **Space** — to advance
5. Audio resumes at whatever speed the speed slider was set to

When you hit the note, step-mode jumps immediately to watching for the next one. When you miss (or just pause to think), the highway stays frozen until you're ready.

## Interop with Note Detection

- If [`slopsmith-plugin-notedetect`](https://github.com/byrongamatos/slopsmith-plugin-notedetect) is installed and active, step-mode advances automatically when you play the correct note. The `notedetect:hit` event is the signal; string/fret and chart-note time have to match.
- If Note Detection isn't installed or is toggled off, **Space** is the only advance mechanism. The waiting overlay's hint text updates to reflect which mode you're in.
- Either way, **Space always works** as an escape hatch — useful for unreachable frets or when you just want to skip a note.

## Chord handling

For v1, a chord counts as "played" if **any one** of its notes is detected as a hit. Keeps step-mode forgiving when pitch detection isn't perfect or an individual string in a chord doesn't sustain long enough to register. This behaviour can be revisited if users want a stricter "all notes required" option.

## Keyboard shortcuts

- **Space** (while step-mode is paused on a note) — advance past the waited note. Step-mode intercepts Space only while actively paused; normal Space play/pause is unchanged when step-mode is off or actively watching.

## Requirements

- Slopsmith v1.x+ (plugin system with `window.playSong` + `highway.getNotes()` / `getChords()`)
- Modern browser with `<audio>` element (all modern browsers)
- *Optional* but recommended: [Note Detection plugin](https://github.com/byrongamatos/slopsmith-plugin-notedetect) v1.1+ — provides the per-note `notedetect:hit` event that lets step-mode advance on a successfully-played note without requiring keyboard input.

## Technical notes

- **Speed preservation.** The plugin pauses and resumes the shared `<audio>` element via `pause()` / `play()`. `HTMLAudioElement.playbackRate` survives pause/play, so your speed-slider setting (0.5×, 1×, etc.) is preserved automatically.
- **Timing source.** Step-mode watches `audio.currentTime` directly for its chart-time comparisons and pause triggering. It doesn't call `highway.getTime()` — timing behaviour follows the shared `<audio>` element's playback clock, so speed-slider changes and any future A/V offset calibration apply consistently to what step-mode sees and what the user hears.
- **Multiple instances / splitscreen.** Step-mode operates on the single shared `<audio>` element and the primary highway, so it's a player-level feature rather than a per-panel one. Splitscreen plugin compatibility is inherent — step-mode pauses the one audio element that drives all panels' render clocks.
- **No telemetry.** Step-mode doesn't persist anything, doesn't dispatch its own events, and doesn't talk to the server. Entirely client-side, entirely ephemeral.

## License

MIT
